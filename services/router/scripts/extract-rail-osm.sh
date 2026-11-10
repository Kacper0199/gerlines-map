#!/usr/bin/env bash
# Builds the rail-only OSM extract from the Germany extract with pyosmium, measured by run-measured.sh.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_input OSM_PBF
mkdir -p "$(dirname "$RAIL_PBF")" "$ROUTER_DATA/logs"

"$ROUTER_DIR/scripts/run-measured.sh" "$ROUTER_DATA/logs/extract-rail" \
  uv run --no-project --with osmium==4.1.1 python -I "$ROUTER_DIR/scripts/extract_rail.py" "$OSM_PBF" "$RAIL_PBF"

ls -l "$RAIL_PBF"
shasum -a 256 "$RAIL_PBF" | tee "$RAIL_PBF.sha256"
