"""Match gtfs.de static trips (fv and rv free feeds) to the DELFI universe by stops and times.

Rule as in WP-2.3: stops within 400 m and times within one minute, at least 2 shared stops and at
least 75 % of the shorter trip's stops, and a unique best candidate. Categories of gtfs.de routes
come from ``gerlines_static_import.categories.classify``.

Usage: python -I gtfsde_match.py --static ZIP [--static ZIP] --universe DIR --window-start ISO
       --window-end ISO --out DIR
"""

import argparse
import datetime as dt
import json
import zipfile
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from gerlines_static_import.categories import classify
from gerlines_static_import.gtfs import open_table, parse_date, parse_int, parse_time

BERLIN = ZoneInfo("Europe/Berlin")
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def base_utc(day: dt.date) -> int:
    noon = dt.datetime(day.year, day.month, day.day, 12, tzinfo=BERLIN)
    return int(noon.timestamp()) - 12 * 3600


def read_feed(path: Path, feed: str, days: list[dt.date], w0: int, w1: int) -> dict[str, list]:
    trips: dict[str, list] = {
        c: []
        for c in (
            "feed",
            "g_trip_id",
            "service_date",
            "route_short_name",
            "agency_name",
            "category",
            "first_dep_utc",
            "last_arr_utc",
            "n_stops",
        )
    }
    events: dict[str, list] = {
        c: [] for c in ("g_trip_id", "service_date", "seq", "lat", "lon", "arr_utc", "dep_utc")
    }
    with zipfile.ZipFile(path) as z:
        with open_table(z, "agency.txt") as t:
            agencies = {r[t.index("agency_id")]: r[t.index("agency_name")] for r in t.rows}
        with open_table(z, "routes.txt") as t:
            routes = {
                r[t.index("route_id")]: (
                    r[t.index("route_short_name")].strip(),
                    parse_int(r[t.index("route_type")]),
                    agencies.get(r[t.index("agency_id")], ""),
                )
                for r in t.rows
            }
        with open_table(z, "calendar.txt") as t:
            cal = {
                r[t.index("service_id")]: (
                    parse_date(r[t.index("start_date")]),
                    parse_date(r[t.index("end_date")]),
                    [r[t.index(d)] == "1" for d in WEEKDAYS],
                )
                for r in t.rows
            }
        exceptions: dict[tuple[str, dt.date], int] = {}
        with open_table(z, "calendar_dates.txt") as t:
            for r in t.rows:
                exceptions[(r[t.index("service_id")], parse_date(r[t.index("date")]))] = int(
                    r[t.index("exception_type")]
                )
        with open_table(z, "trips.txt") as t:
            trip_route = {
                r[t.index("trip_id")]: (r[t.index("route_id")], r[t.index("service_id")])
                for r in t.rows
            }
        with open_table(z, "stops.txt") as t:
            stops = {
                r[t.index("stop_id")]: (
                    float(r[t.index("stop_lat")]),
                    float(r[t.index("stop_lon")]),
                )
                for r in t.rows
            }

        def active(service: str, day: dt.date) -> bool:
            kind = exceptions.get((service, day))
            if kind is not None:
                return kind == 1
            c = cal.get(service)
            return bool(c and c[0] <= day <= c[1] and c[2][day.weekday()])

        rows: dict[str, list] = {}
        with open_table(z, "stop_times.txt") as t:
            tid, sid, seq = t.index("trip_id"), t.index("stop_id"), t.index("stop_sequence")
            arr, dep = t.index("arrival_time"), t.index("departure_time")
            for r in t.rows:
                rows.setdefault(r[tid], []).append(
                    (int(r[seq]), r[sid], parse_time(r[arr]), parse_time(r[dep]))
                )

    for trip_id, stop_rows in rows.items():
        route_id, service = trip_route[trip_id]
        short, route_type, agency = routes[route_id]
        category = classify(route_type, short, agency).category
        stop_rows.sort()
        for day in days:
            if not active(service, day):
                continue
            b = base_utc(day)
            first = stop_rows[0][3] if stop_rows[0][3] is not None else stop_rows[0][2]
            last = stop_rows[-1][2] if stop_rows[-1][2] is not None else stop_rows[-1][3]
            if first is None or last is None or b + last < w0 or b + first > w1:
                continue
            trips["feed"].append(feed)
            trips["g_trip_id"].append(trip_id)
            trips["service_date"].append(day)
            trips["route_short_name"].append(short)
            trips["agency_name"].append(agency)
            trips["category"].append(category.value if category else None)
            trips["first_dep_utc"].append(b + first)
            trips["last_arr_utc"].append(b + last)
            trips["n_stops"].append(len(stop_rows))
            for s, stop_id, a, d in stop_rows:
                lat, lon = stops[stop_id]
                events["g_trip_id"].append(trip_id)
                events["service_date"].append(day)
                events["seq"].append(s)
                events["lat"].append(lat)
                events["lon"].append(lon)
                events["arr_utc"].append(b + a if a is not None else None)
                events["dep_utc"].append(b + d if d is not None else None)
    return {"trips": trips, "events": events}


MATCH_SQL = """
with g as (
  select g_trip_id, service_date, seq, lat, lon, coalesce(dep_utc, arr_utc) // 60 as m,
         floor(lat / 0.004)::int as cy, floor(lon / 0.006)::int as cx
  from g_events
), d as (
  select trip_id, service_date, idx, lat, lon, coalesce(dep_utc, arr_utc) // 60 as m,
         floor(lat / 0.004)::int as cy, floor(lon / 0.006)::int as cx
  from read_parquet($universe || '/stop_times.parquet')
), shifts as (
  select * from range(-1, 2) a(dy), range(-1, 2) b(dx), range(-1, 2) c(dm)
), pairs as (
  select g.g_trip_id, g.service_date, d.trip_id, count(distinct g.seq) as shared
  from g, shifts s
  join d on d.cy = g.cy + s.dy and d.cx = g.cx + s.dx and d.m = g.m + s.dm
           and d.service_date = g.service_date
  where 2 * 6371000 * asin(sqrt(
          pow(sin(radians(d.lat - g.lat) / 2), 2)
          + cos(radians(g.lat)) * cos(radians(d.lat)) * pow(sin(radians(d.lon - g.lon) / 2), 2)
        )) <= 400
  group by all
), scored as (
  select p.*, gt.n_stops as g_stops, ut.n_stops as d_stops,
         p.shared >= 2 and p.shared >= 0.75 * least(gt.n_stops, ut.n_stops) as ok
  from pairs p
  join g_trips gt using (g_trip_id, service_date)
  join read_parquet($universe || '/trips.parquet') ut
    on ut.trip_id = p.trip_id and ut.service_date = p.service_date
), ranked as (
  select *, count(*) over (partition by g_trip_id, service_date, shared) as ties,
         row_number() over (partition by g_trip_id, service_date order by shared desc, trip_id) as rk
  from scored where ok
)
select g_trip_id, service_date, trip_id, shared, g_stops, d_stops, ties > 1 as ambiguous
from ranked where rk = 1
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--static", type=Path, action="append", required=True)
    parser.add_argument("--universe", type=Path, required=True)
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    w0 = int(dt.datetime.fromisoformat(args.window_start).timestamp())
    w1 = int(dt.datetime.fromisoformat(args.window_end).timestamp())
    day = dt.datetime.fromtimestamp(w0, BERLIN).date()
    days = [day - dt.timedelta(days=1), day]
    trips: dict[str, list] = {}
    events: dict[str, list] = {}
    for path in args.static:
        part = read_feed(path, path.parent.parent.name, days, w0, w1)
        for key, values in part["trips"].items():
            trips.setdefault(key, []).extend(values)
        for key, values in part["events"].items():
            events.setdefault(key, []).extend(values)
    g_trips, g_events = pa.table(trips), pa.table(events)
    args.out.mkdir(parents=True, exist_ok=True)
    pq.write_table(g_trips, args.out / "gtfsde_trips.parquet")

    con = duckdb.connect()
    con.register("g_trips", g_trips)
    con.register("g_events", g_events)
    matches = con.execute(MATCH_SQL, {"universe": str(args.universe)}).fetch_arrow_table()
    con.register("matches", matches)
    pq.write_table(matches, args.out / "gtfsde_match.parquet")
    summary = con.execute(
        """
        select gt.category, count(*) as g_trips, count(m.trip_id) as matched,
               count(*) filter (where m.ambiguous) as ambiguous
        from g_trips gt left join matches m using (g_trip_id, service_date)
        group by 1 order by 2 desc
        """
    ).fetchall()
    report = {"g_trips": g_trips.num_rows, "by_category": summary}
    (args.out / "gtfsde_match_report.json").write_text(json.dumps(report, indent=1, default=str))
    print(json.dumps(report, indent=1, default=str))


if __name__ == "__main__":
    main()
