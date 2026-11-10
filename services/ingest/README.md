# @gerlines/ingest: the recorder

The recorder fetches every realtime and static source on its own schedule and keeps each payload so that it can be
recovered byte for byte. The files under `RECORDINGS_DIR` are the source of truth; the database tables `raw_object`,
`raw_object_segment`, `ingest_run` and `recording_gap` are an index of them that `reindex` rebuilds at any time.
Architecture: [docs/architecture.md](../../docs/architecture.md) §5. Licences: [docs/data-sources.md](../../docs/data-sources.md).

## Sources

| Source id | What | Cadence (UTC) | Segment |
| --- | --- | --- | --- |
| `delfi-mobilithek-rt` | official DELFI GTFS-RT from the Mobilithek subscription (K3), the primary DELFI source (D-041): mutual TLS with the machine account's PKCS#12 certificate, gzip, a 304 for an unchanged minute; only when `MOBILITHEK_CERT_P12`, `MOBILITHEK_CERT_PASSWORD` and `MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID` are set | 60 s at hh:mm:12 | hour |
| `delfi-gtfs-rt` | DELFI GTFS-RT as published (incremental), traines.eu mirror `latest.original.gtfs-rt.pbf`, the fallback | 60 s at hh:mm:20 | hour |
| `delfi-gtfs-rt-deincr` | the mirror's de-incremented accumulation of the last 6 h, `latest.gtfs-rt.pbf` | hourly at hh:25:40 | day |
| `delfi-gtfs-sa` | DELFI service alerts, `latest.original.gtfs-sa.pbf` | 5 min | hour |
| `delfi-gtfs` | DELFI national GTFS: the keyless sharing link (303 to the Monday file), downloaded when the target changes | daily at 08:15 | raw file |
| `gtfsde-rt` | gtfs.de realtime, full dataset | 60 s | hour |
| `gtfsde-static-rv`, `gtfsde-static-fv` | gtfs.de regional and long distance rail GTFS | daily at 06:30, conditional GET | raw file |
| `vbb-gtfs-rt`, `vbn-gtfs-rt` | VBB and VBN GTFS-RT | 60 s | hour |
| `ovapi-train-updates`, `cz-czptt-gtfs-rt`, `pl-trains-gtfs-rt`, `pl-pkpic-gtfs-rt`, `fr-sncf-gtfs-rt` | neighbouring countries | 60 s | hour |
| `be-sncb-gtfs-rt`, `be-sncb-gtfs-sa` | NMBS-SNCB trip updates and service alerts from the Belgian Mobility Company gateway, only when `SNCB_API_KEY` is set (sent as the header `bmc-partner-key`, never stored or logged) | 60 s, alerts 5 min | hour |
| `ch-otd-gtfs-rt` | opentransportdata.swiss, only when `OTD_CH_API_KEY` is set (Bearer header) | 60 s | hour |
| `db-iris-fchg-<eva>` | DB Timetables (IRIS) full changes for the 55 EVAs of `IRIS_LONG_DISTANCE_COVER` (`src/db-apis/stations.ts`, D-041), only with `RECORDER_DB_APIS=1` | 3 min, staggered | hour |
| `db-iris-plan-<eva>` | DB Timetables plan of the German local hour three hours ahead (`IRIS_PLAN_AHEAD_HOURS`); a start without a recent plan also asks the current hour and the two after it once (`catchUpUrlsAt`), same switch | hourly, staggered | day |
| `db-stada-stations` | DB StaDa full station list, same switch | daily at 05:40 | day |
| `db-fasta-facilities` | DB FaSta lift and escalator states, same switch | 15 min | day |

The DB sources are off unless `RECORDER_DB_APIS=1`, so a recorder rebuilt from main never polls IRIS by accident.
They need `DB_CLIENT_ID` and `DB_API_KEY` (K1, sent as the headers `DB-Client-Id` and `DB-Api-Key`, never stored or
logged; the keys are read only when the switch is on) and share the `db-timetables` bucket of at most 41 IRIS
requests in any minute against the plan's 60 (the cover needs about 19.3). IRIS has its own lane: one request at a time, its token taken once it
holds a shared in-flight slot. A 429 or 503 pauses every source of that provider (`Retry-After`, else 60 s, at most
15 min). Only one process may poll IRIS: the recorder and `pnpm db-apis sample` or `iris-run` share the lease file
`.db-timetables.lease` in the recordings folder (renewed every 20 s, free after 90 s). The recorder skips its IRIS
sources, logged once, while another process holds it; the CLI refuses to start while the recorder holds it (pass
`--recordings <host recordings folder>`). IRIS, StaDa and FaSta answers are recorded byte for byte
(`http-document`); an XML answer whose root is not `<timetable>`, or JSON that does not parse, is kept with outcome
`invalid`.

Licence, attribution and homepage of each source are in `src/sources.ts` and are written to the `source` table.

## Storage format, version 1

```
RECORDINGS_DIR/
  recorder-events.jsonl                  start, stop, disk pause and resume
  .recorder.lock                         heartbeat of the running recorder (one writer per directory)
  <source>/runs.jsonl                    run-start and run-end lines, one run per process lifetime and job
  <source>/<YYYY-MM-DD>/<HH>.seg.zst     payloads fetched in that UTC hour (day segments: day.seg.zst)
  <source>/<YYYY-MM-DD>/<HH>.jsonl       one sidecar line per fetch, also failures and 304s
  <source>/<YYYY-MM-DD>/<HH>.backfill.*  the same for payloads filled in by backfill-recent
  <source>/<YYYY-MM-DD>/<HH>.archive.*   the same for payloads filled in from a mirror day archive
  .archive-manifests/<source>/<day>.jsonl  sha256 of every snapshot of a mirror day archive (backfill-archive)
  retention.jsonl                        one line per file retention deleted, written before the delete
  golden-days.jsonl                      days marked with `golden add`, kept whole by retention
  .recorder-mode.json                    full, travel or paused (`mode`); missing means full
  <source>/<YYYY-MM-DD>/<HHMMSS>Z-<name> static files, kept whole (already compressed)
```

All names use UTC; local German time appears nowhere, so the DST switch changes nothing.

A **segment** starts with a zstd skippable frame holding `{"format":"gerlines-segment","version":1,...}`, then
one zstd frame per stored payload. The first payload of a segment, and the first after a restart, is a keyframe;
every later one is compressed with the previous payload of the same segment as a raw-content dictionary (zstd
patch-from: level 9, long-distance matching, window sized to hold both, content size and checksum in the frame).
Recovering payload `n` therefore decodes the segment from its last keyframe up to `n`.

A **sidecar line** (`"type":"fetch"`, `"v":1`) holds: source, run id, writer (`live`, `backfill` or `archive`), the request URL
without secrets, start time, the time the payload represents (`observedAt`), duration, HTTP status, the response
headers ETag, Last-Modified, Content-Length, Content-Type, Content-Encoding, Retry-After and Location, the outcome
(`stored`, `unchanged`, `not-modified`, `redirect`, `http-error`, `failure`, `too-large`, `invalid`), and for a
payload its sha256 and length as received (after HTTP transfer decoding). GTFS-RT payloads also carry the feed
header (version, incrementality, timestamp) and entity counts. A stored payload names its object: id (UUIDv7),
key `<source>/<date>/<HH>/<seq>`, file, encoding (`zstd-patch-v1` or `identity`), and for segments `seq`, `base`,
`offset` and `length` of its frame. A payload whose sha256 equals the previous one is not stored again: its line
has `unchanged` and `sameAs` with the earlier key.

**Commit order.** The frame is written and synced, then the sidecar line is appended and synced. A crash between
the two leaves bytes that no line points at; the next writer cuts the segment back to the last committed frame and
drops a torn last sidecar line, so no payload is half recorded and none is counted twice. A segment file that holds
committed frames is never rewritten: when it cannot be appended to (another format version, foreign bytes, a header
of an unexpected length, or a file shorter than its committed frames) the writer rotates to `<HH>.1.seg.zst`,
`<HH>.2.seg.zst` and so on, and leaves the old file as it is. Static files are synced before their rename, and new
files sync their directory. A line that is not JSON is skipped and reported by `verify`.

A 2xx body that is not a GTFS-RT feed (for `http-document` sources: not the declared XML root or JSON) is stored as well, with outcome `invalid` and its scanner error, so a scanner
bug never drops a provider's bytes; `invalid` counts as a failure for gaps and status.

**Retention** (`retention`, dry run unless `--apply`) never loses history. A segment or stored file goes only when
it ends more than 3 days before now (`--keep-days`, at least 3), touches no golden day (UTC or German local date;
2026-10-25 and 2026-10-26 in the code, more with `golden add`), every payload in it is in a public archive (its
sha256 is in a complete `.archive-manifests` file) or was processed into the database (`rt_payload` without an
error, with `--processed-db`, which reads only the shared database `gerlines`), no remaining sidecar line names it
by `sameAs` (a target goes only together with the line naming it, when that line's bytes are archived too; a file
an earlier apply pruned counts as gone), and it does not hold the newest object of its source. Files of the
`archive` and `backfill` writers go only once processed (`unprocessed` until then), since they were stored to be
processed. A sidecar with an unreadable line keeps every file of its hour and the object stored last before it
(`unindexed`); so does a segment whose frame numbers are not all named by sidecar lines; an unreadable line in
`golden-days.jsonl` stops the plan. Symlinks and anything but regular files are never candidates. Sidecars are
never deleted. `--apply` takes `.backfill.lock` before planning and keeps it alive until the last delete, plans as
of now, checks each file again (regular file, same size, inside the recordings folder), appends its sha256 and the
evidence to `retention.jsonl`, then unlinks it; `verify` counts payloads of journalled files as `pruned`. Today only
`delfi-gtfs-rt` minutes can qualify (the mirror's archives); everything else stays until the realtime processor
writes `rt_payload` for it.

## Commands

From the repository root with Node 24 (`RECORDINGS_DIR` must be absolute):

| Command | What it does |
| --- | --- |
| `pnpm --filter @gerlines/ingest recorder run` | record until SIGTERM or SIGINT (normally the container does this) |
| `pnpm --filter @gerlines/ingest recorder:status` | per source: last success, last error, objects and bytes today, staleness, gaps of the last 3 days |
| `pnpm --filter @gerlines/ingest recorder verify --from <ISO> --to <ISO>` | recover every payload stored in the window and compare its sha256 and length with the sidecar; exit 1 on any mismatch |
| `pnpm --filter @gerlines/ingest recorder reindex [--since YYYY-MM-DD]` | rebuild the index rows from the files; repeatable; a full run replaces the gap rows |
| `pnpm --filter @gerlines/ingest recorder backfill-recent [--days 2 \| --from <ISO>] [--dry-run]` | fill `delfi-gtfs-rt` gaps from the mirror, one file every 2 s; stops on a transport or HTTP error; a mirror file that is not a GTFS-RT feed is stored as `invalid`, listed in the report, and the run continues; `--from` starts later than `--days` and leaves earlier minutes alone |
| `pnpm --filter @gerlines/ingest recorder backfill-archive --day YYYY-MM-DD [--dry-run] [--max-rate 8]` | stream the mirror's day archive of a German date once (8 MiB/s cap by default): write its sha256 manifest to `.archive-manifests/`, store the minutes the recordings miss as writer `archive`, report how many recorded minutes match the archived bytes; `--store-root` and `--manifest-root` write elsewhere for a later merge. Bounded against a broken mirror: 60 s for headers and between chunks, 6 GiB compressed, 1,600 payload limits decompressed, 3,000 members, names up to 1 KiB, the recorder's disk floor; minutes outside the day or repeated are only counted; the manifest says `complete: false` when the tar has no end block; a rerun never stores a minute the archive writer already holds |
| `pnpm --filter @gerlines/ingest recorder retention [--as-of <ISO>] [--out plan.json] [--processed-db] [--apply]` | plan (default) or apply retention, see Storage format; the plan lists every file with its reason (`recent`, `golden`, `not-recoverable`, `unprocessed`, `same-as-target`, `newest`, `unindexed`, `deletable`) |
| `pnpm --filter @gerlines/ingest recorder golden [add YYYY-MM-DD --reason TEXT]` | list or mark golden days |
| `pnpm --filter @gerlines/ingest recorder mode [full\|travel\|paused] [--reason TEXT]` | show or set what the running recorder records, read within a minute without a restart; travel keeps Mobilithek every 5 min (about 430 MB a day) and the DELFI alerts every 15 min, or the mirror's hourly de-incremented copy without Mobilithek; every other source waits and shows a gap |
| `pnpm --filter @gerlines/ingest db-apis <budget\|sample\|iris-run\|download\|report\|stada-join>` | the DB API tools of WP-2.4 outside the recorder (live IRIS run, StaDa and FaSta downloads, reports) |
| `pnpm --filter @gerlines/ingest build` | bundle `dist/recorder.mjs` with rolldown (the container runs the bundle) |
| `pnpm --filter @gerlines/ingest test`, `GERLINES_DB_TESTS=required pnpm --filter @gerlines/ingest test:integration` | unit tests; reindex against a throwaway database |

In the container the same commands run as `docker exec gerlines-recorder-1 node /app/recorder.mjs <command>`.

Environment: `RECORDINGS_DIR`, `APP_NAME`, `APP_CONTACT` (User-Agent), `OTD_CH_API_KEY`, `SNCB_API_KEY`,
`MOBILITHEK_CERT_P12` (absolute, or relative to the workspace root), `MOBILITHEK_CERT_PASSWORD` (read from the
environment only, kept out of argv, logs and sidecars), `MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID` (redacted in stored
URLs), `NODE_USE_ENV_PROXY=1` to send requests, mutual TLS included, through `HTTPS_PROXY`,
`RECORDER_DB_APIS` (`1` adds the DB sources, default `0`) with `DB_CLIENT_ID` and `DB_API_KEY`,
`DATABASE_URL` or `POSTGRES_*`, `RECORDER_DISK_FLOOR_GIB` (default 20), `RECORDER_MAX_IN_FLIGHT` (default 3),
`RECORDER_SOURCES` (comma list to record only some), `RECORDER_SEED_DIR` (earlier downloads with a `<file>.json`
sidecar holding `url` and `sha256`; reused instead of downloading the same URL again), `RECORDER_DATABASE`
(`off` records files only), `RECORDER_MIGRATIONS_DIR` (apply migrations from there at start).

## Running it

The Compose service `recorder` (profile `recorder`, `infra/compose.yaml`) builds the image from the sources
(multi-stage `Dockerfile`, context limited by `Dockerfile.dockerignore`), runs with `restart: unless-stopped`, a
1 GiB memory limit, a read-only root file system with a `/tmp` tmpfs, all capabilities dropped,
`no-new-privileges`, at most 128 processes and a heartbeat health check, and bind-mounts `${RECORDINGS_DIR:-../data/recordings}` (host
path) at `/recordings` and `${RECORDER_SEED_DIR:-../data/inputs}` read-only at `/seed`:

```bash
bash infra/compose.sh --profile recorder up -d --build recorder
docker exec gerlines-recorder-1 node /app/recorder.mjs status
docker logs --tail 50 gerlines-recorder-1
```

On SIGTERM the recorder stops fetching, lets the write in progress finish and closes every run as `succeeded`
(`stop_grace_period` is 30 s). A run left `running` by a crash or a killed container is closed as `failed` at the
next start, in `runs.jsonl` and in `ingest_run`. The recorder does not wait for the database: it records first,
logs a failed index write, and at start and every hour applies pending migrations and reindexes the last two UTC
days from the files. While a write has failed (the index is dirty, as after a cold start before Postgres accepts
connections) it reconciles again after 1, 2 and 5 minutes, then hourly; the first write that succeeds after failures
starts that backoff again, and `database index healed from files` is logged once a reconcile leaves the index clean.
A reconcile stops between sources at shutdown. Source and run rows the database refused are written again before the
next object or gap that needs them, so new objects land as soon as the database answers; objects refused meanwhile
wait for the reconcile. An idle pool connection that Postgres ends is logged and never ends the process, and
a connect gives up after 5 s. The raw object's `observed_at` is the instant the payload represents (for a backfilled
minute the mirror snapshot time), `fetched_at` the time we fetched it.

One writer per recordings directory: `.recorder.lock` is created exclusively; a lock without a heartbeat for 90 s
(or one left by the same host and pid, as a restarted container has) is judged again and replaced only while holding
`.recorder.lock.takeover`, created exclusively, so only one waiting writer can win it and none can remove a lock
another has just created. Every heartbeat checks that the lock is still ours; a writer that
lost it (after a sleep past 90 s, say) stops and exits with an error.

## Politeness

Every request sends `User-Agent: <APP_NAME>/<version> (+<APP_CONTACT>)`. Sources are polled on fixed UTC slots
with up to 3 s of jitter (the DELFI original feed 20 s after the mirror's own hh:mm:01 fetch, so our bytes equal
the mirror's minute file). Every source is https; redirects are never followed (a 3xx is recorded with its
`Location` redacted), except one hop to a host the source lists (opentransportdata.swiss answers with a 302 to a
signed URL on `largeapi.opentransportdata.swiss`; the hop drops the Authorization header and the sidecar stores the
final URL with `Signature` and `Key-Pair-Id` redacted) and the DELFI timetable's sharing link; no redirect may
downgrade the scheme. The DELFI
timetable is downloaded again when the target's file name or its Last-Modified (checked with HEAD) changes.
Conditional GET with the ETag and Last-Modified of the payload we hold. A token bucket
per provider (`PROVIDER_LIMITS` in `src/sources.ts`, for example 5 per minute for opentransportdata.swiss), at
most 3 requests in flight overall, a headers deadline (20 s) and a total deadline (5 s under the cadence), a body
limit per source, capped exponential backoff after failures (base the cadence, cap 15 min) and `Retry-After` in
seconds or as an HTTP date (honoured up to one day).

## Gaps and backfill

A gap is an interval of more than twice the cadence without a successful fetch (`stored`, `unchanged`,
`not-modified` or `redirect`), computed from the sidecars, so the process being down, the machine asleep and a failing
provider all show up the same way. `status` lists them; the recorder logs and indexes each gap when it closes.

`backfill-recent` compares, minute by minute, the mirror snapshots (`hh:mm:01` UTC) since `--days` ago with the
successful records, starting from the last success before that window however old it is, and fetches every minute
that no success covers, also one lost to a single failed fetch that makes no gap. It reads the mirror's day folders
(`https://stc.traines.eu/mirror/german-delfi-gtfs-rt/YYYY-MM-DD/`, named by German local date, files named in local
time with offset) at most one file every 2 s, stops at the first error, and stores them in `<HH>.backfill.seg.zst`
with `provenance: backfill:traines-mirror-day-folder` and the file URL. Minutes whose day already left the folders
are reported with the daily archive that holds them (`https://mirror.traines.eu/german-delfi-gtfs-rt/YYYY-MM-DD.tar.br`),
which `backfill-archive --day <date>` streams once. Afterwards it replaces only the gap rows that reach into its window.
Minutes that are empty files in the archive (the mirror's own failed fetches) are stored as `invalid` and stay gaps.
Other sources have no known archive; their gaps stay recorded.

## Realtime processing (`src/realtime`)

A separate process, never part of the recorder: it reads payloads the recorder committed (sidecar lines and
segment frames, the same reader as `verify`), so a failure in processing never stops recording and no source is
fetched twice. It is not wired to the shared `gerlines` database: every command refuses any database but a throwaway
one (`gerlines_wp<n>`, `gerlines_rt…`, `gerlines_test…`), checked on the name as pg reads it (`%67erlines` is
`gerlines`) and again on the server's `current_database()`, unless `--allow-shared` is given on purpose.

| Step | What it does |
| --- | --- |
| decode | `src/gtfs-rt/decode.ts` reads GTFS-RT trip updates, vehicle positions and alerts with the package's own wire reader; a feed over `DECODE_LIMITS` (250,000 entities, 1,000 stop time updates per trip, 64 translations, 250,000 informed entities per alert, 6 million nested messages, strings over 1 MiB) is a payload error |
| adapt | `adaptGtfsRt(payload, observedAt, profile)` is pure (no clock, no database) and gives the canonical events of `@gerlines/schema` (`TripObservation`, `VehicleObservation`, `AlertObservation`); profiles name each source's stop references and train numbers; stop times further than two days from the observation and delays beyond a day are left out, NUL is stripped, ids are cut to 1,024 and texts to 65,536 characters |
| match | DELFI by trip id and start date against the timetable version the payload's `feed_version` names (at most two versions in memory, about 220 MB of heap each, stops shared); an id that version lacks is read in the other loaded version when three in four reported stops agree (`trip_id_other_version`: DELFI keeps some previous-version ids for a while after a switch); a payload naming a version not loaded yet is matched by stops and times against the newest loaded one, the rest waits as `feed_version_not_loaded` and `Processor.timetableLoaded` folds the service days those payloads named again once the version arrives; a payload naming none, and every other source, reads a service day against the newest version published before that day; calendar checked, trips past midnight by GTFS time; trips DELFI adds become `is_added` instances when every stop is a known rail stop point; gtfs.de by its recorded rail timetables (`gtfsde-static-rv`, `-fv`) and stops and scheduled times, ties broken by fewest stops left over, then exact minutes, and runs with identical places and times taking the smallest trip key; VBB (when named) by its DHID stops and times; matching by stops and times looks at the runs of the Europe/Berlin day of the first stop and the days before and after, and every candidate at the best score is compared before a match is called unique; neighbours by UIC or EVA stops and times, else by train number against trips calling in the feed's own country whose times agree (scheduled times when the feed sends delays, else a shift of its stop sequence with a steady delay, `train_number_times_differ` otherwise), stops then placed by that alignment; unmatched trains go to `match_backlog` with a reason, buses and trams are counted as out of scope |
| fold | per source, in observation order: GTFS-RT delay propagation, cancelled and skipped stops, delays more than 30 minutes early read as no data, predicted times kept in order along the run (a time that would run backwards moves to the latest earlier one; finals stay), a forecast row only when a prediction changes, finals when the observation time passes the prediction, one `segment_obs` per leg of served stops, outbox events; a later feed version's stops move onto an instance's stop list by place |
| write | one transaction per payload with its `rt_payload` log row (`source_id` the recorded feed, `fold_source_id` the logical source its rows carry) and a `pg_notify` on `realtime_payload` delivered at commit; `trip_instance_source` keeps when each source named an instance first and last; alerts are `alert_message` (one row per version of the text) and `alert_scope` (each trip instance and stop place named, first seen, last hour); trips of a source without a usable static timetable (`no_static_for_source`) are counted in `rt_payload.counts`, not backlogged; a payload that fails in any step is logged with its error and no rows, and the run goes on |

Duplicates are skipped by raw object id. DELFI from Mobilithek (`delfi-mobilithek-rt`, primary) and from the traines
mirror (`delfi-gtfs-rt`, fallback) fold as one logical source `delfi-gtfs-rt`: a snapshot (the feed header's
timestamp) is folded once, the mirror's copy waits 60 s so Mobilithek's comes first (not while Mobilithek has
delivered nothing for 5 minutes), and its payload is logged as skipped. A payload older than the newest one a source
has folded (a backfilled minute) marks the service days it touches; `flush` deletes those days' stop events,
forecasts and segments, folds them again from the first payload that touched them and sends `realtime_rebuild`; the
outbox (`event`) is kept, since a refold writes the same event ids. So a run with late or repeated payloads writes
the rows an in-order run writes (the outbox may hold events an in-order run would not have sent).

```bash
DATABASE_URL=<throwaway database with the timetable loaded and the recordings reindexed> \
RECORDINGS_DIR=/abs/path/data/recordings \
node --max-old-space-size=1536 src/realtime/cli.ts live [--since ISO] [--checkpoint /abs/state.gz] \
  [--sources a,b] [--horizon-hours 48] [--poll-seconds 5] [--duration-minutes N]
node --max-old-space-size=2200 src/realtime/cli.ts replay --from 2026-10-26T21:00:00Z --to 2026-10-27T07:00:00Z \
  [--sources a,b] [--speed N] [--shuffle-seed N --rounds 3 --duplicates 0.1] \
  [--split-at 2026-10-27T02:43:00Z] [--feed-version-ids 1,3] [--report FILE]
node src/realtime/cli.ts check         # invariants, data facts, table fingerprints, sizes
node src/realtime/cli.ts reset --yes   # empty the realtime tables of the throwaway database
```

`live` follows the sidecars as the recorder appends them (backfill sidecars too), decodes each new frame against
the last one of its segment, adds the index rows the recorder has not written yet (only for sources it registered),
and processes every payload once, oldest first. Without `--since` it starts at the oldest payload processed in the
horizon, else ten minutes back. Every 5 minutes it takes a `delfi-gtfs` version that reached `loaded` (the days its
payloads named are folded again); a version no payload named for 30 hours leaves memory; per-day caches are dropped
when the local day changes, payload bookkeeping after the horizon; newer gtfs.de statics are reloaded. With
`--checkpoint` it writes its fold state every 10 minutes and at stop, and a restart with the same versions loaded
goes on from it (otherwise the processed payloads of the horizon are folded again). It logs JSON lines, a memory line
every minute and the database size every hour.

`--speed N` runs a virtual clock at N times real time (0 delivers as fast as processing goes). The timetables are the
newest two loaded `delfi-gtfs` versions published by `--to` (or exactly `--feed-version-ids`); load each with
`gerlines-static-import load` and index the recordings with `recorder reindex` first. The report gives, per source,
the match rate and the reasons, delays read as no data, times kept in order and payloads per feed version (with
`--split-at`, also apart before and after that instant), and per category the timetable runs under way in the window
that any source matched (`timetableCoverage`). `check` counts, among others, `segment_negative_run` and
`forecast_backwards` (a stop reached before the one before it was left), both 0 on a correct run.

### DB Timetables (IRIS) as a realtime source

With `--sources` naming `db-iris`, the processor folds every recorded `db-iris-plan-<eva>` and `db-iris-fchg-<eva>`
answer (and `db-iris-rchg-<eva>`, which the recorder does not poll) under the one logical source `db-iris` (`src/realtime/iris.ts`, registered by
`fold-sources.ts` with the DB Timetables licence). The XML parser refuses impossible dates, reads the repeated autumn
hour by the request time, and maps meta EVA numbers to their station. Plans and change answers are kept in books per
fold; a train is matched by its number and planned time, or by its planned stops, and a numbered train needs two
stops, or one when its label's category equals the run's. Only `hsr`, `ld` and `night` runs take IRIS rows (others are
out of scope as `iris_not_long_distance`), and among the sources of an `hsr` or `ld` run the D-041 priority decides
(`chooseSource`, shared with `services/live` and the detail API). An answer waits 30 s on the processing clock
(`IRIS_HOLD_MS`) so answers that arrive out of order fold in order (0 rebuilds against 30 without the hold on a
shuffled replay of the probe fixture), and a positive delay at the first stop an answer names is carried back, as
propagated, to the unreported stops before it. The checkpoint holds the books (`iris-plan`, `iris-change` lines), and
a rebuild reaches back to the first answer of the trips it touches. The local recorder has run the lane since
2026-11-08 (`RECORDER_DB_APIS=1`, the cover recomputed on Friday 2026-11-06 with
`spikes/sp-2-coverage/scripts/iris-cover-weekday.sh`); [docs/KEYS.md](../../docs/KEYS.md) has the call budget. A
replay of that evening raised live coverage from 66 to 95 % for high-speed and from 39 to 92 % for long-distance
runs, and a restart from the checkpoint kept every IRIS row. The live processor on the shared database does not run
yet, so no IRIS delay reaches the map outside replays.

## Disk guard

Every minute the recorder checks free space under `RECORDINGS_DIR` (available blocks times the fragment size) and
pauses fetching below `RECORDER_DISK_FLOOR_GIB`; pause and resume go to the log and to `recorder-events.jsonl`.
