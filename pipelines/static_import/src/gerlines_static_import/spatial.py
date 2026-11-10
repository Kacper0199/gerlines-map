"""Distances, a coarse grid for neighbour search, and the national outline test."""

import json
import math
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Protocol

import numpy as np
import shapely
from numpy.typing import NDArray
from shapely.geometry import shape
from shapely.prepared import prep

_EARTH_M = 6_371_000.0
_CELL_DEG = 0.02
_METRES_PER_DEGREE_LAT = 111_320.0


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_M * math.asin(math.sqrt(h))


class Located(Protocol):
    @property
    def lat(self) -> float | None: ...

    @property
    def lon(self) -> float | None: ...


class GridIndex[T: Located]:
    """Items in cells of 0.02 degrees; ``near`` yields the items of the nine cells around one."""

    def __init__(self, items: Iterable[T]) -> None:
        self._cells: dict[tuple[int, int], list[T]] = {}
        for item in items:
            if item.lat is not None and item.lon is not None:
                self._cells.setdefault(self._cell(item.lat, item.lon), []).append(item)

    @staticmethod
    def _cell(lat: float, lon: float) -> tuple[int, int]:
        return math.floor(lat / _CELL_DEG), math.floor(lon / _CELL_DEG)

    def near(self, lat: float, lon: float) -> Iterator[T]:
        row, col = self._cell(lat, lon)
        for d_row in (-1, 0, 1):
            for d_col in (-1, 0, 1):
                yield from self._cells.get((row + d_row, col + d_col), ())


class NationalOutline:
    """Point test against the national outline, widened by ``buffer_m`` for its simplification.

    The outline of ``apps/web/public/geo`` is simplified at 300 m, so a station right at the
    border can fall just outside it; coordinates are scaled to metres around the outline's mean
    latitude before buffering.
    """

    def __init__(self, geometry: shapely.Geometry, buffer_m: float = 500.0) -> None:
        bounds = geometry.bounds
        self._lon_scale = math.cos(math.radians((bounds[1] + bounds[3]) / 2))
        metric = shapely.transform(geometry, self._to_metres)
        self._area = prep(metric.buffer(buffer_m))

    def _to_metres(self, coords: NDArray[np.float64]) -> NDArray[np.float64]:
        scaled = coords.copy()
        scaled[:, 0] *= _METRES_PER_DEGREE_LAT * self._lon_scale
        scaled[:, 1] *= _METRES_PER_DEGREE_LAT
        return scaled

    @classmethod
    def from_geojson(cls, path: Path, buffer_m: float = 500.0) -> "NationalOutline":
        collection = json.loads(path.read_text())
        geometry = shapely.union_all([shape(f["geometry"]) for f in collection["features"]])
        return cls(geometry, buffer_m)

    def contains(self, lat: float | None, lon: float | None) -> bool:
        if lat is None or lon is None:
            return False
        x = lon * _METRES_PER_DEGREE_LAT * self._lon_scale
        y = lat * _METRES_PER_DEGREE_LAT
        return self._area.contains(shapely.Point(x, y))
