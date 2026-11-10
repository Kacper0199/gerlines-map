# @gerlines/db

Plain SQL migrations, a small migration runner, and the Kysely table types for the GerLines database
(PostgreSQL 18, TimescaleDB 2.31, PostGIS 3.6). Architecture: [docs/architecture.md](../../docs/architecture.md) §4.

## Commands

From the repository root (the package scripts load the root `.env` when it exists):

| Command | What it does |
| --- | --- |
| `pnpm db:migrate`, `pnpm db:migrate --to 3` | apply every pending migration, or up to a version |
| `pnpm db:rollback`, `pnpm db:rollback --steps 2` | revert the newest applied migration, or several |
| `pnpm db:status` | list migrations as applied or pending; also fails when an applied file changed |
| `pnpm db:reset` | revert everything, then apply everything; loopback databases only |
| `pnpm db:types` | regenerate `src/generated/database.ts` from a fully migrated database |
| `pnpm db:test` | integration tests against a throwaway database on the local `db` service |
| `pnpm turbo run test --filter=@gerlines/db` | unit tests (no database needed) |

The database comes from `DATABASE_URL`, or from `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB` with the local Compose defaults (`127.0.0.1:5433`, `gerlines`).

## Migrations

Files live in `migrations/` as pairs `NNNN_snake_name.up.sql` and `NNNN_snake_name.down.sql`. The runner:

- applies each migration in its own transaction together with its row in `gerlines_meta.migration`, so a failing
  file leaves no trace;
- stores the SHA-256 of both files (line endings normalised to LF) and refuses to run, roll back or report
  status when an applied file changed, was renamed or deleted, or when a pending file is older than the newest
  applied one;
- holds the session advisory lock `7244618842011453289` for the whole run and waits up to 10 s for it, so
  concurrent runs (two services starting at once) never interleave;
- sets `lock_timeout` to 30 s so a migration never waits forever behind a long query;
- refuses any file that contains a transaction control statement (`BEGIN`, `COMMIT`, `ROLLBACK`, `END`,
  `ABORT`, `SAVEPOINT`, `RELEASE`, `START TRANSACTION`, `PREPARE TRANSACTION`), so a history row can never be
  committed apart from its migration. `BEGIN` and `END` inside a function body are fine.

Rolling back past `0001_extensions` (also `db:reset`) drops TimescaleDB. Connections that were open before and
had loaded TimescaleDB then fail with `could not open relation with OID …`; restart long-lived services
afterwards. The integration test opens a fresh connection for each catalog query for this reason.

Never edit an applied migration; add a new one. Every up file needs a down file that restores the previous state
exactly; the integration test migrates all the way down to an empty `public` schema and up again.

### Statements that cannot run in a transaction

`CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `VACUUM` and `CALL refresh_continuous_aggregate(…)`
cannot run inside a transaction. A file whose **first line** is exactly

```sql
-- gerlines:no-transaction
```

runs statement by statement outside a transaction; its history row is written in its own transaction after the
last statement succeeded. If a statement fails, the statements before it stay applied and no history row is
written: the error names the failing statement, and the database must be repaired by hand (usually with
`IF NOT EXISTS` and `IF EXISTS` guards the file can simply run again). Keep such files to the statements that
need it; the up and down file of one migration choose independently. Any other `-- gerlines:` first line is
refused as a typo.

Continuous aggregates (ADR-0009 rollups) do not need the opt-out: create them `WITH NO DATA` and add a refresh
policy with `add_continuous_aggregate_policy`, both inside the normal transaction, except a continuous aggregate
on a continuous aggregate: its policy is added after its threshold refresh in a no-transaction file (0064, and the
template in `pipelines/rollups/README.md`, "Changing a rule"). A manual `refresh_continuous_aggregate` call needs
a no-transaction file, as in 0064, which sets the level-2 thresholds before any level-1 row exists
(`pipelines/rollups/README.md`, "Why level 2 looks a week ahead"). Its first two statements refresh `station_day`
and `segment_day`, which set the thresholds on both level-1 rollups, so a failure further down leaves no level-1
write unlogged. A failed 0064 is repaired with the level-1 policies paused, not by hand: `gerlines-rollups pause`,
`pnpm db:migrate` (the refreshes do nothing a second time and the policies are added with `if_not_exists`), then
`gerlines-rollups resume`. The Python test fixtures apply such a file one statement at a time with
`gerlines_common.migration_statements`, which splits it as the runner does (both are checked against
`src/split-golden.json`; `GERLINES_UPDATE_SPLIT_GOLDEN=1` rewrites it from the runner after a new migration).

### Correcting a down file after it was applied

Both checksums are stored, so a fixed down file makes every command refuse with `checksum mismatch`. When a down
file of an applied migration is wrong (and the up file is unchanged):

1. Fix the down file and review it like any migration; test it on a throwaway database first
   (`pnpm db:test`, or `pnpm db:reset` locally).
2. Compute its checksum the way the runner does (SHA-256 of the file with CRLF turned into LF):
   `node -e 'const fs=require("node:fs");const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1],"utf8").replaceAll("\r\n","\n")).digest("hex"))' packages/db/migrations/NNNN_name.down.sql`
3. On every database where the migration is applied, record the new checksum in one statement and check that it
   changed exactly one row:
   `UPDATE gerlines_meta.migration SET down_checksum = '<new hex>' WHERE version = NNNN AND name = '<name>';`
4. Run `pnpm db:status`; it must list the migration as applied without an error.

An up file is never corrected this way: its effect is already in the database, so the fix is a new migration.

After a schema change: `pnpm db:reset` (or `db:migrate`), `pnpm db:types`, commit the regenerated types. The
integration test fails when the committed types differ from what kysely-codegen produces from the migrated schema.
kysely-codegen needs the TypeScript 6 compiler API, which it gets through `packageExtensions` in
`pnpm-workspace.yaml` (see [docs/development.md](../../docs/development.md)).

## Tables

All timestamps are `timestamptz`. Names are English and snake_case. The time-series tables of migration 0030
(`stop_event`, `stop_event_forecast`, `segment_obs`, `event`) are TimescaleDB hypertables.

| Table | Key | Purpose |
| --- | --- | --- |
| `source` | `source_id` | one data provider feed, with licence (SPDX expression), licence URL and attribution text, so every value shown can name its source |
| `source_holder` | `(source_id, position)` | the holders a source's licence asks to name, in order (`publisher`, `aggregator`, `mirror`), so clients join them per locale (0055) |
| `ingest_run` | `ingest_run_id` | one continuous execution of a job for one source: a recorder process lifetime or one static import, not one poll. `status` is `running`, `succeeded` or `failed`; `finished_at` is set exactly when it is not `running` |
| `raw_object` | `raw_object_id` | one fetched payload: storage `object_key` (relative, unique), `sha256` and `bytes` of the payload as received, `content_type`, storage `content_encoding`, `fetched_at`, `observed_at` (the instant the payload represents, for example a backfilled mirror minute; filled from `fetched_at` by a trigger when a writer omits it), `http_status` (null for non-HTTP sources), `request_url` without credentials. Its `(ingest_run_id, source_id)` must match the run, so a payload can never be attributed to the wrong source |
| `raw_object_segment` | `raw_object_id` | where a recorder payload lives inside a segment file (`services/ingest/README.md`): `segment_key` (relative path of the `.seg.zst` file), `seq` (unique per segment), `base_seq` (the earlier frame it is patched against, null for a keyframe), `frame_offset` and `frame_bytes` of its zstd frame, storage `format_version`. Deleted with its `raw_object` |
| `recording_gap` | `(source_id, gap_start)` | a UTC interval in which the recorder had no successful fetch of a source for more than twice its cadence; rebuilt from the recording files by `reindex`, replaced per source after a backfill |
| `stop_place` | `stop_place_id` | a station or stop with typed identifiers where they exist: `dhid` (German stop id, `de:11000:900003201`, unique), `eva` (EVA or IBNR number, indexed), `ifopt` (stop ids outside the German DHID profile, unique), `uic` (UIC station code, indexed), `country_code` (ISO 3166-1), and `geom` (point, EPSG:4326, GiST index). `name_source_id` and `geom_source_id` name the `source` that supplied the name and the coordinates; each is set exactly when its value is |
| `stop_point` | `stop_point_id` | a platform or quay of a stop place: `platform_code`, `dhid` (`de:11000:900003201:1:50`), `ifopt`, `geom` (point, EPSG:4326, GiST index), with `name_source_id` and `geom_source_id` like `stop_place` |
| `stop_place_display_name` | `stop_place_id` | the name a stop place is shown with where the timetable name does not name its town, with its source and the rule that chose it (0055) |
| `stop_place_search_name` | `(stop_place_id, name)` | other names search finds a stop place by but never shows: the timetable name where the display name differs, DB StaDa's and the EVA copy's names (0092) |
| `id_map` | `(source_id, entity, source_key)` | every source's own key for an entity, mapped to the canonical id, with `first_seen_at` and `last_seen_at`. `entity` is `stop_place` or `stop_point` so far; later migrations widen the check |
| `category` | `category_code` | the canonical categories of architecture §9 (`hsr`, `ld`, `night`, `rfast`, `reg`, `sbahn`, `urban`, `bus`, `other`), seeded by the migration, with the MOTIS classes (`rfast` is `REGIONAL_RAIL`: MOTIS has no fast regional class), `is_train` and the display order; the catalogue adds German and Polish names (`name_de`, `name_pl`, `names_source_id`) |
| `operator` | `operator_id` | an operator under a stable lowercase slug, its name, the `source` of the name and the ISO country where it is known; `updated_at` trigger. The catalogue (`pipelines/catalog`) adds brand and legal name, Wikidata id with its role (`company`, `parent_company`, `brand`, `network`) and the source the item was chosen from, website, parents, validity dates, `catalog_source_id` (set exactly when `brand_name` is), `field_sources` and `missing` |
| `operator_alias` | `(source_id, alias)` | every name a source uses for an operator (DELFI agency names with and without their counters), with `first_seen_at` and `last_seen_at`; a changed alias is never overwritten, like `id_map`. Catalogue aliases (former official names from Wikidata) carry `valid_from` and `valid_to` where known |
| `verbund` | `verbund_id` | a Verkehrsverbund from the catalogue (`catalog/verbuende.yaml`): abbreviation, name, the Länder it covers (ISO 3166-2 codes), the SPNV flag (null when no source states it), Wikidata id and website, `source_id`, `field_sources` and `missing` (reasons for empty values); `updated_at` trigger |
| `vehicle_series` | `series_id` | a vehicle series of the catalogue (BR, manufacturers, traction, unit kind, cars, unit length, maximum speed, priority P1 to P3, Wikidata id, Commons category, German Wikipedia title) with `source_id`, `field_sources` and `missing`; `updated_at` trigger |
| `vehicle_series_operator` | `(series_id, operator_id)` | which catalogue operators run a series, with the source of that link |
| `livery`, `livery_series`, `livery_colour` | `livery_id`; `(livery_id, series_id)`; `(livery_id, colour_index)` | a livery of an operator and period, the series that carry it, and its colours in order: role, name, RAL code and a hex value only together with `hex_source_id` |
| `line_colour` | `line_colour_id` | a line badge colour (Träwelling line-colors, CC0): line name, DELFI agency, catalogue operator, background, text and border colours, shape, Wikidata id of the line |
| `fleet_rule` | `rule_id` | a rule of `catalog/fleet-rules.yaml` for the vehicle identity (ADR-0011): scope `line` (L2: operator, line keys, series), `operator` (L3: one series with its fleet share) or `category` (L4: a generic model), units, validity, source and evidence (0086) |
| `formation_observation` | `(source_id, service_date, train_number)` | an exact formation (L0): the series read from the vehicle numbers, units, cars, length, unit names and the sha256 of the raw answer; L1 takes the majority over the last 14 days, read through the service-date index of 0091 (0085) |
| `vehicle_photo` | `photo_id` | an approved Commons photo of a series (WP-6.3): rank 1 or 2, file title, page, author, licence with its name and link, focus point, the sizes and SHA-256 of the 330 and 960 px copies, who approved it and whether the user reviewed it (0089) |
| `catalog_version` | `content_sha256` | each distinct catalogue content loaded, with its row counts; loading the same seeds again adds nothing |
| `feed_version` | `feed_version_id` | one timetable file (`UNIQUE (source_id, sha256)`), its `raw_object`, publication day, `feed_info` version and validity, the category set it was loaded with, the stored row counts and `status` (`loading`, `loaded`; `loaded_at` set exactly when loaded). Deleting it removes the whole version |
| `route` | `(feed_version_id, route_key)` | a GTFS route with its operator, GTFS route type, `category_code`, the rule that chose it and `is_foreign` |
| `service_calendar`, `service_calendar_date` | `(feed_version_id, service_key)`, plus `service_date` | GTFS calendar with `weekdays` as a bit mask (Monday bit 0 to Sunday bit 6) and the dated exceptions (`exception_type` 1 added, 2 removed) |
| `trip_pattern`, `trip_pattern_stop` | `(feed_version_id, trip_pattern_id)`, plus `stop_index` | a distinct route, stop sequence and DELFI `shape_key`, with its `stop_point`s in order (UUIDv5 content id) |
| `trip` | `(feed_version_id, trip_key)` | a GTFS trip: route, service, pattern, `shape_key`, headsign, train number (`short_name`), direction, block, `category_code`, `is_foreign`, first departure and last arrival in seconds |
| `stop_time` | `(feed_version_id, trip_key, stop_index)` | arrival and departure in seconds after noon minus 12 h of the service day (GTFS times, above 86,400 for trips past midnight: 4,907 train trips of the 2026-10-19 feed start 24 h or more after that reference, the latest arrival is at 38.97 h), GTFS `stop_sequence`, pickup and drop-off types; the stop is the pattern's stop at `stop_index`. The trains of day D come from the services of days D and D−1 |
| `trip_product` | `(feed_version_id, trip_key)` | the product a timetable trip runs as (ICE, IC, NJ, RE) where the route name alone does not say it, with its source and rule (migration 0055) |
| `shape_pattern` | `shape_hash` | a track shape: SHA-256 content hash (64 lowercase hex) and a stable `shape_no` (identity, unique, never reused; live frames refer to shapes by it), `geom` LineStringZM in EPSG:4326 with M in metres from 0 along the shape (WGS84 geodesic, equal to `length_m` at the end) and Z in metres from the Mapterhorn DEM (straight grade across bridges and tunnels), `stop_arc_m` (the stops' M in stop order, checked element by element), `method` (`motis`, `pfaedle`, `straight`), `qa_status` (`pass`, `fail`, `unmeasured`, `low_quality`; `straight` exactly when `low_quality` or `unmeasured`), `tunnel_spans` and `bridge_spans` (flat start and end M pairs), `elevation_source`, `source_note`, `licence` (ODbL-1.0 for OSM-based shapes) and `provenance`. Rows are never deleted when a feed version stops using them |
| `trip_pattern_shape` | `(feed_version_id, trip_pattern_id)` | the shape of each trip pattern (`pipelines/rail_graph` load step), the method chosen for its route and direction (`group_method`), every candidate's gate verdict, the chosen candidate's gate `metrics` and the pattern's `review_flags` (per pattern, since patterns sharing a shape can differ); removed with its pattern |
| `shape_stub` | `(shape_no, side)` | the track beyond a shape's first (`before`) or last (`after`) vertex (D-055, `pipelines/rail_graph` step `stubs`, written by its load step): `geom` LineStringZM in EPSG:4326 that starts at the shape's end vertex and runs outward along OSM track, M the ground distance in metres from that vertex, growing strictly (0 at it, `length_m` at the far end, at most 400.5 m), Z held at the end vertex's height; `end_reason` (`limit`, `buffer` for a track end, `no_continuation`), `stub_version` of the walk, `source_note`, `licence` (ODbL-1.0) and `provenance`. A shape end with no aligned track has no row. M, stop arcs and the hash of the shape are untouched; removed with its shape (migration 0065) |
| `shape_registry` | `epoch` | the shape number epochs live frames carry (`services/live`: the current epoch is the highest), with `created_at` and a `note` on what the epoch's shapes are; append only (migration 0057) |
| `trip_instance` | `trip_instance_id` | one real run: UUIDv5 of service date, operator, train number, origin stop place and origin departure (`services/ingest` `tripInstanceId`); the timetable trip it stands for (`feed_version_id`, `trip_key`; the smallest trip key when the timetable files one train twice), or `is_added` for a trip a source added, or `backfill` for a run of the history backfill, which has a category and no timetable link (0087); the first source, instant and raw object that named it (the earliest wins under any order) |
| `trip_instance_source` | `(trip_instance_id, source_id)` | when each source named a run first and last, with its last raw object; a source counts as reporting a train while `last_observed_at` moves (0041) |
| `match_backlog` | `(source_id, entity_key, service_date, reason)` | a realtime trip no run was found for, with the reason, detail of its first sighting, `first_observed_at` and its raw object, and `last_seen_hour` |
| `stop_event` (hypertable on `service_date`) | `(service_date, trip_instance_id, stop_index, source_id)` | one stop of a run as one source sees it: scheduled, predicted (`prediction_kind` explicit or propagated) and final arrival and departure with delays, `final_quality` (`live` when the trip was in the payload that passed the time, `carried` from its last prediction, `final_only` for a backfilled stop, 0087), scheduled and actual platform, cancelled, additional, the instant and raw object of its last change |
| `stop_event_forecast` (hypertable on `observed_at`) | `(trip_instance_id, stop_index, source_id, observed_at)` | a row only when a stop's prediction changes, while the stop is not final |
| `segment_obs` (hypertable on `service_date`) | `(service_date, trip_instance_id, from_index, source_id)` | written when a run reaches the next served stop: departure delay, arrival delay, delay gain, scheduled and actual run time, dwell delay; distance and speeds stay null until shapes exist |
| `alert_message` | `(source_id, alert_key, content_hash)` | each version of a service alert: cause, effect, severity, active periods, texts, URL, selector count, first sighting and `last_seen_hour` (0041 replaced the `alert` table of 0030) |
| `alert_scope` | message key plus a trip instance or a stop place | each trip instance or stop place an alert version names (exactly one of the two), first sighting and `last_seen_hour` |
| `event` (hypertable on `occurred_at`) | `(event_id, occurred_at)` | outbox: `TripDelayChanged` (a move of a minute or more), `TripCancelled`, `PlatformChanged`, with a UUIDv5 id |
| `rt_payload` | `raw_object_id` | processing log of realtime payloads: source, observed instant, processing time, counts, error |
| `rt_rebuild_job`, `rt_rebuild_stop_event`, `rt_rebuild_forecast`, `rt_rebuild_segment` (unlogged) | one job; the realtime keys | staging of a late payload's rebuild: the rows from the first changed payload on, of which only those that differ are swapped in (`services/ingest/src/realtime`, 0041) |
| `land`, `land_area` | `land_code` | the 16 Länder (ISO 3166-2, ARS) plus `foreign`; `land_area` holds each Land's BKG VG250 area including its water (GF 1 to 4, EPSG:25832) with edition, URL, sha256, licence and attribution (migration 0060) |
| `stop_place_land` | `stop_place_id` | the Land of each stop place, kept by statement triggers on `stop_place`: `within`, `nearest` (a German-coded place at most 100 m outside), `outside` (`foreign`) or `no_geometry` |
| `stat_bin` | `(kind, bin)` | the fixed histogram bins (`delay`, `gain`, `speed`) the `stat_*_bin` functions implement (0061) |
| `stat_stop`, `stat_segment` (continuous aggregates) | `(day, trip_instance_id, stop_index)`; `(day, trip_instance_id, from_index)` | level 1: one row per stop and leg of a run, each value taken from the best source with a final (`stat_source_key`: live before carried, then rank, then source id) (0062) |
| `station_day`, `station_hour`, `train_day`, `line_day`, `segment_day` (continuous aggregates) | day plus their dimensions | level 2: counts, punctuality shares, delay and gain histograms per day (0063); `pipelines/rollups/README.md` defines every column |
| `land_category_day`, `land_category_hour` (continuous aggregates) | day, Land, category (and local hour) | level 3: level 2 summed per Land and category over `stop_place_land`, read by the statistics routes (0066, [docs/statistics.md](../../docs/statistics.md)) |
| `land_day`, `land_hour` (views) | day, Land plus dimensions | Land figures summed at read time from `station_day` and `station_hour` joined to the current `stop_place_land` |

Realtime rows are keyed per source, so each source's rows depend only on its own payloads in order; the
processor in `services/ingest/src/realtime` folds a source again from its first payload when a payload arrives late.

The timetable tables are filled by `pipelines/static_import` (its README describes the load). A
version is loaded in one transaction and the same file loaded again replaces its rows under the
same `feed_version_id`.

`updated_at` on `stop_place` and `stop_point` is maintained by the `set_updated_at` trigger: it moves to the
transaction time when an `UPDATE` changes the row and stays when the update changes nothing.

`shape_registry` is append only: the `shape_registry_append_only` triggers refuse `UPDATE`, `DELETE`, `TRUNCATE` and
an insert whose epoch is not above every registered one (`restrict_violation`), so an epoch is never reused and the
current epoch only moves forward. A shape switch registers the epoch, builds its packs (`packs build` writes under
the newest epoch) and then restarts `live` (docs/development.md, Live engine); a scratch database that needs other
epochs is dropped and copied again. Inserts take a transaction advisory lock, so two sessions cannot register epochs
out of order. A mistyped epoch stays: only the database owner can undo it, by disabling the trigger for that one
statement or by reverting 0057.

`raw_object.request_url` must not carry credentials: a URL with userinfo (`scheme://user@host`) is rejected by
`raw_object_request_url_no_userinfo`. Key query parameters are stripped by the adapters (WP-1.3).

### EVA and UIC numbers

EVA and UIC numbers are not unique on `stop_place`: DELFI models a station more finely than EVA (for example
`de:11000:900003201` and `de:11000:900003200` at Berlin Hbf), so several places can carry the same EVA. Which
place a source means by an EVA or UIC number is decided in `id_map` (`entity = 'stop_place'`, `source_key` =
the number as the source sends it), not by the column.

### Writing id_map

Ingest records a mapping with this upsert, so repeats refresh `last_seen_at` and a changed mapping is never
overwritten silently:

```sql
INSERT INTO id_map (source_id, entity, source_key, canonical_id, first_seen_at, last_seen_at)
VALUES ($1, $2, $3, $4, $5, $5)
ON CONFLICT (source_id, entity, source_key)
DO UPDATE SET last_seen_at = excluded.last_seen_at
WHERE id_map.canonical_id = excluded.canonical_id;
```

One affected row means inserted or confirmed. **Zero rows means the source now maps that key to another
canonical id**: report it as a conflict (log and count it) and leave the stored mapping unchanged until it is
resolved.

`gerlines_meta.migration` belongs to the runner: version, name, both checksums, `applied_at`, `duration_ms`.

## Identifier strategy

- Provenance rows (`ingest_run`, `raw_object`) get `uuidv7()` defaults from PostgreSQL 18: unique without
  coordination and ordered by creation time, so indexes stay compact.
- `source_id` is a stable lowercase slug chosen by us (for example `db-ris-timetables`, `gtfs-de`) and never
  reused for another feed.
- Canonical entity ids (`stop_place_id`, `stop_point_id`, later trips and trip instances) are UUIDs computed by
  the ingest code, not by the database: UUIDv5 over a fixed GerLines namespace and the preferred natural key
  (DHID, then EVA, then UIC, then `source_id:source_key`). They are assigned once, stored, and never recomputed;
  when a stop later gains a better identifier, `id_map` gains a row and the canonical id stays. This keeps URLs
  and history stable and makes a replay into an empty database produce the same ids.
- `id_map.canonical_id` points at the table named by `entity`. It has no foreign key because the target table
  depends on `entity`; ingest writes the entity row and its mapping in one transaction.

## Typed access

```ts
import { createDatabase, resolveDatabaseUrl } from "@gerlines/db";

const db = createDatabase({
  databaseUrl: resolveDatabaseUrl(process.env),
  applicationName: "gerlines-ingest",
});
const sources = await db.selectFrom("source").select(["source_id", "licence"]).execute();
```

`bigint` columns arrive as strings (`Int8`), `geometry` columns as hex EWKB strings; convert with PostGIS
functions (`ST_AsGeoJSON`, `ST_X`, `ST_Y`) in the query when coordinates are needed.

## Tests

- Unit tests (`*.test.ts`): file name rules, pairing, checksums, history verification, planning, URL handling.
- Integration test (`schema.integration.test.ts`): creates `gerlines_test_<random>` from `template0`, migrates
  up, checks extensions and the Timescale License build, the exact set of tables, constraints and indexes,
  geometry columns, the committed types, data rules through Kysely, the `updated_at` trigger and the `id_map`
  upsert rule, checksum and lock refusal, atomic failure, a no-transaction migration, two concurrent runs on a
  fresh database, then migrates down to an empty schema and up again, and drops the databases.
- `pnpm db:test` loads the root `.env` like the `db:*` scripts. The test is skipped, with the reason in the suite
  name, only when the server is unreachable (connection refused, timed out or host unreachable). Any other error,
  such as a wrong password or a missing database, fails the run. With `GERLINES_DB_TESTS=required` or `CI=true`
  an unreachable server fails the run too; use `GERLINES_DB_TESTS=required pnpm db:test` to verify a change.
