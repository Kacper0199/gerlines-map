#!/usr/bin/env bash
# Serves a run with the DELFI GTFS-RT mirror for RT_MINUTES (default 20, at most 30 against the community mirror),
# samples it with rt_watch.py into data/router/logs/<run>-rt.jsonl and <run>-rt.json, then stops the server.
# Usage: rt-test.sh <run>
# Env: RT_URL (default the traines.eu de-incremented mirror), RT_MINUTES, and USER_AGENT or APP_NAME plus APP_CONTACT
# in the process environment (see serve.sh and README).
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

run="${1:-}"
[[ -n "$run" && -f "$ROUTER_DATA/runs/$run/config.yml" ]] || die "usage: rt-test.sh <imported run>"
port="$(run_port "$run")"
minutes="${RT_MINUTES:-20}"
export RT_URL="${RT_URL:-https://stc.traines.eu/mirror/german-delfi-gtfs-rt/latest.gtfs-rt.pbf}"
if [[ "$RT_URL" == *traines.eu* ]] && ((minutes > 30)); then
  die "the community mirror allows at most 30 minutes, serve a local copy for longer runs"
fi
trap '"$ROUTER_DIR/scripts/stop.sh" "$run" || true' EXIT
"$ROUTER_DIR/scripts/serve.sh" "$run" | tee "$ROUTER_DATA/logs/$run-rt-serve.txt"
uv run --no-project python "$ROUTER_DIR/scripts/rt_watch.py" \
  --base "http://127.0.0.1:$port" \
  --dataset-tag "$(run_dataset "$run")" \
  --pid "$(cat "$ROUTER_DATA/runs/$run/server.pid")" \
  --minutes "$minutes" \
  --out "$ROUTER_DATA/logs/$run-rt.json"
cp "$ROUTER_DATA/runs/$run/server.log" "$ROUTER_DATA/logs/$run-rt-server.log"
