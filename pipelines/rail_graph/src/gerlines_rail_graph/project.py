"""Projection between WGS84 and ETRS89 UTM 32N (EPSG:25832), the metric frame of every metric."""

import numpy as np
from pyproj import Geod, Transformer

_FORWARD = Transformer.from_crs("EPSG:4326", "EPSG:25832", always_xy=True)
_INVERSE = Transformer.from_crs("EPSG:25832", "EPSG:4326", always_xy=True)
_GEOD = Geod(ellps="WGS84")


def geodesic_segments(lonlat: np.ndarray) -> np.ndarray:
    """Length in metres on the WGS84 ellipsoid of each edge of a (lon, lat) polyline."""
    lonlat = np.asarray(lonlat, dtype=float)
    if len(lonlat) < 2:
        return np.zeros(0)
    _, _, distance = _GEOD.inv(lonlat[:-1, 0], lonlat[:-1, 1], lonlat[1:, 0], lonlat[1:, 1])
    return np.asarray(distance, dtype=float)


def geodesic_arc(lonlat: np.ndarray) -> np.ndarray:
    """Cumulative geodesic length at every vertex, starting at 0."""
    return np.concatenate([[0.0], np.cumsum(geodesic_segments(lonlat))])


def to_xy(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    x, y = _FORWARD.transform(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float))
    return np.column_stack([x, y])


def to_lonlat(xy: np.ndarray) -> np.ndarray:
    lon, lat = _INVERSE.transform(xy[:, 0], xy[:, 1])
    return np.column_stack([lon, lat])
