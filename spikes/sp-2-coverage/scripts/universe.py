"""SP-2 universe: DELFI train trips running in the analysis window, with stops and EVA numbers.

Categories, operators, EVA join and the national outline come from ``gerlines_static_import``
(D-025).
Writes ``trips.parquet`` and ``stop_times.parquet`` under ``<out>/universe/``.
"""

import argparse
import datetime as dt
import json
import math
import zipfile
from pathlib import Path
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq

from gerlines_static_import.categories import TRAIN_CATEGORIES
from gerlines_static_import.eva import EvaIndex, read_eva_stations
from gerlines_static_import.gtfs import open_table
from gerlines_static_import.inventory import read_agency_names
from gerlines_static_import.operators import build_catalog
from gerlines_static_import.spatial import NationalOutline
from gerlines_static_import.timetable import (
    Service,
    select_routes,
    select_services,
    select_trips,
    stream_stop_times,
)

BERLIN = ZoneInfo("Europe/Berlin")


def active_services(services: dict[str, Service], exceptions, day: dt.date) -> set[str]:
    bit = 1 << day.weekday()
    active = {
        key
        for key, s in services.items()
        if s.start_date is not None
        and s.end_date is not None
        and s.start_date <= day <= s.end_date
        and s.weekdays & bit
    }
    for key, date, kind in exceptions:
        if date != day:
            continue
        if kind == 1:
            active.add(key)
        elif kind == 2:
            active.discard(key)
    return active


def service_noon_minus_12h_utc(day: dt.date) -> int:
    noon = dt.datetime(day.year, day.month, day.day, 12, tzinfo=BERLIN)
    return int(noon.timestamp()) - 12 * 3600


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--feed", type=Path, required=True)
    parser.add_argument("--eva-mirror", type=Path, required=True)
    parser.add_argument("--outline", type=Path, required=True)
    parser.add_argument("--window-start", required=True, help="UTC ISO, e.g. 2026-10-29T13:35:00Z")
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    w0 = int(dt.datetime.fromisoformat(args.window_start).timestamp())
    w1 = int(dt.datetime.fromisoformat(args.window_end).timestamp())
    local_day = dt.datetime.fromtimestamp(w0, BERLIN).date()
    days = [local_day - dt.timedelta(days=1), local_day]
    out = args.out / "universe"
    out.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "feed": str(args.feed),
        "window": [args.window_start, args.window_end],
    }

    with zipfile.ZipFile(args.feed) as archive:
        agency_names = read_agency_names(archive)
        catalog = build_catalog(agency_names)
        routes = select_routes(archive, agency_names, catalog, TRAIN_CATEGORIES)
        report["routes_by_category"] = dict(routes.by_category)
        trips = select_trips(archive, routes.routes)
        report["trips_by_category_all_dates"] = dict(trips.by_category)
        services = select_services(archive, {t.service_key for t in trips.trips.values()})
        active = {d: active_services(services.services, services.calendar_dates, d) for d in days}
        day_trips = {
            key: [d for d in days if trip.service_key in active[d]]
            for key, trip in trips.trips.items()
        }
        kept = {key: trips.trips[key] for key, ds in day_trips.items() if ds}
        report["trips_active_on_days"] = len(kept)

        times: dict[str, list[tuple]] = {}

        def sink(rows) -> None:
            for trip_key, index, seq, arr, dep, pickup, drop in rows:
                times.setdefault(trip_key, []).append((index, arr, dep, pickup, drop, seq))

        result = stream_stop_times(archive, kept, routes.routes, sink)
        report["dropped_trips"] = len(result.dropped_trips)

        needed: set[str] = set()
        for key in times:
            needed.update(result.patterns[result.trip_times[key].trip_pattern_id].stop_keys)
        stops: dict[str, tuple[str, float, float, str]] = {}
        parents: dict[str, tuple[str, float, float]] = {}
        with open_table(archive, "stops.txt") as table:
            sid, name, lat, lon = (
                table.index(c) for c in ("stop_id", "stop_name", "stop_lat", "stop_lon")
            )
            parent = table.optional_index("parent_station")
            all_rows = {}
            for row in table.rows:
                all_rows[row[sid]] = (
                    row[name],
                    float(row[lat] or "nan"),
                    float(row[lon] or "nan"),
                    row[parent].strip() if parent is not None else "",
                )
        for key in needed:
            stops[key] = all_rows[key]
            p = all_rows[key][3]
            if p and p in all_rows:
                parents[p] = all_rows[p][:3]
        del all_rows

    with zipfile.ZipFile(args.eva_mirror) as mirror:
        index = EvaIndex(read_eva_stations(mirror))
    outline = NationalOutline.from_geojson(args.outline)

    stop_info: dict[str, tuple[int | None, str, bool, str, float, float]] = {}
    for key, (name, la, lo, parent) in stops.items():
        place_key, place_name, pla, plo = key, name, la, lo
        if parent and parent in parents:
            place_key = parent
            place_name, pla, plo = parents[parent]
        match = index.exact(place_key, pla, plo) or index.exact(key, la, lo)
        method = "exact"
        if match is None:
            match = index.match(place_name, pla, plo)
            method = "spatial"
        stop_info[key] = (
            match.eva if match else None,
            method if match else "",
            outline.contains(la, lo),
            place_key,
            la,
            lo,
        )

    trip_rows: dict[str, list] = {
        c: []
        for c in (
            "trip_id",
            "service_date",
            "route_id",
            "category",
            "rule",
            "operator_id",
            "operator_name",
            "agency_name",
            "route_short_name",
            "trip_short_name",
            "first_dep_utc",
            "last_arr_utc",
            "n_stops",
            "km",
            "km_in_window",
            "cross_border",
            "foreign_operator",
        )
    }
    st_rows: dict[str, list] = {
        c: []
        for c in (
            "trip_id",
            "service_date",
            "idx",
            "seq",
            "stop_id",
            "place_id",
            "eva",
            "eva_method",
            "in_de",
            "lat",
            "lon",
            "arr_utc",
            "dep_utc",
        )
    }
    for key, rows in times.items():
        trip = kept[key]
        route = routes.routes[trip.route_key]
        operator = catalog.for_agency(route.agency_key)
        rows.sort()
        stop_keys = result.patterns[result.trip_times[key].trip_pattern_id].stop_keys
        for day in day_trips[key]:
            base = service_noon_minus_12h_utc(day)
            arr = [base + r[1] if r[1] is not None else None for r in rows]
            dep = [base + r[2] if r[2] is not None else None for r in rows]
            first = dep[0] if dep[0] is not None else arr[0]
            last = arr[-1] if arr[-1] is not None else dep[-1]
            if first is None or last is None or last < w0 or first > w1:
                continue
            km = km_window = 0.0
            for i in range(len(stop_keys) - 1):
                a, b = stop_info[stop_keys[i]], stop_info[stop_keys[i + 1]]
                seg = haversine_km(a[4], a[5], b[4], b[5])
                km += seg
                t0 = dep[i] if dep[i] is not None else arr[i]
                t1 = arr[i + 1] if arr[i + 1] is not None else dep[i + 1]
                if t0 is None or t1 is None:
                    continue
                if t1 <= t0:
                    km_window += seg if w0 <= t0 <= w1 else 0.0
                    continue
                overlap = max(0, min(t1, w1) - max(t0, w0))
                km_window += seg * overlap / (t1 - t0)
            in_de = [stop_info[s][2] for s in stop_keys]
            trip_rows["trip_id"].append(key)
            trip_rows["service_date"].append(day)
            trip_rows["route_id"].append(trip.route_key)
            trip_rows["category"].append(route.category.value)
            trip_rows["rule"].append(route.classification.rule)
            trip_rows["operator_id"].append(operator.operator_id if operator else None)
            trip_rows["operator_name"].append(operator.name if operator else None)
            trip_rows["agency_name"].append(agency_names.get(route.agency_key, ""))
            trip_rows["route_short_name"].append(route.short_name)
            trip_rows["trip_short_name"].append(trip.short_name)
            trip_rows["first_dep_utc"].append(first)
            trip_rows["last_arr_utc"].append(last)
            trip_rows["n_stops"].append(len(stop_keys))
            trip_rows["km"].append(round(km, 3))
            trip_rows["km_in_window"].append(round(km_window, 3))
            trip_rows["cross_border"].append(not all(in_de))
            trip_rows["foreign_operator"].append(route.is_foreign)
            for i, s in enumerate(stop_keys):
                info = stop_info[s]
                st_rows["trip_id"].append(key)
                st_rows["service_date"].append(day)
                st_rows["idx"].append(i)
                st_rows["seq"].append(rows[i][5])
                st_rows["stop_id"].append(s)
                st_rows["place_id"].append(info[3])
                st_rows["eva"].append(info[0])
                st_rows["eva_method"].append(info[1])
                st_rows["in_de"].append(info[2])
                st_rows["lat"].append(info[4])
                st_rows["lon"].append(info[5])
                st_rows["arr_utc"].append(arr[i])
                st_rows["dep_utc"].append(dep[i])

    pq.write_table(pa.table(trip_rows), out / "trips.parquet")
    pq.write_table(pa.table(st_rows), out / "stop_times.parquet")
    report["universe_trips"] = len(trip_rows["trip_id"])
    report["universe_stop_times"] = len(st_rows["trip_id"])
    (out / "universe-report.json").write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
