#!/usr/bin/env bash
# Starts the server of a run, measures it with bench.py into data/router/logs/<run>-bench.json, then stops it.
# Usage: bench.sh <run>     Env: LOAD_SECONDS (default 60), WORKERS (default 8).
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

run="${1:-}"
[[ -n "$run" && -f "$ROUTER_DATA/runs/$run/config.yml" ]] || die "usage: bench.sh <imported run>"
port="$(run_port "$run")"
mkdir -p "$ROUTER_DATA/logs"
trap '"$ROUTER_DIR/scripts/stop.sh" "$run" || true' EXIT
"$ROUTER_DIR/scripts/serve.sh" "$run" | tee "$ROUTER_DATA/logs/$run-serve.txt"
sleep 10
uv run --no-project python -I "$ROUTER_DIR/scripts/bench.py" \
  --base "http://127.0.0.1:$port" \
  --dataset-tag "$(run_dataset "$run")" \
  --pid "$(cat "$ROUTER_DATA/runs/$run/server.pid")" \
  --load-seconds "${LOAD_SECONDS:-60}" \
  --workers "${WORKERS:-8}" \
  --out "$ROUTER_DATA/logs/$run-bench.json"
