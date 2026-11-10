"""Category parity between our API and our database over every train trip of one weekday.

For every train trip of the newest loaded feed version that runs on `--date`, asks MOTIS
`/api/v6/trip` (with `joinInterlinedLegs=false`) for it, takes the trip's own leg, and lets the
API's category logic (`categoryOfLeg` in `apps/api/src/router/categories.ts`, run through
`apps/api/scripts/categorize-legs.mjs`) name its category from `routeType`, `displayName` and
`mode`. That category is compared with the trip's `category_code` in the database. The MOTIS mode
is also compared with the MOTIS classes of the category (`category.motis_classes`), for the record:
MOTIS reports one class per stay-seated run. Writes a JSON report with every disagreeing trip, the
disagreeing routes, every trip MOTIS did not find and the `displayName` of each disagreeing leg.

Usage: parity.py --motis http://127.0.0.1:8092 --out <report.json> [--date 2026-10-27]
       [--dataset-tag de-DELFI] [--workers 4] [--node node]
Env: PGHOST (default 127.0.0.1), PGPORT (default 5433), PGDATABASE (default gerlines_replay), and
POSTGRES_USER and POSTGRES_PASSWORD (or PGUSER and PGPASSWORD). Node 24 on PATH.
Run with `uv run --no-project --with psycopg[binary]==3.3.6`.
"""

import argparse
import collections
import concurrent.futures
import datetime as dt
import http.client
import json
import os
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import psycopg

CATEGORIZE_SCRIPT = Path(__file__).resolve().parents[3] / "apps/api/scripts/categorize-legs.mjs"

TRIP_SQL = """
WITH version AS (
  SELECT feed_version_id FROM feed_version
  WHERE status = 'loaded' ORDER BY loaded_at DESC LIMIT 1
)
SELECT
  t.trip_key, t.short_name AS trip_short_name, t.first_departure_s, t.block_key,
  t.category_code, r.route_key, r.short_name, r.long_name, r.gtfs_route_type, r.category_rule,
  r.operator_id, cat.motis_classes
FROM version v
JOIN trip t ON t.feed_version_id = v.feed_version_id
JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
JOIN category cat ON cat.category_code = t.category_code AND cat.is_train
JOIN service_calendar c
  ON c.feed_version_id = t.feed_version_id AND c.service_key = t.service_key
LEFT JOIN service_calendar_date x
  ON x.feed_version_id = t.feed_version_id
 AND x.service_key = t.service_key
 AND x.service_date = %(day)s::date
WHERE x.exception_type = 1
   OR (x.exception_type IS NULL
       AND %(day)s::date BETWEEN c.start_date AND c.end_date
       AND c.weekdays & (1 << (extract(isodow FROM %(day)s::date)::int - 1)) <> 0)
ORDER BY t.trip_key
"""


class CategorizeError(RuntimeError):
    def __init__(self, answered: int, asked: int) -> None:
        super().__init__(f"categorize-legs answered {answered} of {asked} legs")


LIST_KEYS = {"api_mismatches", "api_mismatch_routes", "mode_mismatches", "not_found"}


def motis_trip_id(tag: str, service_date: dt.date, departure_s: int, trip_key: str) -> str:
    hours, rest = divmod(departure_s, 3600)
    return f"{service_date:%Y%m%d}_{hours:02d}:{rest // 60:02d}_{tag}_{trip_key}"


def fetch_trip(base: str, trip_id: str) -> tuple[int, dict | None, float]:
    parsed = urllib.parse.urlsplit(base)
    query = urllib.parse.urlencode(
        {"tripId": trip_id, "joinInterlinedLegs": "false", "detailedLegs": "false"}
    )
    connection = http.client.HTTPConnection(
        parsed.hostname or "127.0.0.1", parsed.port or 80, timeout=30
    )
    started = time.perf_counter()
    try:
        connection.request("GET", f"/api/v6/trip?{query}")
        response = connection.getresponse()
        body = response.read()
    finally:
        connection.close()
    elapsed = time.perf_counter() - started
    if response.status != http.HTTPStatus.OK:
        return response.status, None, elapsed
    return response.status, json.loads(body), elapsed


def leg_for(itinerary: dict, trip_id: str) -> dict | None:
    return next((leg for leg in itinerary.get("legs", []) if leg.get("tripId") == trip_id), None)


def categorize(node: str, legs: list[dict]) -> list[str]:
    identities = [
        {key: leg.get(key) for key in ("routeType", "mode", "displayName", "agencyName")}
        for leg in legs
    ]
    result = subprocess.run(  # noqa: S603
        [node, str(CATEGORIZE_SCRIPT)],
        input=json.dumps(identities),
        capture_output=True,
        text=True,
        check=True,
    )
    categories = json.loads(result.stdout)
    if len(categories) != len(legs):
        raise CategorizeError(len(categories), len(legs))
    return categories


def connect() -> psycopg.Connection:
    return psycopg.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=os.environ.get("PGPORT", "5433"),
        dbname=os.environ.get("PGDATABASE", "gerlines_replay"),
        user=os.environ.get("PGUSER") or os.environ["POSTGRES_USER"],
        password=os.environ.get("PGPASSWORD") or os.environ["POSTGRES_PASSWORD"],
    )


def block_legs(body: dict) -> list[dict]:
    return [
        {
            "trip_id": other.get("tripId"),
            "mode": other.get("mode"),
            "route_type": other.get("routeType"),
            "display_name": other.get("displayName"),
            "stay_seated": other.get("interlineWithPreviousLeg", False),
        }
        for other in body.get("legs", [])
    ]


def mismatch_routes(mismatches: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for record in mismatches:
        route = grouped.setdefault(
            record["route_key"],
            {
                "route_key": record["route_key"],
                "short_name": record["short_name"],
                "long_name": record["long_name"],
                "operator_id": record["operator_id"],
                "category": record["category"],
                "category_rule": record["category_rule"],
                "api_categories": set(),
                "display_names": set(),
                "motis_route_types": set(),
                "trips": 0,
            },
        )
        route["api_categories"].add(record["api_category"])
        route["display_names"].add(record["display_name"])
        route["motis_route_types"].add(record["motis_route_type"])
        route["trips"] += 1
    return [
        {
            key: sorted(value, key=str) if isinstance(value, set) else value
            for key, value in route.items()
        }
        for route in sorted(grouped.values(), key=lambda route: route["route_key"])
    ]


def percentile(values: list[float], share: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * share))] * 1000, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--motis", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--dataset-tag", default="de-DELFI")
    parser.add_argument("--date", default="2026-10-27", type=dt.date.fromisoformat)
    parser.add_argument("--workers", default=4, type=int)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()

    started = time.perf_counter()
    with connect() as connection, connection.cursor() as cursor:
        cursor.execute(TRIP_SQL, {"day": args.date})
        columns = [column.name for column in cursor.description]
        trips = [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]

    trip_ids = [
        motis_trip_id(args.dataset_tag, args.date, trip["first_departure_s"], trip["trip_key"])
        for trip in trips
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        answers = list(pool.map(lambda trip_id: fetch_trip(args.motis, trip_id), trip_ids))

    found, not_found, latencies = [], [], []
    for trip, trip_id, (status, body, seconds) in zip(trips, trip_ids, answers, strict=True):
        latencies.append(seconds)
        leg = leg_for(body, trip_id) if status == 200 and body is not None else None
        if leg is None:
            not_found.append(
                {"trip_id": trip_id, "route_key": trip["route_key"], "http_status": status}
            )
            continue
        found.append((trip, trip_id, leg, body))

    api_categories = categorize(args.node, [leg for _, _, leg, _ in found])

    checked = collections.Counter()
    api_agree = collections.Counter()
    mode_agree = collections.Counter()
    display_differs = 0
    api_mismatches, mode_mismatches = [], []
    for (trip, trip_id, leg, body), api_category in zip(found, api_categories, strict=True):
        category = trip["category_code"]
        record = {
            "trip_id": trip_id,
            "route_key": trip["route_key"],
            "short_name": trip["short_name"],
            "long_name": trip["long_name"],
            "trip_short_name": trip["trip_short_name"],
            "operator_id": trip["operator_id"],
            "category": category,
            "category_rule": trip["category_rule"],
            "delfi_route_type": trip["gtfs_route_type"],
            "api_category": api_category,
            "display_name": leg.get("displayName"),
            "motis_route_type": leg.get("routeType"),
            "motis_mode": leg.get("mode"),
        }
        checked[category] += 1
        if leg.get("displayName") != trip["short_name"]:
            display_differs += 1
        if api_category == category:
            api_agree[category] += 1
        else:
            api_mismatches.append(record)
        if leg.get("mode") in trip["motis_classes"]:
            mode_agree[category] += 1
        else:
            mode_mismatches.append({**record, "block_legs": block_legs(body)})

    report = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "motis": args.motis,
        "date": args.date.isoformat(),
        "weekday": f"{args.date:%A}",
        "train_trips": len(trips),
        "train_routes": len({trip["route_key"] for trip in trips}),
        "checked": sum(checked.values()),
        "api_agree": sum(api_agree.values()),
        "mode_agree": sum(mode_agree.values()),
        "per_category": {
            code: {
                "checked": checked[code],
                "api_agree": api_agree[code],
                "mode_agree": mode_agree[code],
            }
            for code in sorted(checked)
        },
        "api_mismatch_count": len(api_mismatches),
        "api_mismatch_route_count": len({record["route_key"] for record in api_mismatches}),
        "mode_mismatch_count": len(mode_mismatches),
        "mode_mismatches_in_blocks": sum(
            len(record["block_legs"]) > 1 for record in mode_mismatches
        ),
        "display_name_differs_from_route_short_name": display_differs,
        "not_found_count": len(not_found),
        "trip_latency_ms_p50": percentile(latencies, 0.5),
        "trip_latency_ms_p95": percentile(latencies, 0.95),
        "wall_s": round(time.perf_counter() - started, 1),
        "api_mismatch_routes": mismatch_routes(api_mismatches),
        "api_mismatches": api_mismatches,
        "mode_mismatches": mode_mismatches,
        "not_found": not_found,
    }
    Path(args.out).write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    summary = {key: value for key, value in report.items() if key not in LIST_KEYS}
    summary["api_mismatch_routes"] = report["api_mismatch_routes"]
    json.dump(summary, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")
    return 0 if not api_mismatches and not not_found else 1


if __name__ == "__main__":
    sys.exit(main())
