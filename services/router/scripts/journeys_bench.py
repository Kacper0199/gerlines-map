"""Latency of GET /api/v1/journeys per sample query, then parallel load with container memory.

Each query runs once to warm up and then --runs times in sequence (p50, p95 nearest rank, max).
The load phase cycles --workers threads over all queries for --load-seconds while `docker stats`
samples the router container every 2 s. A worker that gets 503 with `Retry-After` (the API's cap on
MOTIS calls in flight) waits that long and counts a refusal, not an error. Memory is also sampled
idle before and after.

Usage: journeys_bench.py --api http://127.0.0.1:8788 --out <bench.json> [--runs 20]
       [--workers 8] [--load-seconds 60] [--container gerlines-router-1]
       [--time 2026-10-27T06:00:00Z]
"""

import argparse
import http.client
import itertools
import json
import math
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

PAIRS = {
    "berlin-muenchen": ("de:11000:900003201", "de:09162:100"),
    "hamburg-koeln": ("de:02000:10950", "de:05315:11201"),
    "frankfurt-dresden": ("de:06412:10", "de:14612:28"),
    "berlin-praha": ("de:11000:900003201", "000005400014"),
}
WITHOUT_HSR = "ld,night,rfast,reg,sbahn,urban,bus,other"


def percentile(values: list[float], share: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


class Api:
    def __init__(self, base: str) -> None:
        parsed = urllib.parse.urlsplit(base)
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80

    def get(self, path: str, params: dict[str, str]) -> tuple[float, int, dict, float | None]:
        connection = http.client.HTTPConnection(self.host, self.port, timeout=60)
        started = time.perf_counter()
        try:
            connection.request("GET", f"{path}?{urllib.parse.urlencode(params)}")
            response = connection.getresponse()
            body = response.read()
            retry_after = response.getheader("Retry-After")
        finally:
            connection.close()
        elapsed = time.perf_counter() - started
        wait = float(retry_after) if retry_after else None
        return elapsed, response.status, json.loads(body), wait


def container_memory_mib(container: str) -> float | None:
    command = ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container]
    out = subprocess.run(command, capture_output=True, text=True, check=False).stdout  # noqa: S603
    used = out.split("/")[0].strip()
    units = {"KiB": 1 / 1024, "MiB": 1.0, "GiB": 1024.0}
    for unit, factor in units.items():
        if used.endswith(unit):
            return round(float(used.removesuffix(unit)) * factor, 1)
    return None


def queries(time_text: str) -> dict[str, dict[str, str]]:
    result = {}
    for name, (origin, destination) in PAIRS.items():
        base = {"from": origin, "to": destination, "time": time_text}
        result[f"{name}-all"] = base
        result[f"{name}-no-hsr"] = {**base, "categories": WITHOUT_HSR}
    return result


def summarise(body: dict) -> dict:
    journeys = body.get("journeys", [])
    fastest = min(journeys, key=lambda journey: journey["durationS"], default=None)
    return {
        "journeys": len(journeys),
        "removed_by_filter": body.get("removedByFilter"),
        "fastest_min": round(fastest["durationS"] / 60) if fastest else None,
        "fastest_transfers": fastest["transfers"] if fastest else None,
        "fastest_lines": [
            f"{leg['line']} ({leg['category']})"
            for leg in (fastest["legs"] if fastest else [])
            if leg["kind"] == "transit"
        ],
        "categories_seen": sorted({code for journey in journeys for code in journey["categories"]}),
    }


def sequential(api: Api, params: dict[str, str], runs: int) -> dict:
    api.get("/api/v1/journeys", params)
    timings, statuses, body = [], set(), {}
    for _ in range(runs):
        seconds, status, body, _ = api.get("/api/v1/journeys", params)
        timings.append(seconds * 1000)
        statuses.add(status)
    return {
        "statuses": sorted(statuses),
        "p50_ms": round(percentile(timings, 0.5), 1),
        "p95_ms": round(percentile(timings, 0.95), 1),
        "max_ms": round(max(timings), 1),
        **summarise(body),
    }


def load(api: Api, params: list[dict[str, str]], workers: int, seconds: float, container: str):
    deadline = time.monotonic() + seconds
    cycle = itertools.cycle(params)
    lock = threading.Lock()
    timings: list[float] = []
    errors: list[int] = []
    refusals: list[float] = []
    memory: list[float] = []

    def worker() -> None:
        while time.monotonic() < deadline:
            with lock:
                query = next(cycle)
            elapsed, status, _, retry_after = api.get("/api/v1/journeys", query)
            if status == http.HTTPStatus.SERVICE_UNAVAILABLE and retry_after is not None:
                with lock:
                    refusals.append(retry_after)
                time.sleep(retry_after)
                continue
            with lock:
                timings.append(elapsed * 1000)
                if status != http.HTTPStatus.OK:
                    errors.append(status)

    def sampler() -> None:
        while time.monotonic() < deadline:
            value = container_memory_mib(container)
            if value is not None:
                memory.append(value)
            time.sleep(2)

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    threads.append(threading.Thread(target=sampler))
    started = time.monotonic()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    wall = time.monotonic() - started
    return {
        "workers": workers,
        "seconds": round(wall, 1),
        "requests": len(timings),
        "per_second": round(len(timings) / wall, 1),
        "p50_ms": round(percentile(timings, 0.5), 1),
        "p95_ms": round(percentile(timings, 0.95), 1),
        "max_ms": round(max(timings), 1),
        "errors": len(errors),
        "refused_with_retry_after": len(refusals),
        "memory_mib_peak": max(memory, default=None),
        "memory_mib_samples": len(memory),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--api", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--load-seconds", type=float, default=60)
    parser.add_argument("--container", default="gerlines-router-1")
    parser.add_argument("--time", default="2026-10-27T06:00:00Z")
    args = parser.parse_args()

    api = Api(args.api)
    sample = queries(args.time)
    report = {"memory_mib_idle_before": container_memory_mib(args.container)}
    report["queries"] = {
        name: sequential(api, params, args.runs) for name, params in sample.items()
    }
    report["memory_mib_after_sequential"] = container_memory_mib(args.container)
    report["load"] = load(
        api, list(sample.values()), args.workers, args.load_seconds, args.container
    )
    time.sleep(10)
    report["memory_mib_idle_after"] = container_memory_mib(args.container)
    Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
