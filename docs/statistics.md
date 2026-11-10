# Statistics API (WP-7.2)

The statistics routes read the WP-2.7 rollups only (`station_day`, `station_hour`, `train_day`, `line_day`) and the
level-3 Land rollups of migration 0066 (`land_category_day`, `land_category_hour`), never the raw realtime tables.
Column definitions are in `pipelines/rollups/README.md`.

Level 3 sums level 2 per day, Land and category (and local hour) over `stop_place_land`, so a year of the whole
network is about 35,000 day rows and 1.1 million hour rows instead of 13 million station rows. Its policies run every
30 minutes after level 2 and refresh to now + 14 days. A change of `stop_place_land` alone does not invalidate level
3: `gerlines-rollups lands` forces a level-3 refresh after it reassigns stop places. The `land_day` and `land_hour`
views stay for the recomputation check. Reads sum the delay histogram as an array only where a median or p90 is shown
(totals, categories, operators, Länder, run groups), never per day or hour, and read totals, categories and operators
in one GROUPING SETS scan. Measured: a year-long `/period` at full-network density in 0.3 to 0.5 s
(`apps/api/src/stats/bench.ts`).
Contract: `@gerlines/schema/stats`; queries: `packages/db/src/stats-queries.ts`; routes: `apps/api/src/stats/`.
The forecasts on the train card are not statistics: they come from their own table ([predictions.md](predictions.md)).

## Sources and licences

The rollups sum stop events of every source in [data-sources](data-sources.md), each under its own licence. Service
days before the live recording come from the history backfill ([history](history.md)):

> Deutsche Bahn train data, collected and processed by piebro (https://github.com/piebro/deutsche-bahn-data),
> licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), data from Deutsche Bahn (DB Timetables
> API, IRIS). Changes: converted to stop events and segments of GerLines, times converted from Berlin wall clock to
> UTC, runs dated by their start, summed into the rollups.

Those days hold DB stations only (EVA numbers 80), times in whole minutes, and no operator or line, so the operator
and line splits of a backfilled period are empty and stops abroad are missing. The same notice is in the
`/api/v1/stats` OpenAPI description and must travel with any figure of such a period that is shown or exported.

## Routes

| Route | Scope |
| --- | --- |
| `GET /api/v1/stats/today` | today's Berlin service day, stops in Germany |
| `GET /api/v1/stats/period?from&to` | service days `from` to `to` inclusive, at most 366, stops in Germany |
| `GET /api/v1/stats/trains/{number}?operator` | one train number, split per operator, category and line, stops abroad included |
| `GET /api/v1/stats/trains/{number}/segments?operator` | the segment profile of a train number (R-09), see [Segment profile](#segment-profile-wp-74a) |
| `GET /api/v1/stats/lines/{line}?operator` | one line name, split per operator and category |
| `GET /api/v1/stats/stations/{id}` | one stop place (UUID), with departures and operators; 404 when unknown |
| `GET /api/v1/stats/lands/{code}` | one Land (`DE-BY`), from the stops inside it (BKG VG250) |

Every route takes `category` (comma list of the nine categories). `from` and `to` default to today; a `from` in the
future without `to` is a single day; days lie between 2000-01-01 and 2100-12-31. Answers carry `period`,
`generatedAt` and `freshness` (`refreshedAt`: the oldest last successful scheduled refresh over all nine policies of
levels 1 to 3, null when one is missing, paused or never ran; refreshes by hand do not count; `maxLagMinutes: 40`;
the note that statistics are up to about 40 minutes behind the live map).

Limits and caching: 60 requests per minute per client (IPv6 by /64, same client rules as search), and of those at
most 10 a minute for periods over 31 days, counted only when the answer is not already held in the cache; answers are kept in process (500 entries, 60 s for periods reaching into
the last two days, an hour otherwise), and concurrent requests for the same answer share one read; `Cache-Control:
public, max-age=60` when the period reaches into the last two days, an hour otherwise; 400 `invalid_request` with
`issues`, 429 `rate_limited`, 503 `not_configured` (no `STATS_DATABASE_URL` or `SEARCH_DATABASE_URL`) or
`stats_unavailable` with `Retry-After: 5`. Statements time out after 10 s.

## Figures

- `punctual6` is DB's operational punctuality: arrivals less than 6 minutes late (5:59) among observed arrivals,
  origins and cancellations left out (`n_lt_6min_arr / n_observed_arr`). `punctual16` the same under 16 minutes.
- Shares, mean, median and p90 are null when nothing was observed. Median and p90 come from the fixed delay bins
  as the smallest value at which half (or 90 %) of the stops are reached, like `percentile_disc`: the sources give
  whole minutes (all of Bahn-Vorhersage, about 88 % of piebro, about 85 % of the live GTFS-RT feeds), so a bin's
  values are taken as its whole minutes from the lower bound, spread evenly. A one-minute bin gives its lower bound
  and a delay of exactly 0 stays 0; a delay with seconds is read down to its minute. The earlier rule interpolated
  inside a bin and sat about half a minute above the true value (2026-11-08, read only, exact
  `percentile_disc` over the stops against the served rule, 40 busiest stations or trains, November 2025, in two
  backfill databases A and B):

  | | median before | median after | p90 before | p90 after |
  | --- | --- | --- | --- | --- |
  | A network | +30.6 s | 0 | +17.0 s | 0 |
  | A stations, month | +32.0 s (0.7 to 59.2) | 0 | +40.6 s | +15.0 s (0 to 60) |
  | A trains, month | +31.8 s (3.7 to 60) | 0 | +44.7 s | +15.0 s (-60 to 120) |
  | B stations, month | +28.8 s (0.8 to 59.6) | 0 | +31.6 s | +3.0 s (-60 to 60) |

  A p90 in a wider bin (16 to 20 minutes and up) is still a spread over that bin's minutes, so it can sit up to the
  bin's width from the truth. `stat_hist_quantile` (migration 0061) keeps the interpolating rule; no served value
  reads it, and it is kept for ad hoc reads until a migration aligns it.
- Mean, median, p90 and max delay count every observed stop, origins with their departure delay included, while
  `punctual6` and `punctual16` count arrivals only. The rollups keep one histogram per stop, so an arrivals-only
  median needs a new rollup column (rule change, not done).
- `/today` is the Berlin calendar date. Between midnight and about 04:00 it shows the new, nearly empty day while
  night trains still run on the previous service day; ask `/period` for yesterday to see them.
- A train number or line answers at most 20 groups (operator, category, line), the busiest first (most stops, ties
  by key), each with its days; more than a handful only happens for bus numbers shared by many operators. The cap
  is applied in SQL: the group read ends in `ORDER BY` stops `LIMIT 20`, and the day read keeps only the rows of
  those 20 groups.
- `observedCarried` and `observedPropagated` count observed stops whose value was carried or copied forward; both
  lean towards punctual. The rollups have no punctual counts without them, so figures without them are not offered.
- Network figures leave out stops abroad and places without a Land; their stop counts are in `outsideGermany`.
- `runs` of a train or line is summed per service day; a trip instance belongs to one service day only.

## Segment profile (WP-7.4a)

`GET /api/v1/stats/trains/{number}/segments?from&to&category&operator` answers, per segment between consecutive stops,
the delay gain of this train number against every train on that segment in the period (contract
`StatsTrainSegments` in `@gerlines/schema/stats`, query `readTrainSegments` in `packages/db/src/segment-queries.ts`).

- Source: the leg rollups only. `stat_segment` (level 1, one row per leg of a run, the source chosen as for stops)
  gives the number's legs; `segment_day` (level 2, day, from place, to place, category) gives every train on the
  same pair of stop places, all categories, this number included. `category` and `operator` choose the runs of the
  number, never the comparison.
- One train per answer: a number is often several trains (596 in November 2025 is an ICE with 24 runs, an RB with
  11 and a bus with 3). `groups` lists the category and operator groups among the chosen runs, most runs first
  (ties by category, then operator id), and only the first (`shown`) is profiled; `route.runs` and every figure
  count that group's runs. Another group is asked for with its `category` and `operator`. Chosen over returning the
  groups beside a mixed profile because a mix puts the RB's and the bus's legs beside the ICE's as off-route
  segments and counts their runs in `route.runs`.
- Route: the number's most frequent ordered stop sequence in the period (`route.patternRuns` of `route.runs` runs
  have it; ties go to the sequence with the smaller hash); its legs come first in stop order with `onRoute`, then
  the number's other legs by runs, at most 100 (`truncated` when more existed). The figures of a segment count every
  run of the number on that pair, not only the runs of the route's sequence.
- Figures: median, p80 and mean delay gain in seconds (arrival delay at the end minus departure delay at the start,
  positive when time was lost) and the legs per gain bin: the 21 bins of `stat_bin` once at the top as `gainBins`
  (bounds in seconds), each figure with `gainCounts` in that order. Median and p80 follow the delay rule above
  (whole minutes, the smallest gain at which half or 80 % of the legs are reached), so a gain of exactly 0 is 0:
  on the 8 busiest pairs of a backfill database in 10 to 16 Nov 2025, 36 to 91 % of the gains are 0, the exact
  median is 0 on all 8 and the interpolating rule gave 3.9 to 35.8 s. Speed is distance over actual run time, the
  mean from the sums and the median interpolated inside the 31 speed bins (speeds are not whole steps).
- Places under two ids: segments are keyed by stop place id, so a station that has two ids in the period splits
  each of its segments in two, and runs before and after the change follow two stop sequences, so `route.patternRuns`
  drops. This holds for days loaded before stop places kept one identity across DELFI feed versions
  ([runbooks/delfi-rollover.md](runbooks/delfi-rollover.md)), such as a reload in a backfill database (S Spandau
  to Berlin Hbf and to S+U Berlin Hauptbahnhof are two segments in November 2025), and for places that rule keeps apart
  (`refused`, such as Basel Bad Bf). The identity keeps the id at a new rollover; it does not merge rows already stored.
- Missing: a segment with fewer than 5 runs (`minRuns`, the planner's reliability rule) is `missing` with
  `too_few_runs` and its run count; no run at all is `no_runs` (for `all`, also when `segment_day` has no row yet);
  `no_gains` with the run count when the rollup row has runs but no gain in its bins (an inconsistent row).
  Speed is missing with `no_distance` where no leg had a distance, which holds for every backfilled day (piebro
  has no distances), and with `too_few_runs` under 5 legs with a distance; `speed.legs` counts those legs (one run
  can pass a pair twice), not runs.
- Bias, stated in `note`: legs after a feed stopped reporting keep a gain of exactly 0 until legs get a quality
  (rollups README), so more legs gain exactly 0 than ran on time (54 % of the legs of 2025-11-12 in the backfill
  have a gain of 0). The quantiles report those zeros as 0 rather than spreading them over the first minute.
- Limits as the other routes: 60 a minute, periods over 31 days also against the 10 a minute; cache and
  `Cache-Control` the same; the read takes 2 of the 6 queries of the gate (the statement and the freshness read).
- Cost (measured 2026-11-08 on a bench copy of every 2025-11 leg on the pairs of ICE 596, IC 2013, RE 4321 and
  S 35125, 145,460 legs): 4 to 9 ms warm, 52 ms for the first call of a fresh process. The legs
  come from the continuous aggregate's `train_number, day` index and `segment_day` from its places index. The same
  query over the raw `segment_obs` of the full month takes 1.9 to 3.4 s (compressed chunks are decompressed whole),
  which is why the route reads only the rollups.
- Size: the gain bin bounds are sent once (`gainBins`), each figure carries 21 counts. With the same synthetic
  counts (F74a, StatsService through the golden reader, 24 and 1,086 runs a segment) 22 segments take 44,295 bytes
  before and 14,682 after (gzip 2,024 and 1,424), 100 segments 198,414 and 61,941 (gzip 4,435 and 2,562). The API
  does not compress, so a proxy in front should. A year-long period on a full `stat_segment` is not measured yet.

## Validation against DB's published punctuality

Source: https://www.deutschebahn.com/de/konzern/konzernprofil/zahlen_fakten/puenktlichkeitswerte-6878476 (read
2026-11-07). Our data: Bahn-Vorhersage parsed train delays 2025 (ODbL), finals of each stop, streamed per day.

| 2025 | DB Fernverkehr | ours | DB Nahverkehr | ours, all regional operators | DB Personenverkehr | ours, all |
| --- | --- | --- | --- | --- | --- | --- |
| October | 51.5 | 50.53 | 85.2 | 84.40 | 84.4 | 83.87 |
| November | 54.5 | 53.45 | 85.2 | 84.11 | 84.5 | 83.64 |

Fernverkehr is IRIS operator `80`; Nahverkehr has no single DB code, so all regional operators are counted. Through
the full chain (stop events, rollups, this API) November Fernverkehr at stations in Germany is 52.78 % (193,870
arrivals). Our figure is 0.5 to 1.1 points below DB's in every case; DB measures against the day's valid timetable,
which may explain part of it.

Backfilled months (piebro, [history](history.md)) on the rollups' rule read 2.6 to 4.6 points below DB in
Fernverkehr and 2.7 to 4.1 in Nahverkehr (2025-11 to 2026-10). The difference is the population, not the
rule or the times: DB counts only its own trains (DB Fernverkehr, DB Regio) and takes partly cancelled
trains out entirely (DB AG in Bundestag Drucksache 19/1999, answer 3), while the rollups count every operator
and the served stops of a partly cancelled run. On DB's population the backfilled months are within 1.6 points
below to 0.7 above DB in Fernverkehr and 0.8 to 1.9 below in Nahverkehr (G7 met); the table and the open
points are in [history](history.md). The rollups keep their rule; the method note of the panel stays as it is.

## Web views (WP-7.3)

The statistics panel in `apps/web/src/stats` reads these routes and shows today, a period, a Land, a station, a line or a
train number. Entry: the Statistics icon button at the end of the search row, paired with Plan a journey, on desktop and
phone; the panel takes the card slot of the train and station cards and of the planner, one
panel at a time; a station card open at that moment becomes the station area.

- Area tabs: Germany, State, Station, Line, Train. Picking a Land focuses it on the map (Land focus); clearing the focus
  or focusing another Land elsewhere moves the panel along. A station comes from the station search, or from the station
  card that was open when the panel opened; a line or train number is checked against the API's own patterns before a request goes out.
- Period tabs: Today (asks `/today`), 7 days, 30 days (ending today), Month (stepper, from January 2024), Custom (two
  days, at most 366). Days are Berlin calendar days taken from the device clock.
- Figures: the share of punctual arrivals (`punctual6`) as the headline with its arrivals count, then `punctual16`,
  observed arrivals, cancelled stops with their share, mean, median, 90th percentile and longest delay. Shares are rounded
  half up on their four decimals, never on binary error (`percentNumber`).
- Charts (own SVG, no chart library, loaded with the panel on first press): delay distribution from `delayHistogram`
  on a minutes scale (bar height is the share of stops per minute of delay, so the wider bins after 16 minutes show no
  false peak; a break mark at 16 minutes) coloured by the Delay mode classes, punctuality by category, by hour of day and by day. Every chart reads with the arrow
  keys, shows the same readout in a tooltip and in a live region, and has a table twin behind one switch.
- Missing data is shown as missing with a reason: no stops recorded, stops without realtime values, no observed arrival, a
  new service day that has just begun, and each failure of the API (not configured, rate limited, invalid, not found,
  unavailable, unreachable, unreadable).
- Provenance: the source, the time of the last refresh (`freshness.refreshedAt`, or that it is not known), the lag from
  `freshness.maxLagMinutes`, and the method note; the sentence on the 0.5 to 1.1 point gap to DB's published figures
  shows only for Germany over whole months.
- The dev server (`pnpm --filter @gerlines/web dev`) serves `/api/v1/stats` itself when `STATS_DATABASE_URL` is set.
