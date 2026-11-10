#!/usr/bin/env bash
# Rebuilds apps/web/e2e/fixture/data from local inputs. Run it from the main checkout with Node 24 on PATH.
#
# Inputs (named, not shipped):
#   render      data/live/r12g            live render of 2026-10-25, timetable version 1, shape epoch 3
#   packs       data/live/packs-t102/v1   its shape packs (s/3/<number>.bin)
#   database    gerlines_wp32             read only; the replay database of that render and of the 2026-10-19 feed
#   places      data/search/places-de.tsv Land and place records of the search service
#   tiles       OpenFreeMap planet 20261101_080013_pt (the version tiles.json names); needs APP_NAME and APP_CONTACT
#   instant     2026-10-25T15:00:02Z      the keyframe nearest 2026-10-25T15:00:00Z
#   trains      keys 25702913 (ICE line 91, number 28) and 25706293 (RE54 4621) are kept whatever their distance;
#               details are kept for 25706459 (RB58 24349, stands at a stop), 25705303 (S1 35146) and 25702913;
#               the other trains are those within 20 km of Frankfurt (8.66,50.11)
#               on a shape of at most 80 km.
# Needs the Postgres container of the project on POSTGRES_PORT with the credentials of .env; nothing here writes to it.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../../.." && pwd)
web="$root/apps/web"
data="$web/e2e/fixture/data"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
set -a
. "$root/.env"
set +a
export PGOPTIONS="-c default_transaction_read_only=on"
replay_url="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/gerlines_wp32"

cd "$web"
node e2e/fixture/build-live.ts \
  --render "$root/data/live/r12g" --packs "$root/data/live/packs-t102/v1" \
  --at 2026-10-25T15:00:00Z --out "$data/live" --include 25702913 --include 25706293

(cd "$root/services/live" && DATABASE_URL="$replay_url" \
  node src/detail/cli.ts render --at 2026-10-25T15:00:02Z --out "$scratch/details" > /dev/null)
keyframe=$(ls "$data"/live/k/*.bin)
node e2e/fixture/build-details.ts --keyframe "$keyframe" --details "$scratch/details" \
  --out "$data/api" --keys 25706459,25705303,25702913

SEARCH_DATABASE_URL="$replay_url" SEARCH_PLACES_FILE="$root/data/search/places-de.tsv" \
  node e2e/fixture/build-search.ts "$data/api/search" en:Bayern en:Bavaria

node e2e/fixture/build-basemap.ts --out "$data/basemap"

pnpm exec biome check --write e2e/fixture
