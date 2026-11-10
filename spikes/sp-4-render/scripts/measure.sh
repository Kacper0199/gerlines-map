#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

groups=("$@")
if [ "${#groups[@]}" -eq 0 ]; then
  groups=(main)
fi

repetitions="${SP4_REPS:-1}"
first="${SP4_FIRST:-1}"
session="${SP4_SESSION:-sp-4}"
env_filter="${SP4_ENV:-}"
only_filter="${SP4_ONLY:-}"
log="$(mktemp)"

sink_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
export SP4_RESULTS_SINK=1
export SP4_SINK_TOKEN="$sink_token"

pnpm build
pnpm exec vite preview --host 127.0.0.1 --port 0 --strictPort >"$log" 2>&1 &
server_pid=$!
cleanup() {
  playwright-cli -s="$session" close >/dev/null 2>&1 || true
  kill "$server_pid" 2>/dev/null || true
  rm -f "$log"
}
trap cleanup EXIT

port=""
for _ in $(seq 1 50); do
  port="$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$log" | head -n 1)"
  [ -n "$port" ] && break
  sleep 0.2
done
if [ -z "$port" ]; then
  echo "preview server did not report a port" >&2
  exit 1
fi

for group in "${groups[@]}"; do
  url="http://127.0.0.1:${port}/?run=${group}&reps=${repetitions}&first=${first}&tag=${group}&sinkToken=${sink_token}"
  [ -n "$env_filter" ] && url="${url}&env=${env_filter}"
  [ -n "$only_filter" ] && url="${url}&only=${only_filter}"
  playwright-cli -s="$session" open "$url"
  playwright-cli -s="$session" --raw run-code --filename=scripts/run-scenarios.js
  playwright-cli -s="$session" close
  node scripts/summarize.mjs "$group"
done
