"""Streamed assembly of routes, trips, services, trip patterns and stop times for one category set.

Nothing here touches the database: stop times go to a ``sink`` callable as they are read, so
``stop_times.txt`` (over 4 GB in the national feed) is never held in memory or written to disk.
The file must be grouped by ``trip_id``; a trip that comes back after another one is refused.
"""

import zipfile
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date
from uuid import UUID

from gerlines_static_import.categories import Category, Classification, classify
from gerlines_static_import.gtfs import GtfsError, open_table, parse_date, parse_int, parse_time
from gerlines_static_import.ids import pattern_id
from gerlines_static_import.operators import OperatorCatalog

StopTimeRow = tuple[str, int, int, int | None, int | None, int, int]
WEEKDAY_COLUMNS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


@dataclass(frozen=True, slots=True)
class Route:
    route_key: str
    agency_key: str
    operator_id: str | None
    short_name: str
    long_name: str
    route_type: int
    classification: Classification
    is_foreign: bool

    @property
    def category(self) -> Category:
        if self.classification.category is None:
            msg = f"route {self.route_key} has no category"
            raise GtfsError(msg)
        return self.classification.category


@dataclass(frozen=True, slots=True)
class Trip:
    trip_key: str
    route_key: str
    service_key: str
    shape_key: str
    headsign: str
    short_name: str
    direction_id: int | None
    block_key: str
    wheelchair_accessible: int | None
    bikes_allowed: int | None


@dataclass(frozen=True, slots=True)
class TripTimes:
    trip_pattern_id: UUID
    first_departure_s: int
    last_arrival_s: int


@dataclass(frozen=True, slots=True)
class Pattern:
    trip_pattern_id: UUID
    route_key: str
    shape_key: str
    stop_keys: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Service:
    service_key: str
    weekdays: int
    start_date: date | None
    end_date: date | None


@dataclass(slots=True)
class RouteSelection:
    routes: dict[str, Route]
    total: int
    by_category: Counter[str]
    excluded_by_category: Counter[str]
    fallbacks: list[Route]
    unmapped: list[Route]


@dataclass(slots=True)
class TripSelection:
    trips: dict[str, Trip]
    total: int
    by_category: Counter[str]
    excluded: int


@dataclass(slots=True)
class ServiceSelection:
    services: dict[str, Service]
    calendar_dates: list[tuple[str, date, int]]
    calendar_total: int
    calendar_dates_total: int


@dataclass(slots=True)
class StopTimesResult:
    total_rows: int = 0
    kept_rows: int = 0
    rows_by_category: Counter[str] = field(default_factory=Counter)
    trip_times: dict[str, TripTimes] = field(default_factory=dict)
    patterns: dict[UUID, Pattern] = field(default_factory=dict)
    served_stops: set[str] = field(default_factory=set)
    dropped_trips: dict[str, str] = field(default_factory=dict)
    dropped_rows: int = 0


def select_routes(
    archive: zipfile.ZipFile,
    agency_names: dict[str, str],
    catalog: OperatorCatalog,
    categories: frozenset[Category],
) -> RouteSelection:
    selection = RouteSelection({}, 0, Counter(), Counter(), [], [])
    with open_table(archive, "routes.txt") as table:
        rid = table.index("route_id")
        aid = table.optional_index("agency_id")
        short = table.index("route_short_name")
        long_name = table.index("route_long_name")
        kind = table.index("route_type")
        for row in table.rows:
            selection.total += 1
            agency_key = row[aid] if aid is not None else ""
            route_type = parse_int(row[kind])
            result = classify(route_type, row[short], agency_names.get(agency_key, ""))
            operator = catalog.for_agency(agency_key)
            route = Route(
                route_key=row[rid],
                agency_key=agency_key,
                operator_id=operator.operator_id if operator is not None else None,
                short_name=row[short].strip(),
                long_name=row[long_name].strip(),
                route_type=route_type,
                classification=result,
                is_foreign=operator.foreign if operator is not None else False,
            )
            if result.category is None:
                selection.unmapped.append(route)
                selection.excluded_by_category["unmapped"] += 1
                continue
            if result.category not in categories:
                selection.excluded_by_category[result.category.value] += 1
                continue
            if result.is_fallback:
                selection.fallbacks.append(route)
            selection.routes[route.route_key] = route
            selection.by_category[result.category.value] += 1
    return selection


def _optional_int(row: list[str], index: int | None) -> int | None:
    if index is None or not row[index].strip():
        return None
    return int(row[index])


def select_trips(archive: zipfile.ZipFile, routes: dict[str, Route]) -> TripSelection:
    selection = TripSelection({}, 0, Counter(), 0)
    with open_table(archive, "trips.txt") as table:
        columns = {
            name: table.optional_index(name)
            for name in (
                "trip_headsign",
                "trip_short_name",
                "direction_id",
                "block_id",
                "shape_id",
                "wheelchair_accessible",
                "bikes_allowed",
            )
        }
        rid = table.index("route_id")
        sid = table.index("service_id")
        tid = table.index("trip_id")

        def text(row: list[str], name: str) -> str:
            index = columns[name]
            return row[index].strip() if index is not None else ""

        for row in table.rows:
            selection.total += 1
            route = routes.get(row[rid])
            if route is None:
                selection.excluded += 1
                continue
            trip = Trip(
                trip_key=row[tid],
                route_key=row[rid],
                service_key=row[sid],
                shape_key=text(row, "shape_id"),
                headsign=text(row, "trip_headsign"),
                short_name=text(row, "trip_short_name"),
                direction_id=_optional_int(row, columns["direction_id"]),
                block_key=text(row, "block_id"),
                wheelchair_accessible=_optional_int(row, columns["wheelchair_accessible"]),
                bikes_allowed=_optional_int(row, columns["bikes_allowed"]),
            )
            if trip.trip_key in selection.trips:
                msg = f"trips.txt repeats trip_id {trip.trip_key}"
                raise GtfsError(msg)
            selection.trips[trip.trip_key] = trip
            selection.by_category[route.category.value] += 1
    return selection


def select_services(archive: zipfile.ZipFile, service_keys: set[str]) -> ServiceSelection:
    selection = ServiceSelection({}, [], 0, 0)
    with open_table(archive, "calendar.txt") as table:
        sid = table.index("service_id")
        days = [table.index(column) for column in WEEKDAY_COLUMNS]
        start = table.index("start_date")
        end = table.index("end_date")
        for row in table.rows:
            selection.calendar_total += 1
            if row[sid] not in service_keys:
                continue
            weekdays = sum(1 << bit for bit, index in enumerate(days) if row[index].strip() == "1")
            selection.services[row[sid]] = Service(
                row[sid], weekdays, parse_date(row[start]), parse_date(row[end])
            )
    with open_table(archive, "calendar_dates.txt") as table:
        sid = table.index("service_id")
        day = table.index("date")
        kind = table.index("exception_type")
        for row in table.rows:
            selection.calendar_dates_total += 1
            if row[sid] not in service_keys:
                continue
            selection.calendar_dates.append((row[sid], parse_date(row[day]), int(row[kind])))
            selection.services.setdefault(row[sid], Service(row[sid], 0, None, None))
    return selection


def stream_stop_times(
    archive: zipfile.ZipFile,
    trips: dict[str, Trip],
    routes: dict[str, Route],
    sink: Callable[[Iterable[StopTimeRow]], None],
) -> StopTimesResult:
    """Read every stop time once; hand the kept ones to ``sink`` one trip at a time."""
    result = StopTimesResult()
    finished: set[str] = set()
    current: str | None = None
    buffer: list[tuple[int, str, int | None, int | None, int, int]] = []
    with open_table(archive, "stop_times.txt") as table:
        tid = table.index("trip_id")
        sid = table.index("stop_id")
        seq = table.index("stop_sequence")
        arr = table.index("arrival_time")
        dep = table.index("departure_time")
        pickup = table.optional_index("pickup_type")
        drop = table.optional_index("drop_off_type")
        for row in table.rows:
            result.total_rows += 1
            trip_key = row[tid]
            if trip_key not in trips:
                continue
            if trip_key != current:
                if current is not None:
                    _flush(current, buffer, trips=trips, routes=routes, sink=sink, result=result)
                    finished.add(current)
                if trip_key in finished:
                    msg = f"stop_times.txt is not grouped by trip_id: {trip_key} comes back"
                    raise GtfsError(msg)
                current = trip_key
                buffer = []
            buffer.append(
                (
                    int(row[seq]),
                    row[sid],
                    parse_time(row[arr]),
                    parse_time(row[dep]),
                    parse_int(row[pickup]) if pickup is not None else 0,
                    parse_int(row[drop]) if drop is not None else 0,
                )
            )
        if current is not None:
            _flush(current, buffer, trips=trips, routes=routes, sink=sink, result=result)
    for trip_key in trips.keys() - result.trip_times.keys() - result.dropped_trips.keys():
        result.dropped_trips[trip_key] = "no stop times"
    return result


def _flush(  # noqa: PLR0913
    trip_key: str,
    buffer: list[tuple[int, str, int | None, int | None, int, int]],
    *,
    trips: dict[str, Trip],
    routes: dict[str, Route],
    sink: Callable[[Iterable[StopTimeRow]], None],
    result: StopTimesResult,
) -> None:
    buffer.sort(key=lambda item: item[0])
    reason = _drop_reason(buffer)
    if reason is not None:
        result.dropped_trips[trip_key] = reason
        result.dropped_rows += len(buffer)
        return
    trip = trips[trip_key]
    stop_keys = tuple(item[1] for item in buffer)
    identifier = pattern_id(trip.route_key, stop_keys, trip.shape_key)
    if identifier not in result.patterns:
        result.patterns[identifier] = Pattern(identifier, trip.route_key, trip.shape_key, stop_keys)
    first, last = buffer[0], buffer[-1]
    result.trip_times[trip_key] = TripTimes(
        trip_pattern_id=identifier,
        first_departure_s=first[3] if first[3] is not None else first[2] or 0,
        last_arrival_s=last[2] if last[2] is not None else last[3] or 0,
    )
    result.served_stops.update(stop_keys)
    result.kept_rows += len(buffer)
    result.rows_by_category[routes[trip.route_key].category.value] += len(buffer)
    sink(
        (trip_key, index, item[0], item[2], item[3], item[4], item[5])
        for index, item in enumerate(buffer)
    )


def _drop_reason(buffer: list[tuple[int, str, int | None, int | None, int, int]]) -> str | None:
    if len(buffer) < 2:
        return "fewer than two stops"
    if len({item[0] for item in buffer}) != len(buffer):
        return "repeated stop_sequence"
    first, last = buffer[0], buffer[-1]
    if (first[3] is None and first[2] is None) or (last[2] is None and last[3] is None):
        return "no time at the first or last stop"
    return None
