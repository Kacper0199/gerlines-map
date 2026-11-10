# History backfill (WP-7.1)

The months before our recorder started come from
[piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data): DB Timetables
(IRIS) plan and change snapshots of every DB station, collected hourly and published as one processed
Parquet file per month, all DB stations from 2025-11 on (the months before cover a few stations
only). Licence CC BY 4.0, attribution "Deutsche Bahn train data, collected and processed by piebro,
data from Deutsche Bahn". Code and commands: [pipelines/backfill](../pipelines/backfill/README.md);
model: [ADR-0009](adr/0009-history-model.md), architecture section 10. The delay forecasts on the train card are
built from these converted months: [predictions.md](predictions.md).

## From a piebro row to our rows

| piebro | ours |
| --- | --- |
| `id` = `<ride>-<YYMMddHHmm>-<n>` | the run key is the id without `-<n>`; its stamp is the run's start, Berlin time, and its date the service date; `stop_index` = `n - 1` |
| `eva` (`08000105`) | `stop_place` through `id_map` of the EVA mirror (static import), else `stop_place.eva`, else a static place without EVA whose dhid carries the EVA (`de:16062:8012494`); a station still open is matched by the Bahn-Vorhersage station coordinates (ODbL) in this order: a static place without EVA within 150 m whose normalised name agrees strongly (score at least 0.8, Frankfurt(M) Flughafen Regionalbf to the Regionalbahnhof and not the Fernbahnhof), else the nearest static place of its station's other EVA numbers (Bahn-Vorhersage `meta_evas`) within 150 m (München Hbf (tief) to München Hbf at 118 m), else a static place without EVA within 150 m whose name agrees fairly (score at least 0.5), never a name that differs only by Nord, Süd, Ost, West, Mitte or Hbf, else one within 25 m that shares a word of the name (Bad Ems and Bad Ems Hauptbahnhof), else a new place named by piebro at those coordinates; every match is kept in `id_map` under `piebro-deutsche-bahn-data`. Every take by coordinates or meta EVA, every close place not taken and every meta place further than 150 m (`meta_too_far`, such as München Hbf Gl.5-10 at 316 m) is a row of `place-review.csv` beside the converted month, with the step as `decision` |
| `train_type`, `line_number` | category (`categories.py`): rail replacement buses, a product train type (`ICE`, `RB`, `S`), the product prefix of the line (`HLB` with `RB45` is `reg`), then `reg`; the run takes the first train type, number and line of its stops that have them |
| planned and changed times (Berlin wall clock, whole minutes) | planned times to UTC (none in the spring gap); in the repeated autumn hour the earlier instant until the run's wall clock goes back, the later one from there on; a final time is the planned instant plus the wall-clock delay, so a delay never jumps by an hour at a clock change |
| `arrival_is_canceled`, `departure_is_canceled` | a cancelled event has no final time; a stop is cancelled when each of its events is cancelled or absent |
| `is_additional_stop` | `additional` |

A run becomes a `trip_instance` with `backfill = true` and no timetable link (`feed_version_id` and
`trip_key` null, migration 0087), no operator (the processed files carry none), its first stop as
origin and its start stamp as origin departure; its id is UUIDv5 of `trip_instance:piebro` and the run
key, so it never equals a live id. Every stop with a final time has `final_quality = final_only`.
Legs (`segment_obs`) join consecutive served stops by the rule of the live fold: not cancelled, with a
schedule, a final departure at the first and a final arrival at the second stop; distance and speeds
stay null. Everything is stored under the source `piebro-deutsche-bahn-data` with the monthly file as
its raw object (sha256, bytes, URL with the dataset revision).

piebro cuts its months by actual time, so a month's runs are read from its own file and the first
two days of the next one. The first month loses the stops after midnight of the runs that started on
2025-10-31 (1,435 rows). A month converted before the next month's file exists warns and records
`next_month_missing: true` in its `summary.json`: runs of its last day miss the stops they make after
midnight (2026-10 until the November file is published); convert it again once the file is there.

A place made by an earlier load is resolved again on every load, so a later static import with the
station moves it: `id_map` follows the new place and the reloaded days point to it. The old place
stays until no row of any month points to it (remove it then by hand, see the pipeline README).

### Reviewed place decisions

A reviewed decision goes into `pipelines/backfill/place-overrides.csv` (columns `eva`, `place`, `note`), which every
load and every dry run reads before any matching, so the decision holds for every month loaded after it. `place` is a
`stop_place_id`, a dhid (`de:09162:100` puts München Hbf Gl.5-10 on München Hbf), or `separate`, which keeps the
station on a place of its own even where a rule would merge it. An override beats every rule, the EVA mirror included;
its station is a row of `place-review.csv` with the decision `override` or `override_separate`. A row without an EVA
number, or with a place that does not exist, stops the load before any day is written. `--overrides <file>` reads
another file. To review before a load, run the matching alone:
`gerlines-backfill places --stations <stations.parquet> --last <month> --review <folder>` resolves each converted month
in a read-only transaction, writes nothing to the database, prints the count per step and writes
`<month>-place-review.csv` to the folder.

## Limits of the data

- **Final values only.** No forecast history; `stop_event_forecast` gets nothing.
- **An unchanged stop looks on time.** piebro sets a change time to the planned time when IRIS never
  sent a change for that stop, so a stop without realtime counts as punctual.
- **DB stations only.** Every EVA number is a DB station (`80…`), so stops abroad and at stations
  outside IRIS are missing.
- **No operator and no line in the rollups.** `operator_id` is null; the line name exists only in the
  converted files (`line_name` of the runs), because the rollups read the line from the timetable.
- **Whole minutes.** IRIS times have no seconds.
- **Cut-over.** A load reads the first service day another source has stop events for and refuses
  days on or after it unless `--until` is that day or earlier; backfill and live ids never meet, so
  both copies of a run would be counted. That first live day is usually partial (the recorder started
  during it) and the backfill leaves it out, so it reads low. GTFS dates a run that starts after
  midnight on the previous service day (times past 24:00), IRIS on the calendar day of its start
  stamp; a few night runs around the cut-over can therefore sit on the neighbouring day.
  The search for that first live day starts two days before the first `ingest_run` of another source that is not a
  static import (the recorder's first run), so the compressed backfilled months before it are never read; stop events of
  another archive source dated earlier than its first run would not be seen.
- **Reload.** Reloading a day deletes its stop events and legs and updates its runs in place
  (deterministic ids); only runs that left the day are deleted, because deleting a run checks the
  `stop_event` key in every chunk.
- **Clock change.** In the repeated autumn hour a planned time is taken as the earlier instant
  unless the run's wall clock has gone back before it; a run that enters the hour only on its
  second pass without going back (rare) is one hour early.

## Validation

Spot check [M]: the Fernverkehr finals of November 2025 from Bahn-Vorhersage (an independent IRIS
collection, ODbL), joined on train number, EVA number and scheduled UTC arrival: 187,912 common
arrivals, 93.1 % with identical delay, mean difference -0.46 s, punctuality 52.58 % from piebro and
52.48 % from Bahn-Vorhersage on the same arrivals. The two sources differ in coverage, not in values:
39,169 arrivals only in piebro (44.9 % punctual, at big hubs) and 27,566 only in Bahn-Vorhersage (60.1 %,
mostly stations abroad). 135 of 14.08 million stops of November appear under two run ids.

Spot check against our own realtime [M] (`pipelines/backfill/scripts/spot_check.py`): the backfilled
2026-10-27 against the `gtfsde-rt` and `delfi-gtfs-rt` stop events our ingest wrote for that day
(live finals only), matched on train number, EVA number and scheduled time: 381,405 events, 53.3 %
identical, 80.3 % within 60 s (whole minutes against seconds), median absolute difference 0 s, p95
420 s. Of 25 trains, five per category with the most matched events, the long-distance, fast regional
and S-Bahn trains agree within 60 s at 59 to 100 % of their stops; the regional outliers (trans regio
RB26, 6 to 59 %) have 75 to 98 % of their stops exactly on schedule in gtfs.de while IRIS shows 5 to
31 minutes of delay, so there the live source lacks realtime. The export:

```sql
SELECT e.service_date, ti.train_number, ti.category_code, ti.operator_id, sp.eva, e.stop_index,
       e.source_id, e.final_quality, e.cancelled,
       to_char(e.scheduled_arrival AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sa,
       to_char(e.final_arrival AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS fa,
       to_char(e.scheduled_departure AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sd,
       to_char(e.final_departure AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS fd
  FROM stop_event e JOIN trip_instance ti USING (trip_instance_id)
  JOIN stop_place sp ON sp.stop_place_id = e.stop_place_id
 WHERE e.service_date = '2026-10-27' AND sp.eva IS NOT NULL AND ti.train_number IS NOT NULL
   AND e.source_id IN ('gtfsde-rt', 'delfi-gtfs-rt');
```

### Punctuality against DB's published figures

DB's rule: a stop is punctual when its planned arrival is exceeded by less than six minutes (up to
5:59), and the figure is the share of punctual stops among all intermediate and final stops of the
month's runs of DB passenger trains
([DB Pünktlichkeitswerte](https://www.deutschebahn.com/de/konzern/konzernprofil/zahlen_fakten/puenktlichkeitswerte-6878476),
the page "Erläuterung Pünktlichkeitswerte für den Oktober 2026", read 2026-11-08, October 2026
provisional; every DB figure below is from that page). Wholly or partly cancelled trains are taken
out of the population: "der Anteil vollständig oder teilweise auf einem Streckenabschnitt
ausgefallener Züge [wird] von der Grundgesamtheit aller planmäßig verkehrender Züge im
Personenverkehr abgezogen" (DB AG in the Federal Government's answer, Bundestag
[Drucksache 19/1999](https://dserver.bundestag.de/btd/19/019/1901999.pdf), 2018, answer 3).

IRIS gives planned and changed times in whole minutes, piebro fills a missing change time with the
planned time, and the converter's delay is changed minus planned, a multiple of 60 s. Our rule, delay
under 360 s, is therefore delay at most 5 whole minutes, which is DB's rule: IRIS minutes are the
second-accurate time truncated (V-71, 4,831 arrivals of 2026-10-27 with second-accurate live finals: a
live 5:30 to 5:59 is IRIS 5). Whole minutes do not undercount; the rule stays as it is for every
source.

#### Why the figures read low

Measured on the converted months unless marked; scripts in `pipelines/backfill/scripts`, the
population rules in `gerlines_backfill.comparison` (tested).

1. **piebro's final is the value after arrival, not a stale forecast** (`final_vs_live.py`, 2026-10-27,
   the one processed day both sources have). piebro reads IRIS `fchg` of every station once per run of
   its collection workflow (every 6 hours plus repair runs; on that day at 00:25, 00:48, 08:57 and
   15:20 UTC) and keeps per stop the latest snapshot with a change; a snapshot still holds the changes
   of the past 5 to 17 hours. Of 192,040 arrivals matched with our live finals (train number, EVA
   number, scheduled arrival), 93.4 % took their value from a snapshot read after the train arrived,
   4.6 % from a forecast read before it and 1.9 % never had a change (planned time). The last two
   groups read *more* punctual than live (94.2 % and 100 % against 79.2 % and 84.6 %), so they cannot
   explain a figure below DB. On the after-arrival group piebro is 41 s later on average (same minute
   57 %, later 30 %, earlier 13 %): against `delfi-gtfs-rt` 15 s and 86.7 % against 86.9 % punctual,
   against `gtfsde-rt` 34 to 62 s and 2 to 3 points less punctual (Fernverkehr 52.7 % against 55.5 %,
   3,136 arrivals). Our live final is fixed when its predicted time passes, which leans early, so the
   live values are no ground truth either; the difference is at most a small part of the gap.
2. **Partly cancelled runs** are the largest part. A converted stop is cancelled when each of its
   events is; we leave cancelled stops out but count the served stops of a partly cancelled run, DB
   takes the whole train out. In October 2026, 8.3 % of Fernverkehr runs and 3.8 % of regional runs
   have a cancelled stop next to served ones (2.1 % and 2.2 % are cancelled throughout); their served
   arrivals are 8 to 13 % of Fernverkehr arrivals and about 36 % punctual. Leaving those runs out
   raises Fernverkehr by 1.4 to 2.6 points and Nahverkehr by 1.1 to 1.7.
3. **Operator and products.** DB's figure covers DB's own trains. Bahn-Vorhersage gives each stop the
   IRIS operator code; seven days of its 2025 archive (2025-11-12, 11-15, 11-16, 12-15, 12-17, 12-20,
   12-21) map the long-distance train numbers. ICE, IC and EC numbers seen only with code 80 (DB
   Fernverkehr) carry 68 to 76 % of the comparable Fernverkehr arrivals; numbers that are also run
   by a partner railway (EC to Austria, Switzerland, Czechia) or only by one (ICE 22 and 28 of ÖBB,
   ICE 106 and 108 to Amsterdam, EC 395) are 1 to 6 points less punctual in every month but one
   (2026-04, partner trains 2.7 above). This is also why the
   Bahn-Vorhersage Fernverkehr extract (operator 80) of [statistics](statistics.md) sat within 1.1
   points of DB: of piebro's 39,219 Fernverkehr arrivals of November 2025 missing there, 35,906 have a
   train number that extract never has. Product sets (ICE only, adding ECE, RJ, RJX, TGV, NJ, EN or
   FLX) move Fernverkehr by about a point either way and close nothing.
4. **Stops abroad** are missing from piebro. In the Bahn-Vorhersage Fernverkehr of November 2025
   (a backfill database), adding the 20,613 arrivals abroad to the 193,933 at German stations raises the
   figure from 52.73 % to 53.37 % (+0.6). Not applied below, because the operator-80 extract and
   piebro differ in other ways too.
5. **Weighting** is per stop in DB's wording and in ours. Other weightings move away from DB: per run
   Fernverkehr -0.2 to -2.2 points against DB, per train-kilometre (great-circle legs) -4.3 to -7.8,
   final stops only -9.6 to -13.3. Stops with a plan record and not additional only: +0.3 to +1.2.

#### DB's population against DB's figures

**DB method**: Fernverkehr ICE, IC and EC whose number is only operator 80, Nahverkehr regional rail
runs whose number the DELFI trains feed of 2026-10-19 gives only to DB Regio companies, both without
partly cancelled runs and at stations inside Germany; arrivals at every stop after the first, under
360 s (`g7_variants.py`, variant `db_method`; 12 months in 3 minutes, 1.4 GB RSS). The comparable figure
of WP-7.1 (same products and operators, partly cancelled runs counted, all Fernverkehr operators) is
beside it.

| Month | FV DB method | FV comparable | DB Fernverkehr | NV DB method | NV comparable | DB Nahverkehr |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2025-11 | 54.24 | 51.40 | 54.5 | 83.31 | 81.72 | 85.2 |
| 2025-12 | 61.86 | 59.13 | 61.7 | 87.39 | 85.99 | 88.4 |
| 2026-01 | 52.35 | 48.43 | 52.1 | 85.56 | 84.36 | 87.2 |
| 2026-02 | 58.84 | 55.86 | 59.4 | 87.58 | 86.30 | 88.7 |
| 2026-03 | 61.83 | 59.01 | 62.1 | 87.91 | 86.55 | 88.8 |
| 2026-04 | 63.53 | 60.60 | 64.4 | 88.18 | 86.94 | 89.1 |
| 2026-05 | 61.02 | 58.35 | 61.1 | 87.79 | 86.38 | 88.7 |
| 2026-06 | 53.18 | 49.45 | 52.6 | 85.42 | 83.76 | 86.4 |
| 2026-07 | 51.98 | 48.79 | 52.6 | 86.55 | 85.21 | 87.9 |
| 2026-08 | 53.05 | 49.61 | 54.2 | 87.31 | 86.12 | 88.5 |
| 2026-09 | 50.75 | 48.26 | 52.4 | 86.75 | 85.64 | 88.2 |
| 2026-10 | 56.91 | 53.67 | 56.2 | 86.32 | 85.19 | 87.1 |

On DB's population Fernverkehr is 1.6 points below to 0.7 above DB and Nahverkehr 0.8 to 1.9 below, so
**G7 (within 2 points) is met in all twelve months** for both. Runs in it per month: Fernverkehr 13,356
to 17,734 (DB: more than 20,000), Nahverkehr 526,279 to 613,311 (DB: about 780,000).

What is left, and how sure it is:

- The Nahverkehr figure stays 0.8 to 1.9 below (closest to the limit in 2025-11, the previous
  timetable year, where 4.7 % of regional numbers are not in the 2026 feed). Likely causes: a fifth to
  a third of DB Regio's runs are not identified (number shared with another operator, not in the feed,
  or missing in IRIS), stops without realtime count as on time in piebro (which raises our figure, so
  it does not explain the gap), and the partly cancelled reading below.
- The partial-cancellation reading is an inference: DB's sentence can also mean only the cancelled
  section leaves the population, which is what the comparable figure does. The data favour the whole
  train (it brings both groups to DB's level in every month), but DB does not publish its method in
  more detail.
- The operator map comes from seven days of November and December 2025. Fernverkehr numbers it does
  not have (11,700 to 24,700 arrivals a month, more in 2026) are left out; counting them as DB's moves
  Fernverkehr to 2.5 below to 0.5 above DB, outside 2 points only in 2026-08 (-2.5).
- Stops abroad (+0.6 in November 2025) are missing and not added.
- The statistics rollups keep our own rule for every source: all operators, all served stops,
  partly cancelled runs included. Backfilled months therefore read 2.6 to 4.6 points below DB in
  Fernverkehr and 2.7 to 4.1 in Nahverkehr (the full scope of WP-7.1); the DB method above is a
  comparison, not a change of the rollups.

Through the whole chain [M]: November 2025 loaded into a scratch database (1,272,914 runs, 14,212,261
stops, 12,328,591 legs, equal to the converted counts), rollups refreshed: `land_category_day` over
the Länder gives per category exactly the observed arrivals and arrivals under 6 minutes of the
converter's summary, and `gerlines-rollups check` finds every stop rollup equal to its recomputation.

## Storage and loading the rest

Measured in a backfill database (TimescaleDB 2.31) on November 2025, the rollups on its weekdays 2025-11-04 to 06.
A month of backfill, in MB:

| Table | Rowstore | Columnstore |
| --- | ---: | ---: |
| `stop_event` | about 3,900 | 745 |
| `segment_obs` | about 2,850 | 680 |
| `trip_instance` (plain table) | 270 | 270 |
| `stat_stop` | 3,818 | about 440 |
| `stat_segment` | about 3,650 | about 290 |
| `station_hour` | 1,480 | about 80 |
| `train_day` | 554 | about 40 |
| `segment_day` | about 320 | about 33 |
| `station_day` | 152 | 15 |
| level 3 and `line_day` | 17 | 2 |
| **all** | **about 17,000** | **about 2,600** |

Raw rows compress 5 to 6 times, the rollups 9 to 20 times (migration 0095, [rollups](../pipelines/rollups/README.md),
Columnstore). Values marked about are a measured weekday times 30, or ten measured days times 3 for the raw rowstore,
so they lean high. In the columnstore a year of backfill is about 31 GB, more than the 25 GB a year may take on
the 16 GB development machine.

**Older months are archived** (`gerlines-backfill archive`, migration 0096): once a month's rollups are refreshed
and compressed, its raw `stop_event` and `segment_obs` chunks are detached and dropped and the days recorded in
`history_archive_day`. Every rollup keeps the month (a detached chunk logs no invalidation), so the statistics
routes, the segment profile included, read it as before; the converted folder (about 270 MB a month on disk,
outside the database) is the reload source, and `load` brings the raw rows back when they are needed, for a rule
change or a check. An archived month takes about 1.2 GB (the rollups and `trip_instance`), so a year with two
recent months kept whole is about 17 GB, and 14 GB with all twelve archived (both inferred from the sizes above,
not measured on an archived year). The archive is tested on fixture days only: a real month has not been archived
yet, nor has a refusal been seen on one; run it once on a database with room (load, refresh, archive, an unforced
refresh, then compare the `station_day` sums) before relying on it. What an archived month gives up: the
forced level-1 refresh and the rollup check over it (both refuse, a reload comes first), and the stop events
themselves for anything that reads them directly (offline scripts read the converted folders instead), and any
migration that rebuilds a level-1 rollup, which refuses until the archived months are reloaded
(`assert_no_archived_days`, [rollups](../pipelines/rollups/README.md), Changing a rule).

Order on a new database: migrations, static import (stop places with EVA numbers), Länder, then per month
`load --first <month> --last <month> --compress`, `gerlines-rollups lands`, `gerlines-rollups refresh --from <first
day> --to <last day>`, and `gerlines-backfill archive --first <month> --last <month>` for months older than the
recent window. The refresh of a month's stop rollups takes about 9 minutes and its rowstore peak is about 10 GB, so on
a small disk refresh and archive a few days at a time (archive refreshes each day itself before it drops it).

Our own recordings cost more per day than a backfilled day (measured by replaying 2026-11-06 from 23:00 to
14:00 UTC, 62.5 % of that weekday's realtime payload, into a scratch database, scaled to the whole day): about
2.6 GB a day pass through the rowstore (2.1 GB of realtime rows, a third of them forecasts, and 0.46 GB of rollups)
and about 0.45 GB a day stay after the columnstore policies (forecasts 155 MB, stop events 77, legs 51, outbox events
21, rollups 42, plain tables about 100), so about 14 GB a month. `stop_event_forecast` and `event` feed no rollup, so
a retention policy on them (`drop_chunks` is safe there) is the first lever once their uses are settled (the B2
training set needs eight weeks of forecasts, [predictions](predictions.md)). The archive above is for backfilled
months only: it refuses a day with rows of another source.
