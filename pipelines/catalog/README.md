# gerlines-catalog

Validates the seed files in [`catalog/`](../../catalog/README.md), loads them into the catalogue tables
(migration `0040_catalog_seeds`, [packages/db](../../packages/db/README.md)), reports how well they cover a
loaded timetable, and keeps the research that produced them reproducible. Work package WP-6.1; data model in
architecture §9.

## Commands

Run from the repository root. Commands that fetch need `APP_NAME` and `APP_CONTACT` (the User-Agent); database
commands take their target only from the environment, never from a default.

| Command | What it does |
| --- | --- |
| `uv run gerlines-catalog validate` | parse every seed file with the pydantic models, check keys, sources and references; prints the content SHA-256 and row counts |
| `DATABASE_URL=... uv run gerlines-catalog load [--dry-run]` | validate, then upsert in one transaction (advisory lock `gerlines-catalog`); when an alias already belongs to another operator the whole load rolls back and the command exits 3 |
| `DATABASE_URL=... uv run gerlines-catalog fingerprint` | row count and MD5 of every catalogue table, to prove that a second load changes nothing |
| `FEED_DATABASE_URL=... uv run gerlines-catalog coverage --day 2026-10-21 [--feed-version 1] [--out file]` | coverage of one service day of a loaded feed, read only |
| `uv run gerlines-catalog fetch` | fetch the pinned Träwelling files (commit and SHA-256 in `upstream.py`) into the cache |
| `uv run gerlines-catalog line-colours` | rebuild `catalog/line-colours.csv` from the pinned Träwelling `line-colors.csv` |
| `uv run gerlines-catalog verbuende` | rebuild `catalog/verbuende.yaml` from the current revision of the German Wikipedia Verbund list and Wikidata |
| `uv run gerlines-catalog series-classes [--out file]` | derive unit kind, traction and double deck of every series from its Wikidata classes (`series_classes.py`) and exit 1 when a seed value cited to Wikidata disagrees |
| `uv run gerlines-catalog fleet-ice-lines --source <id> --valid-from <date> --valid-to <date>` | print fleet rule rows (scope line) for every current ICE line of the German Wikipedia line list whose vehicle cell maps to catalogue series (`fleet.py`, `ARTICLE_SERIES`) |
| `FEED_DATABASE_URL=… uv run gerlines-catalog fleet-ic-regional-lines --day <date> --feed-version <id> --valid-from <date> --valid-to <date> [--write] [--report <file>] [--refresh]` | fleet rule rows (scope line) for IC, Railjet, RE and RB lines from the revisions of the IC, Intercity 2, ICE and Länder line lists cited in sources.yaml (fetched once by oldid, 1 request per second), matched to the timetable pairs of that day in the loaded feed version `<id>` (read only; refused when the version is not loaded or the day is outside the feed); `--write` replaces the generated block of fleet-rules.yaml, whose header names the feed file and its sha256; rows naming a vehicle the catalogue lacks and pairs under a 0.95 route match get no rule, except the listed exceptions from their own lower bound (`fleet_lists.py`, `fleet_cells.py`, `wikitables.py`); steps for a new timetable year below |
| `uv run gerlines-catalog research <query> <inputs or @file> [--name n] [--out f]` | run a named Wikidata query (`operators`, `search`, `sitelinks`, `series`, `series-classes`, `ancestors`, `colours`, `hex`, `official-colours`) through the cache |

### Vehicle photos (WP-6.3)

| Command | What it does |
| --- | --- |
| `uv run gerlines-catalog photos candidates` | for every series: the Wikidata image (P18) and the files of its Commons category (P373, else the seed's `commons_category`, first 50), with `imageinfo` and `extmetadata`; keeps CC0, public domain, CC BY and CC BY-SA files with a named author, at least 960 px wide, JPEG or PNG, without restrictions; writes `data/photos/candidates.json` with the reasons files were left out |
| `uv run gerlines-catalog photos approve\|reject <series_id> "File:…" --reason "…" [--by pick:<id>] [--focus x,y]` | record a decision in `catalog/photos.yaml`; at most two approved photos per series (rank 1 shows on the card); a pre-selected pick waits for a maintainer's review |
| `tools/photo-review/photo-review` (`photos review`) | local review page on 127.0.0.1 for the same decisions, see [tools/photo-review](../../tools/photo-review/README.md) |
| `uv run gerlines-catalog photos store` | download the 330 and 960 px Commons thumbnails of every approved photo not stored yet into `data/photos/<series_id>/<photo_id>-<width>.<ext>`, refused when the Commons file changed since approval (SHA-1), checked with Pillow, SHA-256 recorded |
| `uv run gerlines-catalog photos check` | every approved photo has its credit and both copies with the recorded SHA-256; counts per licence; exit 1 on any problem |
| `DATABASE_URL=... uv run gerlines-catalog photos load [--dry-run] [--include-pending]` | after the check, make `vehicle_photo` (migration 0089) exactly the approved photos a maintainer reviewed (`user_review: done`); `--include-pending` adds the pre-selected picks still waiting for review, for development and screenshots only; run after `load`, which writes the series |

Photo requests share one pause of one second (`photo_commands.paced`); API answers are cached in
`data/catalog/{wikidata,commons}/`, images in `data/photos/` with a sidecar each. Thumbnails come from
`upload.wikimedia.org` or `thumb.wikimedia.org`; tracking query strings are dropped from stored links.

`--data` points at the data folder (default `<repository>/data`); worktrees pass the main checkout's
`data/` so the cache is shared.

## Research cache and load on providers

Every request goes through `ResearchCache` (`data/catalog/<provider>/`): the body sits next to a
`.meta.json` sidecar with URL, request digest, time, SHA-256, size and licence. A cached body whose
SHA-256 matches is reused. Two seconds pass between network calls. The User-Agent is
`<APP_NAME>/catalog-<version> (+<APP_CONTACT>)` as Wikimedia's policy asks; its value is never written to
disk. To keep each answer under about 256 KB, queries go in chunks of 25 items (series
classes 5, class ancestors 3) and Wikipedia infoboxes are read from section 0 only, one page per request.

## Load rules

- Tables the catalogue owns (`verbund`, `vehicle_series`, `vehicle_series_operator`, `livery`,
  `livery_series`, `livery_colour`, `line_colour`) end up exactly as the seeds say.
- `operator` rows are shared with the static import: the catalogue inserts missing operators under their
  DELFI name (source `delfi-gtfs`) and writes only its own columns; an operator dropped from the seeds loses
  them. The country is overwritten only by a catalogue value.
- `operator_alias`: catalogue aliases (source `wikidata`) are written and pruned; aliases of other sources
  are left alone. The validator refuses a seed alias under a source the static import writes (`delfi-gtfs`,
  `traines-delfi-eva`), and the loader never prunes those sources.
- `category`: only the names are updated; a code without a migration is refused.
- Updates use `IS DISTINCT FROM`, so a repeated load writes nothing and `updated_at` stays.

## Fleet rules for a new timetable year

The line rules in `catalog/fleet-rules.yaml` are valid for one timetable year (the generated block and the
ICE rows: 2025-12-14 to 2026-12-12) and must be read again after each timetable change, the second Sunday of
December. For the year from 2026-12-13 to 2027-12-11:

1. **Feed.** Take the first weekly DELFI GTFS (source `delfi-gtfs`, the Monday file
   `<yyyymmdd>_fahrplaene_gesamtdeutschland_gtfs.zip`) whose validity covers the service day you will match,
   a Tuesday outside school and public holidays, for example 2027-01-12. The feed of 2026-10-19 ends on
   2026-12-12, so it cannot serve. `uv run gerlines-static-import stage-recorded --monday <date>` links the
   recorder's copy to `data/inputs/delfi/<date>/delfi-gtfs.zip` (or `download` fetches it).
2. **Separate database.** Never `gerlines`. Create a separate database on port 5433 (for
   example `gerlines_fleet27`), `DATABASE_URL=… pnpm db:migrate` migrates it, and
   `DATABASE_URL=… uv run gerlines-static-import load data/inputs/delfi/<date>/delfi-gtfs.zip` loads the feed
   (default categories, so the render in step 6 has every train). Read its id and file:
   `SELECT f.feed_version_id, r.request_url, f.sha256, f.valid_from, f.valid_to FROM feed_version f JOIN
   raw_object r USING (raw_object_id) WHERE f.status = 'loaded'`.
3. **Cited revisions.** Once the articles describe the new year (their tables say Stand Dezember 2026 or
   later), set the `oldid` in `homepage_url` of each of these rows of `catalog/sources.yaml` to the article's
   current revision and update the row's note: `wikipedia-de-ic-linien`, `wikipedia-de-intercity-2-lines`,
   `wikipedia-de-ice-linien` and `wikipedia-de-spnv-<land>` for nrw, nds, by, bw, rp, sl, nvv, rmv, bb, sn,
   st, th, sh and mv (`fleet_lists.LINE_LISTS`). The command refuses a list without an oldid.
4. **Generate.** From the repository root of the branch, with the main checkout's data folder (the
   revisions are cached by oldid in `data/catalog/wikipedia-de/revision-<oldid>.json`, fetched once at one
   request per second with the project User-Agent, `--refresh` fetches again):

   ```sh
   FEED_DATABASE_URL=postgresql://…/gerlines_fleet27 uv run gerlines-catalog --data <main checkout>/data \
     fleet-ic-regional-lines --day 2027-01-12 --feed-version <id> \
     --valid-from 2026-12-13 --valid-to 2027-12-11 --write --report <scratch>/fleet-lists-report.json
   ```

   It stops with a `SourceChangedError` when the IC list no longer says that DB sold its KISS to ÖBB: read
   which IC2 the IC lines then use before changing `IC2_IS_TWINDEXX`. Check that the IC 87 exception
   (`MATCH_EXCEPTIONS`, Konstanz trains) still holds in the new list text and timetable. The ICE rows are
   regenerated with `fleet-ice-lines --source wikipedia-de-ice-linien --valid-from 2026-12-13 --valid-to
   2027-12-11`, pasted over the ICE block; the hand rows (S-Bahn, operator and category layers) are read
   again from their own sources and get the new dates.
5. **Validate.** `uv run gerlines-catalog validate`, `uv run pytest pipelines/catalog -m "not db"` (the
   committed block keeps the floor and cites the lists), `git diff catalog/fleet-rules.yaml`: explain every
   rule that appears, goes or changes series, and read the report's skipped rows (vehicles the catalogue
   lacks, pairs below the floor, lists that disagree). The generated block's header names the feed file and
   its sha256.
6. **Measured hour.** `DATABASE_URL=… uv run gerlines-catalog load` into the scratch database, then from
   `services/live`: `node src/cli.ts render --from <day>T14:00:00Z --to <day>T15:00:00Z --out <dir>
   --packs <packs of that feed> --report <dir>.json` and `node src/cli.ts verify chain --out <dir> --report
   <dir>.json --clients 40 --seed 7` (0 mismatches). Decode the keyframes (`packages/live-frame`,
   `decodeKeyframe`) and count, per category, the distinct trips with a `series` and those whose series has a
   non-generic model in `tools/trainforge/dist/manifest.json`. The 2026-10-20 hour of the 2026-10-19 feed gave
   74.6 % of all trips with a series and 46.0 % with a series model (reg 42.7 %, rfast 39.2 %, ld 62.7 %); a
   category that falls by more than a few points needs a look before merging.

## Coverage

The series part counts, per priority, every field the validator requires to be filled or explained and
the number of reasons per field.


`coverage` weights operators by the trips of one service day (calendar plus exceptions) and by train-km, the
sum of great-circle distances between consecutive stops (a lower bound of the distance along the track).
Line colours match a route when the catalogue has a colour for its operator or DELFI agency and the same
line name, ignoring spaces and case.

## Tests

`uv run pytest pipelines/catalog -m "not db"` runs without a database. The tests marked `db` create a
throwaway database with every migration (`GERLINES_DB_TESTS=required uv run pytest pipelines/catalog -m db`);
they create and drop it from the server's `postgres` maintenance database, never from `gerlines`.
