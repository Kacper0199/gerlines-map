"""The final shape of a pattern: geometry, arc length M, stop arcs, structure spans, Z, hash.

Geometry is simplified and densified in EPSG:25832; M is the geodesic length on the WGS84
ellipsoid from the first vertex (architecture §8.1: everything moves in arc length), so the end
of M equals the shape's geodesic length. Stop arcs are found by forward projection (ADR-0001)
and carried over to M segment by segment.
"""

import hashlib
import itertools
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely import LineString

from gerlines_rail_graph.metrics import forward_positions
from gerlines_rail_graph.project import geodesic_arc, to_lonlat, to_xy
from gerlines_rail_graph.spurs import (
    U_TURN_MERGE_M,
    hairpin_vertices,
    remove_spurs,
    snap_stops,
    spur_row,
    u_turns,
)

SIMPLIFY_M = 1.0
DENSIFY_M = 200.0
SPAN_GAP_M = 20.0
BAKE_WIDEN_M = 25.0
OUTSIDE_M = (20.0, 30.0, 40.0, 50.0, 60.0)
GRADE_WINDOW_M = 50.0
BAKE_VERSION = 2


def clean(coords: np.ndarray) -> np.ndarray:
    """Finite rows without consecutive repeats."""
    coords = np.asarray(coords, dtype=float)
    coords = coords[np.isfinite(coords).all(axis=1)]
    if len(coords) == 0:
        return coords
    keep = np.ones(len(coords), dtype=bool)
    keep[1:] = np.any(np.diff(coords, axis=0) != 0, axis=1)
    return coords[keep]


def simplify(xy: np.ndarray, tolerance_m: float = SIMPLIFY_M) -> np.ndarray:
    """Douglas-Peucker in metres; the ends are always kept."""
    if len(xy) <= 2:
        return xy
    out = shapely.get_coordinates(shapely.simplify(LineString(xy), tolerance_m))
    return out if len(out) >= 2 else xy[[0, -1]]


def densify_marked(xy: np.ndarray, max_m: float = DENSIFY_M) -> tuple[np.ndarray, np.ndarray]:
    """Extra vertices so no edge is longer than ``max_m``; the mask is true on the input ones.

    The extra vertices only carry the terrain's Z; ``thin_profile`` drops those it does not need.
    """
    parts = [xy[:1]]
    marks = [np.array([True])]
    for a, b in itertools.pairwise(xy):
        pieces = max(1, int(np.ceil(float(np.hypot(*(b - a))) / max_m)))
        t = np.arange(1, pieces + 1)[:, None] / pieces
        parts.append(a + t * (b - a))
        mark = np.zeros(pieces, dtype=bool)
        mark[-1] = True
        marks.append(mark)
    return np.concatenate(parts), np.concatenate(marks)


def densify(xy: np.ndarray, max_m: float = DENSIFY_M) -> np.ndarray:
    return densify_marked(xy, max_m)[0]


def projected_arc(xy: np.ndarray) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])


def insert_marked(
    xy: np.ndarray, essential: np.ndarray, arcs: Sequence[float]
) -> tuple[np.ndarray, np.ndarray]:
    """Vertices added at projected arc positions (span ends), marked essential."""
    cum = projected_arc(xy)
    extra = [a for a in arcs if 0 < a < cum[-1] and np.min(np.abs(cum - a)) > 0.05]
    essential = essential.copy()
    for a in arcs:
        nearest = int(np.argmin(np.abs(cum - a)))
        if abs(cum[nearest] - a) <= 0.05:
            essential[nearest] = True
    if not extra:
        return xy, essential
    points = np.column_stack([np.interp(extra, cum, xy[:, 0]), np.interp(extra, cum, xy[:, 1])])
    order = np.argsort(np.concatenate([cum, extra]), kind="stable")
    marks = np.concatenate([essential, np.ones(len(extra), dtype=bool)])
    return np.concatenate([xy, points])[order], marks[order]


def insert_at(xy: np.ndarray, arcs: Sequence[float]) -> np.ndarray:
    """Vertices added at the given projected arc positions (span ends), unless one is there."""
    return insert_marked(xy, np.zeros(len(xy), dtype=bool), arcs)[0]


def thin_profile(
    m: np.ndarray, z: np.ndarray, essential: np.ndarray, tolerance_m: float = SIMPLIFY_M
) -> np.ndarray:
    """Vertices to keep: the essential ones and those the (M, Z) profile needs within tolerance."""
    keep = np.asarray(essential, dtype=bool).copy()
    keep[[0, -1]] = True
    if len(m) > 2:
        kept = shapely.get_coordinates(
            shapely.simplify(LineString(np.column_stack([m, z])), tolerance_m)
        )
        keep |= np.isin(m, kept[:, 0])
    return keep


def runs_to_spans(mask: np.ndarray, piece_m: float, gap_m: float = SPAN_GAP_M) -> list[tuple]:
    """Projected (start, end) of runs of true samples, runs closer than ``gap_m`` merged."""
    padded = np.concatenate([[False], np.asarray(mask, dtype=bool), [False]])
    edges = np.flatnonzero(np.diff(padded.astype(np.int8)))
    spans: list[list[float]] = []
    for start, end in zip(edges[0::2], edges[1::2], strict=True):
        a, b = start * piece_m, end * piece_m
        if spans and a - spans[-1][1] < gap_m:
            spans[-1][1] = b
        else:
            spans.append([a, b])
    return [(float(a), float(b)) for a, b in spans]


def bake_ranges(
    spans: Sequence[tuple[float, float]], length_m: float, widen_m: float = BAKE_WIDEN_M
) -> list[tuple[float, float, float, float]]:
    """Ranges whose Z is baked: each bridge or tunnel span widened by ``widen_m`` on both sides,
    clipped to the shape, overlapping ones merged; as (start, end, first span start, last span
    end).

    The DEM sees the valley under a bridge or the slope above a portal a pixel or two (about
    12 m each at z12) beyond the OSM structure end, so the grade starts that far outside it.
    """
    out: list[list[float]] = []
    for a, b in sorted(spans):
        start, end = max(0.0, a - widen_m), min(length_m, b + widen_m)
        if out and start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
            out[-1][3] = max(out[-1][3], b)
        else:
            out.append([start, end, a, b])
    return [(float(s), float(e), float(a), float(b)) for s, e, a, b in out]


def outside_positions(
    ranges: Sequence[tuple[float, float, float, float]],
    spans: Sequence[tuple[float, float]],
    length_m: float,
) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """M positions 20 to 60 m before and after each range's structures where the terrain is the
    track's ground: on the shape and on no bridge or tunnel."""
    if not ranges:
        return [], []
    offsets = np.asarray(OUTSIDE_M)
    covered_start, covered_end = _union(spans)

    def kept(positions: np.ndarray) -> list[np.ndarray]:
        k = np.searchsorted(covered_start, positions, side="right") - 1
        on_structure = (k >= 0) & (positions <= covered_end[np.maximum(k, 0)])
        keep = (positions >= 0.0) & (positions <= length_m) & ~on_structure
        return [row[mask] for row, mask in zip(positions, keep, strict=True)]

    firsts = np.array([r[2] for r in ranges])[:, None]
    lasts = np.array([r[3] for r in ranges])[:, None]
    return kept(firsts - offsets), kept(lasts + offsets)


def _union(spans: Sequence[tuple[float, float]]) -> tuple[np.ndarray, np.ndarray]:
    """Sorted, disjoint closed intervals covering the spans."""
    starts: list[float] = []
    ends: list[float] = []
    for a, b in sorted(spans):
        if ends and a <= ends[-1]:
            ends[-1] = max(ends[-1], b)
        else:
            starts.append(a)
            ends.append(b)
    return np.array(starts), np.array(ends)


def bake_z(
    m: np.ndarray,
    z: np.ndarray,
    ranges: Sequence[tuple[float, float, float, float]],
    before: Sequence[np.ndarray],
    after: Sequence[np.ndarray],
) -> np.ndarray:
    """Z across each range replaced by a straight grade between the terrain beyond its ends.

    On a bridge the terrain under the deck is the valley; in a tunnel it is the mountain. The
    track runs from one abutment or portal to the other, so Z is interpolated across, from the
    median of the terrain heights sampled outside each end (``before`` and ``after``). An end
    without such samples takes the other end's height, or the terrain at the range end.
    """
    out = z.copy()
    for k, (start, end, _, _) in enumerate(ranges):
        lo = int(np.searchsorted(m, start - 0.05, side="left"))
        hi = int(np.searchsorted(m, end + 0.05, side="right"))
        if hi <= lo:
            continue
        inside = slice(lo, hi)
        z_start, z_end = np.interp([start, end], m, z)
        low = before[k] if k < len(before) else np.array([])
        high = after[k] if k < len(after) else np.array([])
        if len(low):
            z_start = float(np.median(low))
        if len(high):
            z_end = float(np.median(high))
        if not len(low) and len(high):
            z_start = z_end
        if not len(high) and len(low):
            z_end = z_start
        out[inside] = np.interp(m[inside], [start, max(end, start + 1e-9)], [z_start, z_end])
    return out


def steepest(
    m: np.ndarray, z: np.ndarray, window_m: float = GRADE_WINDOW_M
) -> tuple[float, float | None]:
    """The steepest rise or fall between a vertex and the first vertex at least ``window_m``
    farther along the shape, and the M where that window starts."""
    ahead = np.searchsorted(m, m + window_m)
    valid = ahead < len(m)
    if not valid.any():
        return 0.0, None
    i, j = np.flatnonzero(valid), ahead[valid]
    grades = np.abs(z[j] - z[i]) / (m[j] - m[i])
    k = int(np.argmax(grades))
    return float(grades[k]), float(m[i[k]])


def max_grade(m: np.ndarray, z: np.ndarray, window_m: float = GRADE_WINDOW_M) -> float:
    return steepest(m, z, window_m)[0]


@dataclass(slots=True)
class BuiltShape:
    """A pattern's shape before elevation: (lon, lat, m) per vertex and arcs in metres of M."""

    lonlat: np.ndarray
    m: np.ndarray
    stop_arc_m: list[float]
    method: str
    qa_status: str
    tunnel_spans: list[tuple[float, float]] = field(default_factory=list)
    bridge_spans: list[tuple[float, float]] = field(default_factory=list)
    essential: np.ndarray | None = None
    bake_ranges: list[tuple[float, float, float, float]] = field(default_factory=list)
    spurs: dict = field(default_factory=dict)

    @property
    def length_m(self) -> float:
        return float(self.m[-1])


def to_m(arcs_xy: Sequence[float], xy_cum: np.ndarray, m: np.ndarray) -> list[float]:
    """Projected arc positions carried to geodesic M, linearly within each edge."""
    return [float(v) for v in np.interp(arcs_xy, xy_cum, m)]


def build_geometry(  # noqa: PLR0913
    lonlat: np.ndarray | None,
    stops_lonlat: np.ndarray,
    method: str,
    qa_status: str,
    structures: Callable[[np.ndarray], tuple[list, list]] | None = None,
    *,
    stations_xy: np.ndarray | None = None,
    tolerance_m: float = SIMPLIFY_M,
    densify_m: float = DENSIFY_M,
) -> BuiltShape:
    """The final geometry of a pattern from a candidate, or straight stop to stop without one.

    A candidate loses its zigzags and end spurs first (``spurs.remove_spurs``, the cut the
    evaluation measured), and each stop next to a reversal that remains stands on its turn.
    ``structures`` maps the simplified and densified line (EPSG:25832) to (tunnels, bridges)
    as projected arc ranges along it; their ends and the ends of their bake ranges become
    vertices. Straight lines get none.
    """
    stops_xy = to_xy(stops_lonlat[:, 0], stops_lonlat[:, 1])
    tunnels: list = []
    bridges: list = []
    spurs = spur_row(None)
    if lonlat is None:
        xy = clean(stops_xy)
        if len(xy) < 2:
            xy = np.vstack([stops_xy[0], stops_xy[0] + [0.0, 1.0]])
        essential = np.ones(len(xy), dtype=bool)
    else:
        source = clean(lonlat)
        despurred = remove_spurs(clean(to_xy(source[:, 0], source[:, 1])), stops_xy, stations_xy)
        spurs = spur_row(despurred)
        xy, essential = densify_marked(simplify(despurred.xy, tolerance_m), densify_m)
        if structures is not None:
            tunnels, bridges = structures(xy)
    spans = [*tunnels, *bridges]
    ranges = bake_ranges(spans, float(projected_arc(xy)[-1])) if spans else []
    ends = [v for span in spans for v in span] + [v for r in ranges for v in r[:2]]
    xy, essential = insert_marked(xy, essential, ends)
    cum = projected_arc(xy)
    out_lonlat = to_lonlat(xy)
    m = geodesic_arc(out_lonlat)
    along = forward_positions(LineString(xy), stops_xy) if lonlat is not None else None
    if along is None:
        stop_arcs = [float(v) for v in m[_stop_vertices(xy, stops_xy)]]
    else:
        vertices = hairpin_vertices(xy)
        taken = cum[vertices]
        extra = [
            a for a in u_turns(xy) if not len(taken) or np.min(np.abs(taken - a)) > U_TURN_MERGE_M
        ]
        turns = [float(m[i]) for i in vertices] + [float(v) for v in to_m(np.array(extra), cum, m)]
        stop_arcs = snap_stops(to_m(along, cum, m), turns)
    stop_arcs = list(np.maximum.accumulate(np.clip(stop_arcs, 0.0, m[-1])))
    return BuiltShape(
        lonlat=out_lonlat,
        m=m,
        stop_arc_m=[float(v) for v in stop_arcs],
        method=method,
        qa_status=qa_status,
        tunnel_spans=[tuple(to_m(s, cum, m)) for s in tunnels],
        bridge_spans=[tuple(to_m(s, cum, m)) for s in bridges],
        essential=essential,
        bake_ranges=[tuple(to_m(r, cum, m)) for r in ranges],
        spurs=spurs,
    )


def _stop_vertices(xy: np.ndarray, stops_xy: np.ndarray) -> np.ndarray:
    """Vertex index of each stop on a straight stop-to-stop line (repeats share a vertex)."""
    index = np.zeros(len(stops_xy), dtype=int)
    k = 0
    for i, stop in enumerate(stops_xy):
        while k + 1 < len(xy) and np.hypot(*(xy[k] - stop)) > 1e-6:
            k += 1
        index[i] = k
    return index


def rounded(lonlat: np.ndarray, z: np.ndarray, m: np.ndarray) -> np.ndarray:
    """(lon, lat, z, m) with lon and lat to 1e-7 degrees, z to cm and m to mm."""
    return np.column_stack([np.round(lonlat, 7), np.round(z, 2), np.round(m, 3)]).astype(np.float64)


def content_hash(coords: np.ndarray, shape: BuiltShape) -> str:
    """SHA-256 (64 lowercase hex) of the rounded vertices and everything else stored per shape."""
    digest = hashlib.sha256()
    digest.update(np.ascontiguousarray(coords, dtype="<f8").tobytes())
    digest.update(
        json.dumps(
            {
                "stops": [round(v, 3) for v in shape.stop_arc_m],
                "method": shape.method,
                "qa_status": shape.qa_status,
                "tunnels": [[round(a, 3), round(b, 3)] for a, b in shape.tunnel_spans],
                "bridges": [[round(a, 3), round(b, 3)] for a, b in shape.bridge_spans],
            },
            sort_keys=True,
        ).encode()
    )
    return digest.hexdigest()
