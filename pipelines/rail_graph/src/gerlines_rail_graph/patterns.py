"""Trip patterns of one loaded feed version, each with a representative trip and its weight.

A pattern (WP-2.1 ``trip_pattern``) is a route, its ordered stops and the DELFI shape key it
references. Its representative trip is the one whose first service date in the router window
comes first, then the earliest departure, so MOTIS can be asked for that trip on that day.
Weights are train-km in a reference week: the stop-to-stop geodesic length times the number of
trip days in that week.
"""

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta

import numpy as np
import shapely

from gerlines_rail_graph.project import geodesic_segments, to_xy

GTFS_STOP_SOURCE = "delfi-gtfs"


@dataclass(frozen=True, slots=True)
class Service:
    weekdays: int
    start: date | None
    end: date | None
    added: frozenset[date] = frozenset()
    removed: frozenset[date] = frozenset()


def service_dates(service: Service, first: date, last: date) -> list[date]:
    """Dates from ``first`` to ``last`` (inclusive) on which the service runs.

    ``weekdays`` holds bit 0 for Monday to bit 6 for Sunday, as the static import writes it.
    """
    days = []
    day = first
    while day <= last:
        regular = (
            service.start is not None
            and service.end is not None
            and service.start <= day <= service.end
            and bool(service.weekdays & (1 << day.weekday()))
        )
        if (regular and day not in service.removed) or day in service.added:
            days.append(day)
        day += timedelta(days=1)
    return days


@dataclass(frozen=True, slots=True)
class TripRow:
    trip_key: str
    pattern_id: str
    direction_id: int | None
    service_key: str
    first_departure_s: int
    category: str
    short_name: str | None


@dataclass(slots=True)
class Pattern:
    pattern_id: str
    route_key: str
    route_short_name: str | None
    category: str
    direction_id: int | None
    stops: list[tuple[str, str, float, float]]
    rep_trip: str
    rep_date: str | None
    rep_departure_s: int
    trips: int
    trip_days_week: int
    length_km: float
    scope: str = "domestic"
    train_km_week: float = field(init=False, default=0.0)

    def __post_init__(self) -> None:
        self.train_km_week = round(self.length_km * self.trip_days_week, 3)

    @property
    def group(self) -> str:
        """Route and direction: the unit that keeps one shape method (``gate.choose_group``)."""
        direction = "" if self.direction_id is None else str(self.direction_id)
        return f"{self.route_key}|{direction}"

    def stop_lonlat(self) -> np.ndarray:
        return np.array([[s[2], s[3]] for s in self.stops], dtype=float)

    def as_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, data: Mapping) -> "Pattern":
        values = {k: v for k, v in data.items() if k != "train_km_week"}
        values["stops"] = [tuple(s) for s in values["stops"]]
        return cls(**values)


def pick_representative(
    trips: Sequence[TripRow],
    dates_of: Mapping[str, list[date]],
) -> tuple[TripRow, date | None]:
    """The trip running first in the window (then earliest departure, then key) and that date."""

    def key(trip: TripRow) -> tuple:
        days = dates_of.get(trip.service_key) or []
        first = days[0] if days else date.max
        return (first, trip.first_departure_s, trip.trip_key)

    best = min(trips, key=key)
    days = dates_of.get(best.service_key) or []
    return best, (days[0] if days else None)


def build_patterns(  # noqa: PLR0913, PLR0917
    pattern_rows: Iterable[tuple[str, str, str | None]],
    stop_rows: Iterable[tuple[str, int, str, str, float, float]],
    trips: Iterable[TripRow],
    services: Mapping[str, Service],
    window: tuple[date, date],
    week: tuple[date, date],
    outline=None,
) -> list[Pattern]:
    """Patterns from plain rows: (pattern id, route key, route short name), stops, trips.

    ``stop_rows`` are (pattern id, stop index, GTFS stop id, name, lon, lat). ``outline`` is a
    polygon in EPSG:25832; a pattern with a stop outside it is ``cross_border``.
    """
    stops: dict[str, list[tuple[int, tuple[str, str, float, float]]]] = defaultdict(list)
    for pattern_id, index, key, name, lon, lat in stop_rows:
        stops[pattern_id].append((index, (key, name, float(lon), float(lat))))
    by_pattern: dict[str, list[TripRow]] = defaultdict(list)
    for trip in trips:
        by_pattern[trip.pattern_id].append(trip)
    in_window = {k: service_dates(s, *window) for k, s in services.items()}
    week_days = {k: len(service_dates(s, *week)) for k, s in services.items()}
    patterns = []
    for pattern_id, route_key, short_name in pattern_rows:
        members = by_pattern.get(pattern_id)
        ordered = [s for _, s in sorted(stops.get(pattern_id, []))]
        if not members or len(ordered) < 2:
            continue
        rep, rep_date = pick_representative(members, in_window)
        lonlat = np.array([[s[2], s[3]] for s in ordered])
        scope = "domestic"
        if outline is not None:
            xy = to_xy(lonlat[:, 0], lonlat[:, 1])
            if not shapely.contains_xy(outline, xy[:, 0], xy[:, 1]).all():
                scope = "cross_border"
        patterns.append(
            Pattern(
                pattern_id=pattern_id,
                route_key=route_key,
                route_short_name=short_name,
                category=rep.category,
                direction_id=rep.direction_id,
                stops=ordered,
                rep_trip=rep.trip_key,
                rep_date=rep_date.isoformat() if rep_date else None,
                rep_departure_s=rep.first_departure_s,
                trips=len(members),
                trip_days_week=sum(week_days.get(t.service_key, 0) for t in members),
                length_km=round(float(geodesic_segments(lonlat).sum()) / 1000, 3),
                scope=scope,
            )
        )
    return patterns


PATTERN_SQL = """
SELECT p.trip_pattern_id::text, p.route_key, r.short_name
FROM trip_pattern p JOIN route r USING (feed_version_id, route_key)
WHERE p.feed_version_id = %s
ORDER BY 1
"""

STOP_SQL = """
SELECT ps.trip_pattern_id::text, ps.stop_index, m.source_key, sp.name,
       ST_X(sp.geom), ST_Y(sp.geom)
FROM trip_pattern_stop ps
JOIN stop_point sp USING (stop_point_id)
JOIN id_map m ON m.canonical_id = sp.stop_point_id AND m.entity = 'stop_point'
  AND m.source_id = %s
WHERE ps.feed_version_id = %s
"""

TRIP_SQL = """
SELECT trip_key, trip_pattern_id::text, direction_id, service_key, first_departure_s,
       category_code, short_name
FROM trip WHERE feed_version_id = %s
"""

SERVICE_SQL = """
SELECT service_key, weekdays, start_date, end_date FROM service_calendar
WHERE feed_version_id = %s
"""

SERVICE_DATE_SQL = """
SELECT service_key, service_date, exception_type FROM service_calendar_date
WHERE feed_version_id = %s
"""


def read_patterns(  # noqa: PLR0913, PLR0917
    conn,
    feed_version_id: int,
    window: tuple[date, date],
    week: tuple[date, date],
    outline=None,
    limit: int | None = None,
) -> list[Pattern]:
    """Patterns of one feed version from the database (psycopg connection)."""
    with conn.cursor() as cur:
        cur.execute(PATTERN_SQL, (feed_version_id,))
        pattern_rows = cur.fetchall()
        if limit is not None:
            pattern_rows = pattern_rows[:limit]
        cur.execute(STOP_SQL, (GTFS_STOP_SOURCE, feed_version_id))
        stop_rows = cur.fetchall()
        cur.execute(TRIP_SQL, (feed_version_id,))
        trips = [TripRow(*row) for row in cur.fetchall()]
        cur.execute(SERVICE_SQL, (feed_version_id,))
        base = {k: (w, s, e) for k, w, s, e in cur.fetchall()}
        cur.execute(SERVICE_DATE_SQL, (feed_version_id,))
        added: dict[str, set[date]] = defaultdict(set)
        removed: dict[str, set[date]] = defaultdict(set)
        for key, day, kind in cur.fetchall():
            (added if kind == 1 else removed)[key].add(day)
    services = {
        k: Service(w, s, e, frozenset(added.get(k, ())), frozenset(removed.get(k, ())))
        for k, (w, s, e) in base.items()
    }
    for key in set(added) - set(base):
        services[key] = Service(0, None, None, frozenset(added[key]), frozenset())
    return build_patterns(pattern_rows, stop_rows, trips, services, window, week, outline)
