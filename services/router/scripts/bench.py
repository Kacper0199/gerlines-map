"""Measure a running MOTIS server: plan and map/trips latency, RSS idle and under load, labels.

Usage: bench.py --base http://127.0.0.1:8090 --pid <server pid> --out <result.json>
Stdlib only. RSS comes from /bin/ps.
"""

import argparse
import collections
import concurrent.futures
import http.client
import itertools
import json
import math
import pathlib
import re
import statistics
import subprocess
import threading
import time
import urllib.parse

PLAN_TIME = "2026-10-27T06:00:00Z"
DAY_WINDOW = ("2026-10-27T07:00:00Z", "2026-10-27T07:01:00Z")
NIGHT_WINDOW = ("2026-10-27T23:00:00Z", "2026-10-27T23:05:00Z")
GERMANY_MIN = "47.2,5.8"
GERMANY_MAX = "55.1,15.1"
NO_HSR_MODES = ",".join(
    [
        "TRAM",
        "SUBWAY",
        "FERRY",
        "AIRPLANE",
        "BUS",
        "COACH",
        "LONG_DISTANCE",
        "NIGHT_RAIL",
        "REGIONAL_RAIL",
        "SUBURBAN",
        "FUNICULAR",
        "AERIAL_LIFT",
        "OTHER",
    ]
)
STATIONS = {
    "Berlin Hbf": "de:11000:900003201",
    "München Hbf": "de:09162:100",
    "Hamburg Hbf": "de:02000:10950",
    "Köln Hbf": "de:05315:11201",
    "Frankfurt (Main) Hbf": "de:06412:10",
    "Stuttgart Hbf": "de:08111:6115",
    "Leipzig Hbf": "de:14713:8010205",
    "Hannover Hbf": "de:03241:31",
    "Nürnberg Hbf": "de:09564:510",
    "Dresden Hbf": "de:14612:28",
}
DEFAULT_DATASET_TAG = "de-DELFI"
LABEL_PREFIXES = {
    "ICE", "IC", "EC", "ECE", "NJ", "EN", "S", "RE", "RB", "IRE", "FLX", "RJ", "RJX", "TGV", "MEX",
    "digits+N",
}  # fmt: skip


class UnexpectedStatusError(RuntimeError):
    def __init__(self, path: str, status: int, body: bytes) -> None:
        super().__init__(f"{path} returned {status}: {body[:200]!r}")


class Client:
    def __init__(self, base: str) -> None:
        parsed = urllib.parse.urlsplit(base)
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80

    def get(self, path: str, params: dict) -> tuple[float, int, object]:
        connection = http.client.HTTPConnection(self.host, self.port, timeout=120)
        started = time.perf_counter()
        try:
            connection.request("GET", f"{path}?{urllib.parse.urlencode(params)}")
            response = connection.getresponse()
            body = response.read()
        finally:
            connection.close()
        elapsed = time.perf_counter() - started
        if response.status != http.HTTPStatus.OK:
            raise UnexpectedStatusError(path, response.status, body)
        return elapsed, len(body), json.loads(body)


def rss_mb(pid: int | None) -> float | None:
    if pid is None:
        return None
    command = ["/bin/ps", "-o", "rss=", "-p", str(pid)]
    out = subprocess.run(command, capture_output=True, text=True, check=False).stdout  # noqa: S603
    return round(int(out.strip()) / 1024, 1) if out.strip() else None


def footprint_mb(pid: int | None) -> float | None:
    tool = pathlib.Path("/usr/bin/footprint")
    if pid is None or not tool.exists():
        return None
    command = [str(tool), str(pid)]
    out = subprocess.run(command, capture_output=True, text=True, check=False).stdout  # noqa: S603
    match = re.search(r"Footprint: ([\d.]+) (KB|MB|GB)", out)
    if not match:
        return None
    scale = {"KB": 1 / 1024, "MB": 1, "GB": 1024}[match.group(2)]
    return round(float(match.group(1)) * scale, 1)


def memory(pid: int | None) -> dict:
    return {"rss_mb": rss_mb(pid), "footprint_mb": footprint_mb(pid)}


def summary(samples: list[float]) -> dict:
    ordered = sorted(samples)
    return {
        "runs": len(ordered),
        "p50_ms": round(statistics.median(ordered) * 1000, 1),
        "p95_nearest_rank_ms": round(ordered[math.ceil(len(ordered) * 0.95) - 1] * 1000, 1),
        "max_ms": round(ordered[-1] * 1000, 1),
    }


def find_stop(client: Client, dataset_tag: str, delfi_id: str) -> dict:
    stop_id = f"{dataset_tag}_{delfi_id}"
    _, _, body = client.get("/api/v6/stoptimes", {"stopId": stop_id, "n": 1, "time": PLAN_TIME})
    return {"stopId": stop_id, "name": body["place"]["name"]}


def describe_leg(leg: dict) -> str:
    return "|".join(
        str(leg.get(key, ""))
        for key in ("mode", "displayName", "tripShortName", "routeType", "category")
    )


def plan_runs(client: Client, route: tuple[str, str], modes: str | None, runs: int) -> dict:
    params = {"fromPlace": route[0], "toPlace": route[1], "time": PLAN_TIME}
    if modes:
        params["transitModes"] = modes
    client.get("/api/v6/plan", params)
    samples, last = [], {}
    for _ in range(runs):
        elapsed, _, last = client.get("/api/v6/plan", params)
        samples.append(elapsed)
    itineraries = last.get("itineraries", [])
    fastest = min(itineraries, key=lambda it: it["duration"]) if itineraries else None
    transit_legs = [leg for it in itineraries for leg in it["legs"] if leg["mode"] != "WALK"]
    return {
        **summary(samples),
        "itineraries": len(itineraries),
        "fastest_minutes": round(fastest["duration"] / 60) if fastest else None,
        "fastest_departure": fastest["startTime"] if fastest else None,
        "fastest_legs": [
            describe_leg(leg) for leg in (fastest or {}).get("legs", []) if leg["mode"] != "WALK"
        ],
        "any_highspeed_leg": any(leg["mode"] == "HIGHSPEED_RAIL" for leg in transit_legs),
        "leg_modes": dict(collections.Counter(leg["mode"] for leg in transit_legs)),
    }


def trips_runs(client: Client, zoom: int, window: tuple[str, str], runs: int) -> tuple[dict, list]:
    params = {
        "zoom": zoom,
        "min": GERMANY_MIN,
        "max": GERMANY_MAX,
        "startTime": window[0],
        "endTime": window[1],
        "precision": 5,
    }
    client.get("/api/v6/map/trips", params)
    samples, size, segments = [], 0, []
    for _ in range(runs):
        elapsed, size, segments = client.get("/api/v6/map/trips", params)
        samples.append(elapsed)
    trips = {t["tripId"] for seg in segments for t in seg["trips"]}
    modes = collections.Counter(seg["mode"] for seg in segments)
    return {
        **summary(samples),
        "zoom": zoom,
        "window": list(window),
        "segments": len(segments),
        "distinct_trips": len(trips),
        "bytes": size,
        "realtime_segments": sum(1 for seg in segments if seg.get("realTime")),
        "modes": dict(modes.most_common()),
    }, segments


def name_prefix(name: str) -> str:
    match = re.match(r"[A-Za-zÄÖÜäöü-]+", name)
    if match:
        return match.group(0)
    return "digits+N" if re.fullmatch(r"\d+N", name) else "digits"


def trip_mode(client: Client, trip_id: str) -> str:
    _, _, itinerary = client.get("/api/v6/trip", {"tripId": trip_id})
    modes = {leg["mode"] for leg in itinerary.get("legs", []) if leg["mode"] != "WALK"}
    return "+".join(sorted(modes)) or "none"


def label_table(client: Client, segments: list) -> dict:
    names = {}
    for seg in segments:
        for trip in seg["trips"]:
            names[trip["tripId"]] = trip.get("displayName", "")
    modes = collections.defaultdict(collections.Counter)
    examples = collections.defaultdict(set)
    for trip_id, name in sorted(names.items()):
        prefix = name_prefix(name)
        if prefix not in LABEL_PREFIXES:
            continue
        mode = trip_mode(client, trip_id)
        modes[prefix][mode] += 1
        if len(examples[prefix]) < 6:
            examples[prefix].add(f"{name}={mode}")
    return {
        prefix: {"distinct_trips": dict(counter), "examples": sorted(examples[prefix])}
        for prefix, counter in sorted(modes.items())
    }


def load_test(client: Client, stop_ids: list[str], pid: int | None, options: dict) -> dict:
    pairs = list(itertools.permutations(stop_ids, 2))
    started = time.monotonic()
    deadline = started + options["seconds"]
    latencies, failures = [], []
    peak = {"rss_mb": 0.0, "footprint_mb": 0.0}
    lock = threading.Lock()
    sampling = threading.Event()

    def sampler() -> None:
        while not sampling.is_set():
            for key, value in memory(pid).items():
                peak[key] = max(peak[key], value or 0.0)
            time.sleep(2)

    def worker(offset: int) -> None:
        for origin, destination in itertools.islice(itertools.cycle(pairs), offset, None):
            if time.monotonic() >= deadline:
                return
            params = {"fromPlace": origin, "toPlace": destination, "time": PLAN_TIME}
            try:
                elapsed, _, _ = client.get("/api/v6/plan", params)
            except (OSError, http.client.HTTPException, UnexpectedStatusError, ValueError) as error:
                with lock:
                    failures.append(str(error)[:120])
                continue
            with lock:
                latencies.append(elapsed)

    thread = threading.Thread(target=sampler, daemon=True)
    thread.start()
    workers = options["workers"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(worker, [i * len(pairs) // workers for i in range(workers)]))
    wall = time.monotonic() - started
    sampling.set()
    thread.join()
    return {
        "workers": workers,
        "seconds": round(wall, 1),
        "queries": len(latencies),
        "errors": len(failures),
        "first_errors": failures[:3],
        "queries_per_second": round(len(latencies) / wall, 2),
        **(summary(latencies) if latencies else {}),
        "peak_rss_mb": peak["rss_mb"],
        "peak_footprint_mb": peak["footprint_mb"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8090")
    parser.add_argument("--dataset-tag", default=DEFAULT_DATASET_TAG)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--out", required=True)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--load-seconds", type=int, default=60)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    client = Client(args.base)
    result: dict = {"base": args.base, "memory_after_start": memory(args.pid)}
    stops = {
        name: find_stop(client, args.dataset_tag, delfi_id) for name, delfi_id in STATIONS.items()
    }
    result["stops"] = stops
    berlin_munich = (stops["Berlin Hbf"]["stopId"], stops["München Hbf"]["stopId"])

    result["plan_berlin_munich_all"] = plan_runs(client, berlin_munich, None, args.runs)
    result["plan_berlin_munich_no_hsr"] = plan_runs(client, berlin_munich, NO_HSR_MODES, args.runs)
    result["memory_after_plan"] = memory(args.pid)

    result["map_trips_germany_zoom6"], _ = trips_runs(client, 6, DAY_WINDOW, args.runs)
    result["map_trips_germany_zoom8"], day = trips_runs(client, 8, DAY_WINDOW, args.runs)
    result["map_trips_germany_night_zoom8"], night = trips_runs(client, 8, NIGHT_WINDOW, 3)
    result["labels_day"] = label_table(client, day)
    result["labels_night"] = label_table(client, night)
    result["memory_idle_after_queries"] = memory(args.pid)

    stop_ids = [s["stopId"] for s in stops.values()]
    options = {"seconds": args.load_seconds, "workers": args.workers}
    result["load"] = load_test(client, stop_ids, args.pid, options)
    result["memory_after_load"] = memory(args.pid)

    text = json.dumps(result, ensure_ascii=False, indent=2)
    pathlib.Path(args.out).write_text(text + "\n", encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
