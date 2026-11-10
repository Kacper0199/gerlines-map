#!/usr/bin/env bash
# Runs the SP-2 analysis from recorded and sampled payloads to the coverage tables.
# Usage: analyse.sh <window-start ISO UTC> <window-end ISO UTC> [results-dir]
# Needs Node 24 on PATH and uv. Reads data/recordings (read-only) and writes only under data/sp-2.
set -euo pipefail

main="${GERLINES_MAIN:-$(git rev-parse --show-toplevel)}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
data="$main/data/sp-2"
from="${1:?window start}"
to="${2:?window end}"
results="${3:-$data/results}"
py=(uv run --no-project --with duckdb==1.4.1 --with pyarrow==22.0.0 --with gtfs-realtime-bindings==1.0.0 --with defusedxml==0.7.1 python -I)
pyst=(uv run --project "$repo" --package gerlines-static-import --with duckdb==1.4.1 --with pyarrow==22.0.0 python -I)

cd "$repo"
"${pyst[@]}" "$here/universe.py" \
  --feed "$main/data/inputs/delfi/2026-10-26/delfi-gtfs.zip" \
  --eva-mirror "$main/data/inputs/delfi/2026-10-19/delfi-gtfs-extended-zhv-evaNr.zip" \
  --outline "$main/apps/web/public/geo/germany-outline.geojson" \
  --window-start "$from" --window-end "$to" --out "$data"
"${pyst[@]}" "$here/gtfsde_match.py" \
  --static "$main/data/recordings/gtfsde-static-fv/2026-10-25/100217Z-latest.zip" \
  --static "$main/data/recordings/gtfsde-static-rv/2026-10-25/100202Z-latest.zip" \
  --universe "$data/universe" --window-start "$from" --window-end "$to" --out "$data/gtfsde"

for source in delfi-gtfs-rt gtfsde-rt; do
  node "$here/extract-recordings.ts" --root "$main/data/recordings" --source "$source" \
    --from "$from" --to "$to" --every-min 5 --out "$data/extract"
done
node "$here/extract-recordings.ts" --root "$main/data/recordings" --source delfi-gtfs-rt-deincr \
  --from "$from" --to "$to" --every-min 60 --out "$data/extract"

"${py[@]}" "$here/reduce_rt.py" --source mirror --manifest "$data/extract/delfi-gtfs-rt/index.csv" \
  --dir "$data/extract/delfi-gtfs-rt" --from "$from" --to "$to" \
  --keep-trips "$data/universe/trips.parquet" --out "$data/rt/mirror.parquet"
"${py[@]}" "$here/reduce_rt.py" --source mobilithek --manifest "$data/mobilithek/pull-log.csv" \
  --dir "$data/mobilithek/payloads" --from "$from" --to "$to" \
  --keep-trips "$data/universe/trips.parquet" --out "$data/rt/mobilithek.parquet"
"${py[@]}" "$here/reduce_rt.py" --source deincr --manifest "$data/extract/delfi-gtfs-rt-deincr/index.csv" \
  --dir "$data/extract/delfi-gtfs-rt-deincr" --from "$from" --to "$to" --every-min 60 \
  --keep-trips "$data/universe/trips.parquet" --out "$data/rt/deincr.parquet"
"${py[@]}" "$here/reduce_rt.py" --source gtfsde --manifest "$data/extract/gtfsde-rt/index.csv" \
  --dir "$data/extract/gtfsde-rt" --from "$from" --to "$to" \
  --keep-trips "$data/gtfsde/gtfsde_match.parquet" --keep-column g_trip_id --out "$data/rt/gtfsde.parquet"
"${py[@]}" "$here/iris_reduce.py" "$data/iris" "$data/iris"

"${py[@]}" "$here/coverage.py" --data "$data" --window-start "$from" --window-end "$to" \
  --rt "mirror=$data/rt/mirror.parquet" --rt "mobilithek=$data/rt/mobilithek.parquet" \
  --rt "deincr=$data/rt/deincr.parquet" --rt "gtfsde=$data/rt/gtfsde.parquet" \
  --iris --out "$results"
MPLCONFIGDIR="${TMPDIR:-/tmp}/mpl" uv run --no-project --with matplotlib==3.10.7 python -I "$here/chart.py" "$results" \
  "${from:11:5} to ${to:11:5} UTC, ${from:0:10}"
