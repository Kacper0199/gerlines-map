#!/usr/bin/env bash
# Recomputes the IRIS long-distance station cover (D-041 item 1) over one full weekday, with no IRIS call:
# the DELFI universe of that local day (00:00 to 24:00 Europe/Berlin, trips of the day before still running
# included), the greedy cover of hsr, ld and night runs at a 60-minute gap, then the first 50 cover stations
# against IRIS_LONG_DISTANCE_COVER in services/ingest/src/db-apis/stations.ts.
# Usage: iris-cover-weekday.sh <YYYY-MM-DD, Monday to Friday> <delfi-gtfs.zip> [eva-mirror.zip] [out-dir]
# Needs uv. Heavy job (reads the whole DELFI feed): run it alone, as the project rules say for heavy jobs.
# Writes only under out-dir (default <main checkout>/data/iris-cover/<day>).
set -euo pipefail

main="${GERLINES_MAIN:-$(git rev-parse --show-toplevel)}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
day="${1:?weekday YYYY-MM-DD}"
feed="${2:?DELFI GTFS zip}"
mirror="${3:-$main/data/inputs/delfi/2026-10-19/delfi-gtfs-extended-zhv-evaNr.zip}"
out="${4:-$main/data/iris-cover/$day}"
outline="$repo/apps/web/public/geo/germany-outline.geojson"
py=(uv run --no-project --with duckdb==1.4.1 python -I)
pyst=(uv run --project "$repo" --package gerlines-static-import --with duckdb==1.4.1 --with pyarrow==22.0.0 python -I)

read -r from to < <(uv run --no-project python -I - "$day" <<'PY'
import datetime as dt
import sys
from zoneinfo import ZoneInfo

day = dt.date.fromisoformat(sys.argv[1])
if day.weekday() > 4:
    sys.exit(f"{day} is not a weekday (Monday to Friday)")
berlin = ZoneInfo("Europe/Berlin")
start = dt.datetime(day.year, day.month, day.day, tzinfo=berlin)
end = start + dt.timedelta(days=1)
utc = lambda moment: moment.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
print(utc(start), utc(end))
PY
)

mkdir -p "$out"
cd "$repo"
"${pyst[@]}" "$here/universe.py" --feed "$feed" --eva-mirror "$mirror" --outline "$outline" \
  --window-start "$from" --window-end "$to" --out "$out"
"${py[@]}" "$here/iris_station_cover.py" "$out" --max-gap-min 60 --limit 120 \
  | tee "$out/iris-station-cover-gap60.txt"
uv run --no-project python -I "$here/iris_cover_compare.py" "$out/iris-station-cover-gap60.txt" \
  "$repo/services/ingest/src/db-apis/stations.ts" --first 50 | tee "$out/compare.txt"
