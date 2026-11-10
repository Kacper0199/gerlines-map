"""Out-and-back spurs in candidate shapes, and the reversals that stay.

A train turns back only where it stops: at a stop of its pattern between the first and the
last, or at a curated reversal station (``reversal_stations.csv``). A shape vertex turning
more than 160 degrees anywhere else is a matcher artefact, and the live engine, which moves
trains in arc length along the shape (ADR-0001), would run the train into the stub and back.
Two kinds are cut here, in EPSG:25832 metres:

- a zigzag: two such turns close together with the direction of travel unchanged, where the
  matcher changes to a parallel track by reversing twice instead of through a facing
  crossover. The piece between a point before the first turn and a point after the second is
  replaced by a short chord that leaves and joins within 20 degrees of the track, the
  shortest such cut that stays within 15 m of the removed piece and keeps every stop near the
  line;
- an end spur: a turn before the second stop or after the second-last, or within 300 m of the
  first or last stop, where the shape leaves its first stop the wrong way and comes back
  through it, or runs past its last stop and back. The shape is cut at the turn.

A cut is kept only when every stop stays within 80 m of the line, or within 20 m more than
before when it was already farther. A single turn within 300 m of an intermediate stop, or
within 500 m of a curated station, is a reversal and stays; ``snap_stops`` moves that stop's
arc onto the turn, since a train stands where it reverses. A reversal more than 80 m past its
stop's position is cut back to a chord across the two legs at the stop (``overshoot``), where
the way back passes within 100 m; otherwise the stop stands on the turn and the distance is
reported (``reversal_stop_m``, the choice flag ``stop_on_reversal``).

Other turns are removed while the line keeps its matched track (D-048): where the
way back passes within 100 m of one of the three stops nearest the turn, a chord across the
two legs at that stop, so the train turns, or changes line, where it stands; with a single
such turn and no such stop, the out-and-back stub is cut back to where the two legs part by
more than 25 m, kept only where the line then leaves on another track without reversing (a
junction whose curve the matcher missed). These are ``turn`` cuts, a review flag, made only
when every such turn goes. Otherwise the turns stay in the geometry as unexplained, which
fails the shape in the gate. The passes repeat until one makes no cut.

A turn is a vertex turning more than 160 degrees, on the line or on its 1 m Douglas-Peucker
simplification (the build's tolerance, which merges a turn spread over vertices closer than
that), or a U-turn: the heading 60 m before and 60 m after differing by more than 160 degrees
(``u_turns``), which also sees a reversal split over several vertices.
"""

import itertools
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely import LineString
from shapely.ops import substring

from gerlines_rail_graph.metrics import forward_positions
from gerlines_rail_graph.project import to_xy

SPUR_VERSION = 6
HAIRPIN_DEG = 160.0
ZIGZAG_MAX_M = 1500.0
END_STOP_M = 300.0
REVERSAL_STOP_M = 300.0
STATION_M = 500.0
CHORD_MAX_M = 150.0
CHORD_TURN_DEG = 20.0
CHORD_OFF_M = 15.0
STOP_KEEP_M = 80.0
STOP_SLACK_M = 20.0
STEP_M = 2.0
HEADING_M = 20.0
MAX_CUTS = 64
SIMPLIFY_M = 1.0
TURN_STOP_CHORD_M = 100.0
TURN_STOPS = 3
TURN_PART_M = 25.0
TURN_STUB_MAX_M = 5000.0
MAX_TURN_CUTS = 4
U_TURN_WINDOW_M = 60.0
U_TURN_STEP_M = 5.0
U_TURN_MERGE_M = 50.0
TANGENT_M = 2.0
U_TURN_STOP_M = 30.0
SHARP_PAIR_DEG = 150.0
SHARP_NEAR_M = 100.0
TURN_KINDS = ("turn_at_stop", "turn")


@dataclass(frozen=True, slots=True)
class Cut:
    kind: str
    start_m: float
    end_m: float
    removed_m: float


@dataclass(slots=True)
class Despurred:
    xy: np.ndarray
    cuts: list[Cut] = field(default_factory=list)
    reversals: list[float] = field(default_factory=list)
    hairpins: list[float] = field(default_factory=list)
    reversal_stop_m: float = 0.0
    vertex_hairpins: int = 0

    @property
    def removed_m(self) -> float:
        return float(sum(c.removed_m for c in self.cuts))


def arc(xy: np.ndarray) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])


def dedupe(xy: np.ndarray) -> np.ndarray:
    xy = np.asarray(xy, dtype=float)
    if len(xy) < 2:
        return xy
    keep = np.ones(len(xy), dtype=bool)
    keep[1:] = np.any(np.diff(xy, axis=0) != 0, axis=1)
    return xy[keep]


def turn_degrees(xy: np.ndarray) -> np.ndarray:
    """Turn at every inner vertex in degrees (0 straight on, 180 straight back)."""
    d = np.diff(np.asarray(xy, dtype=float), axis=0)
    length = np.hypot(*d.T)
    a, b = d[:-1], d[1:]
    la, lb = length[:-1], length[1:]
    ok = (la > 0) & (lb > 0)
    cos = np.ones(len(a))
    cos[ok] = (a[ok] * b[ok]).sum(axis=1) / (la[ok] * lb[ok])
    return np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))


def hairpin_vertices(
    xy: np.ndarray, min_deg: float = HAIRPIN_DEG, merge_m: float = 0.0
) -> np.ndarray:
    """Indexes of inner vertices turning more than ``min_deg``; with ``merge_m``, also those
    turning so on the line simplified at ``merge_m`` (which keeps a subset of the vertices)."""
    xy = np.asarray(xy, dtype=float)
    if len(xy) < 3:
        return np.zeros(0, dtype=int)
    found = np.flatnonzero(turn_degrees(xy) > min_deg) + 1
    if merge_m <= 0:
        return found
    simple = shapely.get_coordinates(shapely.simplify(LineString(xy), merge_m))
    if len(simple) < 3 or len(simple) == len(xy):
        return found
    index = _subset_index(xy, simple)
    merged = index[np.flatnonzero(turn_degrees(simple) > min_deg) + 1]
    return np.union1d(found, merged).astype(int)


def u_turns(xy: np.ndarray, min_deg: float = HAIRPIN_DEG) -> np.ndarray:
    """Arcs where the line's heading ``U_TURN_WINDOW_M`` before differs from its heading as far
    after by more than ``min_deg``, sampled every ``U_TURN_STEP_M``: one arc, the middle of each
    run of such samples within ``U_TURN_MERGE_M``. Unlike ``hairpin_vertices`` this sees a
    reversal split over several vertices, such as a U of two right angles."""
    xy = np.asarray(xy, dtype=float)
    if len(xy) < 3:
        return np.zeros(0)
    cum = arc(xy)
    length = float(cum[-1])
    s = np.arange(0.0, length + U_TURN_STEP_M, U_TURN_STEP_M).clip(0.0, length)

    def heading(t: np.ndarray) -> np.ndarray:
        lo = np.clip(t - TANGENT_M, 0.0, length)
        hi = np.clip(t + TANGENT_M, 0.0, length)
        return _unit(_at(xy, cum, hi) - _at(xy, cum, lo))

    h_in = heading(np.clip(s - U_TURN_WINDOW_M, 0.0, length))
    h_out = heading(np.clip(s + U_TURN_WINDOW_M, 0.0, length))
    cos = np.einsum("ij,ij->i", h_in, h_out)
    valid = (np.hypot(*h_in.T) > 0) & (np.hypot(*h_out.T) > 0)
    hit = np.flatnonzero(valid & (cos < np.cos(np.radians(min_deg))))
    if not len(hit):
        return np.zeros(0)
    runs = np.split(hit, np.flatnonzero(np.diff(s[hit]) > U_TURN_MERGE_M) + 1)
    return np.array([float((s[r[0]] + s[r[-1]]) / 2.0) for r in runs])


def _subset_index(xy: np.ndarray, subset: np.ndarray) -> np.ndarray:
    """Index in ``xy`` of each vertex of ``subset``, an ordered subset of its vertices."""
    out = np.empty(len(subset), dtype=int)
    j = 0
    for k, point in enumerate(subset):
        while not (xy[j] == point).all():
            j += 1
        out[k] = j
        j += 1
    return out


def _at(xy: np.ndarray, cum: np.ndarray, s: np.ndarray) -> np.ndarray:
    s = np.asarray(s, dtype=float)
    return np.stack([np.interp(s, cum, xy[:, 0]), np.interp(s, cum, xy[:, 1])], axis=-1)


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return np.divide(v, n, out=np.zeros_like(v), where=n > 0)


def _splice(xy: np.ndarray, cum: np.ndarray, s1: float, s2: float) -> np.ndarray:
    """The line with the piece between arc ``s1`` and ``s2`` replaced by the chord."""
    before = xy[cum < s1]
    after = xy[cum > s2]
    return dedupe(np.vstack([before, _at(xy, cum, [s1, s2]), after]))


def find_chord(xy: np.ndarray, cum: np.ndarray, a1: float, a2: float) -> tuple[float, float] | None:
    """The shortest cut (s1 before ``a1``, s2 after ``a2``) whose chord leaves and joins the
    track within ``CHORD_TURN_DEG`` and stays within ``CHORD_OFF_M`` of the removed piece."""
    back = (a2 - a1) + CHORD_MAX_M + 100.0
    s1 = np.arange(a1 - STEP_M, max(HEADING_M, a1 - back), -STEP_M)
    s2 = np.arange(a2 + STEP_M, min(cum[-1] - HEADING_M, a2 + back), STEP_M)
    if not len(s1) or not len(s2):
        return None
    p1, p2 = _at(xy, cum, s1), _at(xy, cum, s2)
    h1 = _unit(p1 - _at(xy, cum, s1 - HEADING_M))
    h2 = _unit(_at(xy, cum, s2 + HEADING_M) - p2)
    chord = p2[None, :, :] - p1[:, None, :]
    length = np.linalg.norm(chord, axis=-1)
    c = _unit(chord)
    limit = np.cos(np.radians(CHORD_TURN_DEG))
    aligned = (h1 @ h2.T) >= np.cos(np.radians(1.5 * CHORD_TURN_DEG))
    leaves = np.einsum("ik,ijk->ij", h1, c) >= limit
    joins = np.einsum("ijk,jk->ij", c, h2) >= limit
    ok = aligned & (length <= CHORD_MAX_M) & ((length < 1.0) | (leaves & joins))
    if not ok.any():
        return None
    i, j = np.nonzero(ok)
    removed = s2[j] - s1[i]
    for k in np.argsort(removed, kind="stable")[:50]:
        a, b = float(s1[i[k]]), float(s2[j[k]])
        piece = shapely.get_coordinates(
            substring(LineString(xy), a, b) if b > a else LineString(xy[:2])
        )
        n = max(2, int(np.ceil(length[i[k], j[k]] / 5.0)) + 1)
        samples = p1[i[k]] + np.linspace(0, 1, n)[:, None] * chord[i[k], j[k]]
        if (
            len(piece) >= 2
            and np.max(shapely.distance(LineString(piece), shapely.points(samples))) <= CHORD_OFF_M
        ):
            return a, b
    return None


def _stop_gaps(xy: np.ndarray, stops_xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    line = LineString(xy)
    along = forward_positions(line, stops_xy)
    at = shapely.get_coordinates(shapely.line_interpolate_point(line, along))
    return along, np.hypot(*(at - stops_xy).T)


def _stops_kept(old_gaps: np.ndarray, xy: np.ndarray, stops_xy: np.ndarray) -> bool:
    _, gaps = _stop_gaps(xy, stops_xy)
    return bool(np.all(gaps <= np.maximum(old_gaps, STOP_KEEP_M) + STOP_SLACK_M))


def _near_station(point: np.ndarray, stations_xy: np.ndarray | None) -> bool:
    if stations_xy is None or not len(stations_xy):
        return False
    return bool(np.min(np.hypot(*(stations_xy - point).T)) <= STATION_M)


def _at_stop(a: float, along: np.ndarray) -> int | None:
    """The intermediate stop within ``REVERSAL_STOP_M`` of arc ``a``, nearest first."""
    if len(along) < 3:
        return None
    inner = np.abs(along[1:-1] - a)
    k = int(np.argmin(inner))
    return k + 1 if inner[k] <= REVERSAL_STOP_M else None


@dataclass(frozen=True, slots=True)
class _State:
    """A line during the cut: vertices, arcs, turns, and each stop's arc and distance."""

    xy: np.ndarray
    stops_xy: np.ndarray
    cum: np.ndarray
    apexes: np.ndarray
    along: np.ndarray
    gaps: np.ndarray
    stations_xy: np.ndarray | None = None

    @classmethod
    def of(
        cls, xy: np.ndarray, stops_xy: np.ndarray, stations_xy: np.ndarray | None = None
    ) -> "_State":
        along, gaps = _stop_gaps(xy, stops_xy)
        apexes = hairpin_vertices(xy, merge_m=SIMPLIFY_M)
        return cls(xy, stops_xy, arc(xy), apexes, along, gaps, stations_xy)

    def keeps_stops(self, out: np.ndarray, removed: tuple[float, float] | None = None) -> bool:
        """The cut line still passes every stop as near as before (or within ``STOP_KEEP_M``);
        with the removed arc range, no stop that was already farther than ``STOP_KEEP_M`` may
        have its position in it: its forward search fell short, so the cut could remove the
        stretch that really passes it."""
        if removed is not None:
            lost = (self.along >= removed[0] - 1e-6) & (self.along <= removed[1] + 1e-6)
            if np.any(lost & (self.gaps > STOP_KEEP_M)):
                return False
        return len(out) >= 2 and _stops_kept(self.gaps, out, self.stops_xy)

    def at_station(self, vertex: int) -> bool:
        return _near_station(self.xy[vertex], self.stations_xy)


def _end_cut(line: _State) -> tuple[np.ndarray, Cut] | None:
    cum, along = line.cum, line.along
    i = line.apexes[0]
    if (cum[i] <= along[0] + END_STOP_M or cum[i] < along[1]) and not line.at_station(i):
        out = line.xy[i:]
        if line.keeps_stops(out, (0.0, float(cum[i]))):
            return out, Cut("start", 0.0, float(cum[i]), float(cum[i]))
    i = line.apexes[-1]
    if (cum[i] >= along[-1] - END_STOP_M or cum[i] > along[-2]) and not line.at_station(i):
        out = line.xy[: i + 1]
        if line.keeps_stops(out, (float(cum[i]), float(cum[-1]))):
            return out, Cut("end", float(cum[i]), float(cum[-1]), float(cum[-1] - cum[i]))
    return None


def _zigzag_cut(line: _State) -> tuple[np.ndarray, Cut] | None:
    xy, cum = line.xy, line.cum
    for i, j in itertools.pairwise(line.apexes):
        a1, a2 = float(cum[i]), float(cum[j])
        if a2 - a1 > ZIGZAG_MAX_M or line.at_station(i) or line.at_station(j):
            continue
        k1, k2 = _at_stop(a1, line.along), _at_stop(a2, line.along)
        if k1 is not None and k2 is not None and k1 != k2:
            continue
        chord = find_chord(xy, cum, a1, a2)
        if chord is None:
            continue
        s1, s2 = chord
        out = _splice(xy, cum, s1, s2)
        if line.keeps_stops(out):
            removed = (s2 - s1) - float(np.hypot(*np.subtract(*_at(xy, cum, [s2, s1]))))
            return out, Cut("zigzag", s1, s2, removed)
    return None


def _turn_at_stop(
    line: _State, apex: int, stops: Sequence[int] | None = None, kind: str = "turn_at_stop"
) -> tuple[np.ndarray, Cut] | None:
    """A chord across the legs at ``stops`` or at one of the intermediate stops nearest the
    turn, both ends and its length within ``TURN_STOP_CHORD_M`` of the stop, the shortest that
    keeps the stops. The stop is looked for on each leg only within ``TURN_STUB_MAX_M`` of the
    turn, so a line that passes it twice is cut on the pass next to the turn."""
    xy, cum = line.xy, line.cum
    a = float(cum[apex])
    out_from, back_to = max(0.0, a - TURN_STUB_MAX_M), min(float(cum[-1]), a + TURN_STUB_MAX_M)
    if not out_from < a < back_to:
        return None
    full = LineString(xy)
    out_leg, back_leg = substring(full, out_from, a), substring(full, a, back_to)
    inner = np.arange(1, len(line.along) - 1)
    if stops is None:
        stops = inner[np.argsort(np.abs(line.along[inner] - a), kind="stable")][:TURN_STOPS]
    best = None
    for k in stops:
        stop = shapely.points(line.stops_xy[k])
        s1 = out_from + float(shapely.line_locate_point(out_leg, stop))
        s2 = a + float(shapely.line_locate_point(back_leg, stop))
        ends = _at(xy, cum, [s1, s2])
        chord = float(np.hypot(*np.subtract(*ends)))
        near = np.max(np.hypot(*(ends - line.stops_xy[k]).T)) <= TURN_STOP_CHORD_M
        if not near or chord > TURN_STOP_CHORD_M or s2 - s1 <= 1.0 or (best and chord >= best[0]):
            continue
        out = _splice(xy, cum, s1, s2)
        if line.keeps_stops(out):
            best = (chord, out, Cut(kind, s1, s2, (s2 - s1) - chord))
    return None if best is None else (best[1], best[2])


def _turn_stub(line: _State, apex: int) -> tuple[np.ndarray, Cut] | None:
    """The out-and-back stub cut back to where its legs part by more than ``TURN_PART_M``, or
    less far when that would lose a stop."""
    xy, cum = line.xy, line.cum
    a = float(cum[apex])
    steps = np.arange(STEP_M, min(a, TURN_STUB_MAX_M), STEP_M)
    if not len(steps):
        return None
    back_leg = LineString(_at(xy, cum, np.arange(a, min(cum[-1], a + TURN_STUB_MAX_M), STEP_M)))
    if back_leg.length <= 0:
        return None
    points = shapely.points(_at(xy, cum, a - steps))
    apart = np.flatnonzero(shapely.distance(back_leg, points) > TURN_PART_M)
    last = (apart[0] if len(apart) else len(steps)) - 1
    for k in sorted({int(last * f) for f in (1.0, 0.75, 0.5, 0.35, 0.25, 0.15, 0.1)}, reverse=True):
        if k < 0:
            continue
        s1 = a - float(steps[k])
        s2 = a + float(shapely.line_locate_point(back_leg, points[k]))
        out = _splice(xy, cum, s1, s2)
        if line.keeps_stops(out):
            chord = float(np.hypot(*np.subtract(*_at(xy, cum, [s1, s2]))))
            return out, Cut("turn", s1, s2, (s2 - s1) - chord)
    return None


@dataclass(slots=True)
class _Turns:
    """The turns of a line: reversals and unexplained hairpins as arcs, the hairpin vertices,
    and per reversal at a stop the vertex, the stop and how far the turn is from it."""

    reversals: list[float] = field(default_factory=list)
    hairpins: list[float] = field(default_factory=list)
    vertices: list[int] = field(default_factory=list)
    at_stops: list[tuple[int, int, float]] = field(default_factory=list)
    vertex_hairpins: int = 0

    @property
    def reversal_stop_m(self) -> float:
        """How far along the line the farthest reversal at a stop turns from that stop's
        position on it: a platform beside the track is not an overshoot."""
        return max((d for _, _, d in self.at_stops), default=0.0)


def sharp_pair_near(xy: np.ndarray, at: float, within: float = SHARP_NEAR_M) -> bool:
    """Two segments at most ``U_TURN_WINDOW_M`` of arc apart whose directions differ by more
    than ``SHARP_PAIR_DEG``, the first within ``within`` of arc ``at``: the U-turn rule of
    WP-3.2a's pack gate (``services/live/src/shapes/packs.ts``), which sees a reversal split
    over corners that each stay under ``HAIRPIN_DEG``."""
    cum = arc(xy)
    d = np.diff(xy, axis=0)
    length = np.hypot(*d.T)
    unit = np.divide(d, length[:, None], out=np.zeros_like(d), where=length[:, None] > 0)
    limit = np.cos(np.radians(SHARP_PAIR_DEG))
    for i in np.flatnonzero((cum[1:] >= at - within) & (cum[:-1] <= at + within)):
        if length[i] == 0:
            continue
        j = np.arange(i + 1, int(np.searchsorted(cum, cum[i + 1] + U_TURN_WINDOW_M, "right")))
        j = j[j < len(d)]
        if len(j) and np.any((length[j] > 0) & (unit[j] @ unit[i] < limit)):
            return True
    return False


PACK_U_TURN_STOP_M = 5.0
PACK_HAIRPIN_STOP_M = 0.01


def pack_u_turns(xy: np.ndarray, s: np.ndarray, stop_arcs: Sequence[float]) -> list[tuple]:
    """WP-3.2a's pack gate (``uTurnsOffStop`` in ``services/live/src/shapes/packs.ts``): spans
    (from, to) in arc ``s`` where a segment and a later one at most ``U_TURN_WINDOW_M`` further
    differ by more than ``SHARP_PAIR_DEG``, overlapping spans merged, whose turning part has no
    intermediate stop arc within ``PACK_U_TURN_STOP_M``."""
    xy, s = np.asarray(xy, dtype=float), np.asarray(s, dtype=float)
    inner = np.asarray(stop_arcs, dtype=float)[1:-1]
    d = np.diff(xy, axis=0)
    n = len(d)
    if n < 2:
        return []
    length = np.hypot(*d.T)
    ok = length > 0
    unit = np.divide(d, length[:, None], out=np.zeros_like(d), where=ok[:, None])
    last = np.searchsorted(s, s[1:] + U_TURN_WINDOW_M, side="right") - 1
    last = np.minimum(last, n - 1)
    first: dict[int, int] = {}
    limit = np.cos(np.radians(SHARP_PAIR_DEG))
    for k in range(1, int(np.max(last - np.arange(n))) + 1):
        i = np.arange(n - k)
        j = i + k
        hit = (j <= last[i]) & ok[i] & ok[j] & (np.einsum("ij,ij->i", unit[i], unit[j]) < limit)
        for a in np.flatnonzero(hit):
            first.setdefault(int(a), int(a) + k)
    spans: list[list[float]] = []
    for a in sorted(first):
        b = first[a]
        span, turn = [s[a], s[b + 1]], [s[a + 1], s[b]]
        if spans and span[0] <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], span[1])
            spans[-1][2] = min(spans[-1][2], turn[0])
            spans[-1][3] = max(spans[-1][3], turn[1])
        else:
            spans.append([*span, *turn])
    return [
        (float(a), float(b))
        for a, b, t0, t1 in spans
        if not np.any((inner >= t0 - PACK_U_TURN_STOP_M) & (inner <= t1 + PACK_U_TURN_STOP_M))
    ]


def pack_hairpins(xy: np.ndarray, s: np.ndarray, stop_arcs: Sequence[float]) -> int:
    """Vertices turning more than ``HAIRPIN_DEG`` farther than ``PACK_HAIRPIN_STOP_M`` from every
    intermediate stop arc: the pack gate's hairpins (``shapeFaults``)."""
    inner = np.asarray(stop_arcs, dtype=float)[1:-1]
    found = np.asarray(s, dtype=float)[hairpin_vertices(xy)]
    if not len(inner):
        return len(found)
    return int(
        np.sum(np.min(np.abs(found[:, None] - inner[None, :]), axis=1) > PACK_HAIRPIN_STOP_M)
    )


def turn_apexes(xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Vertex indexes of every turn: hairpin vertices (also on the 1 m simplification), then the
    vertex nearest each windowed U-turn (``u_turns``) farther than ``U_TURN_MERGE_M`` from them;
    and a mask of which come from a single vertex."""
    vertices = hairpin_vertices(xy, merge_m=SIMPLIFY_M)
    cum = arc(xy)
    taken = cum[vertices]
    extra = []
    for a in u_turns(xy):
        if not len(taken) or np.min(np.abs(taken - a)) > U_TURN_MERGE_M:
            extra.append(int(np.clip(np.argmin(np.abs(cum - a)), 1, len(xy) - 2)))
            taken = np.append(taken, a)
    apexes = np.concatenate([vertices, np.asarray(extra, dtype=int)])
    single = np.concatenate([np.ones(len(vertices), bool), np.zeros(len(extra), bool)])
    order = np.argsort(apexes, kind="stable")
    return apexes[order].astype(int), single[order]


def _turns(xy: np.ndarray, stops_xy: np.ndarray, stations_xy: np.ndarray | None) -> _Turns:
    out = _Turns()
    apexes, single = turn_apexes(xy)
    if len(apexes):
        cum = arc(xy)
        along, _ = _stop_gaps(xy, stops_xy)
        for i, one_vertex in zip(apexes, single, strict=True):
            a = float(cum[i])
            k = _at_stop(a, along)
            if k is not None:
                out.reversals.append(a)
                out.at_stops.append((int(i), k, abs(a - float(along[k]))))
            elif _near_station(xy[i], stations_xy):
                out.reversals.append(a)
            else:
                out.hairpins.append(a)
                out.vertices.append(int(i))
                out.vertex_hairpins += bool(one_vertex)
    return out


def _overshoot_cut(
    xy: np.ndarray, stops_xy: np.ndarray, turns: _Turns
) -> tuple[np.ndarray, Cut] | None:
    """A reversal that turns more than ``STOP_KEEP_M`` past its stop cut back to a chord at the
    stop, so the train turns at the platform."""
    line = None
    for apex, k, gap in turns.at_stops:
        if gap <= STOP_KEEP_M:
            continue
        line = line or _State.of(xy, stops_xy)
        found = _turn_at_stop(line, apex, [k], "overshoot")
        if found is not None:
            return found
    return None


def _turn_cuts(
    xy: np.ndarray, stops_xy: np.ndarray, stations_xy: np.ndarray | None, turns: _Turns
) -> tuple[np.ndarray, _Turns, list[Cut]] | None:
    """Every unexplained turn removed, or None: chords at stops the line passes on both legs,
    each time the one leaving the fewest turns, and the stub cut when the line had a single
    such turn."""
    single = len(turns.vertices) == 1
    made: list[Cut] = []
    while turns.vertices:
        if len(made) >= MAX_TURN_CUTS:
            return None
        line = _State.of(xy, stops_xy)
        found = None
        for vertex in turns.vertices:
            cut = _turn_at_stop(line, vertex)
            if cut is not None:
                after = _turns(cut[0], stops_xy, stations_xy)
                left = len(after.hairpins)
                if left < len(turns.hairpins) and (found is None or left < len(found[1].hairpins)):
                    found = cut, after
        if found is None and single:
            cut = _turn_stub(line, turns.vertices[0])
            if cut is not None and not sharp_pair_near(cut[0], cut[1].start_m):
                after = _turns(cut[0], stops_xy, stations_xy)
                if not after.hairpins:
                    found = cut, after
        if found is None:
            return None
        (xy, cut_made), turns = found
        made.append(cut_made)
    return (xy, turns, made) if made else None


def remove_spurs(
    xy: np.ndarray, stops_xy: np.ndarray, stations_xy: np.ndarray | None = None
) -> Despurred:
    """The line without zigzags, end spurs, overshoots and removable unexplained turns, the cuts
    made, and the turns that remain as arc positions on the new line: reversals at a stop or
    station, and unexplained turns."""
    xy = dedupe(xy)
    stops_xy = np.asarray(stops_xy, dtype=float)
    cuts: list[Cut] = []
    if len(xy) < 3 or len(stops_xy) < 2:
        return Despurred(xy)
    turns = _Turns()
    while True:
        made, before = len(cuts), xy
        xy, turns = _one_pass(xy, stops_xy, stations_xy, cuts)
        if len(cuts) == made or len(cuts) >= MAX_CUTS or not _changes(before, xy):
            break
    return Despurred(
        xy, cuts, turns.reversals, turns.hairpins, turns.reversal_stop_m, turns.vertex_hairpins
    )


def _changes(old: np.ndarray, new: np.ndarray) -> bool:
    """A cut changed the line (a chord cut again where it already stands removes nothing)."""
    return len(old) != len(new) or not np.allclose(old, new, rtol=0.0, atol=SIMPLIFY_M / 10)


def _one_pass(
    xy: np.ndarray, stops_xy: np.ndarray, stations_xy: np.ndarray | None, cuts: list[Cut]
) -> tuple[np.ndarray, _Turns]:
    """Zigzag and end cuts, overshoot cuts, then turn cuts, appending to ``cuts``; the caller
    repeats it until a pass makes no cut, so the result is a fixed point."""
    while len(cuts) < MAX_CUTS and len(hairpin_vertices(xy, merge_m=SIMPLIFY_M)):
        line = _State.of(xy, stops_xy, stations_xy)
        found = _end_cut(line) or _zigzag_cut(line)
        if found is None:
            break
        xy, cut = found
        cuts.append(cut)
    turns = _turns(xy, stops_xy, stations_xy)
    while len(cuts) < MAX_CUTS and (found := _overshoot_cut(xy, stops_xy, turns)) is not None:
        if not _changes(xy, found[0]):
            break
        after = _turns(found[0], stops_xy, stations_xy)
        if len(after.hairpins) > len(turns.hairpins):
            break
        xy, turns = found[0], after
        cuts.append(found[1])
    resolved = _turn_cuts(xy, stops_xy, stations_xy, turns) if len(cuts) < MAX_CUTS else None
    if resolved is not None:
        xy, turns, made = resolved
        cuts.extend(made)
    return xy, turns


def snap_stops(stop_arcs: list[float], reversal_arcs: list[float]) -> list[float]:
    """Each reversal's nearest intermediate stop within ``REVERSAL_STOP_M`` moved onto it."""
    out = list(stop_arcs)
    along = np.asarray(stop_arcs, dtype=float)
    for a in reversal_arcs:
        k = _at_stop(a, along)
        if k is not None:
            out[k] = float(a)
    return [float(v) for v in np.maximum.accumulate(out)] if out else out


def spur_row(despurred: Despurred | None) -> dict:
    """The gate row fields of a candidate's spur cut."""
    if despurred is None:
        return {
            "hairpins": 0,
            "reversals": 0,
            "spur_cuts": 0,
            "spur_removed_m": 0.0,
            "turn_cuts": 0,
            "reversal_stop_m": 0.0,
            "u_turns_off_stop": 0,
        }
    return {
        "hairpins": despurred.vertex_hairpins,
        "u_turns_off_stop": len(despurred.hairpins),
        "reversals": len(despurred.reversals),
        "spur_cuts": len(despurred.cuts),
        "spur_removed_m": round(despurred.removed_m, 1),
        "turn_cuts": sum(c.kind in TURN_KINDS for c in despurred.cuts),
        "reversal_stop_m": round(despurred.reversal_stop_m, 1),
    }


def unexplained(
    turn_arcs: np.ndarray,
    stop_arcs: list[float],
    turns_lonlat: np.ndarray,
    stations_lonlat: np.ndarray | None = None,
    within_m: float = REVERSAL_STOP_M,
) -> int:
    """How many turns of a final shape (arcs in M, positions in lon and lat) are no reversal:
    farther than ``within_m`` from every intermediate stop arc and ``STATION_M`` from every
    curated station."""
    turn_arcs = np.asarray(turn_arcs, dtype=float)
    if not len(turn_arcs):
        return 0
    along = np.asarray(stop_arcs, dtype=float)
    points = to_xy(turns_lonlat[:, 0], turns_lonlat[:, 1])
    stations = (
        None
        if stations_lonlat is None or not len(stations_lonlat)
        else to_xy(stations_lonlat[:, 0], stations_lonlat[:, 1])
    )
    inner = along[1:-1]
    return sum(
        (not len(inner) or float(np.min(np.abs(inner - a))) > within_m)
        and not _near_station(p, stations)
        for a, p in zip(turn_arcs, points, strict=True)
    )
