"""Serial DB Timetables (IRIS) sampler for SP-2: plan and fchg for the 20 WP-2.4 stations.

Usage: python -I iris_sampler.py <out-dir> <minutes> [--fchg-every-min N]

One request at a time with at least 2.1 s between request starts, so no rolling minute sees
more than 29 requests (budget: 30). Credentials come from the main checkout .env, read
by this process only.
"""

import argparse
import csv
import datetime as dt
import gzip
import http.client
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ENV_FILE = Path(os.environ.get("GERLINES_MAIN", Path(__file__).resolve().parents[3])) / ".env"
BASE = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1"
BERLIN = ZoneInfo("Europe/Berlin")
MIN_GAP_S = 2.1

STATIONS = [
    (8011160, "S+U Berlin Hauptbahnhof", "hub"),
    (8002549, "Hamburg Hbf", "hub"),
    (8000261, "München Hbf", "hub"),
    (8000207, "Köln Hbf", "hub"),
    (8000105, "Frankfurt (Main) Hauptbahnhof", "hub"),
    (8000096, "Stuttgart Hauptbahnhof", "hub"),
    (8000085, "Düsseldorf Hbf", "hub"),
    (8000152, "Hannover Hauptbahnhof", "hub"),
    (8010205, "Leipzig Hbf", "hub"),
    (8000284, "Nürnberg Hbf", "hub"),
    (8000244, "Mannheim, Hauptbahnhof", "hub"),
    (8010101, "Erfurt Hbf", "hub"),
    (8010304, "Rostock Hauptbahnhof", "regional"),
    (8010073, "Cottbus, Hauptbahnhof", "regional"),
    (8002924, "Hof Hbf", "regional"),
    (8000001, "Aachen, Hbf", "border"),
    (8010113, "Frankfurt (Oder), Bahnhof", "border"),
    (8000298, "Passau Hbf", "border"),
    (8000026, "Basel Bad Bf", "border"),
    (8000879, "Bad Bentheim", "border"),
    (8098160, "Berlin Hbf (tief)", "probe"),
]


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def plan_slot(at: dt.datetime) -> tuple[str, str]:
    local = at.astimezone(BERLIN)
    return local.strftime("%y%m%d"), local.strftime("%H")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("minutes", type=float)
    parser.add_argument("--fchg-every-min", type=float, default=3.0)
    parser.add_argument("--plan-hours-ahead", type=int, default=1)
    args = parser.parse_args()

    env = read_env(ENV_FILE)
    headers = {
        "DB-Client-Id": env["DB_CLIENT_ID"],
        "DB-Api-Key": env["DB_API_KEY"],
        "Accept": "application/xml",
        "Accept-Encoding": "gzip",
        "User-Agent": f"{env.get('APP_NAME', 'gerlines')}/0.0 (+{env.get('APP_CONTACT', 'unset')})",
    }
    del env

    out = Path(args.out)
    (out / "payloads").mkdir(parents=True, exist_ok=True)
    log_path = out / "request-log.csv"
    new_log = not log_path.exists()
    log_file = log_path.open("a", newline="")
    log = csv.writer(log_file)
    if new_log:
        log.writerow(
            ["requested_utc", "endpoint", "eva", "slot", "http_code", "bytes", "elapsed_s", "file"]
        )

    start = time.time()
    end = start + args.minutes * 60
    fchg_period = args.fchg_every_min * 60
    next_fchg = {
        eva: start + i * fchg_period / len(STATIONS) for i, (eva, _, _) in enumerate(STATIONS)
    }
    planned: set[tuple[int, str, str]] = set()
    last_start = 0.0
    window_starts: list[float] = []

    def due_plans(now: float) -> list[tuple[int, str, str]]:
        current = dt.datetime.fromtimestamp(now, dt.UTC)
        slots = [
            plan_slot(current + dt.timedelta(hours=h)) for h in range(-1, args.plan_hours_ahead + 1)
        ]
        return [
            (eva, d, h)
            for (d, h) in slots
            for (eva, _, _) in STATIONS
            if (eva, d, h) not in planned
        ]

    while time.time() < end:
        now = time.time()
        plans = due_plans(now)
        fchg_due = sorted((t, eva) for eva, t in next_fchg.items() if t <= now)
        if fchg_due:
            eva = fchg_due[0][1]
            endpoint, path, slot = "fchg", f"/fchg/{eva}", ""
            next_fchg[eva] += fchg_period
        elif plans:
            eva, d, h = plans[0]
            endpoint, path, slot = "plan", f"/plan/{eva}/{d}/{h}", f"{d}{h}"
            planned.add((eva, d, h))
        else:
            time.sleep(0.5)
            continue

        wait = last_start + MIN_GAP_S - time.time()
        if wait > 0:
            time.sleep(wait)
        window_starts = [t for t in window_starts if t > time.time() - 60]
        if len(window_starts) >= 29:
            time.sleep(max(0.0, window_starts[0] + 60.05 - time.time()))
        last_start = time.time()
        window_starts.append(last_start)

        stamp = dt.datetime.fromtimestamp(last_start, dt.UTC).strftime("%Y%m%dT%H%M%SZ")
        request = urllib.request.Request(BASE + path, headers=headers)  # noqa: S310
        code, body = 0, b""
        try:
            with urllib.request.urlopen(request, timeout=40) as response:  # noqa: S310
                code = response.status
                body = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
        except urllib.error.HTTPError as error:
            code = error.code
            retry = error.headers.get("Retry-After")
            if code == 429:
                time.sleep(min(900, int(retry) if retry and retry.isdigit() else 60))
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, EOFError):
            code, body = 0, b""
        name = ""
        if code == 200 and body:
            name = f"{stamp}_{endpoint}_{eva}{'_' + slot if slot else ''}.xml.gz"
            (out / "payloads" / name).write_bytes(gzip.compress(body))
        log.writerow(
            [stamp, endpoint, eva, slot, code, len(body), round(time.time() - last_start, 3), name]
        )
        log_file.flush()
        if endpoint == "plan" and (code in (0, 429) or code >= 500):
            planned.discard((eva, d, h))

    log_file.close()
    (out / "done.txt").write_text(dt.datetime.now(dt.UTC).isoformat())


if __name__ == "__main__":
    main()
