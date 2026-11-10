"""Watch a MOTIS server that polls GTFS-RT: RSS, realtime share of map/trips, plan latency.

Usage: rt_watch.py --base http://127.0.0.1:8090 --pid <server pid> --minutes 20 --out <rt.json>
Samples once per --interval seconds with the current time as the query time. Each sample goes to
<out>l (JSON lines) as it is taken; <out> gets the full list at the end.
Run it without python -I: it imports bench.py from its own directory.
"""

import argparse
import datetime
import json
import pathlib
import statistics
import time

from bench import (
    DEFAULT_DATASET_TAG,
    GERMANY_MAX,
    GERMANY_MIN,
    STATIONS,
    Client,
    footprint_mb,
    rss_mb,
)


def iso(moment: datetime.datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def sample(client: Client, pid: int | None, dataset_tag: str) -> dict:
    now = datetime.datetime.now(datetime.UTC)
    params = {
        "zoom": 8,
        "min": GERMANY_MIN,
        "max": GERMANY_MAX,
        "startTime": iso(now),
        "endTime": iso(now + datetime.timedelta(minutes=1)),
        "precision": 5,
    }
    trips_s, trips_bytes, segments = client.get("/api/v6/map/trips", params)
    realtime = [seg for seg in segments if seg.get("realTime")]
    delays = [
        (
            datetime.datetime.fromisoformat(seg["departure"])
            - datetime.datetime.fromisoformat(seg["scheduledDeparture"])
        ).total_seconds()
        / 60
        for seg in realtime
    ]
    plan = {
        "fromPlace": f"{dataset_tag}_{STATIONS['Berlin Hbf']}",
        "toPlace": f"{dataset_tag}_{STATIONS['München Hbf']}",
        "time": iso(now),
    }
    plan_s, _, body = client.get("/api/v6/plan", plan)
    legs = [
        leg for it in body.get("itineraries", []) for leg in it["legs"] if leg["mode"] != "WALK"
    ]
    return {
        "time": iso(now),
        "rss_mb": rss_mb(pid),
        "footprint_mb": footprint_mb(pid),
        "map_trips_ms": round(trips_s * 1000, 1),
        "map_trips_bytes": trips_bytes,
        "segments": len(segments),
        "realtime_segments": len(realtime),
        "median_departure_delay_min": round(statistics.median(delays), 1) if delays else None,
        "max_departure_delay_min": round(max(delays), 1) if delays else None,
        "plan_ms": round(plan_s * 1000, 1),
        "plan_realtime_legs": sum(1 for leg in legs if leg.get("realTime")),
        "plan_legs": len(legs),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8090")
    parser.add_argument("--dataset-tag", default=DEFAULT_DATASET_TAG)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--minutes", type=float, default=20)
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    client = Client(args.base)
    out = pathlib.Path(args.out)
    lines = out.with_name(out.name + "l")
    lines.write_text("", encoding="utf-8")
    samples = []
    deadline = time.monotonic() + args.minutes * 60
    while time.monotonic() < deadline:
        samples.append(sample(client, args.pid, args.dataset_tag))
        line = json.dumps(samples[-1])
        with lines.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        print(line, flush=True)
        time.sleep(args.interval)
    out.write_text(json.dumps(samples, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
