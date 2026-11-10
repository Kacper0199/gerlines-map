"""Greedy choice of IRIS stations for a long-distance poller.

Usage: python -I iris_station_cover.py <data-dir> [--categories hsr,ld,night] [--max-gap-min 30] [--limit 120]

A run is covered at a moment when it called at a chosen station within the last ``max-gap-min`` minutes
(scheduled), so a station poll gives its delay. The greedy step adds the station that covers the most uncovered
(run, 10-minute slot) pairs while the run is inside Germany. Prints the cumulative share of slots covered and of
runs seen at least once, per number of stations, and the request rate at fchg every 3 min plus one plan per hour.
"""

import argparse
from pathlib import Path

import duckdb


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data", type=Path)
    parser.add_argument("--categories", default="hsr,ld,night")
    parser.add_argument("--max-gap-min", type=int, default=30)
    parser.add_argument("--limit", type=int, default=120)
    args = parser.parse_args()
    cats = [c.strip() for c in args.categories.split(",")]
    con = duckdb.connect()
    con.execute(
        """
        create table ev as
        select x.trip_id || '/' || x.service_date as run, x.eva,
               coalesce(x.dep_utc, x.arr_utc) as t
        from read_parquet($u || '/stop_times.parquet') x
        join read_parquet($u || '/trips.parquet') r using (trip_id, service_date)
        where r.category in (select unnest($cats)) and x.in_de and x.eva is not null
        """,
        {"u": str(args.data / "universe"), "cats": cats},
    )
    con.execute(
        """
        create table slots as
        select run, slot from (
          select run, unnest(range((min(t) // 600) * 600, max(t) + 1, 600)) as slot
          from ev group by run)
        """
    )
    con.execute(
        """
        create table cover as
        select distinct e.eva, s.run, s.slot
        from slots s join ev e on e.run = s.run
         and e.t <= s.slot + 600 and e.t > s.slot - $gap * 60
        """,
        {"gap": args.max_gap_min},
    )
    total_slots = con.execute("select count(*) from slots").fetchone()[0]
    total_runs = con.execute("select count(distinct run) from slots").fetchone()[0]
    names = dict(
        con.execute(
            "select eva, any_value(place_id) from read_parquet($u || '/stop_times.parquet') "
            "where eva is not null group by eva",
            {"u": str(args.data / "universe")},
        ).fetchall()
    )
    con.execute("create table covered (run varchar, slot bigint)")
    con.execute("create table seen (run varchar)")
    chosen: list[int] = []
    print(
        f"runs {total_runs}, run slots {total_slots}, categories {cats}, max gap {args.max_gap_min} min"
    )
    print("n   eva      slots%  runs_seen%  req_per_min  place")
    for n in range(1, args.limit + 1):
        best = con.execute(
            """
            select c.eva, count(*) as gain from cover c
            anti join covered k on k.run = c.run and k.slot = c.slot
            group by c.eva order by gain desc, c.eva limit 1
            """
        ).fetchone()
        if best is None or best[1] == 0:
            break
        chosen.append(best[0])
        con.execute(
            "insert into covered select run, slot from cover where eva = $e "
            "except select run, slot from covered",
            {"e": best[0]},
        )
        con.execute(
            "insert into seen select distinct run from ev where eva = $e except select run from seen",
            {"e": best[0]},
        )
        cs = con.execute("select count(*) from covered").fetchone()[0]
        rs = con.execute("select count(*) from seen").fetchone()[0]
        if n <= 10 or n % 10 == 0:
            rate = n * (1 / 3 + 1 / 60)
            print(
                f"{n:<4}{best[0]:<9}{100 * cs / total_slots:6.1f}  {100 * rs / total_runs:9.1f}"
                f"  {rate:11.1f}  {names.get(best[0], '')}"
            )
    print("stations:", ",".join(str(e) for e in chosen))


if __name__ == "__main__":
    main()
