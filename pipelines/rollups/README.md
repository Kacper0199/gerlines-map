# gerlines-rollups

Statistics rollups over the realtime tables (WP-2.7): TimescaleDB continuous aggregates with fixed-bin
histograms, the Land of every stop place, and a check that recomputes every rollup from the raw rows.
The schema lives in `packages/db/migrations/0060` to `0066` (level 3 per Land and category in 0066); this package
loads the Land areas, refreshes, checks and watches the refresh policies.

## Commands

All commands need `DATABASE_URL`; there is no default.

| Command | What it does |
| --- | --- |
| `gerlines-rollups lands [--archive <zip>]` | replaces `land_area` with the 16 Länder of BKG VG250 (land and water, GF 1 to 4) and assigns every stop place a Land; default archive `<data>/geo/bkg-vg250/vg250_01-01.utm32s.gpkg.ebenen.zip` |
| `gerlines-rollups refresh [--from D] [--to D] [--only ...] [--force] [--json F]` | refreshes the continuous aggregates in dependency order (level 1, then level 2) for service days in the range, open where a side is left out, and reports seconds per rollup; `--force` with a level-1 rollup refuses a range with an archived day (exit 2) |
| `gerlines-rollups check --from D --to D [--json F]` | compares every rollup and Land view with a direct recomputation over `stop_event` and `segment_obs` for those service days; exit 0 when all are equal; refuses a range with an archived day (exit 2) |
| `gerlines-rollups health [--max-age-min 45]` | exit 0 when every refresh policy is scheduled and its last success is younger than the limit (`timescaledb_information.job_stats`), and level 2 logs every level-1 write |
| `gerlines-rollups pause` | pauses all seven refresh policies and waits until none of them is still running |
| `gerlines-rollups resume` | resumes paused policies after a pause of any length: with all seven paused and idle, refreshes `station_day` and `segment_day` to now + 7 days, then resumes level 1, then level 2 |

The check runs in one REPEATABLE READ snapshot. A rollup that differs while TimescaleDB still logs
invalidations for the window, its own or those of the level-1 rollup it reads, has status `pending`
(the next policy run fixes it); a difference without pending invalidations is `unequal`, which is a bug.

## Layers

1. **Level 1, `stat_stop` and `stat_segment`.** One row per stop (and per leg) of a trip instance and
   service day. Realtime rows are stored per source; level 1 takes each value from one source, chosen
   by `stat_source_key`, over the rows that are decided (cancelled or with a final):
   1. a `live` final before a `carried` one (carried is the last prediction frozen after the source
      stopped reporting the trip),
   2. the source rank of D-041 item 3: long distance (`hsr`, `ld`) IRIS, gtfs.de, DELFI, VBB and VBN,
      the neighbours; every other category DELFI, gtfs.de, VBB and VBN, the neighbours, then IRIS,
   3. inside DELFI the Mobilithek feed, the traines mirror, then the de-incremented copy (D-041 item 2),
   4. the source id.
   Place and local hour fall back to the best row overall when no source has decided.
2. **Level 2**, hierarchical aggregates over level 1 with a one-day bucket: `station_day` (place,
   category, operator), `station_hour` (place, local hour, category), `train_day` (operator, train
   number, category, line), `line_day` (operator, line, category), `segment_day` (from and to place,
   category).
3. **Land views**, `land_day` (Land, category, operator) and `land_hour` (Land, local hour, category):
   plain views that sum `station_day` and `station_hour` at read time, joined to the current
   `stop_place_land`, so a moved or reassigned station changes every period consistently and nothing
   has to be re-materialised.
4. **Level 3**, `land_category_day` (day, Land, category, with the delay histogram) and
   `land_category_hour` (day, Land, local hour, category, no histogram), migration 0066: continuous
   aggregates over `station_day` and `station_hour` joined to `stop_place_land` at refresh time, for the
   statistics API over long periods (WP-7.2). A change of `stop_place_land` alone logs no
   invalidation, so `lands` ends with a forced level-3 refresh over the whole range; `check` compares both
   with the direct recomputation like every other rollup.

The bucket is the service day because the hypertables are partitioned by `service_date`; the hour is
the Europe/Berlin hour of the scheduled time, a dimension. Trains after midnight stay on their service
day with hours 0 to 4.

## Definitions

- **Stop delay** (`stop_delay_s`): the arrival delay where a scheduled arrival exists, otherwise the
  departure delay. Delays earlier than 30 minutes ahead of the timetable are no data (D-040).
  Cancelled stops are counted (`n_cancelled`) and never observed.
- **Punctuality as DB publishes it**: DB counts a stop as punctual when the train exceeds its
  scheduled arrival by less than 6 minutes (less than 16 for the second figure), at stops with an
  arrival, without cancellations ([DB Pünktlichkeitswerte](https://www.deutschebahn.com/de/konzern/konzernprofil/zahlen_fakten/puenktlichkeitswerte-6878476)).
  The comparable figure is `n_lt_6min_arr / n_observed_arr` (and `n_lt_16min_arr`), which leave out
  the origin (`stop_index = 0`), where GTFS repeats the departure as an arrival. `n_observed` and
  `n_lt_6min` include origins.
- **Stops abroad**: `train_day` and `line_day` describe a whole run, stops abroad included. National
  and Land figures come from `land_day`, where stops abroad have `land_code = 'foreign'` and places
  without a geometry a null Land; leave both out for a figure about Germany.
- **Carried and propagated**: `n_observed_carried` counts observed stops whose final was carried,
  `n_observed_propagated` those whose chosen row was propagated (the source never named that stop and
  its delay was copied forward). Both lean towards punctual; report figures with and without them.
- **Delay gain** (`segment_day.gain_hist`): arrival delay at the next stop minus departure delay. Legs
  are built whatever the quality of their ends, so legs after a feed drop have a gain of exactly 0
  until WP-2.3b adds a leg quality (review F-06); WP-7.2 and WP-7.4 must state this bias.
- **Counts that do not add up**: `n_runs` counts distinct trip instances, so it cannot be summed over
  days, places or Länder; the Land views therefore have no `n_runs`.

## Histograms

Bins are fixed and listed in `stat_bin`; each stored array (`histogram()`) has an underflow and an
overflow cell around them, always 0 because values outside the bins are filtered first.

| Kind | Bins |
| --- | --- |
| delay (30) | [-30, -5) min, [-5, 0), one-minute bins 0 to 16 min, [16, 20), five-minute bins 20 to 60, [60, 90), [90, 120), 120 and over |
| gain (21) | under -10 min, [-10, -5), one-minute bins -5 to +10, [10, 15), [15, 30), [30, 60), 60 and over |
| speed (31) | 10 km/h bins from 0, 300 and over |

One-minute delay bins run to 16 minutes so DB's 5:59 and 15:59 rules fall on bin edges. Read with
`stat_hist_counts(h)` (the bins without the edge cells), merge periods with `stat_hist_sum(h)` (returns
`bigint[]`, raises when lengths differ), and read quantiles with `stat_hist_quantile(h, kind, q)`,
which interpolates inside a bin and returns the bound of an open-ended bin. The API does not use it for delays and
gains: those are whole minutes in the sources, and interpolating sits about half a minute above the true median;
`histogramQuantile` in `apps/api/src/stats/summary.ts` reads whole minutes instead (docs/statistics.md, Figures).

## Refresh policies

Level 1 refreshes every 30 minutes over `[-infinity, now + 2 days)` at minutes 0, 1, 30 and 31; level 2
refreshes every 30 minutes over `[-infinity, now + 7 days)` at minutes 5 to 9 and 35 to 39. Level 3
refreshes every 30 minutes over `[-infinity, now + 14 days)` at minutes 20, 21, 50 and 51, so its thresholds on
level 2 stay 7 days past anything level 2 writes (`health` reports that margin); `resume` refreshes it to
now + 14 days before resuming it. A
refresh rewrites every row of each service day with a change, so its cost follows the size of the day, not
the size of the change: on the replayed morning of 2026-10-27 (194,228 level-1 rows) one cycle of all seven
took 11 to 13 s and wrote about 400 MB of WAL whether 9,000 or 28,000 stops had changed.
`timescaledb.enable_merge_on_cagg_refresh` (write only changed rows) stays off: with it the level-1 refresh
of the same day ran for more than 8 minutes and was cancelled (2.31.0). A refresh recomputes only service
days with pending invalidations, so late data of any age, backfills and replays reach the rollups at the next
run once written (writes into days the columnstore policy has compressed, after 2 days, need
`timescaledb.max_tuples_decompressed_per_dml_transaction = 0` or a decompressed chunk); an unchanged
history costs nothing. Reads see materialised rows only (`materialized_only`): level 1 lags up to 30
minutes and level 2 up to about 40 (five to nine minutes after level 1, plus its run time).

**Why level 2 looks a week ahead.** A level-2 aggregate logs a change to level 1 only below its
threshold on the level-1 materialisation, which its refreshes move to their window end. A level-1 write at
or above that threshold is not logged; when it commits after a level-2 run that read level 1 without it,
it never reaches level 2, and only `refresh --force` restores it (measured when all policies
started together, and in the pause and resume test before migration 0064). Migration 0064 therefore
refreshes level 2 once to now + 7 days while level 1 is still empty, which sets the threshold before any
level-1 row exists, and only then adds the level-2 policies, whose window keeps the threshold five days
past anything level 1 writes. While level 2 has run within the last five days, the order in which the jobs
run does not matter: pausing, resuming, a stopped scheduler or a restart lose nothing. After a longer pause,
or a scheduler stopped for longer while data keeps arriving, the threshold lags behind: the first level-1 run
writes the paused days above it, unlogged, while the first level-2 run may already be reading, and days
that never change again are lost. Resume such policies with `gerlines-rollups resume` (below), never with
`alter_job` alone. A stopped database container loses nothing, because the recorder stops with it.
`health` checks it: per level-2 rollup it reports
`threshold_margin_days` (threshold minus the end of the level-1 window) and is red below one day, as well
as when a policy is paused, failed or older than 1.5 schedule intervals (`--max-age-min` overrides).

**Pausing and resuming.** `gerlines-rollups pause` pauses all seven policies and waits for a running one,
because `alter_job` does not stop a run in progress. `gerlines-rollups resume` is safe after a pause of any
length: it keeps all seven paused and waits until none runs, refreshes `station_day` and `segment_day` to
now + 7 days (this sets the level-2 thresholds on both level-1 rollups), then resumes level 1, then level 2.
By hand the same is `refresh --only station_day segment_day --to <today + 6 days>` (the end is inclusive)
with every policy paused and idle, then `alter_job(job_id, scheduled => true)` for `stat_stop` and
`stat_segment`, then for level 2. Resuming with `alter_job` alone is safe only within four days of the last
level-2 run. After a pause of more than four days, run `check` over the paused days after the first full
cycle.

Scratch databases: pause the policies when a database is left standing, or drop it, because every
database's jobs share the TimescaleDB background workers.

## Columnstore (migration 0095)

Every rollup moves to the TimescaleDB columnstore: `stat_stop` and `stat_segment` in one-day chunks after
3 days, `segment_day` after 35 days, the other level-2 and level-3 rollups (10-day chunks) after 14 days. Each is
segmented by category (level 3 by Land, `segment_day` not at all, since the profile reads every category of a pair)
and ordered by what the statistics routes filter on (`stat_segment` by
train number, `station_day` and `station_hour` by stop place, `train_day` by train number, `segment_day` by place
pair, `line_day` by line), so a read decompresses only the batches whose minimum and maximum hold the value.
`segment_day` waits longer because the segment profile joins it to a train's legs by place pair, which only its
index serves without decompressing the whole period, so the default 30-day profile stays on the index. Over older
periods the profile passes the train's origins as an array (`packages/db/src/segment-queries.ts`), which TimescaleDB
checks against each batch's minimum and maximum: on a 366-day profile in a backfill database (five days of data) it read
41 of 94 compressed batches instead of 86 of 99, p95 17 and 24 ms instead of 40 and 38 ms for trains 115 and 25411.

Measured on the backfilled weekdays 2025-11-04 to 06 in a backfill database (TimescaleDB 2.31): per day `stat_stop`
134 to 14.7 MB (9.1x), `stat_segment` 122 to 9.6 MB (12.7x), `station_hour` 53 to 2.6 MB, `train_day` 20 to 1.3 MB,
`segment_day` 10.7 to 1.1 MB; `station_day` 152 to 15 MB a month. A month of rollups is about 10 GB in the rowstore and
about 0.9 GB in the columnstore.

A refresh over compressed chunks works and gives the same rows (late data reaches compressed days as before; the
`max_tuples_decompressed_per_dml_transaction` limit does not apply to it), at the cost of decompressing and
compressing again the batches it touches. The statistics reads filter in a materialised CTE before their
`GROUPING SETS`: with several grouping sets TimescaleDB 2.31 excludes no chunk and pushes no filter into compressed
chunks (`packages/db/src/stats-queries.ts`).

## Archived days (migration 0096)

`history_archive_day` lists service days whose raw rows were dropped after their rollups were built and compressed
(`gerlines-backfill archive`, backfilled months only). The rollups keep these days: the raw chunks are detached and
dropped, which logs no invalidation. `drop_chunks` would log one, and the next refresh over the range would recompute
the day from nothing and empty level 1, then level 2 (measured on a throwaway database). Two commands would read the
missing raw rows, so both refuse a range with an archived day (exit 2): a forced refresh of `stat_stop` or
`stat_segment`, and `check`. A forced refresh of level 2 or 3 is fine, since level 1 keeps the day. Reloading the day
with `gerlines-backfill load` restores its raw rows and removes it from the list. Rolling back 0096 refuses while
the list has rows.

## Changing a rule

The rank, key and bin functions are called by the aggregates at refresh time. Changing one with
`CREATE OR REPLACE` would change future refreshes but not materialised history. A rule change is a new
migration that drops and recreates the affected aggregates.

**Archived days first.** A recreated `stat_stop` or `stat_segment` is rebuilt from the raw rows, and archived days
(migration 0096) have none, so the rebuild would empty them and level 2 would follow at its next refresh. Every
migration that drops or recreates a level-1 rollup starts with `SELECT assert_no_archived_days('<what it does>');`,
which raises while `history_archive_day` has rows, inside the migration's own transaction. Reload the archived months
from their converted folders (`gerlines-backfill load`, which clears their marks), then migrate. Recreating a level-2
or level-3 rollup stays safe without that: it is rebuilt from level 1, which keeps the archived days. A recreated level-2 aggregate needs the same
order as 0063 and 0064: create it `WITH NO DATA` without a policy in the normal transaction, then set its
threshold and add its policy in a no-transaction file. The recorder applies migrations by itself when it
starts and only logs a warning when one fails, so that file pauses level 1 and waits for a running level-1
job itself (a level-1 write during the threshold refresh is the case above, and `alter_job` does not wait),
refreshes to `(now() + INTERVAL '7 days')::date` (an open end leaves the threshold where it is on an empty
level 1), adds the policy with the -7 days end offset and resumes level 1 last. For `station_day`:

```sql
-- gerlines:no-transaction
SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs
 WHERE proc_name = 'policy_refresh_continuous_aggregate' AND hypertable_name IN ('stat_stop', 'stat_segment');
DO $$
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM timescaledb_information.job_stats s
        JOIN timescaledb_information.jobs j USING (job_id)
       WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
         AND j.hypertable_name IN ('stat_stop', 'stat_segment') AND s.job_status = 'Running');
    PERFORM pg_sleep(1);
  END LOOP;
END $$;
CALL refresh_continuous_aggregate('station_day', NULL, (now() + INTERVAL '7 days')::date);
SELECT add_continuous_aggregate_policy('station_day', start_offset => NULL,
  end_offset => INTERVAL '-7 days', schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now()) + INTERVAL '5 minutes', if_not_exists => true);
SELECT alter_job(job_id, scheduled => true) FROM timescaledb_information.jobs
 WHERE proc_name = 'policy_refresh_continuous_aggregate' AND hypertable_name IN ('stat_stop', 'stat_segment');
```

`job_status` comes from `pg_stat_activity`, which a transaction reads once unless `pg_stat_clear_snapshot()`
discards it, so the loop calls it on every pass. A failure in the middle leaves level 1 paused, and `health`
is red until the file has been run again. Afterwards run `gerlines-rollups refresh --force` over the
affected days and `check` after the first full cycle.

Re-applying 0064 after its down follows the same rule: the down removes the level-2 policies, so the
threshold stops moving while level 1 keeps writing. Run `gerlines-rollups pause` first, migrate, then
`gerlines-rollups resume`.

## After migrating a database

1. `gerlines-rollups lands` (until then every place has a null Land).
2. The policies materialise the whole history on their first run; on a large database pause the two
   level-1 policies, run `gerlines-rollups refresh` once by hand in a quiet hour and time it, then
   resume them.
3. `gerlines-rollups health` after the first level-1 run, which starts 10 to 70 minutes after the
   migration at minute 0 of an hour; a policy that never ran is unhealthy and has no age.
4. `gerlines-rollups check --from <yesterday> --to <today>` after the first full cycle: `equal` or
   `pending`; `unequal` means lost rows, repair with `refresh --force` over those days.

## Backups and WAL

The rollups are derived data: every row can be rebuilt from `stop_event` and `segment_obs` with
`refresh --force`, so a backup needs the source tables, not the rollups. Each refresh cycle rewrites the
current day (about 400 MB of WAL on the replayed morning above, more on a full day), so a backup that
archives WAL continuously would ship tens of GB a day of rollup rewrites; plan base or logical backups of
the source tables instead, or budget the archive explicitly (WP-10.1).
`max_wal_size` is 4 GB in `infra/compose.yaml`, which means about one requested checkpoint per 2 GB of WAL
instead of per 1 GB (PostgreSQL requests one after about `max_wal_size / (1 + checkpoint_completion_target)`,
target 0.9). An end-of-day refresh cycle of 1.6 to 2 GB (estimated) plus the recorder's WAL will still often
cross one. At 2 GB the server counted 348 requested and 131 timed checkpoints since its start on 2026-11-05,
all databases together, replays, pfaedle and test databases included. Whether 8 GB is worth it is decided
after measuring a day of WAL on `gerlines` (`pg_stat_checkpointer` and the LSN delta over 24 hours).

## Tests

```
GERLINES_DB_TESTS=required uv run pytest pipelines/rollups
```

The tests create throwaway databases on the server of `DATABASE_URL` (its `postgres` database is the
maintenance connection). `GERLINES_VG250_ARCHIVE` points the shore station test at a VG250 archive
outside the checkout; without the archive that test is skipped.
