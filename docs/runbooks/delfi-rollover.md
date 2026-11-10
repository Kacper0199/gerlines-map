# Runbook: weekly DELFI feed rollover

DELFI publishes a new national GTFS feed every Monday (`<YYYYMMDD>_fahrplaene_gesamtdeutschland_gtfs.zip` behind the
keyless sharing link). The recorder stores each new file once (`data/recordings/delfi-gtfs/<fetch day>/`), and
realtime payloads refer to the trip ids of the newest feed from the moment DELFI switches. This runbook takes a new
feed through every stage beside the running one: static import, shapes, MOTIS, realtime and the live engine. Nothing
replaces the old version until the new one is complete; the live engine switches by itself at 03:00 Europe/Berlin
once the new version's shapes cover the day's patterns about as well as the old version's (section 5).

Decisions behind it: D-025 (one transaction per version, versions side by side), D-028 (shape method), D-040
(realtime version set), WP-3.2 (timetable version switch, FORMAT.md section 3).

## 0. Before you start

| Check | Command | Stop when |
| --- | --- | --- |
| A new feed was stored | `uv run gerlines-static-import stage-recorded` prints `staged <Monday>` (step 1) | it says `reused` for last week's Monday: nothing new |
| Disk | `df -h data/` | under 60 GiB free (the new version needs about 1.5 GB of database rows and 0.5 GB of shape work files) |
| Power | the machine is on mains power and will not sleep (on macOS `pmset -g batt` says AC power) | a laptop on battery or with the lid closed sleeps and a step stalls (section 6: keep it awake with `caffeinate -dims` on macOS or `systemd-inhibit` on Linux) |
| Memory | `memory_pressure` (macOS) or `free -m` (Linux) | under 40 % free for pfaedle, evaluate, build, finish, load (they refuse by themselves, or wait with `GUARD_WAIT_S`, step 2) |
| Locks | `data/locks/heavy/owner.txt`, `data/locks/db-load/owner.txt` | another job holds them: wait, never break a lock |
| Database | `DATABASE_URL` names the target | on the shared `gerlines`, only the maintainer runs this runbook |

Every command below runs from the repository root. `D=data`, `F=<Monday>` (for example `2026-11-02`),
`W=$D/rail_graph/feeds/$F`, `R="uv run --group rail-graph gerlines-rail-graph"`, `N=<new feed_version_id>`,
`O=<previous feed_version_id>`.

## 1. Static import beside the old version

```bash
uv run gerlines-static-import stage-recorded                     # links the newest stored feed to $D/inputs/delfi/$F/
DATABASE_URL=... uv run gerlines-static-import load $D/inputs/delfi/$F/delfi-gtfs.zip
DATABASE_URL=... uv run gerlines-static-import display-names --eva $D/inputs/delfi/<week of the EVA copy>/delfi-gtfs-extended-zhv-evaNr.zip \
  --stada $D/inputs/stada/<date>/stada/all/<file>.json --vg250 $D/geo/bkg-vg250/vg250_01-01.utm32s.gpkg.ebenen.zip
DATABASE_URL=... uv run gerlines-static-import products --feed-version $N --gtfsde <newest gtfsde-static-fv zip>
uv run gerlines-static-import enrich $D/inputs/delfi/$F/delfi-gtfs.zip     # for MOTIS (step 3)
```

- `display-names` needs a StaDa full list (`pnpm --filter @gerlines/ingest db-apis download --api stada --out
  $D/inputs/stada/<date>`, one call per day per key, K1) and the VG250 archive of `pipelines/geo_base`; a list a few weeks
  old is fine, stations rarely change names.
- `stage-recorded` reads the recorder's `day.jsonl`, takes the feed's Monday from the stored URL, hard links the file
  (no extra disk, the recording stays untouched), checks its sha256 and writes the sidecar `download` would write. With
  `--monday` it stages an older stored week. Without recordings, `download` fetches the file instead.
- `load` adds a version (`feed_version.status` goes to `loaded` only at commit) and never touches other versions. It
  prints `feed_version_id`; that is `N`. Measured 2026-11-06: 180 s, 342 MB RSS, 30,424 patterns.
- Without an EVA mirror copy of the same week, run `load` without `--eva`: stop places keep the EVA numbers they have
  (the upsert keeps the old value); new places get none until a later week with the copy.
- Stop place identity: a station that DELFI gave another id in this feed keeps the stop place it had, so
  realtime rows, statistics and history do not split at the rollover. `load` takes the stored place for a place with
  a new id by a DHID under another district key, an EVA number both ids carry, or the same name within 100 m, never a
  place another place of this feed holds, and folds the platforms of one station that DELFI put under two district
  keys. Review `$D/static/$F/place-identity.csv` (and `stops.identity` in `load-report.json`) before step 2:
  `reused` and `folded` rows are the merges, `refused` rows are candidates a place of this feed holds, mostly a split
  station or a bus station next to a railway station. Measured 2026-10-19 to 2026-11-02: 17 reused, 2 folded in
  2026-10-19 (Göttingen, Speele), 1 refused (Basel Bad Bf, DB trains and FlixTrain split into two places); in the
  night of 2026-11-07, 14 of the 87 realtime rows that named another place than the O run now match by index, and 25
  with a Basel override. A wrong merge or a split to join goes into `pipelines/static_import/place-identity-overrides.csv`
  (`key,stored,decision,reason`, decision `same` or `separate`) and the version is loaded again before realtime
  folds on it (`load` of the same zip refills it; `separate` gives a wrongly merged place its own identity again,
  `place-identity.csv` says `separated`). A `separate` row points the key at the new place in `id_map` (the only
  key `load` ever remaps, counted as `stops.identity.keys_remapped`) and the stored place gives up the DHID or IFOPT
  the new place carries (`ids_released`), so the split lasts at later loads; keep the row in the file all the same.
  Limits of `separate`: it acts on one key, so when DELFI renames the station again the rule may give the new key
  either place (check `reused` rows for it and add a row for the new key); keys an earlier load folded into the
  merged place stay with it; realtime rows, statistics and history recorded before the split stay on the merged
  place (no rewrite). Add a `same` override only for the newest pair: a place already loaded keeps its
  id, so joining Basel at the next load would split it from the version before. `load` stops when an override file
  given with `--place-overrides` does not exist; `skipped` rows list overrides whose key is not in this feed, and
  `review` rows list merges to check by eye: district twins that were both stored places (their points now share
  one place, the folded key stays mapped to the other) and name matches where one name says Bahnhof or Bf and the
  other does not say the same (a bus stop at the station named X Bahnhof next to the railway station X Bf).
- Check: `load-report.json` in `$D/static/$F/` (integrity all zero, `fallback_routes` reviewed), and the version row:
  `SELECT feed_version_id, published_on, feed_version, valid_from, valid_to FROM feed_version`.
- Check `platform_stop_numbers` in `load-report.json` (the load also prints its warnings): the VRS and OWL districts
  whose platform codes the API reads as stop numbers, not tracks (`STOP_NUMBER_FROM` in
  `packages/schema/src/platform.ts`). A warning that a listed district has many codes under its floor means
  the district changed its scheme: compare its stations against recorded IRIS plans (`data/recordings/db-iris-plan-*`)
  and change `STOP_NUMBER_FROM` and `pipelines/static_import` `platform_codes.py` together. On the 2026-10-19 feed the
  only warnings name unlisted districts with codes of 70 and above (MVV S-Bahn 09162, Märkischer Kreis 05962, Bingen
  07339, Hanau 06435), all unverified; a new district in that list is worth the same check.
- A republished Monday (DELFI replaced the file after it was staged): `stage-recorded` stops with `already holds
  another file; move it away first`. Move the staged file away, run `stage-recorded` again and `load` the new file:
  that is a second version with the same `published_on`, and the engine takes the higher `feed_version_id` of the two.
  Hide the first one as in section 7 so the realtime processor does not match against it, then run steps 2 to 5 for
  the new `N`.

## 2. Shapes: reuse, then build only the new patterns

```bash
DATABASE_URL=... $R reuse --work $W --feed-version $N --from-version $O --db-load-lock $D/locks/db-load
DATABASE_URL=... $R patterns --work $W --feed-version $N --outline design/variants/data/germany-outline.geojson \
  --week-from <next Monday> --week-to <next Sunday> --only $W/new-patterns.json
uv run gerlines-static-import subset $D/inputs/delfi/$F/delfi-gtfs.zip --trips $W/rep-trips.txt \
  --name delfi-gtfs-new-patterns.zip
TRAINS_ZIP=$D/static/$F/delfi-gtfs-new-patterns.zip bash pipelines/rail_graph/scripts/run-pfaedle.sh rollover-$F
TRAINS_ZIP=... PFAEDLE_PARAMS_FILE=pipelines/rail_graph/config/pfaedle-strict-turns.cfg \
  bash pipelines/rail_graph/scripts/run-pfaedle.sh rollover-$F-strict
$R pfaedle-sidecar --pfaedle $D/rail_graph/pfaedle/rollover-$F --osm <pbf> --gtfs $D/static/$F/delfi-gtfs-new-patterns.zip --image <digest>
$R pfaedle-sidecar --pfaedle $D/rail_graph/pfaedle/rollover-$F-strict ... --params pipelines/rail_graph/config/pfaedle-strict-turns.cfg
$R extract-pfaedle --work $W --pfaedle $D/rail_graph/pfaedle/rollover-$F --alternate $D/rail_graph/pfaedle/rollover-$F-strict
$R fetch-motis --work $W --without-router          # or --router-run once MOTIS serves the new feed (step 3)
$R evaluate-all --work $W --osm $D/rail_graph/osm --outline design/variants/data/germany-outline.geojson \
  --workers 3 --heavy-lock $D/locks/heavy
$R choose --work $W
$R build --work $W --osm $D/rail_graph/osm --outline design/variants/data/germany-outline.geojson --workers 3 \
  --heavy-lock $D/locks/heavy
$R finish --work $W --dem $D/rail_graph/dem --dem-archive $D/rail_graph/dem/mapterhorn-z12-de.pmtiles \
  --heavy-lock $D/locks/heavy
$R verify --work $W
DATABASE_URL=... $R load --work $W --feed-version $N --merge --heavy-lock $D/locks/heavy --db-load-lock $D/locks/db-load
```

- `reuse` links each new pattern to an earlier version's shape, in this order: the same pattern id; the same stop
  points in order with the same category; the same stop places in order (another platform). It refuses a reuse when
  a stop now stands more than 80 m from its stop arc on the old shape and more than 20 m beyond the distance
  the same stop was gated with (`metrics.stop_m` of the old link by stop index, or `metrics.max_stop_m` when that
  list does not have one entry per stop). Stop points are one table that each
  load overwrites, so today's coordinates of the old stops are no baseline. Only passing shapes matched on rails are
  reused: a pattern whose old shape is a straight fallback or did not pass the gate is built again, so new OSM data or
  a reimported MOTIS get another try (`not_reused_quality` in `reuse.json`). When several old shapes share a stop key
  (a diversion variant), the one with the same DELFI shape key wins, then the same route key, then the same line name,
  then the gate ranking (`collisions` and `decided_by` in `reuse.json`). Reused links copy the old link's method,
  verdicts, metrics and review flags and add `metrics.reused_from` with today's worst stop distance (`worst_m`). It
  writes `reuse.json` (counts) and `new-patterns.json` (what is left). It skips patterns that already have a link, so
  a rerun after a crash continues.
- `patterns --only` keeps the listed patterns and writes `rep-trips.txt`, their representative trips, which
  `subset --trips` turns into a small GTFS for pfaedle.
- Until MOTIS is reimported (step 3), `fetch-motis --without-router` gives no MOTIS candidate, so the gate chooses
  among pfaedle and the straight fallback. Rerun from `fetch-motis` with `--router-run` later to let MOTIS compete.
- `load --merge` replaces only the links of the patterns built here; without `--merge` it would drop the reused links.
- Heavy steps take `data/locks/heavy` themselves and refuse below 40 % free memory. A chain of steps (a script that
  runs this section unattended) runs under `bash pipelines/rail_graph/scripts/run-chain.sh bash <chain script>`,
  which sets `GUARD_WAIT_S=3600` and `GUARD_RETRIES=1` (values already set win) and keeps a macOS machine awake with
  `caffeinate -dims` (section 6), instead of a wait loop of its own: then `evaluate-all`, `build`, `finish`, `load`
  and `run-pfaedle.sh` wait for the floor, polling every `GUARD_WAIT_INTERVAL_S` (60) seconds and logging each wait
  (`waiting for memory: 39 % free, floor 40 %, waited 60 of 3600 s`), and refuse only when the hour ran out.
  `run-pfaedle.sh` also reruns pfaedle once after its guard stopped it with a failure, for swap growth or for
  critical memory pressure alike, when memory is back at the floor and swap is back within half of `GUARD_SWAP_MB`
  of the first start (all attempts share that one swap baseline, so a retry never gets a fresh 2 GB; otherwise the
  summary says `no retry` and the run fails). A container that had already exited 0 when the guard fired is kept,
  not retried. Killed (Ctrl-C, `kill`), the script stops the container, saves its log and removes it. Without the
  variables the steps refuse at once, as before. One run
  lost a step to each: strict pfaedle was stopped by the swap guard (swap 14.9 to 17.1 GB) and `load` refused at
  39 % right after the chain's own wait saw 40 %.
- Check: the patterns of `$N` equal its links plus the patterns without a service date in the window
  (`without_service_date_in_window` of the `patterns` step, 555 here); the switch rule passes for `N`: render the next
  night on a scratch database (section 6) and read its `timetable decision` line, where `N`'s `coverage` must reach
  `floor` and its `runs` must reach `runsFloor`; `verify` reports 0 violations.

### 2a. Track beyond the border

The German extract stops at the border, so cross-border legs had no track to match and no area to be measured in:
on 2026-11-02, 1,342 of 1,389 cross-border links came out `unmeasured` and were drawn straight (D-067). The
neighbours' rail OSM fixes this where it is downloaded. Run it **after `reuse` and `patterns` of step 2 and before
`run-pfaedle.sh`**; the corridor needs every pattern of the feed, so write those once with `patterns` without
`--only` into a folder of their own.

```bash
DE_RAIL=$D/router/osm/germany-2026-10-20-rail.osm.pbf; DE_FULL=$D/inputs/osm/germany-2026-10-20.osm.pbf
NB=$D/inputs/osm-neighbours/<date>; NO=$D/router/osm/neighbours-<date>; C=$NB/corridor-$F.geojson
DATABASE_URL=... $R patterns --work $W/all --feed-version $N --outline design/variants/data/germany-outline.geojson
node --env-file=.env --eval 'process.exitCode = require("node:child_process").spawnSync("bash",
  process.argv.slice(1), {stdio: "inherit"}).status' services/router/scripts/download-neighbours.sh $NB
$R source-md --dir $NB
$R corridor --patterns $W/all/patterns.json --outline design/variants/data/germany-outline.geojson \
  --previous <last corridor> --out $C
$R neighbours --corridor $C --index $NB/geofabrik-index-v1.json --out $NO --keep-rail \
  $(awk '/^[a-z]/ {print "'$NB'/" $1 ".osm.pbf"}' services/router/config/neighbours.txt)
$R merge-osm --base $DE_RAIL $(printf -- '--add %s ' $NO/*-corridor.osm.pbf) --out <merged rail pbf>   # MOTIS, caches
$R merge-osm --base $DE_FULL $(printf -- '--add %s ' $NO/*-corridor.osm.pbf) --out <merged full pbf>   # pfaedle
$R osm --rail-pbf <merged rail pbf> --full-pbf $DE_FULL $(printf -- '--full-pbf %s ' $NO/*-corridor.osm.pbf) --out $W/osm
$R osm-structures --rail-pbf <merged rail pbf> --osm $W/osm
```

To clip a grown corridor again from the kept rail filters, without the raw downloads (the files are read in place,
never filtered over; each `<region>-rail.osm.pbf.json` names the raw download's url and sha256 and the filter):

```bash
$R neighbours --corridor $C --index $NB/geofabrik-index-v1.json --out $NO --keep-rail $NO/*-rail.osm.pbf
```

- `corridor` takes every stop-to-stop leg of the feed's patterns that leaves Germany, up to 300 km beyond the border,
  buffered by 20 % of its length (5 to 25 km), and joins it with `--previous`, so it only grows; it prints the area,
  the area added and the area of the previous corridor the feed no longer draws (`previous_not_drawn_km2`), in km2.
  Drawn from the new patterns only, it would leave out lines whose shapes were reused (Linz to St. Poelten on
  2026-11-08) and shrink the next week.
- The regions in `services/router/config/neighbours.txt` are the smallest Geofabrik regions that hold most of it
  (23 files, 6.29 GB on 2026-11-08; budget `MAX_BYTES` 7 GB). `download-neighbours.sh` reads every size first and
  stops before downloading anything above the budget, takes one file at a time with the project User-Agent, checks
  Geofabrik's md5 (fetched again once when Geofabrik updated the file meanwhile) and skips files already complete.
  `source-md` writes the folder's `SOURCE.md` from the download sidecars.
- `neighbours` keeps track and platform ways, every `railway` node and stop node, rail route and stop area relations,
  and what they reference with their tags; this is a superset of the German rail extract's filter (`extract_rail.py`
  keeps only stop nodes and no route relations), because pfaedle reads those from the full German extract. It cuts each
  region to the ways with a node in the corridor (whole) and keeps every relation with a member there, with its full
  member list. It writes a sidecar with sha256 per region and `held.geojson`, the corridor inside the downloaded
  regions' polygons: the only area beyond Germany with track in the caches. `--keep-rail` keeps
  `<region>-rail.osm.pbf`, so a grown corridor can be clipped again from those files without the downloads.
- `merge-osm` lays the clipped regions over the German file: an object of a region enters only with a higher version
  than the German copy, so an equal version keeps the German one (a complete German relation stays complete); between
  regions the higher version wins, then the copy with more members. It writes `<out>.json` with every sha256.
- Then step 2 changes in these commands only: `run-pfaedle.sh <run> <merged full pbf>`, `pfaedle-sidecar --osm
  <merged full pbf>`, `evaluate-all --osm $W/osm --coverage $NO/held.geojson`, and `--osm $W/osm` for `build` and
  `stubs`. `--coverage` joins the held area to the outline before the 2 km inset: stops and samples there are
  measured, and the rest of the corridor stays unmeasured, as missing data. Without it a shape abroad stays
  `unmeasured`. `qa-report.json` records the coverage path and sha256, and `cross_border_unmeasured_abroad` marks
  only shapes with stops or track outside the measured area.
- Measured 2026-11-08: `neighbours` 136 s, 1.7 GB; the rail merge 3 s (104 MB, German 58.6 MB, 0 missing way nodes);
  the full merge 80 s (4.92 GB); `osm` 20 s (496,630 track ways against 274,450).

## 3. MOTIS reimport

```bash
DELFI_ZIP=$PWD/$D/static/$F/delfi-gtfs-enriched.zip RUN_NAME=rail-$F PORT=<a port no other run uses> \
  GUARD_MIN_FREE_PERCENT=55 bash services/router/scripts/import.sh rail
```

- With the neighbours' track (step 2a) set `RAIL_PBF=<merged rail pbf>`, and set `FIRST_DAY` and `NUM_DAYS` so the
  window holds every representative date of `$W/patterns.json` (the `patterns` step picks them from 2026-10-24 to
  2026-12-11 by default), or `fetch-motis --router-run` finds no trip for the patterns outside it.

- The rail variant imports in about 3 minutes but needs about 8.1 GB of memory with the neighbours' track (measured 2026-11-08:
  5.21 GiB peak RSS, 8.10 GB footprint; SP-1 without it 7.45 GiB): run it alone, under the heavy lock, with at least
  55 % memory free and no browser open, never beside pfaedle or a replay. It writes `runs/<run>/inputs.json` with the
  sha256 of the feed and the OSM file.
- `fetch-motis` counts as `no_service_date_in_router_window` the patterns whose trips run on no day of the `patterns`
  window (2026-10-24 to 2026-12-11; 679 in 2026-11-02, `without_service_date_in_window` of the `patterns` step): they
  have no representative trip to ask MOTIS for, whatever the MOTIS window.
- `import.sh` runs under `run-measured.sh` (memory guard) and writes a new run folder `data/router/runs/rail-$F`;
  serve it on its own port (the `PORT` of the import; `serve.sh` refuses a port that already answers, so a second run
  can never be mistaken for the first), check a few journeys (`scripts/bench.sh`), then point the
  API at the new run and stop the old server. Journeys planned on the old feed keep working until then.
- Stop ids the search gives: every station of the search answers the `stopId` the planner
  sends to MOTIS, the DHID or else the station's newest `id_map` key, and where one station has several stop places
  (district twins such as Göttingen `de:03152:33817` and `de:03159:33817`, or one EVA number and one name within 1 km)
  the id of the place the newest loaded feed serves, then the one seen latest, then one that is not a place the
  importer built from platform ids, then a `location_type` 0 row of
  `stops.txt` (a `stop_point` key in `id_map`; a parent station is a row MOTIS accepts too, but only a `stop_place`
  key) (`apps/api/src/search/stop-ids.ts`). MOTIS answers 404 `stop_not_found` for an id that is no row of its
  feed's `stops.txt`. The rule assumes the newest version in the search database is the one the router runs on, and
  "seen latest" follows the order of loads, not `published_on`: never load an older DELFI version into the search
  database again (it would look newest), and switch the API to the new run the same day step 1 loads its feed. The choice is made in the API, so export it with the API's own code, for the service day the API
  answers, before step 1 and again here, and check every id, stations with a DHID included:

  ```bash
  DAY=$(TZ=Europe/Berlin date +%F)
  (set -a; . ./.env; set +a     # the password stays out of shell history; SEARCH_DB=<the API's search database>
   SEARCH_DATABASE_URL="postgres://$POSTGRES_USER:$(node -p 'encodeURIComponent(process.env.POSTGRES_PASSWORD)')@127.0.0.1:${POSTGRES_PORT:-5433}/${SEARCH_DB:-$POSTGRES_DB}?options=-c%20default_transaction_read_only%3Don" \
     pnpm --filter @gerlines/api exec node src/search/stop-ids-export.ts $DAY) > $D/static/$F/stop-ids-after.tsv   # before step 1: stop-ids-before.tsv
  unzip -p $D/static/$F/delfi-gtfs-enriched.zip stops.txt | cut -d, -f1 | tr -d '"' | sort -u > $D/static/$F/stop-ids-feed.txt
  unzip -p <old run's delfi-gtfs-enriched.zip> stops.txt | cut -d, -f1 | tr -d '"' | sort -u > $D/static/$F/stop-ids-feed-old.txt
  cut -f2 $D/static/$F/stop-ids-after.tsv | grep -v '^$' | sort -u | comm -23 - $D/static/$F/stop-ids-feed.txt > $D/static/$F/stop-ids-missing.txt
  comm -12 $D/static/$F/stop-ids-missing.txt $D/static/$F/stop-ids-feed-old.txt > $D/static/$F/stop-ids-dropped.txt
  wc -l $D/static/$F/stop-ids-missing.txt $D/static/$F/stop-ids-dropped.txt
  diff <(cut -f1,2 $D/static/$F/stop-ids-before.tsv) <(cut -f1,2 $D/static/$F/stop-ids-after.tsv)
  ```

  The export prints `stop_place_id`, stop id and name per station (an empty stop id is a station the planner greys
  out) and the station count and timetable version on stderr; it takes about 1.5 s. `stop-ids-missing.txt` holds the
  ids no row of the new feed carries, `stop-ids-dropped.txt` those of them the old run still had:

  - A dropped id: the planner answers 404 for that station once the API points at the new run. Find the station with
    `grep -F "<id>" stop-ids-after.tsv`, then look for it in the new feed:
    `unzip -p $D/static/$F/delfi-gtfs-enriched.zip stops.txt | grep -F -e '"<id>:' -e "<name>"`.
    1. Nothing of it left (the station left the feed, or carries a new id): if step 1 has not loaded the new feed
       into the search database yet, load it and export again. The search day then uses the new version, which no
       longer serves the old place, and among the places of one station the search takes the one the new version
       serves. An id still dropped after that is a defect.
    2. Only its platforms left (`<id>:…` rows, the station row gone, as Durmersheim Nord `de:08216:35109` on
       2026-11-02): the place keeps its DHID, which the new feed no longer has as a row; MOTIS answers 404 for it
       and the journeys API asks again with the station's platform seen latest, which works while that
       platform is a row of the new feed (`grep -xF <platform id> stop-ids-feed.txt`).
    Report every dropped id still there after step 1 with the id, `stop_place_id`, name and what the new feed has for
    the station, before switching the API; never edit `id_map` by hand. On 2026-11-09 (search of a replay database, feed
    2026-10-19, against feed 2026-11-02) 153 ids were dropped, 104 of them DHIDs, and 78 of the 153 kept their
    platforms in the new feed.
  - A missing id the old feed lacked as well is a place the importer built from platform ids without a `stops.txt`
    row of its own (Oberbettingen-Hillesheim `de:07233:30669`: MOTIS 404, its platform `de:07233:30669:2:2` answers;
    Göttingen `de:03159:33817` was such a place in feed 2026-10-19, and the importer now gives both Göttingen places
    `de:03152:33817`). MOTIS answers 404 for it on both runs, and the journeys API asks again with the station's
    platform seen latest and in the most trip patterns (`SearchIndex.routableStopOf`). 658 of the 811 missing ids were of
    this kind on 2026-11-09 (654 after that retry, 650 of them with a platform in feed 2026-11-02). Compare the count with
    the previous rollover's and report a rise.
  - Every id that changed between the two exports must be in the new feed (`grep -xF <id> stop-ids-feed.txt`), and
    the API must point at the new run the same day.

## 4. Realtime version set

Nothing to run. The live realtime processor (`realtime live`) checks for DELFI versions that reached `loaded` and
loads the newest into its matcher (`timetable version loaded` in its log); at most two versions stay in memory, the
oldest is dropped once no payload has named it for a while (`timetable version dropped from memory`). Payloads are
matched by the exact `feed_version` in their GTFS-RT header; a payload naming a version that is not loaded yet is
matched by stops against the newest and folded again once it is loaded.

- Check after the load: the log line above within a few minutes; `realtime check` reports 0 invariants; the share of
  `feed_version_not_loaded` in the quality counts falls to 0.
- A replay into a scratch database loads the newest two versions published by `--to` (or `--feed-version-ids`).

## 5. Live engine switch

Nothing to run either: at 03:00 Europe/Berlin (and at start, by the rule at the end of this section, or when the active version's `valid_to` passed) the engine
reads the loaded versions and moves to the newest one published by today whose shape coverage for today (the share of
the day's patterns with a passing shape) is at least 0.95, or at most 0.02 below the active version's and at least
0.90 (`SWITCH_COVERAGE_FLOOR`, so the slack cannot slide week by week); otherwise it stays. Every decision is
logged with both coverages (`timetable decision` in the `live run` log). The second rule exists because the shape gate passes about 93 % of patterns (the 2026-10-19 version covers
92.2 % of the patterns running on 2026-11-06), so 0.95 alone would never switch. An expired active version
(`valid_to` passed) gives way only to newer versions; an active version that is no longer loaded (rollback) is left for
the best loaded one at the next read of the version list, at most 5 minutes later. A switch writes a keyframe without a delta under the new timetable version; clients drop
frames of the old version (FORMAT.md section 3). Trains already running keep their plan; trains admitted after the
switch come from the new version, under the same instance ids. A train the engine already ended under the old version
stays ended: the switch reloads the service days, but the engine remembers the instances it dropped per day and does
not admit them again (stop indices of two versions differ, so a late train coming back on its new plan looked like a
step back: IC 22 of 2026-11-05, Dortmund Hbf stop 9 in 2026-10-19 and stop 8 in 2026-11-02).

```bash
node services/live/src/cli.ts packs build --out <live dir> --timetable-version $N \
  --allow-u-turn-shapes <shape numbers checked by hand>   # before the deadline below
```

- The pack gate names accepted faults by shape number: a first build without `--allow-*` lists the offenders
  and exits 1; check each one, then rebuild with their numbers. A passing full build writes `s/<epoch>/complete.json`,
  which `live run` waits for. Measured 2026-11-07 on 2026-11-02: 4 U-turn shapes (169889, 170169, 171355, 171863),
  23,625 shapes, 57 s with every pack already written.

- **Deadline: 03:00 Europe/Berlin** on the day of the switch, which is 02:00Z under CET and 01:00Z under CEST. Finish
  `load --merge` (step 2) and the pack build before it. `live run` never switches to a version whose packs
  `s/<epoch>/complete.json` does not mark (V-84 M2): the nightly decision line then shows the candidate with
  `packs` false, the engine stays on O and looks again at every read of the version list (every 5 minutes, decision
  `reason` packs), so a late pack build switches within 5 minutes of its end, during the day as well. A restart
  keeps this: the restored engine makes one `packs` decision at its first read of the version list. An expired O
  waiting for packs is decided again only at these reads, not every tick, and never gives way to a version
  published before it. A switch during the day reloads the service days under N: a running train whose first stop or
  first departure differs between O and N gets another instance id under N and can show twice, on its O plan and on
  its N plan, until its O run ends. Finish the pack build before 03:00, when few trains run, to keep this rare.
- Packs: shape numbers are never reused (epoch 1), so the build writes only the packs of new shapes and keeps the
  rest. Run it after step 2 and before the deadline, or the clients lack packs for the new shapes.
- Stubs: `load` keeps the stored stubs of shapes loaded earlier (`stubs_kept`); changed stubs (a newer OSM extract, a
  `STUB_VERSION` bump) need `load --restub` and a new shape epoch, or `packs build` marks those shapes stale.
- Check after 03:00: the head's `timetableVersion` is `N`; the `timetable` field of the `live run` tick line shows
  `version` N, `publishedOn` the Monday of N and `switches` one higher; the legend counts did not drop.
- A newer version must also run at least 0.9 of the active version's runs today (`SWITCH_RUNS_FLOOR`), so a thin
  feed that lost an operator or a region is refused even at full coverage. The decision line reports `activeRuns`,
  `runsFloor` and each candidate's `runs`.
- **When the head is still on O after 03:00** (the tick line's `refusals` went up): read the nightly `timetable
  decision` line. A candidate below `floor` lacks shapes: rerun step 2 from `fetch-motis --router-run` once MOTIS is
  reimported (step 3), then `load --merge` and the pack build; the engine takes N at the next 03:00. A candidate
  below `runsFloor` lacks trips: compare the trip counts of N and O per agency before going further, and report the
  feed to DELFI if it is thin. To take a version judged good by hand, restart with `live run --out <live dir>
  --timetable-version $N`: the engine serves N whenever it is loaded, below both floors (the decision line says
  `reason` pinned), and waits for N's packs before it starts. Restart without the flag once a later version passes
  on its own.
- **Realtime while the engine stays on O.** The realtime processor folds each payload on the version it names (N
  after DELFI moved to it), with N's stop indices. The engine places every source's rows on its O run with one
  monotone alignment (`services/live/src/plan/place-rows.ts`): rows keep their order on strictly increasing
  stops, and the placement of least total cost wins. A row's planned time is its prediction less its delay; on a stop
  of its own place it costs its planned time distance there (saturating at 5 min). A row moves to another index shift
  than the row before it only when it names a place and its planned time fits that stop within 5 min, and the shift
  costs as much as 1 min of time distance, so on a ring, a loop or a station visited twice a few minutes apart the
  visit of the planned time wins and no row lands on an earlier visit. A row without a place stays on the shift of
  the row before it (within 5 min, or untimed); a row naming a place the O run lacks goes only on the stop of the same
  planned time (within 30 s: a station under a new stop place id in N) and within 150 m of it (`placesWithin` over
  the `stop_place` coordinates, which the engine reads again when the version list changes and the detail reads
  with the place names; a place without coordinates is near none). Rows of O itself stay on their index without
  the alignment table. A row that fits no stop is dropped; only that stop loses its realtime (it runs on the delay
  carried from the stop before), the rows after it are still placed. The train detail places the rows with the same
  function and the same scheduled times, so the map and the card agree. Plan counters (per plan build, so a row
  counts once per rebuild): `placeMismatches` rows dropped, `placesRealigned` rows placed off their own index or on a
  stop of another place, `placesRenamed` of those the rows of a renamed station. Measured on the 2026-11-07 night
  render (O = 1, N = 2) with the realignment: 167 dropped (954 in the later run), 1,328 realigned (535), of them 705 renamed; the
  same three counts again after the review's weights and the 150 m check. The dropped rows are
  stops N added (Frankfurt Griesheim, Nied, Höchst); the renamed ones are the same stations under new ids, 0 to 87 m
  apart by `stop_place` coordinates (Göttingen, Basel Bad Bf, Karlsruhe Westbahnhof, Speele, Weißenstein Bahnhof), so
  the distance check drops none of them. There is no parent station in the schema; the check is distance only.
- **At start** (no restored chain, so no active version) the engine decides as if the best-covered current version
  with packs were active: among the versions published by today and not expired whose packs are marked
  and whose runs today reach 0.9 (`SWITCH_RUNS_FLOOR`) of the most runs among them, the one with the highest shape
  coverage today (ties to the newer) is the reference, the floors are taken from it as at 03:00, and a newer version
  is chosen only if it reaches them, otherwise the reference. The runs condition keeps a partial upload or a tiny
  fully shaped feed from becoming the reference (0.93 with 30,000 runs and 0.94 with 8,000 runs give the
  first, as the nightly runs floor would). The decision line shows `reason` start, `active` 0 and `reference`. So a
  restart or a render without `--restart-at` makes the same choice as the running engine made from the older version
  at 03:00 (2026-11-07: 1 at 0.9110 and 2 at 0.8912 give 1 at floor 0.90, as the nightly check did), with one
  exception: when the newer version covers more than the older one but both are under 0.90 (0.85 and 0.87), the
  newer one is the reference and stays, as the nightly check from the newer version would keep it, while the
  running engine on the older version would refuse it at the floor of 0.90. Only when every current version draws
  nothing today (coverage 0) does it take the newest version with packs.

## 6. Verification in a scratch database

Repeat the rollover on a scratch database before the shared one, with a replay across the switch:

```bash
DATABASE_URL=<scratch> RECORDINGS_DIR=$PWD/$D/recordings node services/ingest/src/realtime/cli.ts replay \
  --from <evening before> --to <after 03:00> --speed 0 --feed-version-ids $O,$N --report <file>
DATABASE_URL=<scratch> node services/live/src/cli.ts packs build --out <dir> --timetable-version $N
DATABASE_URL=<scratch> node services/live/src/cli.ts render --from <before 03:00> --to <after 03:00> \
  --out <dir> --report <dir>/render.json --version-available $N=<instant the load finished> --packs <packs dir>
DATABASE_URL=<scratch> node services/live/src/cli.ts verify continuity --out <dir> --packs <dir> --report <dir>/render.json
```

`--version-available` hides version `N` from the engine until that instant, as in production, where the version
appears only once its load finished; without it the engine would start on `N` and nothing would switch. `--packs`
applies the pack gate of `live run`.
Pass when: the render's `versionSwitches` is 1, the heads change to `N` at 03:00 local, the `timetable decision` line
of the nightly check names `N` as chosen, the render's detail check (`--detail-check`) reports `backwards` 0 and every
give-way verified (`passed` true), `verify chain` reports 0 mismatches, and `verify continuity` reports 0 jumps, 0
stalls, 0 backward steps and 0 off-track frames.

Measured 2026-11-07 (2026-10-19 to 2026-11-02 in a replay database, render 2026-11-06 00:00Z to 02:40Z,
`--version-available 2=00:30Z`): 9,601 ticks in 46 s, 594 MB; 1 switch, heads on version 2 from 02:00Z (2,401 heads);
decision active 1 at 0.9222, floor 0.9022, version 2 at 0.9046, chosen 2 (a margin of 0.0024: a weekly build that
covers a little less stays on the old version); detail check 1,699 updates, 0 backwards, 1 give-way verified (S 32063,
stop 1 cancelled by gtfs.de); chain 40 clients, 0 mismatches; continuity 696 trips, 0 jumps, 0 stalls, 0 backward
steps, 0 off-track frames, 0 U-turns.

Measured 2026-11-08 (the whole of steps 1, 2 and 5 as one chain: 2026-11-02 rebuilt as version 2 in
the replay database with reuse from version 1, replay of 2026-11-06T23:00Z to 2026-11-07T13:30Z, renders of the night
00:00Z to 02:40Z with `--version-available 2=00:30Z` and of the day 11:30Z to 13:00Z). Wall time and peak RSS per step
(`/usr/bin/time -l`):

| Step | Wall | Peak RSS | Result |
| --- | --- | --- | --- |
| stage-recorded | 1.4 s | 55 MB | sha256 equals version 2 |
| reuse `--from-version 1` | 201 s | 373 MB | 20,788 reused (same stops 14,127, same places 6,661), 2,035 sent back for quality, 4,065 stop moved, 9,636 new patterns |
| patterns, subset | 8 s, 76 s | 483 MB, 54 MB | |
| pfaedle default, strict | 718 s, 681 s | container 1,510 MB, 1,584 MB | the first strict run was stopped by the swap guard (swap 14.9 to 17.1 GB) |
| extract-pfaedle | 196 s | 1,940 MB | |
| fetch-motis `--without-router` | | | 0 shapes (MOTIS not reimported) |
| evaluate-all | 364 s | 1,118 MB | |
| choose | | | pass 6,907 of 9,636 (71.7 %; domestic 86.5 %, cross-border 28.5 %), low quality 1,340, unmeasured 1,389 (1,342 cross-border) |
| build | 149 s | 1,532 MB | |
| finish | 256 s CPU | 1,635 MB | 27,681 s wall: the machine slept (below) |
| verify | 1,269 s | 798 MB | 0 violations |
| load `--merge` | 25 s | 876 MB | 340 shapes inserted, 30,424 links of version 2 |
| packs build | 47 s | 596 MB | 23,863 shapes, 110 written, 0 failed, 4 allowed U-turn shapes |
| realtime replay (14.5 h of payloads) | 1,582 s | 2,117 MB | 7,336 payloads, 36,908 matched runs, 14 invariants 0 |
| render night, day | 164 s, 200 s | 489 MB, 592 MB | |

Without the sleep and the two resumes the chain is about 1 h 40 min of work (sum of the wall times above, with 256 s
for finish). Outcome: on 2026-11-07 version 2 covers 0.8912 and version 1 0.9110, so the floor is 0.90 and the night
check refused version 2 (versionSwitches 0, versionRefusals 1, all 9,601 night heads on version 1): the pass condition
above was not met that week. The gap is the MOTIS shapes version 1 had: 2,729 of 30,424 version 2 links are straight,
built this week without MOTIS (step 3). Detail check: 0 backwards in both windows, 1 give-way verified at night; verify
chain 40 clients, 0 mismatches in both; continuity 1,612 trips at night and 4,974 by day, 0 jumps, 0 stalls, 0 backward
steps, 0 off-track frames, 0 plans failed.

Measured 2026-11-08 (version 2 rebuilt in the replay database from `fetch-motis` on, with
the neighbours' track of step 2a and the MOTIS run `rail-2026-11-02`; work dir `data/rail_graph/feeds/2026-11-02-b1`):

| Step | Wall | Peak RSS | Result |
| --- | --- | --- | --- |
| pfaedle default, strict (merged full PBF) | 1,369 s, 1,191 s | container 2,314 MB, 2,321 MB | the first default attempt was stopped by the swap guard while swap grew from other jobs (container at 241 MB); rerun with `GUARD_SWAP_MB=6144` |
| MOTIS import `rail-2026-11-02` (merged rail extract, FIRST_DAY 2026-10-24, NUM_DAYS 50) | 174 s | 5.21 GiB, footprint 8.10 GB | data 6.0 GB; route_shapes 2,148 beelined segments (17,278 in `delfi-2026-10-19-rail`) |
| fetch-motis `--router-run` | 185 s | 2,721 MB | 8,916 of 9,636 with a MOTIS shape (679 without a service date in the window) |
| evaluate-all `--coverage` | 959 s | | legs without a rail path 717 (3,088 without the neighbours) |
| choose | | | pass 8,915 of 9,636 (MOTIS 6,639, pfaedle 2,276), low quality 709, unmeasured 12; cross-border unmeasured 1,342 to 6, pass 28.5 % to 90.7 % |
| build, finish, stubs | 357 s, 744 s, 19 s | 967 MB, 1,390 MB | finish fetched 467 DEM tiles beyond the archive box |
| verify | | | 0 violations |
| load `--merge` | 53 s | 690 MB | 6,706 shapes inserted; version 2 links pass 29,703, low quality 709, unmeasured 12 (straight 2,729 to 721) |
| packs build | 330 s | 667 MB | 25,646 shapes, 6,596 written, 0 U-turns, no `--allow-*` needed |
| render 2026-11-07 11:00Z to 13:00Z | 194 s | 674 MB | heads on version 2; detail check 3,509 updates, 0 backwards; chain 40 clients, 0 mismatches; continuity 6,289 trips, 0 jumps, stalls, backward steps, off-track frames |

Shape coverage of version 2 on 2026-11-07 rose from 0.8912 to 0.9794 (hsr 0.783 to 0.919, ld 0.497 to 0.874), on
Monday 2026-11-09 it is 0.9804, so version 2 clears the 0.95 switch floor on its own. The replay database is at
migration 56 without `shape_stub`, so that load ran without `final/stubs.jsonl`.

**Keep the machine awake for the whole chain.** On a laptop, run it on mains power with the lid open (or an external
display attached), under `bash pipelines/rail_graph/scripts/run-chain.sh bash <chain>` (on macOS it wraps the chain in
`caffeinate -dims`, where `-s` holds only on AC power; on Linux wrap the chain in `systemd-inhibit --what=sleep`), or set
the power settings so the machine does not sleep. Once a laptop went to sleep on battery for eight hours mid-chain, and the
finish step took 7.7 h wall for 256 s of CPU, advancing only in dark wakes. `run-chain.sh` also sets the guard variables
of step 2 (`GUARD_WAIT_S=3600 GUARD_RETRIES=1`), so a dip below the memory floor waits instead of ending it.

## 7. Rollback

- Before 03:00: delete the new version's links (`DELETE FROM trip_pattern_shape WHERE feed_version_id = $N`); its
  coverage drops to 0 and the engine stays on the old version.
- Hide a version from every reader: `UPDATE feed_version SET status = 'loading', loaded_at = NULL WHERE
  feed_version_id = $N`. The live engine and the realtime processor read only `loaded` versions; the live engine reads the
  loaded versions again every 5 minutes (`VERSIONS_REFRESH_S`, 300 s) and leaves a version that is no longer loaded
  within that interval with a keyframe of the old version, without a restart (a restart restores the chain and does
  the same at once). Restart `realtime live` (the matcher drops the version). Rows already folded
  keep their trip instance ids, which do not depend on the version.
- Remove a version: `DELETE FROM feed_version WHERE feed_version_id = $N` cascades to its routes, patterns, trips,
  stop times and shape links, but `trip_instance.feed_version_id` refers to it without a cascade, so this works only
  before realtime folded a payload against it. Stop places, stop points and shapes stay (shared, append-only).
- MOTIS: point the API back at the old run folder.

## 8. Later

- A scheduled job (Monday after the recorder's fetch) that runs steps 1, 2 and the pack build, and sends the result
  to the operator; the MOTIS reimport stays manual on the 16 GB machine.
- Drop versions older than two weeks once nothing reads them (history reads stop events, not the timetable).
