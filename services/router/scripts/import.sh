#!/usr/bin/env bash
# Imports one MOTIS variant into data/router/runs/<variant>-d<days>/data, measured by run-measured.sh.
# Usage: import.sh <gtfs|rail|full>
# Env: NUM_DAYS, FIRST_DAY, PORT, SCRIPT (see render-config.sh), GUARD_* (see run-measured.sh),
# RUN_NAME (default <variant>-d<days>). Writes runs/<run>/inputs.json with the sha256 of the feed and the OSM file.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

variant="${1:-}"
[[ "$variant" =~ ^(gtfs|rail|full)$ ]] || die "usage: import.sh <gtfs|rail|full>"
[[ -x "$MOTIS_BIN" ]] || die "run download-motis.sh first"
run="${RUN_NAME:-$variant-d${NUM_DAYS:-49}}"
run_dir="$ROUTER_DATA/runs/$run"
mkdir -p "$run_dir" "$ROUTER_DATA/logs"
"$ROUTER_DIR/scripts/render-config.sh" "$variant" >"$run_dir/config.yml"
case "$variant" in gtfs) osm="" ;; rail) osm="$RAIL_PBF" ;; full) osm="$OSM_PBF" ;; esac
{
  printf '{\n "run": "%s",\n "delfi_zip": {"path": "%s", "sha256": "%s"},\n' "$run" "$DELFI_ZIP" "$(shasum -a 256 "$DELFI_ZIP" | cut -d' ' -f1)"
  if [[ -n "$osm" ]]; then
    printf ' "osm": {"path": "%s", "sha256": "%s"}\n}\n' "$osm" "$(shasum -a 256 "$osm" | cut -d' ' -f1)"
  else
    printf ' "osm": null\n}\n'
  fi
} >"$run_dir/inputs.json"

cd "$run_dir"
set +e
"$ROUTER_DIR/scripts/run-measured.sh" "$ROUTER_DATA/logs/$run-import" "$MOTIS_BIN" import -c config.yml -d data
status=$?
set -e
[[ -d data ]] || exit "$status"
{
  echo "data_dir_bytes $(($(du -sk data | cut -f1) * 1024))"
  echo "data_dir_human $(du -sh data | cut -f1)"
} | tee -a "$ROUTER_DATA/logs/$run-import.summary"
du -sh data/* | sort -h | tail -n 12 >"$ROUTER_DATA/logs/$run-import.files"
exit "$status"
