"""Track stubs beyond a shape's ends (D-055 part 2).

A shape starts at its first stop and ends at its last, with M 0 at the first vertex. A train
standing at its origin has its cars behind the head, before M 0, so they have no track to stand
on. The stubs give them one without touching the shape: per end, a polyline that starts at the
end vertex and runs outward along OSM track (rail, light rail, narrow gauge) for at most
``STUB_M``, the longest consist. ``before`` runs against the shape's first heading, ``after``
with its last. M, the stop arcs and the shape hash stay as they are; a consumer places a point
at M < 0 on ``before`` at distance -M, and at M > length on ``after`` at M - length.

The walk snaps the end vertex to the nearest track segment within ``SNAP_M`` whose direction
lies within ``ALIGN_DEG`` of the heading, follows that track, and at a node takes the
continuation that turns least, only when it turns less than ``TURN_DEG``. It ends at
``STUB_M``, at a track end (``buffer``) or where no continuation qualifies. An end vertex more
than ``SNAP_GAP_M`` from that track, a walk shorter than ``MIN_STUB_M``, or a walk whose first
point beyond ``START_M`` of the end vertex lies more than ``START_DEG`` off the heading (the
``jump`` check of the live ``packs build``, with a margin for projection and rounding) gives no
stub (``no_track``): the stub never jumps sideways onto a track (ADR-0001). In EPSG:25832 metres
throughout.
"""

from collections import Counter
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass

import numpy as np
import shapely

from gerlines_rail_graph.osm import RailWays

STUB_M = 400.0
STUB_VERSION = 2
STUB_SOURCE_NOTE = "OpenStreetMap contributors: railway tracks beyond the shape end"
STUB_LICENCE = "ODbL-1.0"
SNAP_M = 15.0
SNAP_GAP_M = 1.0
MIN_STUB_M = 5.0
ALIGN_DEG = 30.0
TURN_DEG = 30.0
HEADING_M = 20.0
START_M = 1.0
START_DEG = 30.0
START_MARGIN_M = 0.05
START_MARGIN_DEG = 1.0
ROUTABLE = ("rail", "light_rail", "narrow_gauge")


@dataclass(frozen=True, slots=True)
class Stub:
    """Points from the shape's end vertex outward, their distance from it, and why it ended:
    ``limit`` (``STUB_M``), ``buffer`` (track end), ``no_continuation`` or ``no_track``; the OSM
    id of the way it snapped to, the OSM node where it ended (the buffer stop at a ``buffer``
    end, -1 at the limit) and the snap gap in metres."""

    xy: np.ndarray
    dist: np.ndarray
    end: str
    way_id: int = -1
    end_node: int = -1
    gap_m: float = float("inf")

    @property
    def length_m(self) -> float:
        return float(self.dist[-1])


def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.hypot(*v))
    return v / n if n > 0 else v


class TrackWalker:
    """The routable OSM tracks with a spatial index of ways and the ways meeting at each node."""

    def __init__(self, ways: RailWays) -> None:
        keep = np.flatnonzero(np.isin(ways.railway, ROUTABLE))
        self.xy = ways.xy
        self.node_ids = ways.node_ids
        self.way_ids = ways.way_ids[keep]
        self.starts = ways.offsets[keep]
        self.stops = ways.offsets[keep + 1]
        self.tree = shapely.STRtree(
            [
                shapely.linestrings(ways.xy[a:b])
                for a, b in zip(self.starts, self.stops, strict=True)
            ]
        )
        vertex_way = np.repeat(np.arange(len(keep)), self.stops - self.starts)
        vertices = np.concatenate(
            [np.zeros(0, dtype=np.int64)]
            + [np.arange(a, b) for a, b in zip(self.starts, self.stops, strict=True)]
        )
        order = np.argsort(self.node_ids[vertices], kind="stable")
        self.by_node = vertices[order]
        self.by_node_way = vertex_way[order]
        self.sorted_nodes = self.node_ids[self.by_node]

    def _at_node(self, node: int) -> list[tuple[int, int]]:
        lo = int(np.searchsorted(self.sorted_nodes, node, side="left"))
        hi = int(np.searchsorted(self.sorted_nodes, node, side="right"))
        return [(int(self.by_node_way[k]), int(self.by_node[k])) for k in range(lo, hi)]

    def _snap(
        self, point: np.ndarray, heading: np.ndarray
    ) -> tuple[int, int, int, np.ndarray] | None:
        """The nearest aligned segment within ``SNAP_M``: way, its first vertex, the direction to
        walk (+1 or -1 along the way) and the point on it."""
        best = None
        limit = np.cos(np.radians(ALIGN_DEG))
        for w in sorted(
            self.tree.query(shapely.points(point), predicate="dwithin", distance=SNAP_M)
        ):
            a, b = int(self.starts[w]), int(self.stops[w])
            p, q = self.xy[a : b - 1], self.xy[a + 1 : b]
            d = q - p
            length2 = np.einsum("ij,ij->i", d, d)
            t = np.clip(
                np.einsum("ij,ij->i", point - p, d) / np.where(length2 > 0, length2, 1), 0, 1
            )
            foot = p + t[:, None] * d
            gap = np.hypot(*(foot - point).T)
            cos = np.einsum("ij,j->i", d, heading) / np.sqrt(np.where(length2 > 0, length2, 1))
            ok = (gap <= SNAP_M) & (length2 > 0) & (np.abs(cos) >= limit)
            for k in np.flatnonzero(ok):
                key = (float(gap[k]), int(w), int(k))
                if best is None or key < best[0]:
                    best = (key, int(w), a + int(k), 1 if cos[k] > 0 else -1, foot[k])
        return None if best is None else best[1:]

    def walk(  # noqa: PLR0913
        self,
        point: np.ndarray,
        heading: np.ndarray,
        limit_m: float = STUB_M,
        *,
        max_gap_m: float = SNAP_GAP_M,
        min_m: float = MIN_STUB_M,
        start_deg: float | None = START_DEG,
    ) -> Stub:
        """The stub from ``point`` along the track that leaves it in ``heading``; ``no_track``
        when that track lies farther than ``max_gap_m``, the walk is shorter than ``min_m`` or
        it leaves ``point`` more than ``start_deg`` off ``heading`` (``None``: not checked)."""
        point = np.asarray(point, dtype=float)
        heading = _unit(np.asarray(heading, dtype=float))
        snapped = self._snap(point, heading)
        if snapped is None:
            return Stub(point[None, :], np.zeros(1), "no_track")
        way, vertex, step, foot = snapped
        gap = float(np.hypot(*(foot - point)))
        none = Stub(point[None, :], np.zeros(1), "no_track", int(self.way_ids[way]), -1, gap)
        if gap > max_gap_m:
            return none
        first_way = int(self.way_ids[way])
        points = [point, foot] if gap >= 0.01 else [point]
        a, b = int(self.starts[way]), int(self.stops[way])
        nxt = vertex + 1 if step > 0 else vertex
        direction = _unit((self.xy[vertex + 1] - self.xy[vertex]) * step)
        end = "limit"
        travelled = float(np.hypot(*(points[-1] - point)))
        while True:
            target = self.xy[nxt]
            seg = target - points[-1]
            seg_len = float(np.hypot(*seg))
            if seg_len > 0:
                if _turn(direction, seg) > TURN_DEG:
                    end = "no_continuation"
                    break
                direction = _unit(seg)
                if travelled + seg_len >= limit_m:
                    points.append(points[-1] + direction * (limit_m - travelled))
                    break
                points.append(target)
                travelled += seg_len
            following = nxt + step
            if a <= following < b:
                nxt = following
                continue
            chosen = self._continue(way, nxt, direction)
            if chosen is None:
                end = (
                    "buffer"
                    if len(self._at_node(int(self.node_ids[nxt]))) == 1
                    else "no_continuation"
                )
                break
            way, nxt, step = chosen
            a, b = int(self.starts[way]), int(self.stops[way])
            nxt += step
        xy = np.array(points)
        dist = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
        if dist[-1] < min_m or (start_deg is not None and _leaves_off(xy, heading, start_deg)):
            return none
        reached = -1 if end == "limit" else int(self.node_ids[nxt])
        return Stub(xy, dist, end, first_way, reached, gap)

    def _continue(
        self, way: int, vertex: int, direction: np.ndarray
    ) -> tuple[int, int, int] | None:
        """At the node of ``vertex``: the way, vertex and step turning least, under ``TURN_DEG``."""
        best = None
        for other, v in self._at_node(int(self.node_ids[vertex])):
            if other == way and v == vertex:
                continue
            a, b = int(self.starts[other]), int(self.stops[other])
            for step in (1, -1):
                if not a <= v + step < b:
                    continue
                turn = _turn(direction, self.xy[v + step] - self.xy[v])
                key = (turn, other, step)
                if turn < TURN_DEG and (best is None or key < best[0]):
                    best = (key, other, v, step)
        return None if best is None else best[1:]


def _leaves_off(xy: np.ndarray, heading: np.ndarray, degrees: float) -> bool:
    """Whether a point about ``START_M`` from the first one, up to the first beyond it, lies
    more than ``degrees`` off ``heading`` (a unit vector); both bounds carry a margin, so the
    live check, which measures on the ground from rounded WGS84 points, agrees."""
    offsets = xy[1:] - xy[0]
    reach = np.hypot(*offsets.T)
    limit = np.cos(np.radians(degrees - START_MARGIN_DEG))
    for offset, r in zip(offsets, reach, strict=True):
        if r <= START_M - START_MARGIN_M:
            continue
        if float(offset @ heading) / r < limit:
            return True
        if r > START_M + START_MARGIN_M:
            return False
    return False


def _turn(direction: np.ndarray, segment: np.ndarray) -> float:
    cos = float(np.dot(direction, _unit(segment)))
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


def _heading(xy: np.ndarray, from_end: bool) -> np.ndarray:
    """The line's direction over its first (or last) ``HEADING_M``, pointing away from that end."""
    line = xy[::-1] if from_end else xy
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(line, axis=0).T))])
    k = int(np.searchsorted(cum, min(HEADING_M, float(cum[-1])), side="left"))
    return _unit(line[0] - line[max(k, 1)])


def end_stubs(walker: TrackWalker, xy: np.ndarray, limit_m: float = STUB_M) -> tuple[Stub, Stub]:
    """The stubs before the first and after the last vertex of a shape (EPSG:25832)."""
    xy = np.asarray(xy, dtype=float)
    before = walker.walk(xy[0], _heading(xy, from_end=False), limit_m)
    after = walker.walk(xy[-1], _heading(xy, from_end=True), limit_m)
    return before, after


STRAIGHT = "straight"
STUBS_FILE = "stubs.jsonl"


def _side(stub: Stub, z: float) -> dict:
    """The stub in WGS84 with geodesic distances, the scale of shape M (the walk measures in
    EPSG:25832, about 0.04 to 0.2 % off the ground), rounded to 1 cm and growing strictly: a
    vertex that adds no centimetre is left out."""
    from gerlines_rail_graph.project import geodesic_arc, to_lonlat  # noqa: PLC0415

    lonlat = to_lonlat(stub.xy)
    dist = np.round(geodesic_arc(lonlat) if len(lonlat) > 1 else np.zeros(1), 2)
    keep = np.concatenate([[True], np.diff(np.maximum.accumulate(dist)) > 0])
    return {
        "lonlatz": [[round(float(a), 7), round(float(b), 7), float(z)] for a, b in lonlat[keep]],
        "dist": [float(d) for d in dist[keep]],
        "length_m": float(dist[keep][-1]),
        "end": stub.end,
    }


def stub_rows(
    metas: Iterable[Mapping], coords_of: Callable[[str], np.ndarray], walker: TrackWalker
) -> tuple[list[dict], dict]:
    """One row per distinct track shape (``shape_hash``) with its stubs before and after, Z held
    at the end vertex's baked height; and counts of how the stubs ended."""
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415

    rows, seen = [], set()
    ends: dict[str, Counter] = {"before": Counter(), "after": Counter()}
    for meta in metas:
        if meta["method"] == STRAIGHT or meta["shape_hash"] in seen:
            continue
        seen.add(meta["shape_hash"])
        coords = coords_of(meta["pattern_id"])
        before, after = end_stubs(walker, to_xy(coords[:, 0], coords[:, 1]))
        ends["before"][before.end] += 1
        ends["after"][after.end] += 1
        rows.append(
            {
                "shape_hash": meta["shape_hash"],
                "before": _side(before, float(coords[0, 2])),
                "after": _side(after, float(coords[-1, 2])),
            }
        )
    return rows, {"shapes": len(rows), **{k: dict(v) for k, v in ends.items()}}
