"""Neighbour countries with label points near Germany, and rail lines that cross the border.

All distances are metres in a projected CRS (the pipeline uses ETRS89 / UTM 32N).
"""

from collections.abc import Sequence
from dataclasses import dataclass

import shapely
from shapely import Point
from shapely.geometry.base import BaseGeometry

from gerlines_geo_base.geometry import label_point, polygon_parts

SHARED_BORDER_GAP = 2_000.0
LABEL_PRECISION = 100.0


@dataclass(frozen=True, slots=True)
class Country:
    code: str
    name_en: str
    name_de: str
    name_pl: str
    geometry: BaseGeometry


@dataclass(frozen=True, slots=True)
class Neighbour:
    country: Country
    distance: float
    shares_border: bool
    label: Point


@dataclass(frozen=True, slots=True)
class RailLine:
    source_id: str
    geometry: BaseGeometry


@dataclass(frozen=True, slots=True)
class Crossing:
    point: Point
    country: str
    source_id: str


def nearby_countries(
    germany: BaseGeometry,
    countries: Sequence[Country],
    max_distance: float,
    label_band: float,
) -> list[Neighbour]:
    """Countries within ``max_distance`` of Germany, labelled inside a band along the border."""
    band = shapely.buffer(germany, label_band)
    found = []
    for country in countries:
        distance = float(shapely.distance(germany, country.geometry))
        if distance > max_distance:
            continue
        near_part = shapely.difference(shapely.intersection(country.geometry, band), germany)
        if not polygon_parts(near_part):
            near_part = country.geometry
        found.append(
            Neighbour(
                country=country,
                distance=distance,
                shares_border=distance <= SHARED_BORDER_GAP,
                label=label_point(near_part, LABEL_PRECISION),
            )
        )
    return sorted(found, key=lambda n: (n.distance, n.country.code))


def border_crossings(
    germany: BaseGeometry,
    lines: Sequence[RailLine],
    countries: Sequence[Country],
    max_gap: float,
    merge: float,
) -> list[Crossing]:
    """Points where a rail line crosses Germany's land border into a country within ``max_gap``.

    Crossings along one line closer than ``merge`` to an earlier one are merged into it.
    """
    border = germany.boundary
    crossings: list[Crossing] = []
    for line in lines:
        hits = shapely.get_parts(shapely.intersection(line.geometry, border))
        points = sorted((hit for hit in hits if isinstance(hit, Point)), key=line.geometry.project)
        kept: list[Point] = []
        for point in points:
            if any(point.distance(earlier) < merge for earlier in kept):
                continue
            neighbour = _closest_country(point, countries, max_gap)
            if neighbour is None:
                continue
            kept.append(point)
            crossings.append(Crossing(point, neighbour, line.source_id))
    return crossings


def _closest_country(point: Point, countries: Sequence[Country], max_gap: float) -> str | None:
    best: tuple[float, str] | None = None
    for country in countries:
        distance = shapely.distance(point, country.geometry)
        if distance <= max_gap and (best is None or distance < best[0]):
            best = (distance, country.code)
    return None if best is None else best[1]
