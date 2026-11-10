"""SP-2 coverage tables: which share of the train runs in the window has live data in each source.

Usage: python -I coverage.py --data DIR --window-start ISO --window-end ISO --rt NAME=PARQUET ...
       [--gtfsde-source NAME] --out DIR

Definitions (also in the README):
- universe: DELFI train trips running at some moment of the window (``universe/trips.parquet``);
  duplicates of one train run (same service date, category, train number, first departure and
  last arrival) collapse to one run, canonical trip = smallest trip id;
- live in a source: the run appears in at least one payload of the window with at least one stop
  time update, or as a cancelled trip;
- passed delay: some stop time update carries a delay or time for a stop whose scheduled time is at
  or before the payload's fetch time;
- IRIS: runs with a stop event in the window at one of the sampled stations, joined to the IRIS plan
  by station EVA, train number and planned time (two minutes); live when a fchg of the window names
  that stop with a changed time or a cancellation.
"""

import argparse
import datetime as dt
import json
from pathlib import Path

import duckdb


def run(
    con: duckdb.DuckDBPyConnection, sql: str, params: dict[str, object]
) -> duckdb.DuckDBPyConnection:
    used = {key: value for key, value in params.items() if f"${key}" in sql}
    return con.execute(sql, used)


SETUP = """
create or replace table trips as
select t.*,
       try_cast(nullif(regexp_replace(t.trip_short_name, '\\D', '', 'g'), '') as bigint) as number
from read_parquet($data || '/universe/trips.parquet') t;

create or replace table runs as
select *, min(trip_id) over (
         partition by service_date, category,
           coalesce(number::varchar, trip_id), first_dep_utc, last_arr_utc) as run_id
from trips;

create or replace table stop_times as
select * from read_parquet($data || '/universe/stop_times.parquet');

create or replace table top_ops as
select operator_name, sum(km_in_window) as km, row_number() over (order by sum(km_in_window) desc) as rank
from trips group by 1;
"""

OBS_DELFI = """
select t.run_id, o.fetched_at, o.header_ts, o.trip_sr, o.n_stu, u.unnest as s, t.service_date, t.trip_id
from read_parquet($path) o
join runs t on t.trip_id = o.trip_id and strftime(t.service_date, '%Y%m%d') = o.start_date
left join unnest(o.stus) u on true
where o.tick >= $w0 and o.tick < $w1
"""

OBS_GTFSDE = """
select r.run_id, o.fetched_at, o.header_ts, o.trip_sr, o.n_stu, u.unnest as s, r.service_date, r.trip_id
from read_parquet($path) o
join read_parquet($data || '/gtfsde/gtfsde_match.parquet') m
  on m.g_trip_id = o.trip_id and strftime(m.service_date, '%Y%m%d') = o.start_date
join runs r on r.trip_id = m.trip_id and r.service_date = m.service_date
left join unnest(o.stus) u on true
where o.tick >= $w0 and o.tick < $w1
"""

PER_SOURCE = """
create or replace table cov_{name} as
with obs as ({obs}),
st as (
  select o.*, coalesce(x.dep_utc, x.arr_utc) as sched
  from obs o
  left join stop_times x
    on x.trip_id = o.trip_id and x.service_date = o.service_date and x.seq = o.s.seq
)
select run_id,
       bool_or(n_stu > 0 or trip_sr = 3) as live,
       bool_or(trip_sr = 3) as cancelled,
       bool_or(
         (s.arr_delay is not null or s.dep_delay is not null
          or s.arr_time is not null or s.dep_time is not null)
         and s.sr <> 2
         and coalesce(
               sched,
               coalesce(s.dep_time, s.arr_time) - coalesce(s.dep_delay, s.arr_delay, 0)
             ) <= fetched_at
       ) as passed_delay,
       bool_or(coalesce(s.arr_delay, 0) <> 0 or coalesce(s.dep_delay, 0) <> 0) as nonzero
from st group by run_id
"""

IRIS = """
create or replace table iris_plan as
select p.*, case when p.eva in (8098160) then 8011160 else p.eva end as join_eva,
       try_cast(p.n as bigint) as number
from read_parquet($data || '/iris/iris_plan.parquet') p;

create or replace table iris_fchg as
select * from read_parquet($data || '/iris/iris_fchg.parquet') where fetched_at >= $w0 and fetched_at < $w1;

create or replace table iris_events as
select r.run_id, r.category, x.trip_id, x.service_date, x.idx, x.eva,
       coalesce(x.dep_utc, x.arr_utc) as sched
from stop_times x join runs r using (trip_id, service_date)
where x.eva in (select distinct join_eva from iris_plan)
  and coalesce(x.dep_utc, x.arr_utc) between $w0 and $w1;

create or replace table iris_join as
select e.*, p.stop_id as iris_stop_id, p.eva as iris_eva, p.c as iris_c,
       coalesce(p.dp_pt, p.ar_pt) as iris_pt
from iris_events e
left join runs r using (run_id)
left join iris_plan p
  on p.join_eva = e.eva
 and (p.number = r.number
      or (r.number is null and p.c = upper(regexp_extract(r.route_short_name, '^([A-Za-z]+)', 1))
          and abs(coalesce(p.dp_pt, p.ar_pt) - e.sched) <= 60))
 and abs(coalesce(p.dp_pt, p.ar_pt) - e.sched) <= 120
qualify row_number() over (partition by e.trip_id, e.service_date, e.idx
                           order by abs(coalesce(p.dp_pt, p.ar_pt) - e.sched)) = 1;

create or replace table cov_iris as
select j.run_id,
       bool_or(j.iris_stop_id is not null) as in_plan,
       bool_or(f.stop_id is not null
               and (f.ar_ct is not null or f.dp_ct is not null
                    or f.ar_cs = 'c' or f.dp_cs = 'c')) as live,
       bool_or(f.ar_cs = 'c' or f.dp_cs = 'c') as cancelled,
       bool_or((f.ar_ct is not null or f.dp_ct is not null) and j.iris_pt <= f.fetched_at)
         as passed_delay,
       bool_or(coalesce(f.dp_ct, f.ar_ct) <> j.iris_pt) as nonzero
from iris_join j
left join iris_fchg f on f.stop_id = j.iris_stop_id and f.eva = j.iris_eva
group by j.run_id;
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--rt", action="append", default=[], help="NAME=PARQUET")
    parser.add_argument("--gtfsde-source", default="gtfsde")
    parser.add_argument("--iris", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    w0 = int(dt.datetime.fromisoformat(args.window_start).timestamp())
    w1 = int(dt.datetime.fromisoformat(args.window_end).timestamp())
    con = duckdb.connect()
    params = {"data": str(args.data)}
    for statement in SETUP.split(";"):
        if statement.strip():
            run(con, statement, params)

    sources: list[str] = []
    ages: dict[str, dict[str, float]] = {}
    for spec in args.rt:
        name, path = spec.split("=", 1)
        obs = OBS_GTFSDE if name == args.gtfsde_source else OBS_DELFI
        sql = PER_SOURCE.format(name=name.replace("-", "_"), obs=obs)
        run(con, sql, {"path": path, "w0": w0, "w1": w1, "data": str(args.data)})
        row = con.execute(
            """
            select count(distinct fetched_at), median(fetched_at - header_ts),
                   quantile_cont(fetched_at - header_ts, 0.9)
            from (select distinct fetched_at, header_ts from read_parquet($path)
                  where tick >= $w0 and tick < $w1)
            """,
            {"path": path, "w0": w0, "w1": w1},
        ).fetchone()
        ages[name] = {"payloads": row[0], "median_age_s": row[1], "p90_age_s": row[2]}
        sources.append(name.replace("-", "_"))

    if args.iris:
        for statement in IRIS.split(";"):
            if statement.strip():
                run(con, statement, {"data": str(args.data), "w0": w0, "w1": w1})
        row = con.execute(
            """
            select count(distinct (eva, fetched_at)), count(distinct eva),
                   median(gap) from (
              select eva, fetched_at,
                     fetched_at - lag(fetched_at) over (partition by eva order by fetched_at) as gap
              from (select distinct eva, fetched_at from iris_fchg))
            """
        ).fetchone()
        ages["iris"] = {"fchg_payloads": row[0], "stations": row[1], "median_poll_gap_s": row[2]}
        sources.append("iris")

    cols = ",\n".join(
        f"coalesce({s}.live, false) as live_{s}, coalesce({s}.passed_delay, false) as delay_{s}, "
        f"coalesce({s}.nonzero, false) as nonzero_{s}"
        for s in sources
    )
    joins = "\n".join(f"left join cov_{s} {s} on {s}.run_id = r.run_id" for s in sources)
    con.execute(
        f"""
        create or replace table run_cov as
        select r.run_id, r.category, r.operator_name, r.cross_border, r.km_in_window,
               coalesce(o.rank <= 30, false) as top30,
               {"coalesce(iris_scope.in_plan, false) as iris_in_plan, iris_scope.run_id is not null as iris_scope," if "iris" in sources else ""}
               {cols}
        from (select distinct on (run_id) * from runs order by run_id, trip_id) r
        left join top_ops o on o.operator_name = r.operator_name
        {"left join cov_iris iris_scope on iris_scope.run_id = r.run_id" if "iris" in sources else ""}
        {joins}
        """
    )
    args.out.mkdir(parents=True, exist_ok=True)
    pct = ", ".join(
        f"round(100.0 * avg(live_{s}::int), 1) as live_{s}, "
        f"round(100.0 * avg(delay_{s}::int), 1) as delay_{s}, "
        f"round(100.0 * avg(nonzero_{s}::int), 1) as nonzero_{s}"
        for s in sources
        if s != "iris"
    )
    delfi_union = " or ".join(f"live_{s}" for s in sources if s not in {"iris", args.gtfsde_source})
    any_union = " or ".join(f"live_{s}" for s in sources if s != "iris")
    extra = ""
    if delfi_union:
        extra += f", round(100.0 * avg(({delfi_union})::int), 1) as live_any_delfi"
    if any_union:
        extra += f", round(100.0 * avg(({any_union})::int), 1) as live_any_gtfsrt"
    order = "case category when 'hsr' then 1 when 'ld' then 2 when 'night' then 3 when 'rfast' then 4 when 'reg' then 5 else 6 end"
    queries = {
        "by_category": f"select category, count(*) as runs, {pct}{extra} from run_cov group by category order by {order}",
        "by_border": f"select category, cross_border, count(*) as runs, {pct}{extra} from run_cov group by category, cross_border order by {order}, 2",
        "by_operator": f"""
            select case when top30 then operator_name else 'all other operators' end as operator,
                   round(sum(km_in_window)) as train_km_in_window, count(*) as runs, {pct}{extra}
            from run_cov group by 1 order by (operator = 'all other operators'), 2 desc""",
        "total": f"select count(*) as runs, {pct}{extra} from run_cov",
    }
    if "iris" in sources:
        others = ", ".join(
            f"round(100.0 * avg(live_{s}::int), 1) as live_{s}" for s in sources if s != "iris"
        )
        queries["iris_scope"] = f"""
            select category, count(*) as runs_at_iris_stations,
                   round(100.0 * avg(iris_in_plan::int), 1) as in_iris_plan,
                   round(100.0 * avg(live_iris::int), 1) as live_iris,
                   round(100.0 * avg(delay_iris::int), 1) as delay_iris,
                   round(100.0 * avg(nonzero_iris::int), 1) as nonzero_iris, {others}
                   {extra}, round(100.0 * avg(({any_union} or live_iris)::int), 1) as live_any_incl_iris
            from run_cov where iris_scope group by category order by {order}"""
    report: dict[str, object] = {"window": [args.window_start, args.window_end], "ages": ages}
    for name, sql in queries.items():
        rel = con.sql(sql)
        rel.write_csv(str(args.out / f"{name}.csv"))
        print(f"\n== {name}")
        rel.show(max_rows=60, max_width=250)
    report["universe"] = con.execute(
        "select count(*) as trips, count(distinct run_id) as runs from runs"
    ).fetchone()
    report["sources"] = sources
    (args.out / "report.json").write_text(json.dumps(report, indent=1, default=str))
    print(json.dumps(report, indent=1, default=str))


if __name__ == "__main__":
    main()
