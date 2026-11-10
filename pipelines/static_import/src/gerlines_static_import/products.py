"""The product each timetable train runs as (ICE, IC, NJ, RE ...), also for routes named by number.

DELFI names most routes with their product ("RE10", "FLX20", "NJ"), but files DB long-distance lines
by number ("42") and night lines as "43N". Rules in order, the first that decides wins:

1. ``delfi:name`` the route name starts with a product code;
2. ``delfi:number`` another long-distance trip of the same feed with the same train number runs on
   a named route, and all such trips agree (codeshare copies: ÖBB "43N" 403 is "NJ" 403);
3. ``gtfsde:trip`` a gtfs.de long-distance trip departs at the trip's origin and arrives at its
   destination at the same times, and every such trip names one product ("ICE 42" gives "ICE");
4. ``gtfsde:line`` the trips of the same operator, line and route type matched by rule 3 all name
   one product.

A trip no rule decides gets no row: the card then shows it without a product.
"""

import re
import zipfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import psycopg

from gerlines_static_import import db
from gerlines_static_import.gtfs import open_table, parse_time
from gerlines_static_import.spatial import distance_m

PRODUCT_CODES = frozenset(
    {
        "ICE", "TGV", "THA", "RJX", "ES", "EST", "FR",
        "IC", "EC", "ECE", "ECM", "FLX", "RJ", "D",
        "EN", "NJ",
        "RE", "IRE", "MEX", "FEX", "RX", "REX", "HBX", "EX", "IR", "RR",
        "S", "RS",
        "RB", "R", "OS", "SP",
    }
)  # fmt: skip
CANONICAL = {"OS": "Os", "SP": "Sp"}
LONG_DISTANCE = frozenset({"hsr", "ld", "night"})
NEAR_M = 1500.0

DELFI_SOURCE = "delfi-gtfs"
GTFSDE_FV = db.SourceRow(
    source_id="gtfsde-static-fv",
    name="gtfs.de static GTFS, long distance rail",
    homepage_url="https://gtfs.de/",
    licence="CC-BY-4.0",
    licence_url="https://creativecommons.org/licenses/by/4.0/",
    attribution="DELFI e.V. and GTFS.de",
)

_PREFIX = re.compile(r"^([^\W\d_]+)")
_NIGHT_LINE = re.compile(r"^\d+N$")


@dataclass(frozen=True, slots=True)
class TimetableTrip:
    trip_key: str
    train_number: str | None
    line: str | None
    operator_id: str | None
    route_type: int
    category: str
    first_departure_s: int
    last_arrival_s: int
    origin: tuple[float, float] | None
    destination: tuple[float, float] | None


@dataclass(frozen=True, slots=True)
class TripProduct:
    trip_key: str
    product: str
    source_id: str
    rule: str


@dataclass(frozen=True, slots=True)
class ForeignStopTime:
    trip_id: str
    sequence: int
    position: tuple[float, float]


@dataclass
class GtfsdeIndex:
    """gtfs.de stop times by departure and by arrival second, with each trip's product."""

    departures: dict[int, list[ForeignStopTime]]
    arrivals: dict[int, list[ForeignStopTime]]
    products: dict[str, str]


def route_product(line: str | None) -> str | None:
    """The product a route name starts with in canonical case ("RE" of "Re 1"), else None."""
    if not line or _NIGHT_LINE.match(line.strip()):
        return None
    match = _PREFIX.match(line.strip())
    if match is None:
        return None
    code = match.group(1).upper()
    if code not in PRODUCT_CODES:
        return None
    return CANONICAL.get(code, code)


def normalize_number(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if text.isdigit():
        return text.lstrip("0") or "0"
    return text


def read_gtfsde(archive: zipfile.ZipFile) -> GtfsdeIndex:
    stops: dict[str, tuple[float, float]] = {}
    with open_table(archive, "stops.txt") as table:
        sid, lat, lon = table.index("stop_id"), table.index("stop_lat"), table.index("stop_lon")
        for row in table.rows:
            if row[lat].strip() and row[lon].strip():
                stops[row[sid]] = (float(row[lat]), float(row[lon]))
    route_products: dict[str, str] = {}
    with open_table(archive, "routes.txt") as table:
        rid, name = table.index("route_id"), table.index("route_short_name")
        for row in table.rows:
            product = route_product(row[name])
            if product is not None:
                route_products[row[rid]] = product
    products: dict[str, str] = {}
    with open_table(archive, "trips.txt") as table:
        tid, rid = table.index("trip_id"), table.index("route_id")
        for row in table.rows:
            product = route_products.get(row[rid])
            if product is not None:
                products[row[tid]] = product
    departures: dict[int, list[ForeignStopTime]] = defaultdict(list)
    arrivals: dict[int, list[ForeignStopTime]] = defaultdict(list)
    with open_table(archive, "stop_times.txt") as table:
        tid, stop, seq = (
            table.index("trip_id"),
            table.index("stop_id"),
            table.index("stop_sequence"),
        )
        arr, dep = table.index("arrival_time"), table.index("departure_time")
        for row in table.rows:
            position = stops.get(row[stop])
            if row[tid] not in products or position is None:
                continue
            entry = ForeignStopTime(row[tid], int(row[seq]), position)
            if (departure := parse_time(row[dep])) is not None:
                departures[departure].append(entry)
            if (arrival := parse_time(row[arr])) is not None:
                arrivals[arrival].append(entry)
    return GtfsdeIndex(dict(departures), dict(arrivals), products)


def _near(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return distance_m(a[0], a[1], b[0], b[1]) <= NEAR_M


def gtfsde_products(trip: TimetableTrip, index: GtfsdeIndex) -> set[str]:
    """Products of the gtfs.de trips that run from the trip's origin to its destination on time."""
    if trip.origin is None or trip.destination is None:
        return set()
    starts: dict[str, int] = {}
    for entry in index.departures.get(trip.first_departure_s, ()):
        if _near(entry.position, trip.origin):
            starts[entry.trip_id] = min(entry.sequence, starts.get(entry.trip_id, entry.sequence))
    found = set()
    for entry in index.arrivals.get(trip.last_arrival_s, ()):
        start = starts.get(entry.trip_id)
        if start is not None and entry.sequence > start and _near(entry.position, trip.destination):
            found.add(index.products[entry.trip_id])
    return found


def resolve_products(
    trips: Sequence[TimetableTrip], gtfsde: GtfsdeIndex | None
) -> list[TripProduct]:
    decided: dict[str, TripProduct] = {}
    named_by_number: dict[str, set[str]] = defaultdict(set)
    for trip in trips:
        product = route_product(trip.line)
        if product is None:
            continue
        decided[trip.trip_key] = TripProduct(trip.trip_key, product, DELFI_SOURCE, "delfi:name")
        number = normalize_number(trip.train_number)
        if number is not None and trip.category in LONG_DISTANCE:
            named_by_number[number].add(product)

    open_trips = [t for t in trips if t.trip_key not in decided and t.category in LONG_DISTANCE]
    for trip in open_trips:
        number = normalize_number(trip.train_number)
        siblings = named_by_number.get(number or "", set())
        if len(siblings) == 1:
            decided[trip.trip_key] = TripProduct(
                trip.trip_key, next(iter(siblings)), DELFI_SOURCE, "delfi:number"
            )
    if gtfsde is None:
        return sorted(decided.values(), key=lambda p: p.trip_key)

    by_line: dict[tuple[str | None, str | None, int], Counter[str]] = defaultdict(Counter)
    for trip in open_trips:
        if trip.trip_key in decided:
            continue
        found = gtfsde_products(trip, gtfsde)
        if len(found) == 1:
            product = next(iter(found))
            decided[trip.trip_key] = TripProduct(
                trip.trip_key, product, GTFSDE_FV.source_id, "gtfsde:trip"
            )
            by_line[(trip.operator_id, trip.line, trip.route_type)][product] += 1
    for trip in open_trips:
        if trip.trip_key in decided:
            continue
        seen = by_line.get((trip.operator_id, trip.line, trip.route_type))
        if seen is not None and len(seen) == 1:
            decided[trip.trip_key] = TripProduct(
                trip.trip_key, next(iter(seen)), GTFSDE_FV.source_id, "gtfsde:line"
            )
    return sorted(decided.values(), key=lambda p: p.trip_key)


TRIPS_QUERY = """
SELECT t.trip_key, t.short_name, r.short_name, r.operator_id, r.gtfs_route_type, t.category_code,
       t.first_departure_s, t.last_arrival_s,
       ST_Y(o.geom), ST_X(o.geom), ST_Y(d.geom), ST_X(d.geom)
  FROM trip t
  JOIN route r USING (feed_version_id, route_key)
  JOIN trip_pattern p USING (feed_version_id, trip_pattern_id)
  JOIN trip_pattern_stop s0 ON s0.feed_version_id = t.feed_version_id
   AND s0.trip_pattern_id = t.trip_pattern_id AND s0.stop_index = 0
  JOIN trip_pattern_stop s1 ON s1.feed_version_id = t.feed_version_id
   AND s1.trip_pattern_id = t.trip_pattern_id AND s1.stop_index = p.stop_count - 1
  JOIN stop_point p0 ON p0.stop_point_id = s0.stop_point_id
  JOIN stop_place o ON o.stop_place_id = p0.stop_place_id
  JOIN stop_point p1 ON p1.stop_point_id = s1.stop_point_id
  JOIN stop_place d ON d.stop_place_id = p1.stop_place_id
 WHERE t.feed_version_id = %s
 ORDER BY t.trip_key
"""


def read_trips(conn: psycopg.Connection, feed_version_id: int) -> list[TimetableTrip]:
    def point(lat: float | None, lon: float | None) -> tuple[float, float] | None:
        return None if lat is None or lon is None else (lat, lon)

    return [
        TimetableTrip(
            trip_key=row[0],
            train_number=row[1],
            line=row[2],
            operator_id=row[3],
            route_type=row[4],
            category=row[5],
            first_departure_s=row[6],
            last_arrival_s=row[7],
            origin=point(row[8], row[9]),
            destination=point(row[10], row[11]),
        )
        for row in conn.execute(TRIPS_QUERY, (feed_version_id,))
    ]


def write_products(
    conn: psycopg.Connection, feed_version_id: int, products: Iterable[TripProduct]
) -> int:
    """Replace the feed version's products; the caller commits."""
    db.upsert_sources(conn, [GTFSDE_FV])
    listed = list(products)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM trip_product WHERE feed_version_id = %s", (feed_version_id,))
        cur.executemany(
            """
            INSERT INTO trip_product (feed_version_id, trip_key, product, source_id, rule)
            VALUES (%s, %s, %s, %s, %s)
            """,
            [(feed_version_id, p.trip_key, p.product, p.source_id, p.rule) for p in listed],
        )
    return len(listed)


def run_products(
    feed_version_id: int, gtfsde_path: Path | None, database_url: str
) -> dict[str, object]:
    """Resolve and replace one feed version's products in one transaction; returns the coverage."""
    index = None
    if gtfsde_path is not None:
        with zipfile.ZipFile(gtfsde_path) as archive:
            index = read_gtfsde(archive)
    with psycopg.connect(database_url) as conn:
        trips = read_trips(conn, feed_version_id)
        products = resolve_products(trips, index)
        written = write_products(conn, feed_version_id, products)
    return {
        "feed_version_id": feed_version_id,
        "gtfsde": str(gtfsde_path) if gtfsde_path else None,
        "written": written,
        "coverage": coverage(trips, products),
    }


def coverage(
    trips: Sequence[TimetableTrip], products: Iterable[TripProduct]
) -> Mapping[str, Mapping[str, int]]:
    """Trips per category: all, with a product, and per rule."""
    by_key = {p.trip_key: p for p in products}
    report: dict[str, Counter[str]] = defaultdict(Counter)
    for trip in trips:
        counts = report[trip.category]
        counts["trips"] += 1
        product = by_key.get(trip.trip_key)
        if product is not None:
            counts["with_product"] += 1
            counts[product.rule] += 1
    return {category: dict(counts) for category, counts in sorted(report.items())}
