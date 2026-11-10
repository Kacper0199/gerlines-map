"""Legs of a pfaedle shape replaced from a second pfaedle run with strict turns.

pfaedle charges a full turn ``routing_full_turn_penalty`` seconds (180 in its rail profile), so a
hop between two stops may turn back at a junction where no train does: ICE 50 from Frankfurt
Flughafen to Wiesbaden Hbf turns at the Breckenheim junction, where the curve it would need is
not built (D-051). Raising the penalty for the whole run is no fix: pfaedle charges the same
penalty for the reversal at a stop between two hops, and trains then loop round instead of
reversing at Frankfurt Hbf. So a second run with a high penalty
(``config/pfaedle-strict-turns.cfg``) gives legs only: a pattern whose default shape keeps a
turn fault after ``spurs.remove_spurs`` gets each leg that holds a U-turn farther than
``REVERSAL_STOP_M`` from every stop of the trip (and ``STATION_M`` from every curated station)
from the second run. Legs are cut at pfaedle's own ``shape_dist_traveled`` of the stops; the
default and the second shape must meet within ``SPLICE_JOIN_M`` at each inner joint. The splice
is kept only when it leaves no turn fault, fewer U-turns than the default shape had and no
more reversals at stops after the spur cut; legs are taken only where a turn is still a fault
after the spur cut.
"""

import csv
import itertools
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely

from gerlines_rail_graph.patterns import Pattern
from gerlines_rail_graph.project import to_xy
from gerlines_rail_graph.shape import clean
from gerlines_rail_graph.spurs import (
    REVERSAL_STOP_M,
    STATION_M,
    arc,
    remove_spurs,
    spur_row,
    u_turns,
)

SPLICE_JOIN_M = 25.0
SPLICED_FILE = "pfaedle-spliced.json"


@dataclass(frozen=True, slots=True)
class TripShape:
    """A pfaedle trip shape: (lon, lat) rows, ``shape_dist_traveled`` per row and per stop."""

    lonlat: np.ndarray
    dist: np.ndarray
    stop_dist: np.ndarray


def _shape_ids(trips_txt: Path, wanted: set[str]) -> dict[str, str]:
    with trips_txt.open(encoding="utf-8-sig", newline="") as text:
        return {
            row["trip_id"]: row["shape_id"]
            for row in csv.DictReader(text)
            if row["trip_id"] in wanted and row.get("shape_id")
        }


def _shape_rows(shapes_txt: Path, wanted: set[str]) -> dict[str, np.ndarray]:
    found: dict[str, list[tuple[int, float, float, float]]] = {}
    missing: set[str] = set()
    with shapes_txt.open(encoding="utf-8-sig", newline="") as text:
        reader = csv.reader(text)
        header = next(reader)
        sid, seq = header.index("shape_id"), header.index("shape_pt_sequence")
        lat, lon = header.index("shape_pt_lat"), header.index("shape_pt_lon")
        dist = header.index("shape_dist_traveled")
        for row in reader:
            if row[sid] not in wanted:
                continue
            if not row[dist]:
                missing.add(row[sid])
                continue
            found.setdefault(row[sid], []).append(
                (int(row[seq]), float(row[lon]), float(row[lat]), float(row[dist]))
            )
    return {
        k: np.array(sorted(v), dtype=float)[:, 1:] for k, v in found.items() if k not in missing
    }


def _stop_rows(stop_times_txt: Path, wanted: set[str]) -> dict[str, np.ndarray | None]:
    found: dict[str, list[tuple[int, float]]] = {}
    missing: set[str] = set()
    with stop_times_txt.open(encoding="utf-8-sig", newline="") as text:
        reader = csv.reader(text)
        header = next(reader)
        tid, seq = header.index("trip_id"), header.index("stop_sequence")
        dist = header.index("shape_dist_traveled")
        for row in reader:
            if row[tid] not in wanted:
                continue
            if not row[dist]:
                missing.add(row[tid])
                continue
            found.setdefault(row[tid], []).append((int(row[seq]), float(row[dist])))
    return {
        k: None if k in missing else np.array([d for _, d in sorted(v)]) for k, v in found.items()
    }


def read_trip_shapes(feed_dir: Path, trips: Iterable[str]) -> dict[str, TripShape]:
    """Shape and stop distances of the wanted trips from a pfaedle output feed; a trip whose
    shape or any stop lacks ``shape_dist_traveled`` is left out."""
    wanted = set(trips)
    shape_of = _shape_ids(feed_dir / "trips.txt", wanted)
    shapes = _shape_rows(feed_dir / "shapes.txt", set(shape_of.values()))
    stops = _stop_rows(feed_dir / "stop_times.txt", set(shape_of))
    out = {}
    for trip, shape_id in shape_of.items():
        rows, stop_dist = shapes.get(shape_id), stops.get(trip)
        if rows is None or len(rows) < 2 or stop_dist is None or len(stop_dist) < 2:
            continue
        out[trip] = TripShape(rows[:, :2], rows[:, 2], stop_dist)
    return out


def _xy(lonlat: np.ndarray) -> np.ndarray:
    return to_xy(lonlat[:, 0], lonlat[:, 1])


def _near(point: np.ndarray, places_xy: np.ndarray | None, within_m: float) -> bool:
    if places_xy is None or not len(places_xy):
        return False
    return float(np.min(np.hypot(*(np.asarray(places_xy) - point).T))) <= within_m


def turn_legs(shape: TripShape, stations_xy: np.ndarray | None = None) -> list[int]:
    """Legs (index of the stop they start at) holding a U-turn farther than ``REVERSAL_STOP_M``
    from every stop and ``STATION_M`` from every curated station; turns before the first or
    after the last stop belong to no leg (``remove_spurs`` cuts end spurs)."""
    xy = _xy(shape.lonlat)
    cum = arc(xy)
    legs: set[int] = set()
    last = len(shape.stop_dist) - 2
    for s in u_turns(xy):
        d = float(np.interp(s, cum, shape.dist))
        if float(np.min(np.abs(shape.stop_dist - d))) <= REVERSAL_STOP_M:
            continue
        point = np.array([np.interp(s, cum, xy[:, 0]), np.interp(s, cum, xy[:, 1])])
        if _near(point, stations_xy, STATION_M):
            continue
        leg = int(np.searchsorted(shape.stop_dist, d, side="right")) - 1
        if 0 <= leg <= last:
            legs.add(leg)
    return sorted(legs)


def _point(shape: TripShape, d: float) -> np.ndarray:
    return np.array(
        [np.interp(d, shape.dist, shape.lonlat[:, 0]), np.interp(d, shape.dist, shape.lonlat[:, 1])]
    )


def _piece(shape: TripShape, d0: float, d1: float) -> np.ndarray:
    inner = shape.lonlat[(shape.dist > d0) & (shape.dist < d1)]
    return np.vstack([_point(shape, d0), inner, _point(shape, d1)])


def _gap_m(a: np.ndarray, b: np.ndarray) -> float:
    xy = to_xy(np.array([a[0], b[0]]), np.array([a[1], b[1]]))
    return float(np.hypot(*(xy[1] - xy[0])))


def _forward_joint(
    shape: TripShape, point: np.ndarray, d: float, ahead: bool, window: float
) -> float:
    """``shape_dist_traveled`` of the point of ``shape`` nearest ``point``, looked for only ahead
    of ``d`` (or only behind it) within ``window``, so the joined line never steps back."""
    lo, hi = (d, d + window) if ahead else (d - window, d)
    lo, hi = max(lo, float(shape.dist[0])), min(hi, float(shape.dist[-1]))
    if hi - lo <= 0:
        return d
    piece = _piece(shape, lo, hi)
    dist = np.concatenate([[lo], shape.dist[(shape.dist > lo) & (shape.dist < hi)], [hi]])
    xy = _xy(piece)
    cum = arc(xy)
    target = _xy(point[None, :])[0]
    s = float(shapely.line_locate_point(shapely.linestrings(xy), shapely.points(target)))
    return float(np.interp(s, cum, dist))


def _bridge_short_gaps(default: TripShape, chosen: list[int], shortest_m: float) -> list[int]:
    """``chosen`` plus every run of unchosen legs between two chosen ones whose default length is
    under ``shortest_m``."""
    out = set(chosen)
    for a, b in itertools.pairwise(chosen):
        if b - a > 1 and default.stop_dist[b] - default.stop_dist[a + 1] < shortest_m:
            out.update(range(a + 1, b))
    return sorted(out)


def splice_legs(
    default: TripShape, alternate: TripShape, legs: Sequence[int], join_m: float = SPLICE_JOIN_M
) -> np.ndarray | None:
    """The default shape with the given legs from the alternate, or None when the two have
    different stop counts or an inner joint is farther apart than ``join_m``. A first or last
    leg runs from or to the alternate's own end. At an inner joint the default piece ends (or
    resumes) at the point nearest the alternate's stop point, looked for only behind (or ahead
    of) its own stop point, so a stop point placed a few metres differently in the two runs
    makes a sideways step, never a step back. Default legs between two chosen ones
    that are together shorter than both joint windows are taken from the alternate as well, so
    the two joints never overlap."""
    n = len(default.stop_dist)
    chosen = sorted(set(legs))
    if not chosen or len(alternate.stop_dist) != n or chosen[0] < 0 or chosen[-1] > n - 2:
        return None
    window = 2.0 * join_m
    chosen = _bridge_short_gaps(default, chosen, 2.0 * window)
    for k in chosen:
        for j in (k, k + 1):
            inner = 0 < j < n - 1
            neighbour = j - 1 if j == k else j
            if inner and neighbour not in chosen:
                gap = _gap_m(
                    _point(default, default.stop_dist[j]), _point(alternate, alternate.stop_dist[j])
                )
                if gap > join_m:
                    return None
    pieces = []
    at = float(default.dist[0])
    for k in chosen:
        start = float(alternate.stop_dist[k]) if k > 0 else float(alternate.dist[0])
        end = float(alternate.stop_dist[k + 1]) if k + 1 < n - 1 else float(alternate.dist[-1])
        if k > 0 and k - 1 not in chosen:
            stop = float(default.stop_dist[k])
            upto = _forward_joint(default, _point(alternate, start), stop, False, window)
            pieces.append(_piece(default, at, max(at, upto)))
        pieces.append(_piece(alternate, start, end))
        stop = float(default.stop_dist[k + 1])
        at = _forward_joint(default, _point(alternate, end), stop, True, window)
    if chosen[-1] + 1 < n - 1:
        pieces.append(_piece(default, at, float(default.dist[-1])))
    return clean(np.vstack(pieces))


def _turn_fault(lonlat: np.ndarray, stops_xy: np.ndarray, stations_xy: np.ndarray | None) -> int:
    row = spur_row(remove_spurs(clean(_xy(lonlat)), stops_xy, stations_xy))
    return row["u_turns_off_stop"] + row["hairpins"]


def fault_legs(
    shape: TripShape, stops_xy: np.ndarray, stations_xy: np.ndarray | None = None
) -> list[int]:
    """Legs holding a turn that is still a fault after ``remove_spurs``: a turn the
    spur cut removes anyway needs no leg from the other run."""
    raw = _xy(shape.lonlat)
    despurred = remove_spurs(clean(raw), stops_xy, stations_xy)
    if not despurred.hairpins:
        return []
    cut = despurred.xy
    points = np.column_stack([np.interp(despurred.hairpins, arc(cut), cut[:, i]) for i in (0, 1)])
    line, cum = shapely.linestrings(raw), arc(raw)
    last = len(shape.stop_dist) - 2
    legs: set[int] = set()
    for point in points:
        s = float(shapely.line_locate_point(line, shapely.points(point)))
        d = float(np.interp(s, cum, shape.dist))
        leg = int(np.searchsorted(shape.stop_dist, d, side="right")) - 1
        if 0 <= leg <= last:
            legs.add(leg)
    return sorted(legs)


def adds_reversal(
    result: np.ndarray,
    default: np.ndarray,
    stops_xy: np.ndarray,
    stations_xy: np.ndarray | None = None,
) -> bool:
    """The spliced shape keeps more reversals at stops than the default after the spur cut: a
    leg from the other run turned at a stop the train passes through."""

    def reversals(lonlat: np.ndarray) -> int:
        return spur_row(remove_spurs(clean(_xy(lonlat)), stops_xy, stations_xy))["reversals"]

    return reversals(result) > reversals(default)


def _far_u_turn(lonlat: np.ndarray, stops_xy: np.ndarray) -> bool:
    """Cheap first test: a U-turn farther than ``REVERSAL_STOP_M`` in a straight line from every
    stop (it is then at least that far along the shape too)."""
    xy = _xy(lonlat)
    cum = arc(xy)
    for s in u_turns(xy):
        point = np.array([np.interp(s, cum, xy[:, 0]), np.interp(s, cum, xy[:, 1])])
        if not _near(point, stops_xy, REVERSAL_STOP_M):
            return True
    return False


def candidates_to_splice(
    patterns: Sequence[Pattern],
    shapes: Mapping[str, np.ndarray | None],
    stations_xy: np.ndarray | None = None,
) -> list[Pattern]:
    """Patterns whose default shape keeps a turn fault after ``remove_spurs``."""
    out = []
    for pattern in patterns:
        lonlat = shapes.get(pattern.pattern_id)
        if lonlat is None or len(lonlat) < 3:
            continue
        stop_lonlat = pattern.stop_lonlat()
        stops_xy = to_xy(stop_lonlat[:, 0], stop_lonlat[:, 1])
        if _far_u_turn(lonlat, stops_xy) and _turn_fault(lonlat, stops_xy, stations_xy):
            out.append(pattern)
    return out


def splice_turn_legs(
    patterns: Sequence[Pattern],
    shapes: Mapping[str, np.ndarray | None],
    default: Mapping[str, TripShape],
    alternate: Mapping[str, TripShape],
    stations_xy: np.ndarray | None = None,
) -> tuple[dict[str, np.ndarray | None], dict[str, list[int]], dict]:
    """The shapes with turning legs replaced where that clears every turn fault, the legs
    replaced per pattern id, and a summary."""
    out = dict(shapes)
    spliced: dict[str, list[int]] = {}
    faulty = candidates_to_splice(patterns, shapes, stations_xy)
    refused = 0
    for pattern in faulty:
        mine, other = default.get(pattern.rep_trip), alternate.get(pattern.rep_trip)
        if mine is None or other is None:
            refused += 1
            continue
        stop_lonlat = pattern.stop_lonlat()
        stops_xy = to_xy(stop_lonlat[:, 0], stop_lonlat[:, 1])
        legs = fault_legs(mine, stops_xy, stations_xy)
        if not legs or set(legs) & set(turn_legs(other, stations_xy)):
            refused += 1
            continue
        result = splice_legs(mine, other, legs)
        if (
            result is None
            or _turn_fault(result, stops_xy, stations_xy)
            or len(u_turns(_xy(result))) >= len(u_turns(_xy(mine.lonlat)))
            or adds_reversal(result, mine.lonlat, stops_xy, stations_xy)
        ):
            refused += 1
            continue
        out[pattern.pattern_id] = result
        spliced[pattern.pattern_id] = legs
    return (
        out,
        spliced,
        {
            "with_turn_fault": len(faulty),
            "spliced_patterns": len(spliced),
            "spliced_legs": sum(len(v) for v in spliced.values()),
            "refused": refused,
        },
    )
