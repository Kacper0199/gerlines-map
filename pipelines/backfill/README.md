# gerlines-backfill

History before our recorder started, from the monthly processed Parquet files of
[piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data) (DB Timetables
IRIS, all DB stations from 2025-11, CC BY 4.0), converted to our stop events, runs and legs
(architecture section 10, ADR-0009). The model, the checks and the comparison with DB's monthly
punctuality are in [docs/history.md](../../docs/history.md).

## Commands

Run from the repository root. `--data` defaults to `<repository>/data`; a worktree passes the main
checkout's folder. `load` needs `DATABASE_URL` and has no default.

| Command | What it does |
| --- | --- |
| `uv run gerlines-backfill download --last 2026-10 [--first 2025-11] [--revision <sha>]` | fetches `monthly_processed_data/data-YYYY-MM.parquet` at one dataset revision to `data/inputs/piebro/<fetch date>/`, checks each file against the sha256 of its LFS object on the Hub and writes `SOURCE.md` (URL, revision, licence, attribution, sha256 per file). Needs `APP_NAME` and `APP_CONTACT` for the User-Agent |
| `uv run gerlines-backfill convert --inputs <folder> --last 2026-10` | one service day at a time (under 2 GB RSS): `data/backfill/piebro/<month>/stops/`, `trips/`, `segments/` with one Parquet file per day, and `summary.json` (row counts, categories, punctuality by the rollups' rule, station names) |
| `DATABASE_URL=… uv run gerlines-backfill load --inputs <folder> --revision <sha> --last 2026-10 [--stations <bahn-vorhersage stations.parquet>] [--until <day>] [--compress]` | replaces each converted day in `trip_instance`, `stop_event` and `segment_obs` in its own transaction; days from `--until` on are removed and skipped (the first service day of the live recording); without `--until`, or with a later one, it refuses to load days on or after the first service day another source has stop events for; runs are updated in place and only runs that left a day are deleted; every station matched by coordinates or meta EVA, and every close place not taken, is listed in `<month>/place-review.csv`; `--compress` compresses each day's chunks once it is loaded, which keeps the uncompressed peak at about one day (about 245 MB); reviewed decisions in `place-overrides.csv` (or `--overrides <file>`) are applied before any matching (docs/history.md) |
| `DATABASE_URL=… uv run gerlines-backfill places --last 2026-10 [--first 2025-11] [--stations <stations.parquet>] [--review <folder>]` | dry run of the station matching in a read-only transaction: prints the count per step for each converted month and writes `<month>-place-review.csv` to `--review`; nothing is written to the database |
| `DATABASE_URL=… uv run gerlines-backfill archive --first 2025-11 --last 2025-11 [--report <file>]` | for each loaded service day of the months: refreshes the rollups over the day, checks that level 1 holds as many stops and legs as the raw rows, compresses the rollup chunks that hold the day and decompresses the day's `stop_event` and `segment_obs` chunks; then, in one transaction under the day's advisory lock (which `load` takes for each day too), recounts the raw rows, requires no change pending over the day in any rollup, detaches and drops the chunks and records the day in `history_archive_day`. Refuses a day with rows of another source, a raw chunk wider than the day, or rows that changed since the count; a refusal prints the days already archived. Decompressing writes about one uncompressed day per table (about 250 MB of heap and WAL for a backfilled weekday) before the drop. The converted folder stays the reload source; `load` of an archived day restores its raw rows and clears the mark |

After a load: `gerlines-rollups lands` (stop places created for unknown EVA numbers need a Land),
then `gerlines-rollups refresh --from <first> --to <last>` and `gerlines-rollups check`.

## Archived months

A detached chunk logs no invalidation, unlike `drop_chunks`, so the rollups keep an archived day under
their policies as they are, and a refresh that is not forced leaves it alone. Two things would recompute it from
the missing raw rows and empty it: a forced level-1 refresh and the check, so `gerlines-rollups refresh --force`
and `gerlines-rollups check` refuse a range with an archived day (exit 2). Sizes and the reasoning:
[docs/history.md](../../docs/history.md), Storage.

## Comparison with DB's figures

`scripts/comparable.py` (WP-7.1 scopes), `scripts/g7_variants.py` (every counting variant of the G7 validation and the
DB method of `gerlines_backfill.comparison`, per month) and `scripts/final_vs_live.py` (piebro's finals against
recorded live finals, by the raw snapshot behind each value) read the converted months and print JSON; their
inputs and results are in [docs/history.md](../../docs/history.md).

## Tests

`uv run pytest pipelines/backfill`; with a database `GERLINES_DB_TESTS=required uv run pytest
pipelines/backfill`. The fixtures in `tests/fixtures/` are every row of eleven runs cut from the real
files by `scripts/cut_fixtures.py` (a run that crosses from November into December, cancellations,
an additional stop, a replacement train and bus, an operator brand as train type, a run without train
type, both clock changes).

## Places made by an earlier load

A load resolves each EVA number again, so a place it made earlier moves to a static place found
later (`id_map` follows). Once every month that used the old place is reloaded, remove the places no
row points to:

```sql
DELETE FROM stop_place p
 WHERE p.name_source_id = 'piebro-deutsche-bahn-data'
   AND NOT EXISTS (SELECT 1 FROM id_map m WHERE m.canonical_id = p.stop_place_id)
   AND NOT EXISTS (SELECT 1 FROM trip_instance t WHERE t.origin_stop_place_id = p.stop_place_id)
   AND NOT EXISTS (SELECT 1 FROM stop_event e WHERE e.stop_place_id = p.stop_place_id);
```
