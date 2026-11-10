"""MOTIS 2 trip geometry (API v6) for scheduled GTFS trips, from a server on 127.0.0.1."""

import json
import math
import urllib.parse
import urllib.request

import numpy as np
from shapely import LineString, Point
from shapely.ops import substring

from gerlines_rail_graph.metrics import forward_positions
from gerlines_rail_graph.polyline import decode


def trip_id(service_day: str, first_departure_s: int, gtfs_trip_id: str, tag: str) -> str:
    """MOTIS trip id ``YYYYMMDD_HH:MM_<tag>_<trip_id>`` from service day and GTFS start time.

    Hours may pass 24 for trips that start after midnight of their service day.

    Format from motis v2.11.4 ``src/tag_lookup.cc`` ``id_fragments`` for scheduled trips.
    """
    minutes = first_departure_s // 60
    return (
        f"{service_day.replace('-', '')}_{minutes // 60:02}:{minutes % 60:02}_{tag}_{gtfs_trip_id}"
    )


def leg_lonlat(itinerary: dict) -> list[tuple[float, float]]:
    """Concatenated (lon, lat) of every transit leg geometry, without repeating joint points."""
    points: list[tuple[float, float]] = []
    for leg in itinerary.get("legs", []):
        geometry = leg.get("legGeometry")
        if not geometry or not geometry.get("points"):
            continue
        for lat, lon in decode(geometry["points"], int(geometry.get("precision", 6))):
            if not points or points[-1] != (lon, lat):
                points.append((lon, lat))
    return points


def run_stops(itinerary: dict, tag: str) -> list[tuple[str, Point]]:
    """GTFS stop id and position of every stop of the returned run, without the ``<tag>_`` prefix.

    A stop shared by two joined legs appears once.
    """
    prefix = f"{tag}_"
    stops: list[tuple[str, Point]] = []
    for leg in itinerary.get("legs", []):
        for place in [leg["from"], *leg.get("intermediateStops", []), leg["to"]]:
            stop = place.get("stopId", "").removeprefix(prefix)
            if not stops or stops[-1][0] != stop:
                stops.append((stop, Point(place["lon"], place["lat"])))
    return stops


END_SNAP_M = 300.0
END_SEARCH_DEG = 0.2


def _metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Equirectangular distance between two (lon, lat) points, good to a few metres here."""
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((b[0] - a[0]) * 111_320 * math.cos(lat), (b[1] - a[1]) * 110_574)


def _project_end(
    line: LineString, lo: float, hi: float, stop: tuple[float, float]
) -> tuple[float, float]:
    """Arc position of ``stop`` on the line between ``lo`` and ``hi``, and its distance."""
    window = substring(line, lo, hi)
    if window.length == 0:
        point = line.interpolate(lo)
        return lo, _metres((point.x, point.y), stop)
    offset = window.project(Point(stop))
    point = window.interpolate(offset)
    return lo + offset, _metres((point.x, point.y), stop)


def slice_to_trip(  # noqa: PLR0911
    itinerary: dict,
    stop_ids: list[str],
    tag: str,
    stop_lonlat: list[tuple[float, float]] | None = None,
) -> tuple[list[tuple[float, float]] | None, str]:
    """The run geometry cut to the trip's own stops, and how it was found.

    MOTIS returns the whole stay-seated run (trips joined by block_id) and leaves out stops
    without pickup or drop-off; the trip is the part of the run holding the trip's stops that
    the run lists, in order. When the trip's first or last stop is not in the run (a stop the
    train only passes), that end is cut where the stop projects onto the run within 300 m, if
    ``stop_lonlat`` is given. Returns (None, reason) otherwise.
    """
    points = leg_lonlat(itinerary)
    if len(points) < 2:
        return None, "no_geometry"
    stops = run_stops(itinerary, tag)
    run = [stop for stop, _ in stops]
    if run == stop_ids:
        return points, "whole_run"
    in_run = set(run)
    present = [s for s in stop_ids if s in in_run]
    n = len(present)
    starts = [i for i in range(len(run) - n + 1) if run[i : i + n] == present] if n >= 2 else []
    if not starts:
        return None, "stops_not_in_run"
    missing_ends = n < len(stop_ids) and (present[0] != stop_ids[0] or present[-1] != stop_ids[-1])
    if n < len(stop_ids) and not missing_ends and run[starts[0] : starts[0] + n] == run:
        return points, "whole_run_without_passed_stops"
    if missing_ends and stop_lonlat is None:
        return None, "end_stop_not_in_run"
    first = starts[0]
    line = LineString(points)
    coords = np.array([[p.x, p.y] for _, p in stops[: first + n]])
    along = forward_positions(line, coords, extra=0.02)
    lo, hi = float(along[first]), float(along[first + n - 1])
    how = "cut_from_run"
    if missing_ends and stop_lonlat is not None:
        if present[0] != stop_ids[0]:
            lo, gap = _project_end(line, max(0.0, lo - END_SEARCH_DEG), lo, stop_lonlat[0])
            if gap > END_SNAP_M:
                return None, f"first_stop_not_in_run_{round(gap)}m"
        if present[-1] != stop_ids[-1]:
            hi, gap = _project_end(line, hi, min(line.length, hi + END_SEARCH_DEG), stop_lonlat[-1])
            if gap > END_SNAP_M:
                return None, f"last_stop_not_in_run_{round(gap)}m"
        how = "cut_at_projected_end"
    cut = substring(line, lo, hi)
    coords = [(float(x), float(y)) for x, y in cut.coords]
    return (coords, how) if len(coords) >= 2 else (None, "empty_cut")


def fetch_trip(base_url: str, motis_trip_id: str, timeout_s: float = 30.0) -> dict:
    query = urllib.parse.urlencode({"tripId": motis_trip_id})
    url = f"{base_url.rstrip('/')}/api/v6/trip?{query}"
    if not url.startswith("http://127.0.0.1:"):
        msg = f"refusing a non-local MOTIS URL {url}"
        raise ValueError(msg)
    with urllib.request.urlopen(url, timeout=timeout_s) as response:  # noqa: S310
        return json.load(response)
