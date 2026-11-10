# rail_graph

Rail graph and trip shapes for GerLines. The production pipeline (WP-2.2, decision D-028) gives every trip pattern
of a loaded feed version a QA-gated shape on OSM track, with arc length, stop arc positions and baked elevation, and
loads it into `shape_pattern` and `trip_pattern_shape`. The SP-3 spike commands below it compare the methods.

## Production pipeline

Every step works in one folder per feed version (`data/rail_graph/feeds/<published on>/`), prints one JSON line,
records a fingerprint of its inputs in `steps/<name>.json` and is skipped when nothing changed (`--force` reruns it).
Heavy steps take the shared lock folder `data/locks/heavy` themselves and refuse to start below 40 % free memory.
With `GUARD_WAIT_S=<seconds>` they wait for the floor instead, polling every `GUARD_WAIT_INTERVAL_S` (60) seconds,
log each wait to stderr and refuse only when the wait ran out; `scripts/run-pfaedle.sh` reads the same variables and
reruns pfaedle `GUARD_RETRIES` (0) times after its guard (swap growth or critical pressure) stopped it with a failure,
once memory is at the floor and swap within half of `GUARD_SWAP_MB` of the first start. `scripts/run-chain.sh <command>`
runs a chain with `GUARD_WAIT_S=3600 GUARD_RETRIES=1` under `caffeinate -dims` (runbook chains,
`docs/runbooks/delfi-rollover.md`).

| Step | Reads | Writes |
| --- | --- | --- |
| `reuse` | the database: a new version's patterns and earlier versions' links | the new version's `trip_pattern_shape` links to earlier shapes (same pattern, same stop points, or same stop places in order with the same category; refused when a stop now stands over 80 m from its arc and 20 m beyond the old link's gated `max_stop_m`), `reuse.json`, `new-patterns.json`; takes the db-load lock ([rollover runbook](../../docs/runbooks/delfi-rollover.md)) |
| `patterns` | the database (`DATABASE_URL`): patterns, stops, trips, calendars of one feed version | `patterns.json`: a representative trip per pattern (first service day in the MOTIS window), train-km per reference week, domestic or cross-border; `rep-trips.txt`; `--only new-patterns.json` keeps the listed patterns |
| `pfaedle-sidecar` | a finished pfaedle run | `pfaedle/<run>/inputs.json` with the sha256 of its OSM and GTFS inputs |
| `extract-pfaedle` | pfaedle output (refuses when an input changed); `--alternate` a strict-turn run | `candidates/pfaedle/` (memory-mapped store), `candidates/pfaedle-spliced.json` |
| `fetch-motis` | a MOTIS server with `route_shapes` on 127.0.0.1 | `candidates/motis/`, `candidates/motis.how.json` (why each shape was found or not); `--without-router` gives no MOTIS shape for any pattern while MOTIS still serves the previous feed |
| `evaluate-all` | candidates, OSM caches | `eval/legs.json` (rail length per stop pair), `eval/chunk-*.jsonl` (gate rows per pattern and method); resumable; `--coverage <held.geojson>` measures beyond Germany where the caches hold the neighbours' track |
| `choose` | evaluation rows | `choice.json` (outcome, group method, verdicts, flags), `qa-report.json` (pass rates for G2) |
| `osm-structures` | the rail extract | `osm/way_structures.npz` (bridge and tunnel flags) |
| `corridor` | every pattern of the feed (`--patterns`), the outline, the last corridor (`--previous`) | the area beyond Germany the cross-border legs run through (300 km cap, buffer 20 % of a leg, 5 to 25 km), joined with the last one; prints area, added and removed in km2 |
| `neighbours` | the corridor, Geofabrik extracts and their index | per region `<region>-corridor.osm.pbf` and a sha256 sidecar: rail objects with their tags (track, platforms, railway and stop nodes, rail route and stop area relations; a superset of `extract_rail.py`) cut to the corridor, relations with full member lists; `held.geojson`, the corridor inside the downloaded regions, for `evaluate-all --coverage` |
| `merge-osm` | a base extract and the clipped regions | one extract: an added object enters only with a higher version than the base's (the base wins ties), a `<out>.json` with every sha256; the rail merge feeds MOTIS and `osm` (`--full-pbf` repeated for the route relations of each file), the full merge feeds pfaedle (runbook section 2a) |
| `build` | choice, candidates, OSM caches | `build/geometry/`, `build/meta.jsonl`; workers build chunks of 500 patterns in pattern id order and the parent writes each chunk as it returns, with at most two chunks per worker in flight |
| `finish` | build output, Mapterhorn tiles (from a local PMTiles extract, else fetched once, into `data/rail_graph/dem/`) | `final/shapes/` (lon, lat, z, m), `final/meta.jsonl` with the SHA-256 shape hash; takes the heavy lock and the 40 % memory floor; the geometry and the build metas are read and finished in chunks of 4 M vertices, and the output is streamed |
| `load` | final shapes, choice, evaluation, stubs | `shape_pattern` rows (shape content only, kept across versions, so `shape_no` stays), the version's `trip_pattern_shape` links with each pattern's gate metrics and review flags, and the `shape_stub` rows of `final/stubs.jsonl`, in one transaction; takes the heavy and db-load locks; `--merge` replaces only the links of the patterns loaded (keeps those from `reuse`); `--restub` also replaces the stubs of shapes loaded earlier |
| `stubs` | final shapes, `osm/ways.npz` | `final/stubs.jsonl`: per track shape hash a stub before the first and after the last vertex along OSM track (D-055), at most 400 m; M, stop arcs and hashes unchanged |
| `reversal-groups` | final shapes, patterns, `osm/ways.npz` | `reversal-groups.json`: review of disputed reversals at stops, rule 0 neighbour direction (both neighbours on one side: the through shapes are the faults), rule 2 track end within 150 m (way, buffer node and gap per turn); not a gate |
| `export-geojson` | final shapes | `geojson/<pattern>.geojson` for QA pages (`--flag`, `--pattern` or `--all`) |

Spurs (`spurs.py`): before anything is measured or built, a candidate loses its out-and-back spurs. A vertex
turning more than 160 degrees is a reversal only within 300 m of an intermediate stop of the pattern or 500 m of a
curated reversal station (`reversal_stations.csv`); `build` then puts that stop's arc on the turn, since a train
stands where it reverses. Two kinds of matcher artefact are cut: a zigzag (two turns at most 1.5 km apart with the
direction of travel unchanged, where the matcher changed to a parallel track by reversing twice) becomes a chord
that leaves and joins within 20 degrees of the track and stays within 15 m of the removed piece, the shortest such
cut; an end spur (a turn before the second stop or after the second-last, or within 300 m of the first or last) is
cut at the turn. A cut is kept only when every stop stays within 80 m of the line, or within 20 m more than before,
and an end cut never removes the stretch where a stop already farther than 80 m was placed (its forward search fell
short, so the cut could drop the leg that really passes it). Neither cut touches a turn within 500 m of a curated
station.
A reversal more than 80 m past its stop is cut back to a chord across the two legs at the stop (`overshoot`),
so the train turns at the platform; where the way back passes no closer than 100 m, the stop stands on the turn and
the choice flags it (`stop_on_reversal`, with `reversal_stop_m`). Both measure along the line from the stop's
position on it, so a platform whose coordinate lies 80 m or more beside the track is no overshoot. Other turns are removed while the shape keeps its
matched track (D-048): each by a chord across the legs at one of the three nearest stops where the way back
passes within 100 m (`turn_at_stop`, any number of turns, at most 4 cuts; the stop is looked for on each leg within
5 km of the turn, so a line passing it twice is cut on the nearer pass; the train may step up to 100 m sideways at
that stop); with a single turn and no such stop, the out-and-back stub is cut back to where its legs part by more
than 25 m (`turn`), kept only when the line then leaves on another track without a U-turn (a junction whose curve
the matcher missed) and no two segments within 60 m of arc near the cut differ by more than 150 degrees (the U-turn
rule of WP-3.2a's pack gate, which sees a U split over corners that each stay under 160 degrees). Both count as `turn_cuts`, a review flag (`turn_cut`), and are made only when every such turn
goes. A turn is a vertex turning more than 160 degrees, on the line or on its 1 m Douglas-Peucker simplification, or
a U-turn: the heading 60 m before and 60 m after differing by more than 160 degrees (`u_turns`), which sees a
reversal split over several vertices. The passes repeat until one makes no cut or leaves the line unchanged (a chord cut again where it already stands).
Every other turn stays and fails the shape in the gate (`hairpins`).

pfaedle leg splice (`splice.py`): pfaedle charges a full turn 180 s, so a hop may turn back at a junction
no train reverses at (ICE 50 at the Breckenheim junction, D-051). A higher penalty for the whole run also charges the
reversal at a stop between two hops and loses real reversals, so a second run with
`config/pfaedle-strict-turns.cfg` (`PFAEDLE_PARAMS_FILE` of `run-pfaedle.sh`, recorded by `pfaedle-sidecar --params`)
gives legs only. `extract-pfaedle --alternate <run>`: where the default shape still has a turn fault after the spur
cut, each leg holding a turn that is still a fault after the spur cut comes from the strict run (unless the strict
run turns more than 300 m from every stop in that leg too), cut at pfaedle's stop `shape_dist_traveled`, inner joints within 25 m (the default piece ends or resumes at its point
nearest the strict run's stop point, looked for only behind or ahead of its own, so a joint steps sideways, never back; default legs between two strict ones that are together under 100 m come from the strict run too, so two joints never overlap); the splice is kept only when it
leaves no turn fault, fewer U-turns and no more reversals at stops after the spur cut (a strict leg that turns at a
stop the train runs through is refused). The legs taken are listed in `candidates/pfaedle-spliced.json`, and a chosen
spliced pfaedle shape carries the review flag `pfaedle_spliced`. Like a cut turn, a spliced shape fails the strict
verdict: it is chosen only after shapes without a repair and never moves its route group to pfaedle. `run-pfaedle.sh`
writes the parameters it passed to `params.cfg` in the run folder; the sidecar checks `--params` against it, and
`load` names the strict run in the provenance (`extract-pfaedle-alternate`). The evaluation and `build` run the same cut, so
the gate judges the geometry that is built; `SPUR_VERSION` is in the build fingerprint and in the provenance of every
shape row `load` writes.

Geometry: candidates are simplified at 1 m and densified to 200 m in EPSG:25832; M is the WGS84 geodesic length from
the first vertex (so the end of M is the shape's geodesic length); stops are placed by forward projection; bridge and
tunnel spans come from the OSM tags of the nearest track within 10 m. For the elevation bake each span is widened by
25 m on both sides (the DEM sees a valley or a portal slope a pixel or two beyond the OSM structure end), overlapping
ranges merge, and Z across a range is a straight grade between the median terrain 20 to 60 m outside the structure
on either side (samples on another structure are dropped; an end without samples takes the other end's height).
Span and range ends become vertices; densified vertices are kept only where the (M, Z) profile needs them within
1 m. `verify` counts final shapes with a hairpin that is no reversal at a stop or station
(`hairpin_not_at_stop`, a violation), final shapes with a U-turn more than 300 m from every intermediate stop,
in a straight line from the stop as the timetable places it or along the line from the stop's forward position on it
(the gate's measure), not from the stop arcs, which the build moves onto the turn (`u_turn_not_at_stop`, a
violation), final shapes that WP-3.2a's pack gate would refuse (`pack_u_turn_off_stop`: two segments within 60 m of
arc turning more than 150 degrees with no stop arc within 5 m of the turning part; `pack_hairpin_off_stop`: a vertex
turning more than 160 degrees farther than 0.01 m from every stop arc; both violations), the U-turns of distinct
shapes by distance (0-30, 30-80, 80-150, 150-300 m, with how many stand at a stop where the timetable reverses, the
stops before and after lying within 60 degrees of each other, and how many are on `stop_on_reversal` shapes;
`u_turns_by_stop_distance` in a straight line, `u_turns_by_track_distance` along the line; review figures), the
U-turns a curated station exempts (`u_turns_at_curated_station`, a review figure, so a station added later cannot
hide junction turns unseen), and reports track shapes with a grade over 60 per mille across 50 m, at a structure end or elsewhere, as a
review figure: Z is the bare-earth terrain under the track, which carries cuttings, embankment edges, street bridges
over sunken stations and foreign DEM seams, so it is not a violation. A pattern without a passing shape is
drawn as straight lines between its stops with `qa_status` `low_quality`, or `unmeasured` when its shapes could not
be measured at all (D-028's third state; both are fallbacks for drawing).

```bash
D=data; W=$D/rail_graph/feeds/2026-10-19; R="uv run --group rail-graph gerlines-rail-graph"
DATABASE_URL=... $R patterns --work $W --feed-version 1 --outline design/variants/data/germany-outline.geojson
$R pfaedle-sidecar --pfaedle $D/rail_graph/pfaedle/full --osm $D/inputs/osm/germany-2026-10-20.osm.pbf \
  --gtfs $D/static/2026-10-19/delfi-gtfs-trains.zip --image <pinned digest from scripts/lib.sh>
PFAEDLE_PARAMS_FILE=pipelines/rail_graph/config/pfaedle-strict-turns.cfg \
  bash pipelines/rail_graph/scripts/run-pfaedle.sh full-strict-turns
$R pfaedle-sidecar --pfaedle $D/rail_graph/pfaedle/full-strict-turns --osm $D/inputs/osm/germany-2026-10-20.osm.pbf \
  --gtfs $D/static/2026-10-19/delfi-gtfs-trains.zip --image <pinned digest> \
  --params pipelines/rail_graph/config/pfaedle-strict-turns.cfg
$R extract-pfaedle --work $W --pfaedle $D/rail_graph/pfaedle/full --alternate $D/rail_graph/pfaedle/full-strict-turns
ROUTER_DATA=$D/router GERLINES_INPUTS=$D/inputs bash services/router/scripts/serve.sh rail-d49
$R fetch-motis --work $W --router-run $D/router/runs/rail-d49/config.yml
ROUTER_DATA=$D/router GERLINES_INPUTS=$D/inputs bash services/router/scripts/stop.sh rail-d49
$R evaluate-all --work $W --osm $D/rail_graph/osm --outline design/variants/data/germany-outline.geojson \
  --workers 4 --heavy-lock $D/locks/heavy
$R choose --work $W
$R osm-structures --rail-pbf $D/router/osm/germany-2026-10-20-rail.osm.pbf --osm $D/rail_graph/osm
$R build --work $W --osm $D/rail_graph/osm --outline design/variants/data/germany-outline.geojson \
  --workers 4 --heavy-lock $D/locks/heavy
pmtiles extract --minzoom=12 --maxzoom=12 --bbox=5.5,47.0,15.5,55.2 \
  https://download.mapterhorn.com/planet.pmtiles $D/rail_graph/dem/mapterhorn-z12-de.pmtiles
APP_NAME=... APP_CONTACT=... $R finish --work $W --dem $D/rail_graph/dem \
  --dem-archive $D/rail_graph/dem/mapterhorn-z12-de.pmtiles --heavy-lock $D/locks/heavy
$R stubs --work $W --osm $D/rail_graph/osm
DATABASE_URL=... $R load --work $W --feed-version 1 --heavy-lock $D/locks/heavy --db-load-lock $D/locks/db-load
$R export-geojson --work $W --flag off_relation_run
```

Stubs (D-055, `stubs.py`): a shape starts at its first stop, so a train standing there has its cars before M 0. The
`stubs` step gives each end a polyline beside the shape instead of extending it (the pack format keeps M and stop
arcs unsigned from 0, and an extension would change every shape hash and stop arc): from the end vertex it snaps to
the nearest rail, light rail or narrow gauge segment within 15 m whose direction lies within 30 degrees of the
shape's end heading, and follows that track outward, at a node taking the continuation that turns least (under 30
degrees), for at most 400 m (the longest consist), ending earlier at a buffer stop or where no continuation
qualifies. An end vertex more than 1 m from that track, a walk shorter than 5 m, or a walk whose first point beyond
1 m of the end vertex lies more than 30 degrees off the outward heading (the `jump` check of `packs build`, applied
with a 5 cm and 1 degree margin) gives no stub (`no_track`), so a stub never jumps sideways onto a track. Z is the end vertex's baked height. A consumer places a point at M < 0 on `before` at distance -M and at
M > length on `after` at M - length. `load` writes `final/stubs.jsonl`, when present, into `shape_stub` (migration
0065) in the same transaction: one row per shape end with track, M the geodesic distance from the end vertex (the scale of shape
M, growing strictly at 1 cm), `stub_version` 2, ODbL-1.0. Only the shapes the load inserts get stubs: a shape
loaded earlier may already sit in a published pack, and a changed stub would make `packs build` mark it stale, so
its stored stubs stay (`stubs_kept` counts the staged sides left out). With `--restub` a changed stub replaces its
row, and an end that lost its track, or whose stub starts more than 1 m from the end vertex (`stubs_refused_start`),
loses it; changed stubs of published shapes then need a new shape epoch. Run `stubs` before `load`.

Mapterhorn's documented bulk access (https://mapterhorn.com/data-access) is a PMTiles extract of `planet.pmtiles`
with the go-pmtiles CLI: the Germany box at z12 is 1.07 GB in about 40 range requests. `finish --dem-archive` reads
tiles from it first; only tiles outside the box (cross-border ends) are fetched from the tile endpoint, one at a time
with a pause, which needs `APP_NAME` and `APP_CONTACT` for the User-Agent. Behind a filtering proxy
responses can arrive cut short and Go may reject the proxy certificate, so run both without one. Elevation: Mapterhorn
(https://mapterhorn.com/attribution), German data from the Länder under CC BY 4.0, DL-DE BY 2.0 and DL-DE Zero 2.0.

## SP-3 shape comparison

The spike compares three ways of giving every train trip a shape that follows the real track (ADR-0001) and measures
them against OpenStreetMap rail.

| Method | Source | How it is produced here |
| --- | --- | --- |
| `delfi` | `shapes.txt` of the DELFI feed | read from the train-only subset of WP-2.1 |
| `pfaedle` | pfaedle map matching on OSM (`-m rail`) | Docker image pinned by digest, all train trips |
| `motis` | MOTIS 2 `route_shapes` on the rail-only extract | SP-1's import `rail-d49`, `/api/v6/trip` |

## Metrics

All geometry is projected to ETRS89 UTM 32N (EPSG:25832). Per trip and method:

- **Stop distance**: from every stop to the shape point at the stop's forward arc position (ADR-0001). Stops are
  located along the shape in order, each searched only ahead of the previous one in a window of 3 times the straight
  distance plus 2 km, so rings are followed lap by lap (p50, p95, max; trips with a stop over 80 m).
- **On rail**: share of the shape length, sampled every 10 m, within 10 m of an OSM track centreline (`railway` rail,
  light_rail, subway, narrow_gauge, tram from the rail-only extract). Only samples inside Germany count (Natural Earth
  outline buffered 2 km inwards), because the OSM extract stops near the border.
- **Beeline**: length of single shape edges of 1 km or longer whose midpoint lies more than 10 m from any track.
- **Detour**: shape length between consecutive stops against the shortest OSM rail path between them (graph of rail,
  light_rail and narrow_gauge ways, two-neighbour chains contracted). The path is directed: at a
  junction it continues only onto a track leaving within 60 degrees of the arriving direction (tangents over 20 m),
  so it never reverses at a switch or turns at a level crossing; it may start and end in either direction, since a
  train reverses only at its stops. Each stop snaps to the nearest point of every track segment within 200 m whose
  distance is at most 30 m more than the nearest track's, with no connector length, so a tunnel under a station is
  found next to dense surface tracks. Search: A* with the straight distance as bound, limit 3 times the straight
  distance plus 2 km. This strict path is the reference of the ceiling (1.10), the 1.3 leg ratio and the extra
  length. The floor (0.97) uses a lower bound of any real route, computed only for legs with a strict path: the
  same search, but a stop may start from every track within 200 m, and inside a leg turning back is allowed only
  at junctions within 500 m of a curated station where trains reverse without a passenger stop
  (`reversal_stations.csv`, each with its source; empty for the 2026-10-19 feed). A leg's ends are the pattern's own
  stops, where any train may turn. Allowing reversals near every stop of the feed hid real errors (ICE Würzburg to
  Erfurt shapes turning at Schweinfurt Hbf onto the non-electrified line to Meiningen). A shape that passes the
  floor only against the lower bound carries the review flag `floor_by_lower_bound`. Per trip: the ratio over all routed legs, the worst leg ratio for legs of 2 km or more, the worst extra
  length of any leg, legs over 300 m plus 5 % of their rail path longer, and legs where the shape runs backwards.
- **Off-relation run**: a continuous stretch of 500 m or more, every sample at least 300 m from any stop, where the
  shape follows a track whose OSM passenger route relations carry only the other kind of train (an S-Bahn on a track
  only main-line routes use, or any other train on an S-Bahn-only track) while a track of its own kind runs within
  30 m. Track kinds come from the route relations of the full Germany extract (`route=light_rail`, or `route=train`
  with `service=commuter` or a ref S1, S 2, as S-Bahn; other `route=train` as main line; a light_rail track without
  relations as S-Bahn). It says the relations disagree with the shape, not that the train is on the wrong track:
  relations can be incomplete, and pfaedle matches on the same relations.
- **Missing shape**: no geometry or fewer than two points.
- **Hairpins**: vertices of the cut candidate turning more than 160 degrees that are no reversal at a stop or a
  curated station (above), counted per vertex (`hairpins`) and as all reversals off stops including U-turns
  (`u_turns_off_stop`), both faults; also `reversals` kept, `spur_cuts`, `spur_removed_m`, `turn_cuts` and
  `reversal_stop_m` (the farthest a reversal at a stop turns from that stop's position on the line) per row.

Corridor numbers count only stops, samples and legs inside the corridor box plus 1 km.

## Gate and choice (`gate.py`, D-028 and D-037)

- **Fail**: no shape, a backwards leg, legs measured but none routed, a beeline over 1 km, on rail below 98 %, a trip
  detour below 0.97 (against the lower bound) or above 1.10 (against the strict path), a leg of 2 km or more over 1.3 times its rail path, or a leg over 300 m plus 5 % longer
  than its rail path, or a hairpin left after the spur cut that is no reversal at a stop or curated station.
  **Unmeasured**: nothing inside Germany was checked. A shape whose turns were cut passes with a review flag,
  but after every shape without one (D-048): the pattern takes the group method's clean shape, then the other
  method's clean shape, then the flagged ones; a flagged MOTIS shape asks for pfaedle like a failing one, and a
  flagged shape is no evidence for the stop rule.
- **Stop rule** (D-028): a stop over 80 m from a shape fails that shape only when the other method's shape keeps the
  same stop within 80 m; otherwise it flags the stop for stop-data review.
- **Choice per route and direction**: MOTIS; the whole group moves to pfaedle when a pattern's MOTIS shape fails or
  has an off-relation run and pfaedle passes on every such pattern. Patterns MOTIS could not be asked about (no
  service day in the router window) do not move their group. A pattern keeps the group's method when that shape
  passes; otherwise it takes the other method's shape when that one passes (D-037, its stop rule judged against the
  group method's shape). With neither passing the pattern is `unmeasured` when every shape it has is unmeasured, and
  `low_quality` otherwise. DELFI shapes are never chosen.

## Rerun

From a checkout root, with the inputs of the main checkout (git-ignored `data/`). The package lives in its own
dependency group, so every command runs with `uv run --group rail-graph` (a plain `uv run` would sync it away).

```bash
D=data  # run from the repository root
R="uv run --group rail-graph gerlines-rail-graph"
# 1. OSM caches: track ways of the rail extract, route classes of the full extract
$R osm --rail-pbf $D/router/osm/germany-2026-10-20-rail.osm.pbf \
  --full-pbf $D/inputs/osm/germany-2026-10-20.osm.pbf --out $D/rail_graph/osm
# 2. Sample: per category 120 patterns drawn by train-km on Tuesday 2026-10-27, plus 20 corridors
$R sample --gtfs $D/static/2026-10-19/delfi-gtfs-trains.zip \
  --validation-report $D/static/2026-10-19/validation-trains/report.json \
  --outline design/variants/data/germany-outline.geojson --date 2026-10-27 --out $D/rail_graph/sample.json
# 3. pfaedle over all train trips (Docker, memory guard; writes logs/pfaedle-full.summary)
bash pipelines/rail_graph/scripts/run-pfaedle.sh full
# 4. Shapes of the sample trips
$R shapes --sample $D/rail_graph/sample.json --feed $D/static/2026-10-19/delfi-gtfs-trains.zip \
  --out $D/rail_graph/shapes/delfi.json
$R shapes --sample $D/rail_graph/sample.json --feed $D/rail_graph/pfaedle/full/gtfs-out \
  --out $D/rail_graph/shapes/pfaedle.json
# 5. MOTIS: serve SP-1's run without realtime, fetch (writes motis.how.json per trip), stop
ROUTER_DATA=$D/router GERLINES_INPUTS=$D/inputs bash services/router/scripts/serve.sh rail-d49
$R motis --sample $D/rail_graph/sample.json --out $D/rail_graph/shapes/motis.json
ROUTER_DATA=$D/router GERLINES_INPUTS=$D/inputs bash services/router/scripts/stop.sh rail-d49
# 6. Metrics, tables, gate and choice
$R evaluate --sample $D/rail_graph/sample.json --osm $D/rail_graph/osm \
  --outline design/variants/data/germany-outline.geojson \
  --method delfi=$D/rail_graph/shapes/delfi.json --method pfaedle=$D/rail_graph/shapes/pfaedle.json \
  --method motis=$D/rail_graph/shapes/motis.json --out $D/rail_graph/results
$R report --results $D/rail_graph/results/results.json > $D/rail_graph/results/report.md
$R gate --sample $D/rail_graph/sample.json --per-trip $D/rail_graph/results/per-trip.json \
  --out $D/rail_graph/results/gate.json
$R stop-outliers --sample $D/rail_graph/sample.json \
  --method pfaedle=$D/rail_graph/shapes/pfaedle.json --method motis=$D/rail_graph/shapes/motis.json
$R legs --sample $D/rail_graph/sample.json --shapes $D/rail_graph/shapes/pfaedle.json --osm $D/rail_graph/osm \
  --outline design/variants/data/germany-outline.geojson   # legs over 300 m longer than rail; also for motis.json
# 7. Precision check: 20 random off-relation runs per method, as zoom 17 pages
$R hits --sample $D/rail_graph/sample.json --per-trip $D/rail_graph/results/per-trip.json \
  --out $D/rail_graph/results/hits.json
# 8. Overlay preview and screenshots (serve only the preview folder)
$R overlay --sample $D/rail_graph/sample.json --osm $D/rail_graph/osm \
  --per-trip $D/rail_graph/results/per-trip.json --method delfi=$D/rail_graph/shapes/delfi.json \
  --method motis=$D/rail_graph/shapes/motis.json --method pfaedle=$D/rail_graph/shapes/pfaedle.json \
  --hits $D/rail_graph/results/hits-pages.json --out $D/rail_graph/preview
uv run --group rail-graph python -m http.server 8765 --bind 127.0.0.1 --directory $D/rail_graph/preview
playwright-cli -s=sp-3 open "http://127.0.0.1:8765/?c=koeln-hbf"
playwright-cli -s=sp-3 resize 1200 850
playwright-cli -s=sp-3 run-code --filename=pipelines/rail_graph/scripts/overlay-shots.js   # every page in data/index.json
playwright-cli -s=sp-3 close
```

`hits-pages.json` is `hits.json` plus a `case` list of runs to look at (including the three longest runs
of trip 3448688644). The overlay page loads MapLibre GL JS 5.24.0 from unpkg with subresource integrity and the
OpenFreeMap positron style; the OSM tracks drawn on top come from the rail-only extract (ODbL), coloured by route
relation kind.

Each command prints one JSON line (wall time, peak RSS, counts); the verification file quotes those lines, kept in
`data/rail_graph/logs/`.

## Tests

```bash
uv sync --group rail-graph
uv run --group rail-graph ruff check pipelines/rail_graph && uv run --group rail-graph pytest pipelines/rail_graph
```

CI runs them in the path-filtered workflow `.github/workflows/rail-graph.yml`; the main CI job ignores this package.
