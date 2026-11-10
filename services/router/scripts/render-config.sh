#!/usr/bin/env bash
# Renders a MOTIS config.yml for one variant to stdout.
# Usage: render-config.sh <gtfs|rail|full>
# Env: FIRST_DAY (default 2026-10-25), NUM_DAYS (default 49, DELFI 2026-10-19 ends 2026-12-12), PORT (default 8090),
# SCRIPT (optional absolute path of a MOTIS Lua user script for the dataset). Realtime feeds are added by serve.sh.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

variant="${1:-}"
case "$variant" in
  gtfs) template="gtfs.yml"; osm="" ;;
  rail) template="rail.yml"; osm="$RAIL_PBF" ;;
  full) template="rail.yml"; osm="$OSM_PBF" ;;
  *) die "usage: render-config.sh <gtfs|rail|full>" ;;
esac

require_input DELFI_ZIP
case "$variant" in rail) require_input RAIL_PBF ;; full) require_input OSM_PBF ;; esac
[[ -z "${SCRIPT:-}" || -f "$SCRIPT" ]] || die "missing $SCRIPT"
web_folder="$(dirname "$(readlink "$MOTIS_BIN")")/ui"

sed -e "s|@PORT@|${PORT:-8090}|" \
  -e "s|@WEB_FOLDER@|$web_folder|" \
  -e "s|@FIRST_DAY@|${FIRST_DAY:-2026-10-25}|" \
  -e "s|@NUM_DAYS@|${NUM_DAYS:-49}|" \
  -e "s|@DELFI_ZIP@|$DELFI_ZIP|" \
  -e "s|@OSM@|$osm|" \
  "$ROUTER_DIR/config/$template" |
  awk -v script="${SCRIPT:-}" '{print} $1 == "path:" && script != "" {print "      script: \"" script "\""}'
