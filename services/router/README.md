# services/router

MOTIS 2 journey planner for GerLines (ADR-0008), run natively from the release binary. This folder holds the
configuration templates and the scripts that download, import, serve and measure it. Binaries, OSM extracts, imported
data and logs live in `data/router/` of the main checkout (git-ignored).

## Layout

| Path | Purpose |
| --- | --- |
| `config/gtfs.yml` | variant `gtfs`: DELFI GTFS only, shapes from DELFI `shapes.txt`, no OSM, no street routing |
| `config/rail.yml` | variants `rail` (rail-only OSM extract) and `full` (whole Germany OSM): street routing on, `route_shapes` for rail classes only |
| `config/night-classes.lua` | SP-1 proof that a user script moves NJ, EN and lines like 27N from LONG_DISTANCE to NIGHT; kept to rerun SP-1 only. The service imports the enriched feed instead, whose route types already carry our categories, so it uses no script (see Categories) |
| `Dockerfile` | MOTIS server image from the Linux release binary (arm64 or amd64 by `TARGETARCH`), checked against the release sha256; holds no data |
| `scripts/container-config.sh` | writes `runs/<run>/container.yml`, the run's imported config with the server on `0.0.0.0:8080` and the image's web folder, mounted by compose over `/data/config.yml` |
| `scripts/parity.py` | category parity: every train trip of one weekday, the API's category of the MOTIS leg against the database |
| `scripts/journeys_bench.py` | latency of `GET /api/v1/journeys` for the sample queries, parallel load, container memory |
| `scripts/download-motis.sh` | downloads MOTIS v2.11.4 for this OS and checks size and sha256 from the GitHub release digest |
| `scripts/extract-rail-osm.sh`, `scripts/extract_rail.py` | rail-only extract with pyosmium 4.1.1 (tracks, sidings, platforms, stations, referenced nodes) |
| `scripts/check_extract.py` | referential completeness and way counts of an extract |
| `scripts/render-config.sh` | renders a template with absolute paths, days and port; adds a GTFS-RT feed and User-Agent on request |
| `scripts/import.sh` | `motis import` into `data/router/runs/<variant>-d<days>/data`, measured; writes `inputs.json` with the sha256 of the feed and the OSM file |
| `scripts/download-neighbours.sh`, `config/neighbours.txt` | the neighbouring regions' Geofabrik extracts, sizes checked against `MAX_BYTES` before any download, md5 checked |
| `scripts/run-measured.sh` | runs one heavy command under `/usr/bin/time` (`-l` on macOS, `-v` on Linux) with a memory guard (swap growth, pressure level) and a start ceiling (refuses above 4096 MB swap used or below 40 % free memory; `GUARD_MAX_SWAP_MB`, `GUARD_MIN_FREE_PERCENT` override) |
| `scripts/serve.sh`, `scripts/stop.sh` | start a run's server on 127.0.0.1 and wait for health (refused when its port already answers), stop it |
| `scripts/bench.sh`, `scripts/bench.py` | plan and `map/trips` latency, RSS idle and under load, category labels |
| `scripts/rt-test.sh`, `scripts/rt_watch.py` | server with the DELFI GTFS-RT mirror, sampled every 30 s |
| `scripts/route_types.py` | DELFI routes per `route_type` and name prefix |

MOTIS map tiles and geocoding stay off in every variant (no `tiles` key, `geocoding: false`). The server binds to
127.0.0.1 only.

## Requirements

- macOS on Apple silicon or Linux x86_64 or arm64; `curl`, `shasum`, `bzip2`, `uv`, `ps` and `pgrep`. On Linux
  also GNU time at `/usr/bin/time` (package `time`; without it `run-measured.sh` records no peak memory) and procfs:
  `/proc/meminfo`, `/proc/vmstat` and, when the kernel has it, `/proc/pressure/memory`.
- Inputs in the main checkout: `data/inputs/delfi/2026-10-19/delfi-gtfs.zip` and
  `data/inputs/osm/germany-2026-10-20.osm.pbf` by default, the dated files of the SP-1 runs. Set `DELFI_ZIP`,
  `OSM_PBF` and `RAIL_PBF` (and `ROUTER_DATA`) to your own files; a script that needs a missing input stops before any
  work and names the variable to set.
- `run-measured.sh` reads memory with `sysctl`, `memory_pressure` and `vm_stat` on macOS and from `/proc` on Linux, and
  the process tree with `ps` and `pgrep`.
- The realtime test sends `User-Agent: <APP_NAME>/<version> (+<APP_CONTACT>)`. `serve.sh` takes `USER_AGENT`, or
  `APP_NAME` and `APP_CONTACT`, from the process environment and stops with a clear message without them; no script
  reads `.env`. Let Node load the file into the environment of the child process:

  ```bash
  node --env-file=.env --eval 'process.exitCode = require("node:child_process")
    .spawnSync("bash", process.argv.slice(1), {stdio: "inherit"}).status' \
    services/router/scripts/rt-test.sh rail-d49
  ```

## Commands

Every number in the SP-1 report comes from these commands, run from the repository root of the main checkout or a
worktree (the scripts find the main checkout themselves). Results land in `data/router/logs/`.

```bash
bash services/router/scripts/download-motis.sh
bash services/router/scripts/extract-rail-osm.sh
uv run --no-project --with osmium==4.1.1 python -I services/router/scripts/check_extract.py \
  data/router/osm/germany-2026-10-20-rail.osm.pbf
uv run --no-project python -I services/router/scripts/route_types.py data/inputs/delfi/2026-10-19/delfi-gtfs.zip

bash services/router/scripts/import.sh gtfs            # logs/gtfs-d49-import.{summary,time,log,mem.csv,files}
bash services/router/scripts/import.sh rail            # logs/rail-d49-import.*
RUN_NAME=gtfs-night-d14 NUM_DAYS=14 SCRIPT="$PWD/services/router/config/night-classes.lua" \
  bash services/router/scripts/import.sh gtfs           # 14 days plus the night class script

bash services/router/scripts/bench.sh gtfs-d49         # logs/gtfs-d49-bench.json
bash services/router/scripts/bench.sh rail-d49         # logs/rail-d49-bench.json
bash services/router/scripts/bench.sh gtfs-night-d14   # labels_night shows NIGHT_RAIL
RT_MINUTES=20 bash services/router/scripts/rt-test.sh rail-d49   # logs/rail-d49-rt.json, rail-d49-rt-server.log
```

`import.sh full` (whole Germany OSM with street routing) exists but was not run in SP-1: the 16 GB development machine had no headroom
left with the other jobs running (see the SP-1 report). Its memory need is unmeasured; try it on a larger machine
first, with the memory guard of `run-measured.sh` in place.

Realtime ingest summary from the server log:

```bash
grep -c 'GTFS-RT update stats' data/router/logs/rail-d49-rt-server.log
grep 'rt update\] finished' data/router/logs/rail-d49-rt-server.log
```

Summary of a bench result:

```bash
jq '{memory_after_start, memory_after_load, plan_berlin_munich_all, plan_berlin_munich_no_hsr,
  map_trips_germany_zoom8, load}' data/router/logs/rail-d49-bench.json
```

The paths under `data/` above are relative to the main checkout.

Memory is reported two ways: RSS from `ps` and the physical footprint from `/usr/bin/footprint` (dirty plus
compressed memory, without clean file-backed pages that macOS can drop; macOS only, null on Linux). The import summary
carries the peak of both from `/usr/bin/time -l`; on Linux only the peak RSS, from `/usr/bin/time -v`.

Import facts per run: `logs/<run>-import.summary` (wall time, peak RSS, peak memory footprint, swap, guard),
`runs/<run>/data/timing.txt` (MOTIS step timings), `runs/<run>/data/logs/route_shapes.txt` (matched and beelined
segments), `runs/<run>/data/timetable_metrics.json` (locations, trips, transports times days).

Manual server for exploration:

```bash
bash services/router/scripts/serve.sh rail-d49
curl 'http://127.0.0.1:8090/api/v6/plan?fromPlace=de-DELFI_de:11000:900003201&toPlace=de-DELFI_de:09162:100&time=2026-10-27T06:00:00Z'
bash services/router/scripts/stop.sh rail-d49
```

Stop and trip IDs are DELFI IDs prefixed with the dataset tag and an underscore (`de-DELFI_`). The dataset tag is
`de-DELFI`, as on Transitous. The SP-1 runs in `data/router/runs/` were imported with the earlier tag `de` and keep it; `bench.sh` and
`rt-test.sh` read the tag and the port from each run's `config.yml`, so they work for both. `map/trips` refuses more than
12,000 trips per request (`too many trips`), so query Germany at zoom 8 or below; zoom 8 already returns every rail
class including S-Bahn (MOTIS minimum zoom per class: long distance 4, regional 7, S-Bahn 8, U-Bahn 9, tram and bus
9 to 10).

## Service run and Compose service (WP-2.5)

The service imports the enriched feed of `pipelines/static_import` (`enrich`), configuration (2) of D-024, as run
`delfi-2026-10-19-rail` (dataset tag `de-DELFI`), under the heavy lock:

```bash
RUN_NAME=delfi-2026-10-19-rail PORT=8091 \
  DELFI_ZIP="$PWD/data/static/2026-10-19/delfi-gtfs-enriched.zip" \
  GUARD_MAX_SWAP_MB=16384 GUARD_MIN_FREE_PERCENT=55 bash services/router/scripts/import.sh rail
bash services/router/scripts/container-config.sh delfi-2026-10-19-rail
bash infra/compose.sh --profile router up -d --wait router      # from the main checkout
curl http://127.0.0.1:8092/api/v1/health
```

The Compose service `router` (profile `router`) builds `gerlines-router:2.11.4` from `Dockerfile`, mounts
`${ROUTER_RUN_DIR}/data` read-only at `/data` and `${ROUTER_RUN_DIR}/container.yml` over `/data/config.yml`, and
publishes `127.0.0.1:${ROUTER_PORT:-8092}`. `ROUTER_RUN_DIR` defaults to `../data/router/runs/delfi-2026-10-19-rail`
relative to `infra/`, so a worktree sets it to the main checkout's absolute path. A data dir imported natively on
macOS arm64 loads in the Linux arm64 container unchanged: the server needs only the data dir, and the absolute import
paths in its config are not read when serving. Memory limit 3 GiB against a measured peak of 2,391 MiB under 8 parallel
journey clients and about 1.5 GiB idle.

## Categories

Our rules decide (D-025). `enrich` writes the route type of our category into `routes.txt` (`hsr` 101, `ld` 102,
`night` 105, `rfast` and `reg` 106, `sbahn` 109), and MOTIS (nigiri) maps these to HIGHSPEED_RAIL, LONG_DISTANCE,
NIGHT_RAIL, REGIONAL_RAIL and SUBURBAN. That covers IC filed as 106, EC and RJ on 101, night lines and S-Bahn lines
filed as 106, so no Lua script is needed; `rfast` against `reg` has no MOTIS class and stays a post-filter in
`apps/api`. MOTIS joins trips of one `block_id` (stay-seated) into one run and reports one class for every leg of that
run, and routing matches the run under any class in it (a 43N after an IC is found with `transitModes=LONG_DISTANCE`
and labelled LONG_DISTANCE). By default `/api/v6/plan` also returns the run as one joined leg with the route type of
its first trip (IC, 102, Amsterdam to Basel for the IC and 43N block), so `apps/api` asks with
`joinInterlinedLegs=false`: each trip is its own leg with its own `routeType`, later ones with
`interlineWithPreviousLeg`. The API takes categories from `routeType` and post-filters.

```bash
node --env-file=.env --eval 'process.exitCode = require("node:child_process").spawnSync("uv", ["run",
  "--no-project", "--with", "psycopg[binary]==3.3.6", "python", "-I", "services/router/scripts/parity.py",
  "--motis", "http://127.0.0.1:8092", "--date", "2026-10-27",
  "--out", "data/router/logs/delfi-2026-10-19-rail-parity-weekday.json"],
  {stdio: "inherit"}).status'
uv run --no-project python -I services/router/scripts/journeys_bench.py --api http://127.0.0.1:8788 \
  --out data/router/logs/delfi-2026-10-19-rail-journeys-bench.json
```

`parity.py` reads `gerlines_replay` (or `PGDATABASE`), asks MOTIS for every train trip running on `--date`, and lets
the API's own `categoryOfLeg` (through `apps/api/scripts/categorize-legs.mjs`, Node 24 on `PATH`) name each leg's
category from `routeType`, `displayName` and `mode`. It exits 1 when that category differs from the trip's
`category_code` or a trip is missing; the report lists those trips with their `displayName`, groups them by route,
and also lists MOTIS mode differences with the legs of their block. `journeys_bench.py` needs the API running with `ROUTER_BASE_URL` set and Docker for the
memory samples.

## Timetable window

The DELFI feed of 2026-10-19 is valid from 2026-10-03 to 2026-12-12. Imports default to `FIRST_DAY=2026-10-25` and
`NUM_DAYS=49`, which ends with the feed. A new DELFI feed means a new import; set `FIRST_DAY` to the import day.
