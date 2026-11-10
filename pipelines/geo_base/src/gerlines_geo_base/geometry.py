"""Pure geometry steps: coverage simplification, rounding, masks, label points and bounds."""

import math
from collections.abc import Sequence

import numpy as np
import shapely
from shapely import MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import polylabel

WEB_MERCATOR_MAX_LATITUDE = 85.051129
WORLD = shapely.box(-180.0, -WEB_MERCATOR_MAX_LATITUDE, 180.0, WEB_MERCATOR_MAX_LATITUDE)


def polygon_parts(geometry: BaseGeometry) -> list[Polygon]:
    return [part for part in shapely.get_parts(geometry) if isinstance(part, Polygon)]


def drop_small_parts(geometry: BaseGeometry, min_area: float) -> MultiPolygon:
    """Keep the parts of at least ``min_area``; keep the largest part when none is that big."""
    parts = polygon_parts(geometry)
    kept = [part for part in parts if part.area >= min_area]
    return MultiPolygon(kept or [max(parts, key=lambda part: part.area)])


def absorb_small_parts(
    geometries: Sequence[BaseGeometry], min_area: float, keep: Sequence[Point] = ()
) -> list[BaseGeometry]:
    """Remove parts smaller than ``min_area`` from a coverage without opening gaps.

    A part holding a point of ``keep`` stays whatever its size. A small part that shares an
    edge with another polygon (an enclave, a sliver across a river) joins the polygon it
    shares the longest edge with; one that shares no edge (an islet, a tiny exclave abroad)
    is dropped.
    """
    received: list[list[Polygon]] = [[] for _ in geometries]
    kept: list[list[Polygon]] = []
    for index, geometry in enumerate(geometries):
        parts = polygon_parts(geometry)
        largest = max(parts, key=lambda part: part.area)
        own = []
        for part in parts:
            if part.area >= min_area or part is largest or _holds_any(part, keep):
                own.append(part)
                continue
            target = _longest_shared_edge(part, geometries, index)
            if target is not None:
                received[target].append(part)
        kept.append(own)
    return [
        shapely.coverage_union_all(np.array(own + extra, dtype=object))
        for own, extra in zip(kept, received, strict=True)
    ]


def _holds_any(part: Polygon, points: Sequence[Point]) -> bool:
    return any(part.contains(point) for point in points)


def _longest_shared_edge(
    part: Polygon, geometries: Sequence[BaseGeometry], index: int
) -> int | None:
    best: tuple[float, int] | None = None
    for other, geometry in enumerate(geometries):
        if other == index or not part.intersects(geometry):
            continue
        shared = shapely.intersection(part.boundary, geometry.boundary).length
        if shared > 0 and (best is None or shared > best[0]):
            best = (shared, other)
    return None if best is None else best[1]


def simplify_coverage(
    geometries: Sequence[BaseGeometry],
    tolerance: float,
    min_part_area: float,
    keep: Sequence[Point] = (),
) -> list[BaseGeometry]:
    """Simplify polygons that share edges so those edges stay identical: no gaps, no slivers."""
    trimmed = np.array(absorb_small_parts(geometries, min_part_area, keep), dtype=object)
    return list(shapely.coverage_simplify(trimmed, tolerance))


def round_coordinates(geometry: BaseGeometry, decimals: int) -> BaseGeometry:
    """Round every vertex; equal vertices stay equal, so shared edges stay shared."""
    rounded = shapely.transform(geometry, lambda xy: np.round(xy, decimals))
    return shapely.remove_repeated_points(rounded, 0.0)


def is_rfc7946_oriented(geometry: BaseGeometry) -> bool:
    """Exterior rings counterclockwise and holes clockwise (RFC 7946, section 3.1.6)."""
    return all(
        part.exterior.is_ccw and not any(ring.is_ccw for ring in part.interiors)
        for part in polygon_parts(geometry)
    )


def world_minus(geometry: BaseGeometry) -> BaseGeometry:
    """The Web Mercator world with ``geometry`` cut out, oriented for GeoJSON."""
    return shapely.orient_polygons(shapely.difference(WORLD, geometry), exterior_cw=False)


def label_point(geometry: BaseGeometry, precision: float) -> Point:
    """Pole of inaccessibility of the largest part: inside the polygon, away from its holes."""
    largest = max(polygon_parts(geometry), key=lambda part: part.area)
    return polylabel(largest, tolerance=precision)


def core_parts(geometry: BaseGeometry, max_gap: float, min_share: float) -> MultiPolygon:
    """Parts near the largest part or holding at least ``min_share`` of the area.

    Fitting the camera to these keeps a far islet (Hamburg's Neuwerk) from shrinking the view.
    """
    parts = polygon_parts(geometry)
    largest = max(parts, key=lambda part: part.area)
    total = sum(part.area for part in parts)
    return MultiPolygon(
        [
            part
            for part in parts
            if part.distance(largest) <= max_gap or part.area >= min_share * total
        ]
    )


def outward_bbox(geometry: BaseGeometry, decimals: int) -> tuple[float, float, float, float]:
    """Bounds rounded outwards, so the rounded box still contains ``geometry``."""
    west, south, east, north = geometry.bounds
    scale = 10**decimals

    def down(value: float) -> float:
        return round(math.floor(value * scale) / scale, decimals)

    def up(value: float) -> float:
        return round(math.ceil(value * scale) / scale, decimals)

    return down(west), down(south), up(east), up(north)
