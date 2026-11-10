"""Shape quality metrics in projected metres."""

from enum import IntEnum

import numpy as np
import shapely
from shapely import LineString
from shapely.ops import substring


class WayClass(IntEnum):
    """Which trains an OSM rail way carries, from the route relations it belongs to."""

    NONE = 0
    UNTYPED = 1
    SBAHN = 2
    MAIN = 3
    SHARED = 4


def quantiles(values: np.ndarray) -> dict[str, float | int | None]:
    values = np.asarray(values, dtype=float)
    if values.size == 0:
        return {"n": 0, "p50": None, "p95": None, "max": None}
    return {
        "n": int(values.size),
        "p50": float(np.percentile(values, 50)),
        "p95": float(np.percentile(values, 95)),
        "max": float(values.max()),
    }


def stop_distances(line: LineString, stops_xy: np.ndarray) -> np.ndarray:
    return shapely.distance(line, shapely.points(stops_xy))


def sample_points(line: LineString, step: float) -> np.ndarray:
    """Points at the middle of each ``step`` long piece of the line.

    Interpolates with cumulative edge lengths in one pass; GEOS ``line_interpolate_point`` walks
    the line from its start for every point, which is quadratic on long dense shapes.
    """
    coords = shapely.get_coordinates(line)
    edges = np.hypot(*np.diff(coords, axis=0).T)
    cumulative = np.concatenate([[0.0], np.cumsum(edges)])
    length = cumulative[-1]
    count = max(1, int(length // step))
    offsets = (np.arange(count) + 0.5) * (length / count)
    edge = np.clip(np.searchsorted(cumulative, offsets, side="right") - 1, 0, len(edges) - 1)
    span = np.where(edges[edge] > 0, edges[edge], 1.0)
    fraction = ((offsets - cumulative[edge]) / span)[:, None]
    return coords[edge] + fraction * (coords[edge + 1] - coords[edge])


def long_edges(line: LineString, min_edge_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Midpoints and lengths of the line's single edges of at least ``min_edge_m``.

    A long edge is a beeline only when it also leaves the track; a simplified shape keeps long
    edges on straight track.
    """
    coords = shapely.get_coordinates(line)
    edges = np.hypot(*np.diff(coords, axis=0).T)
    long = edges >= min_edge_m
    midpoints = (coords[:-1][long] + coords[1:][long]) / 2
    return midpoints, edges[long]


def forward_positions(
    line: LineString, points: np.ndarray, *, factor: float = 3.0, extra: float = 2000.0
) -> np.ndarray:
    """Arc positions of consecutive ``points`` on ``line``, each searched only ahead of the last.

    The search window for a point is ``factor`` times its straight distance from the previous
    point plus ``extra`` (in the line's units), and five times ``extra`` from the line start for
    the first point, so a ring or a run that passes the same place twice is followed lap by lap
    instead of jumping to the nearest pass.
    """
    positions = np.zeros(len(points))
    start = 0.0
    for k, point in enumerate(points):
        if k == 0:
            end = min(line.length, 5 * extra)
        else:
            end = min(
                line.length, start + factor * float(np.hypot(*(point - points[k - 1]))) + extra
            )
        window = substring(line, start, end)
        offset = window.project(shapely.Point(point)) if window.length > 0 else 0.0
        start += offset
        positions[k] = start
    return positions


def long_runs(mask: np.ndarray, piece: float, min_m: float) -> list[tuple[int, int]]:
    """Index ranges ``[start, end)`` of consecutive true samples at least ``min_m`` long."""
    padded = np.concatenate([[False], np.asarray(mask, dtype=bool), [False]])
    edges = np.flatnonzero(np.diff(padded.astype(np.int8)))
    starts, ends = edges[0::2], edges[1::2]
    return [(int(s), int(e)) for s, e in zip(starts, ends, strict=True) if (e - s) * piece >= min_m]


def stop_arc_distances(line: LineString, stops_xy: np.ndarray, along: np.ndarray) -> np.ndarray:
    """Distance from each stop to the shape point at its forward arc position (ADR-0001)."""
    at = shapely.get_coordinates(shapely.line_interpolate_point(line, along))
    return np.hypot(*(at - stops_xy).T)


def detour_ratio(shape_m: float, rail_m: float | None) -> float | None:
    if rail_m is None or rail_m <= 0:
        return None
    return shape_m / rail_m


def off_relation_mask(
    nearest: np.ndarray, other_m: np.ndarray, *, is_sbahn: bool, parallel_m: float
) -> np.ndarray:
    """Samples on a track that only the other kind of route uses, own kind within ``parallel_m``.

    "Off-relation" means the OSM route relations disagree with the train's kind; it is not proof
    of a wrong track (relations can be incomplete, and pfaedle matches on the same relations).

    ``nearest`` is the class of the nearest rail way of each point, ``other_m`` the distance
    to the nearest way the train should use (S-Bahn or shared for an S-Bahn, main or shared
    for any other train).
    """
    wrong_class = WayClass.MAIN if is_sbahn else WayClass.SBAHN
    return (np.asarray(nearest) == wrong_class) & (np.asarray(other_m) <= parallel_m)
