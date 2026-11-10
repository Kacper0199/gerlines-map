"""OSM rail graph in projected metres for stop-to-stop reference rail path lengths.

Chains of nodes with exactly two neighbours become single edges between junctions. The search
moves along a chain in one direction and passes a junction only onto a chain that leaves within
``MAX_TURN_DEG`` of the arriving direction, so a path never reverses at a switch or turns off at
a crossing; it may start and end in either direction, because a train reverses at its stops.
With ``reversals`` a path may also turn back at any junction within ``STATION_RADIUS_M`` of a
curated reversal station (an operational reversal without a passenger stop, ``reversals.py``),
which gives the lower bound of a real route's length. A point snaps to the nearest track
segments, not nodes, so a tunnel with few nodes under a station is found next to dense surface
tracks, and the snap adds no length: the shape leg it is compared with is measured between the
stops' projections too.
"""

import heapq
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from itertools import pairwise

import numpy as np
from scipy.sparse import csr_array
from scipy.spatial import cKDTree

MAX_TURN_DEG = 60.0
TANGENT_M = 20.0
SNAP_SLACK_M = 30.0
SAMPLE_STEP_M = 40.0
STATION_RADIUS_M = 500.0


@dataclass(frozen=True, slots=True)
class Snap:
    chain: int
    offset: float
    distance: float


@dataclass(frozen=True, slots=True)
class RailGraph:
    xy: np.ndarray
    total_length_m: float
    edge_total: int
    chain_length: np.ndarray
    chain_start: np.ndarray
    chain_end: np.ndarray
    seg_a: np.ndarray
    seg_b: np.ndarray
    seg_chain: np.ndarray
    seg_offset: np.ndarray
    sample_seg: np.ndarray
    sample_tree: cKDTree
    succ_ptr: np.ndarray
    succ: np.ndarray
    head: np.ndarray
    head_xy: np.ndarray
    leave_ptr: np.ndarray
    leave: np.ndarray
    station: np.ndarray

    @classmethod
    def build(
        cls, ways: Sequence[Sequence[int]], node_xy: Mapping[int, tuple[float, float]]
    ) -> "RailGraph":
        index: dict[int, int] = {}
        for nodes in ways:
            for node in nodes:
                index.setdefault(node, len(index))
        xy = np.empty((len(index), 2))
        for node, i in index.items():
            xy[i] = node_xy[node]
        pairs = [(index[a], index[b]) for nodes in ways for a, b in pairwise(nodes)]
        return cls.from_arrays(xy, np.array(pairs, dtype=np.int64).reshape(-1, 2))

    @classmethod
    def from_arrays(cls, xy: np.ndarray, edges: np.ndarray) -> "RailGraph":
        """Graph of track edges between node indices."""
        xy = np.asarray(xy, dtype=float)
        edges = np.asarray(edges, dtype=np.int64).reshape(-1, 2)
        edges = edges[edges[:, 0] != edges[:, 1]]
        n = len(xy)
        keys = np.unique(
            np.minimum(edges[:, 0], edges[:, 1]) * n + np.maximum(edges[:, 0], edges[:, 1])
        )
        u_lo, u_hi = keys // n, keys % n
        lengths = np.maximum(np.hypot(*(xy[u_lo] - xy[u_hi]).T), 1e-3)
        full = csr_array(
            (
                np.concatenate([lengths, lengths]),
                (np.concatenate([u_lo, u_hi]), np.concatenate([u_hi, u_lo])),
            ),
            shape=(n, n),
        )
        full.sort_indices()
        chains = _chains(full)
        seg_a, seg_b, seg_chain, seg_offset, seg_len = _segments(xy, chains)
        chain_length = np.array([float(c[-1][1]) for c in chains]) if chains else np.zeros(0)
        sample_xy, sample_seg = _samples(xy, seg_a, seg_b, seg_len)
        start = np.array([c[0][0] for c in chains], dtype=np.int64)
        end = np.array([c[-1][0] for c in chains], dtype=np.int64)
        start_dir, end_dir = _tangents(xy, chains)
        succ_ptr, succ = _transitions(start, end, start_dir, end_dir, n)
        head = np.empty(2 * len(chains), dtype=np.int64)
        tail = np.empty(2 * len(chains), dtype=np.int64)
        head[0::2], head[1::2] = end, start
        tail[0::2], tail[1::2] = start, end
        leave = np.argsort(tail, kind="stable").astype(np.int64)
        leave_ptr = np.concatenate([[0], np.cumsum(np.bincount(tail, minlength=n))])
        return cls(
            xy=xy,
            total_length_m=float(lengths.sum()),
            edge_total=len(keys),
            chain_length=chain_length,
            chain_start=start,
            chain_end=end,
            seg_a=seg_a,
            seg_b=seg_b,
            seg_chain=seg_chain,
            seg_offset=seg_offset,
            sample_seg=sample_seg,
            sample_tree=cKDTree(sample_xy) if len(sample_xy) else cKDTree(np.zeros((1, 2))),
            succ_ptr=succ_ptr,
            succ=succ,
            head=head,
            head_xy=xy[head] if len(head) else np.zeros((0, 2)),
            leave_ptr=leave_ptr.astype(np.int64),
            leave=leave,
            station=np.zeros(n, dtype=bool),
        )

    def with_stations(
        self, stations_xy: np.ndarray, radius_m: float = STATION_RADIUS_M
    ) -> "RailGraph":
        """The same graph where junctions within ``radius_m`` of a station allow reversals."""
        junctions = np.unique(np.concatenate([self.chain_start, self.chain_end]))
        station = np.zeros(len(self.xy), dtype=bool)
        if len(junctions) and len(stations_xy):
            distance, _ = cKDTree(np.asarray(stations_xy, dtype=float)).query(
                self.xy[junctions], distance_upper_bound=radius_m
            )
            station[junctions[np.isfinite(distance)]] = True
        return replace(self, station=station)

    @property
    def node_count(self) -> int:
        return len(self.xy)

    @property
    def edge_count(self) -> int:
        return self.edge_total

    def snaps(
        self, point: tuple[float, float], max_snap_m: float, slack_m: float = SNAP_SLACK_M
    ) -> list[Snap]:
        """The nearest point of each chain with a segment within ``max_snap_m`` of ``point``,
        keeping only chains at most ``slack_m`` farther than the nearest track."""
        if len(self.sample_seg) == 0:
            return []
        ids = self.sample_tree.query_ball_point(point, max_snap_m + SAMPLE_STEP_M / 2)
        if not ids:
            return []
        segs = np.unique(self.sample_seg[ids])
        a, b = self.xy[self.seg_a[segs]], self.xy[self.seg_b[segs]]
        ab = b - a
        p = np.asarray(point, dtype=float)
        length2 = np.maximum((ab * ab).sum(axis=1), 1e-12)
        t = np.clip(((p - a) * ab).sum(axis=1) / length2, 0.0, 1.0)
        distance = np.hypot(*(a + t[:, None] * ab - p).T)
        near = distance <= max_snap_m
        if not near.any():
            return []
        near &= distance <= distance[near].min() + slack_m
        offsets = self.seg_offset[segs] + t * np.sqrt(length2)
        best: dict[int, Snap] = {}
        for seg_chain, offset, d in zip(
            self.seg_chain[segs][near], offsets[near], distance[near], strict=True
        ):
            chain = int(seg_chain)
            if chain not in best or d < best[chain].distance:
                best[chain] = Snap(chain, float(offset), float(d))
        return list(best.values())

    def path_length(  # noqa: PLR0913
        self,
        a: tuple[float, float],
        b: tuple[float, float],
        *,
        max_snap_m: float = 200.0,
        limit_factor: float = 3.0,
        limit_extra_m: float = 2000.0,
        slack_m: float = SNAP_SLACK_M,
        reversals: bool = False,
    ) -> float | None:
        """Shortest rail distance between the track points of ``a`` and ``b``, or None.

        ``slack_m`` bounds how much farther than the nearest track a candidate track of a stop
        may be; ``reversals`` lets the path turn back at station junctions (``with_stations``).
        The search stops at ``limit_factor`` times the straight distance plus ``limit_extra_m``.
        """
        sources = self.snaps(a, max_snap_m, slack_m)
        targets = self.snaps(b, max_snap_m, slack_m)
        if not sources or not targets:
            return None
        straight = float(np.hypot(*(np.asarray(a, dtype=float) - np.asarray(b, dtype=float))))
        limit = straight * limit_factor + limit_extra_m
        best = self._search(
            sources, targets, np.asarray(b, dtype=float), limit, reversals=reversals
        )
        return float(best) if np.isfinite(best) and best <= limit else None

    def _moves(self, state: int, *, reversals: bool) -> list[int]:
        """States reachable from ``state`` at its head junction: within the turn limit, or any
        leaving state at a station junction when reversals are allowed."""
        node = self.head[state]
        if reversals and self.station[node]:
            return self.leave[self.leave_ptr[node] : self.leave_ptr[node + 1]].tolist()
        return self.succ[self.succ_ptr[state] : self.succ_ptr[state + 1]].tolist()

    def _search(
        self,
        sources: list[Snap],
        targets: list[Snap],
        goal: np.ndarray,
        limit: float,
        *,
        reversals: bool,
    ) -> float:
        """A* over (chain, direction) states; the straight distance to ``goal`` minus the
        farthest target snap is a lower bound of the remaining track length."""
        target_at = {t.chain: t.offset for t in targets}
        slack = max(t.distance for t in targets)
        best = np.inf
        for s in sources:
            if s.chain in target_at:
                best = min(best, abs(s.offset - target_at[s.chain]))
        lengths, head_xy = self.chain_length, self.head_xy

        def bound(state: int) -> float:
            dx, dy = head_xy[state] - goal
            return max(0.0, (dx * dx + dy * dy) ** 0.5 - slack)

        cost: dict[int, float] = {}
        heap: list[tuple[float, float, int]] = []
        for s in sources:
            for state, g in (
                (2 * s.chain, lengths[s.chain] - s.offset),
                (2 * s.chain + 1, s.offset),
            ):
                if g < cost.get(state, np.inf):
                    cost[state] = g
                    heapq.heappush(heap, (g + bound(state), g, state))
        while heap:
            f, g, state = heapq.heappop(heap)
            if f >= best or f > limit:
                break
            if g > cost.get(state, np.inf):
                continue
            for nxt in self._moves(state, reversals=reversals):
                chain = nxt >> 1
                if chain in target_at:
                    enter = target_at[chain] if nxt % 2 == 0 else lengths[chain] - target_at[chain]
                    best = min(best, g + enter)
                g2 = g + lengths[chain]
                if g2 <= limit and g2 < cost.get(nxt, np.inf):
                    cost[nxt] = g2
                    heapq.heappush(heap, (g2 + bound(nxt), g2, nxt))
        return best


def _chains(full: csr_array) -> list[list[tuple[int, float]]]:
    """Every chain as its nodes with their offsets, from a junction (degree other than two) to
    the next; rings without a junction start at one of their nodes. Each edge is in one chain."""
    n = full.shape[0]
    indptr, indices, weights = full.indptr, full.indices, full.data
    degree = np.diff(indptr)
    kept = degree != 2
    visited = np.zeros(n, dtype=bool)
    chains: list[list[tuple[int, float]]] = []

    def walk(start: int, first: int, weight: float) -> None:
        nodes = [(start, 0.0)]
        prev, cur, length = start, first, weight
        while not kept[cur]:
            visited[cur] = True
            nodes.append((cur, length))
            a, b = indices[indptr[cur] : indptr[cur + 1]]
            wa, wb = weights[indptr[cur] : indptr[cur + 1]]
            prev, cur, step = (cur, b, wb) if a == prev else (cur, a, wa)
            length += step
        nodes.append((int(cur), float(length)))
        chains.append(nodes)

    def walk_from(start: int) -> None:
        for k in range(indptr[start], indptr[start + 1]):
            first = int(indices[k])
            if kept[first]:
                if start < first:
                    walk(start, first, float(weights[k]))
            elif not visited[first]:
                walk(start, first, float(weights[k]))

    for start in np.flatnonzero(kept):
        walk_from(int(start))
    for start in np.flatnonzero(~kept & ~visited & (degree == 2)):
        if visited[start]:
            continue
        kept[start] = True
        visited[start] = True
        k = indptr[start]
        walk(int(start), int(indices[k]), float(weights[k]))
    return chains


def _segments(xy: np.ndarray, chains: list[list[tuple[int, float]]]) -> tuple[np.ndarray, ...]:
    """Each chain's consecutive node pairs with their chain and offset along it."""
    a, b, chain_of, offset, length = [], [], [], [], []
    for c, nodes in enumerate(chains):
        for (n0, o0), (n1, o1) in pairwise(nodes):
            a.append(n0)
            b.append(n1)
            chain_of.append(c)
            offset.append(o0)
            length.append(o1 - o0)
    return (
        np.array(a, dtype=np.int64),
        np.array(b, dtype=np.int64),
        np.array(chain_of, dtype=np.int64),
        np.array(offset, dtype=float),
        np.array(length, dtype=float),
    )


def _samples(
    xy: np.ndarray, seg_a: np.ndarray, seg_b: np.ndarray, seg_len: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Middles of pieces of at most ``SAMPLE_STEP_M`` of each segment, with their segment, so
    every point of a track is within half a step of a sample of its own segment."""
    count = np.maximum(1, np.ceil(seg_len / SAMPLE_STEP_M).astype(np.int64))
    seg = np.repeat(np.arange(len(seg_a)), count)
    first = np.cumsum(count) - count
    fraction = (np.arange(count.sum()) - np.repeat(first, count) + 0.5) / np.repeat(count, count)
    points = xy[seg_a[seg]] + fraction[:, None] * (xy[seg_b[seg]] - xy[seg_a[seg]])
    return points, seg


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.maximum(np.hypot(v[:, 0], v[:, 1]), 1e-9)[:, None]


def _tangents(
    xy: np.ndarray, chains: list[list[tuple[int, float]]]
) -> tuple[np.ndarray, np.ndarray]:
    """Direction leaving each chain's start and arriving at its end, over ``TANGENT_M``."""
    start_dir = np.zeros((len(chains), 2))
    end_dir = np.zeros((len(chains), 2))
    for c, nodes in enumerate(chains):
        total = nodes[-1][1]
        ahead = next((n for n, o in nodes[1:] if o >= TANGENT_M), nodes[-1][0])
        behind = next((n for n, o in reversed(nodes[:-1]) if total - o >= TANGENT_M), nodes[0][0])
        start_dir[c] = xy[ahead] - xy[nodes[0][0]]
        end_dir[c] = xy[nodes[-1][0]] - xy[behind]
    return _unit(start_dir), _unit(end_dir)


def _transitions(
    start: np.ndarray, end: np.ndarray, start_dir: np.ndarray, end_dir: np.ndarray, n: int
) -> tuple[np.ndarray, np.ndarray]:
    """Allowed moves between states (2c forward, 2c+1 backward) at shared junctions."""
    k = len(start)
    states = np.arange(2 * k)
    head = np.empty(2 * k, dtype=np.int64)
    tail = np.empty(2 * k, dtype=np.int64)
    head[0::2], head[1::2] = end, start
    tail[0::2], tail[1::2] = start, end
    arrive = np.empty((2 * k, 2))
    leave = np.empty((2 * k, 2))
    arrive[0::2], arrive[1::2] = end_dir, -start_dir
    leave[0::2], leave[1::2] = start_dir, -end_dir
    out_count = np.bincount(tail, minlength=n)
    out_first = np.cumsum(out_count) - out_count
    out_sorted = np.argsort(tail, kind="stable")
    reps = out_count[head]
    src = np.repeat(states, reps)
    within = np.arange(reps.sum()) - np.repeat(np.cumsum(reps) - reps, reps)
    dst = out_sorted[out_first[head[src]] + within]
    straight_enough = (arrive[src] * leave[dst]).sum(axis=1) >= np.cos(np.radians(MAX_TURN_DEG))
    keep = straight_enough & (dst != (src ^ 1))
    src, dst = src[keep], dst[keep]
    order = np.argsort(src, kind="stable")
    ptr = np.concatenate([[0], np.cumsum(np.bincount(src, minlength=2 * k))])
    return ptr.astype(np.int64), dst[order].astype(np.int64)
