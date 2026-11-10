#!/usr/bin/env bash
# Assemble the preview page, the geo outputs and MapLibre into a temporary folder and serve only that folder.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
port="${1:-8765}"
site="$(mktemp -d "${TMPDIR:-/tmp}/geo-base-preview.XXXXXX")"
trap 'rm -rf "$site"' EXIT
mkdir -p "$site/vendor" "$site/geo"

cp "$root/pipelines/geo_base/preview/index.html" "$site/"
cp "$root/apps/web/node_modules/maplibre-gl/dist/"maplibre-gl{.mjs,-shared.mjs,-worker.mjs,.css} "$site/vendor/"
cp -R "$root/apps/web/public/geo/." "$site/geo/"
git -C "$root" show main:design/variants/data/germany-outline.geojson > "$site/geo/ne-germany-outline.geojson"
git -C "$root" show main:design/variants/data/germany-mask.geojson > "$site/geo/ne-germany-mask.geojson"

echo "serving $site on http://127.0.0.1:$port/"
uv run --project "$root" python -m http.server "$port" --bind 127.0.0.1 --directory "$site"
