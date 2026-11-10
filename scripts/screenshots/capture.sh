#!/usr/bin/env bash
# Captures the documentation screenshots listed in scripts/screenshots/capture.js from a running dev server.
# Usage: bash scripts/screenshots/capture.sh [shot id prefixes, comma separated, or all]
# Environment: BASE_URL (default http://127.0.0.1:5173), OUT_DIR (default raw/screenshots/docs),
# PREFIX (default docs), SETTLE_MS (default 6000), SESSION (default docs-shots),
# TRAIN_KEY (frame key of the train the shots 09 and 10 select, from apps/web/scripts/find-trips.ts; none selects no train).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
shots="${1:-all}"
base_url="${BASE_URL:-http://127.0.0.1:5173}"
out_dir="${OUT_DIR:-$root/raw/screenshots/docs}"
prefix="${PREFIX:-docs}"
settle_ms="${SETTLE_MS:-6000}"
session="${SESSION:-docs-shots}"
train_key="${TRAIN_KEY:-}"

case "$base_url" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *) echo "BASE_URL must be the local dev server, got $base_url" >&2; exit 2 ;;
esac
if ! curl -fsS -o /dev/null "$base_url/"; then
  echo "No dev server answers at $base_url. Start it first, see docs/screenshots.md." >&2
  exit 2
fi
if [[ -n "$train_key" && ! "$train_key" =~ ^[1-9][0-9]*$ ]]; then
  echo "TRAIN_KEY must be a frame key (a positive whole number), got $train_key" >&2
  exit 2
fi
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

runner="$(mktemp "${TMPDIR:-/tmp}/gerlines-shots.XXXXXX")"
trap 'rm -f "$runner"' EXIT
config="{\"baseUrl\":\"$base_url\",\"outDir\":\"$out_dir\",\"prefix\":\"$prefix\",\"settleMs\":$settle_ms,\"shots\":\"$shots\",\"trainKey\":${train_key:-null}}"
{
  printf 'async (page) => (\n'
  grep -v '^// biome-ignore' "$here/capture.js"
  printf ')(page, %s)\n' "$config"
} > "$runner"

playwright-cli -s="$session" open about:blank > /dev/null
status=0
playwright-cli -s="$session" --raw run-code --filename="$runner" || status=$?
playwright-cli -s="$session" close > /dev/null || true
exit "$status"
