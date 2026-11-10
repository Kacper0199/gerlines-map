"""Streaming reads of a GTFS zip: only the columns and rows the shape comparison needs."""

import csv
import io
import zipfile
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from pathlib import Path


def rows(zip_path: Path, member: str) -> Iterator[dict[str, str]]:
    """Rows of ``member`` from a GTFS zip, or from a folder holding the unpacked feed."""
    if zip_path.is_dir():
        with (zip_path / member).open(encoding="utf-8-sig", newline="") as text:
            yield from csv.DictReader(text)
        return
    with zipfile.ZipFile(zip_path) as archive, archive.open(member) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def gtfs_seconds(value: str) -> int:
    hours, minutes, seconds = value.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds)


@dataclass(frozen=True, slots=True)
class Stop:
    name: str
    lat: float
    lon: float


@dataclass(frozen=True, slots=True)
class Route:
    route_type: int
    short_name: str
    agency_id: str


@dataclass(frozen=True, slots=True)
class Trip:
    route_id: str
    service_id: str
    shape_id: str
    short_name: str
    headsign: str
    direction_id: str = ""


def read_stops(zip_path: Path) -> dict[str, Stop]:
    return {
        r["stop_id"]: Stop(r["stop_name"], float(r["stop_lat"]), float(r["stop_lon"]))
        for r in rows(zip_path, "stops.txt")
        if r["stop_lat"] and r["stop_lon"]
    }


def read_routes(zip_path: Path) -> dict[str, Route]:
    return {
        r["route_id"]: Route(int(r["route_type"]), r["route_short_name"], r["agency_id"])
        for r in rows(zip_path, "routes.txt")
    }


def read_trips(zip_path: Path) -> dict[str, Trip]:
    return {
        r["trip_id"]: Trip(
            r["route_id"],
            r["service_id"],
            r["shape_id"],
            r["trip_short_name"],
            r["trip_headsign"],
            r.get("direction_id", ""),
        )
        for r in rows(zip_path, "trips.txt")
    }


def active_services(zip_path: Path, day: date) -> set[str]:
    key = day.strftime("%Y%m%d")
    weekday = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")[
        day.weekday()
    ]
    active = {
        r["service_id"]
        for r in rows(zip_path, "calendar.txt")
        if r["start_date"] <= key <= r["end_date"] and r[weekday] == "1"
    }
    for r in rows(zip_path, "calendar_dates.txt"):
        if r["date"] != key:
            continue
        if r["exception_type"] == "1":
            active.add(r["service_id"])
        elif r["exception_type"] == "2":
            active.discard(r["service_id"])
    return active


def read_stop_times(zip_path: Path, trip_ids: set[str]) -> dict[str, list[tuple[str, int, int]]]:
    """Per trip, (stop_id, arrival s, departure s) in stop_sequence order."""
    found: dict[str, list[tuple[int, str, int, int]]] = defaultdict(list)
    for r in rows(zip_path, "stop_times.txt"):
        if r["trip_id"] in trip_ids:
            arrival = r["arrival_time"] or r["departure_time"]
            departure = r["departure_time"] or r["arrival_time"]
            found[r["trip_id"]].append(
                (
                    int(r["stop_sequence"]),
                    r["stop_id"],
                    gtfs_seconds(arrival),
                    gtfs_seconds(departure),
                )
            )
    return {trip: [(s, a, d) for _, s, a, d in sorted(stops)] for trip, stops in found.items()}


def read_shapes(zip_path: Path, shape_ids: set[str]) -> dict[str, list[tuple[float, float]]]:
    """Per shape, (lon, lat) in shape_pt_sequence order."""
    found: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for r in rows(zip_path, "shapes.txt"):
        if r["shape_id"] in shape_ids:
            found[r["shape_id"]].append(
                (int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"]))
            )
    return {
        shape: [(lon, lat) for _, lon, lat in sorted(points)] for shape, points in found.items()
    }
