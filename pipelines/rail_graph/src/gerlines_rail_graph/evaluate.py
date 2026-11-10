"""Per-trip shape metrics against OSM rail, and their aggregation per group and method."""

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field

import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely import LineString, Polygon, STRtree

from gerlines_rail_graph.graph import RailGraph
from gerlines_rail_graph.metrics import (
    WayClass,
    detour_ratio,
    forward_positions,
    long_edges,
    long_runs,
    off_relation_mask,
    quantiles,
    sample_points,
    stop_arc_distances,
)

SAMPLE_STEP_M = 10.0
ON_RAIL_M = 10.0
PARALLEL_M = 30.0
STRAIGHT_EDGE_M = 1000.0
STOP_LIMIT_M = 80.0
LEG_DETOUR_LIMIT = 1.3
LEG_MIN_M = 2000.0
LEG_EXTRA_LIMIT_M = 300.0
LEG_EXTRA_SHARE = 0.05
OFF_RELATION_RUN_M = 500.0
LOW_SLACK_M = 200.0
STOP_CLEARANCE_M = 300.0


@dataclass(frozen=True, slots=True)
class RailIndex:
    """Track geometry, class per track, the S-Bahn and main sub-indexes and the routing graph."""

    tree: STRtree
    classes: np.ndarray
    sbahn_tree: STRtree
    main_tree: STRtree
    graph: RailGraph
    coverage: Polygon
    piece_way: np.ndarray | None = None

    @classmethod
    def build(
        cls,
        lines: Sequence[LineString],
        classes: np.ndarray,
        graph: RailGraph,
        coverage: Polygon,
        piece_way: np.ndarray | None = None,
    ) -> "RailIndex":
        lines_arr = np.asarray(lines, dtype=object)
        own_sbahn = np.isin(classes, [WayClass.SBAHN, WayClass.SHARED])
        own_main = np.isin(classes, [WayClass.MAIN, WayClass.SHARED])
        return cls(
            tree=STRtree(lines_arr),
            classes=np.asarray(classes),
            sbahn_tree=STRtree(lines_arr[own_sbahn]),
            main_tree=STRtree(lines_arr[own_main]),
            graph=graph,
            coverage=coverage,
            piece_way=piece_way,
        )


def _nearest(tree: STRtree, points: np.ndarray, max_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Tree index and distance of the nearest geometry within ``max_m``, else -1 and inf."""
    index = np.full(len(points), -1, dtype=np.int64)
    distance = np.full(len(points), np.inf)
    if len(points) == 0:
        return index, distance
    (src, dst), dist = tree.query_nearest(
        shapely.points(points), max_distance=max_m, return_distance=True, all_matches=False
    )
    index[src] = dst
    distance[src] = dist
    return index, distance


@dataclass(slots=True)
class TripMetrics:
    has_shape: bool
    stop_m: list[float] = field(default_factory=list)
    covered_m: float = 0.0
    on_rail_m: float = 0.0
    off_relation_m: float = 0.0
    off_relation_runs: list[tuple[float, float, float]] = field(default_factory=list)
    beeline_m: float = 0.0
    length_m: float = 0.0
    shape_legs_m: float = 0.0
    rail_legs_m: float = 0.0
    rail_legs_low_m: float = 0.0
    legs: int = 0
    legs_routed: int = 0
    legs_backwards: int = 0
    legs_over_limit: int = 0
    legs_extra_over_limit: int = 0
    worst_leg: float | None = None
    worst_extra_m: float | None = None
    stops_outside: int = 0

    @property
    def detour(self) -> float | None:
        return detour_ratio(self.shape_legs_m, self.rail_legs_m if self.legs_routed else None)

    @property
    def detour_low(self) -> float | None:
        """Shape length against the lower bound of any real route (reversals at curated stations,
        every track near the stops)."""
        return detour_ratio(self.shape_legs_m, self.rail_legs_low_m if self.legs_routed else None)

    @property
    def max_stop_m(self) -> float | None:
        return max(self.stop_m) if self.stop_m else None

    @property
    def on_rail(self) -> float | None:
        return self.on_rail_m / self.covered_m if self.covered_m else None

    @property
    def longest_off_relation_m(self) -> float:
        return max((run[2] for run in self.off_relation_runs), default=0.0)


def evaluate_trip(  # noqa: PLR0913
    stops_xy: np.ndarray,
    shape_xy: np.ndarray | None,
    index: RailIndex,
    *,
    is_sbahn: bool,
    area: Polygon | None = None,
    legs: tuple[dict, Sequence[str]] | None = None,
) -> TripMetrics:
    """Metrics of one trip shape; with ``area`` only the stops, samples and legs inside it count.

    ``legs`` is a rail length cache shared across trips and methods, keyed by stop id pairs, with
    this trip's stop ids; each value is the pair from ``reference_lengths``.
    """
    if shape_xy is None or len(shape_xy) < 2:
        return TripMetrics(has_shape=False)
    line = LineString(shape_xy)
    if line.length == 0:
        return TripMetrics(has_shape=False)
    region = index.coverage if area is None else area.intersection(index.coverage)
    along = forward_positions(line, stops_xy)
    distances = stop_arc_distances(line, stops_xy, along)
    if area is not None:
        distances = distances[shapely.contains_xy(area, stops_xy[:, 0], stops_xy[:, 1])]
    metrics = TripMetrics(
        has_shape=True, stop_m=[float(v) for v in distances], length_m=float(line.length)
    )
    midpoints, lengths = long_edges(line, STRAIGHT_EDGE_M)
    if len(lengths):
        inside_mid = shapely.contains_xy(region, midpoints[:, 0], midpoints[:, 1])
        _, mid_m = _nearest(index.tree, midpoints[inside_mid], ON_RAIL_M)
        metrics.beeline_m = float(lengths[inside_mid][~np.isfinite(mid_m)].sum())
    _measure_track(metrics, line, stops_xy, index, region, is_sbahn=is_sbahn)

    def rail_length(j: int) -> tuple[float | None, float | None]:
        if legs is None:
            return reference_lengths(index.graph, stops_xy[j], stops_xy[j + 1])
        cache, keys = legs
        key = (keys[j], keys[j + 1])
        if key not in cache:
            cache[key] = reference_lengths(index.graph, stops_xy[j], stops_xy[j + 1])
        return tuple(cache[key])

    _measure_legs(metrics, along, stops_xy, region, rail_length)
    metrics.stops_outside = int(
        (~shapely.contains_xy(region, stops_xy[:, 0], stops_xy[:, 1])).sum()
    )
    return metrics


def _measure_track(  # noqa: PLR0913
    metrics: TripMetrics,
    line: LineString,
    stops_xy: np.ndarray,
    index: RailIndex,
    region: Polygon,
    *,
    is_sbahn: bool,
) -> None:
    """On-rail share and continuous off-relation runs away from stops, inside ``region``."""
    points = sample_points(line, SAMPLE_STEP_M)
    piece = line.length / len(points)
    inside = shapely.contains_xy(region, points[:, 0], points[:, 1])
    metrics.covered_m = float(inside.sum() * piece)
    nearest, near_m = _nearest(index.tree, points[inside], ON_RAIL_M)
    metrics.on_rail_m = float(np.isfinite(near_m).sum() * piece)
    near_class = np.where(nearest >= 0, index.classes[np.maximum(nearest, 0)], WayClass.NONE)
    wrong = near_class == (WayClass.MAIN if is_sbahn else WayClass.SBAHN)
    own_m = np.full(len(near_class), np.inf)
    if wrong.any():
        own_tree = index.sbahn_tree if is_sbahn else index.main_tree
        _, own_m[wrong] = _nearest(own_tree, points[inside][wrong], PARALLEL_M)
    off = np.zeros(len(points), dtype=bool)
    off[inside] = off_relation_mask(near_class, own_m, is_sbahn=is_sbahn, parallel_m=PARALLEL_M)
    if off.any():
        stop_m, _ = cKDTree(stops_xy).query(points[off])
        off[np.flatnonzero(off)[stop_m < STOP_CLEARANCE_M]] = False
    for start, end in long_runs(off, piece, OFF_RELATION_RUN_M):
        middle = points[(start + end) // 2]
        metrics.off_relation_runs.append(
            (float(middle[0]), float(middle[1]), float((end - start) * piece))
        )
    metrics.off_relation_m = float(sum(run[2] for run in metrics.off_relation_runs))


def reference_lengths(
    graph: RailGraph, a: np.ndarray, b: np.ndarray
) -> tuple[float | None, float | None]:
    """The strict reference (directed, no reversal between the stops, tracks within the snap
    slack) and the lower bound of any real route (reversals only at the leg's own stops and at
    curated reversal stations, every track within the snap distance) between two stops. A leg
    counts only where the strict path exists; the lower bound then only relaxes the detour
    floor."""
    a_xy, b_xy = (float(a[0]), float(a[1])), (float(b[0]), float(b[1]))
    strict = graph.path_length(a_xy, b_xy)
    low = graph.path_length(a_xy, b_xy, slack_m=LOW_SLACK_M, reversals=True)
    return strict, low


def _measure_legs(
    metrics: TripMetrics,
    along: np.ndarray,
    stops_xy: np.ndarray,
    region: Polygon,
    rail_length: Callable[[int], tuple[float | None, float | None]],
) -> None:
    inside = shapely.contains_xy(region, stops_xy[:, 0], stops_xy[:, 1])
    for j in range(len(stops_xy) - 1):
        if not (inside[j] and inside[j + 1]):
            continue
        metrics.legs += 1
        shape_leg = float(along[j + 1] - along[j])
        if shape_leg <= 0:
            metrics.legs_backwards += 1
            continue
        rail, low = rail_length(j)
        if rail is None or rail <= 0:
            continue
        metrics.legs_routed += 1
        metrics.shape_legs_m += shape_leg
        metrics.rail_legs_m += rail
        metrics.rail_legs_low_m += rail if low is None else min(rail, low)
        extra = shape_leg - rail
        metrics.worst_extra_m = (
            extra if metrics.worst_extra_m is None else max(metrics.worst_extra_m, extra)
        )
        if extra > LEG_EXTRA_LIMIT_M + LEG_EXTRA_SHARE * rail:
            metrics.legs_extra_over_limit += 1
        if rail < LEG_MIN_M:
            continue
        ratio = shape_leg / rail
        metrics.worst_leg = ratio if metrics.worst_leg is None else max(metrics.worst_leg, ratio)
        if ratio > LEG_DETOUR_LIMIT:
            metrics.legs_over_limit += 1


def as_row(metrics: TripMetrics) -> dict:
    """The per-trip row the gate reads; off-relation runs as (x, y, length) in EPSG:25832."""
    return {
        "has_shape": metrics.has_shape,
        "max_stop_m": metrics.max_stop_m,
        "on_rail": metrics.on_rail,
        "detour": metrics.detour,
        "detour_low": metrics.detour_low,
        "beeline_m": metrics.beeline_m,
        "worst_leg": metrics.worst_leg,
        "worst_extra_m": metrics.worst_extra_m,
        "legs": metrics.legs,
        "legs_routed": metrics.legs_routed,
        "legs_backwards": metrics.legs_backwards,
        "legs_over_1_3": metrics.legs_over_limit,
        "legs_extra_over_300m": metrics.legs_extra_over_limit,
        "off_relation_m": metrics.off_relation_m,
        "off_relation_runs": [list(run) for run in metrics.off_relation_runs],
        "length_m": metrics.length_m,
        "covered_m": metrics.covered_m,
        "stops_outside": metrics.stops_outside,
        "stop_m": [round(v, 1) for v in metrics.stop_m],
    }


def aggregate(results: Iterable[TripMetrics], weights: Iterable[float] | None = None) -> dict:
    """Pooled figures of a group; ``weights`` (train-km per trip) weight the shares and rates."""
    results = list(results)
    weights = [1.0] * len(results) if weights is None else list(weights)
    shaped = [(r, w) for r, w in zip(results, weights, strict=True) if r.has_shape]
    stops = np.array([d for r, _ in shaped for d in r.stop_m])
    covered = sum(r.covered_m for r, _ in shaped)
    detours = np.array([r.detour for r, _ in shaped if r.detour is not None])
    worst = np.array([r.worst_leg for r, _ in shaped if r.worst_leg is not None])
    extra = np.array([r.worst_extra_m for r, _ in shaped if r.worst_extra_m is not None])
    total_w = sum(weights) or 1.0

    def share(test: Callable[[TripMetrics], bool]) -> float:
        return sum(w for r, w in shaped if test(r)) / total_w

    return {
        "trips": len(results),
        "train_km": sum(weights),
        "missing_shape": len(results) - len(shaped),
        "stop_m": quantiles(stops),
        "trips_stop_over_80m": sum(1 for r, _ in shaped if (r.max_stop_m or 0) > STOP_LIMIT_M),
        "on_rail_share": (sum(r.on_rail_m for r, _ in shaped) / covered) if covered else None,
        "covered_km": covered / 1000,
        "beeline_share": (sum(r.beeline_m for r, _ in shaped) / covered) if covered else None,
        "trips_beeline_over_1km": sum(1 for r, _ in shaped if r.beeline_m > 1000),
        "detour": quantiles(detours),
        "worst_leg_detour": quantiles(worst),
        "worst_leg_extra_m": quantiles(extra),
        "legs": sum(r.legs for r, _ in shaped),
        "legs_routed": sum(r.legs_routed for r, _ in shaped),
        "legs_over_1_3": sum(r.legs_over_limit for r, _ in shaped),
        "legs_extra_over_300m": sum(r.legs_extra_over_limit for r, _ in shaped),
        "legs_backwards": sum(r.legs_backwards for r, _ in shaped),
        "off_relation_km": sum(r.off_relation_m for r, _ in shaped) / 1000,
        "off_relation_runs": sum(len(r.off_relation_runs) for r, _ in shaped),
        "trips_off_relation_run": sum(1 for r, _ in shaped if r.off_relation_runs),
        "train_km_share_off_relation_run": share(lambda r: bool(r.off_relation_runs)),
        "train_km_share_stop_over_80m": share(lambda r: (r.max_stop_m or 0) > STOP_LIMIT_M),
    }
