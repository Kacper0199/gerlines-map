#!/usr/bin/env bash
# Stops the MOTIS server of a run started by serve.sh and restores the import config.
# Usage: stop.sh <run>
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ -n "${1:-}" ]] || die "usage: stop.sh <run>"
run_dir="$ROUTER_DATA/runs/$1"
pid_file="$run_dir/server.pid"
[[ -f "$pid_file" ]] || die "no pid file at $pid_file"
pid="$(cat "$pid_file")"
command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
if [[ "$command" == *motis*server* ]]; then
  kill -TERM "$pid"
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
fi
[[ -z "$command" || "$command" == *motis*server* ]] || echo "pid $pid is no longer a MOTIS server, left alone"
rm -f "$pid_file"
[[ -f "$run_dir/data/config.import.yml" ]] && cp "$run_dir/data/config.import.yml" "$run_dir/data/config.yml"
echo "stopped $pid"
