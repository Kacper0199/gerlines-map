# Delay predictions B0 and B1 (WP-7.5)

The train card shows, for the stops ahead of a running train, the arrival delay that history makes
likely, labelled as a forecast and never as a measurement. This page defines the models, the
backtest that decides where they ship, its results and the served table. Code:
[pipelines/predict](../pipelines/predict/README.md), `apps/api/src/predictions`,
`apps/web/src/components/train/forecast`. Architecture section 10: B0 and B1 ship with statistics,
B2 (gradient boosting) later and only when it beats B0 at every horizon.

## Question and decision

Which of three forecasts of the arrival delay at a later stop is closest to what happened, given the
delay a train has when it leaves its current stop, and at which horizons does the card show B1?

- **Zero**: the train arrives on time (0 minutes) everywhere ahead. A floor, not a candidate.
- **B0, persistence**: the delay at the current stop carries to every stop ahead unchanged.
- **B1, historical quantiles**: for the train number and the stop ahead, the empirical median and
  80th percentile from history of trains that left a stop in the same delay band.

## Definitions

- **Pair.** The moment a train leaves served stop `i` with a known delay, and a later served stop
  `j` of the same run with a known arrival delay. Cancelled stops are removed from the run before
  counting, so **stops ahead** `k = j - i` counts served stops. **Minutes ahead** is the planned
  arrival at `j` minus the planned departure at `i`. Pairs reach up to 30 stops ahead.
- **Current delay** `d_i`: the departure delay at `i`, else its arrival delay; **target** `d_j`: the
  arrival delay at `j`. Both in whole minutes as IRIS gives them (seconds rounded down in the API).
- **Delay band** of `d_i`: on time (0 or less, early included), 1 to 5, 6 to 15, over 15 minutes.
- **Horizon bucket** of `k`: 1, 2 to 3, 4 to 7, 8 or more stops ahead.
- **B1 levels**, most specific first, each keyed also by band and horizon bucket:
  1. train: category, train number, EVA number of `j`;
  2. stop: category, EVA number of `j` (every train of that category at that stop);
  3. category.
  A level answers when its key holds at least 20 **runs** in the training window: distinct service
  days and runs, not pairs, as one run gives a key up to 23 pairs at 8 or more stops ahead (the
  category level answers with any count). The horizon bucket is added to the brief's keys at every level because
  the change from the current delay grows with distance; without it the train level pooled
  1-stop and 10-stop changes and lost to B0 one stop ahead in the first trial (smoke run on two days,
  MAE 0.64 against 0.61).
- **B1 variants.** `level`: quantiles of `d_j` itself. `change`: quantiles of `d_j - d_i`, added to
  the current delay; the point forecast is `d_i + median(d_j - d_i)`, the upper bound
  `d_i + p80(d_j - d_i)`. Both are empirical quantiles of the arrival delay given the band; the
  second keeps the delay within the band.
- **Quantile**: the lower empirical one, the smallest whole minute whose cumulative share reaches
  0.5 or 0.8, exact from counts per minute (values clipped to minus 120 and 899 minutes).

## Backtest

Data: the converted piebro months (docs/history.md), 2025-11 to 2026-10, rail categories only
(rail replacement buses left out), no database. Strict time split: each test month is predicted by
tables built from the three months right before it only; nothing of the test month or later reaches
them. Test months 2026-02 to 2026-10 (nine folds) for `change`; the `level` variant on the last
three folds, 2026-08 to 2026-10 (time). Each run streams day by day in memory with
`POLARS_MAX_THREADS=3` and writes only its sums; the first change run peaked at 2.48 GB RSS, the
fixed code (sort-based merge and ranking, train level in 3 shards) at 1.19 to 1.26 GB, and its
2026-10 fold gave sums identical to the first run. Counting runs per key beside the histograms
raised the peak to 1.98 GB RSS for the nine folds, just under the 2 GB cap.

Metrics per horizon, over every pair of the test months: mean absolute error (MAE) of the point
forecast in minutes, the share within 2 and within 5 minutes, and for B1 the calibration of the
80th percentile (share of actual delays at or under it; 80 % is calibrated).

Shipping rule, fixed before the run: the B1 variant with the lower MAE over all common test pairs
is chosen; it ships at a stops-ahead bin when its MAE is lower than B0's in every test month and the
95 % interval of the MAE difference B1 minus B0 (2,000 bootstrap draws of test days) lies below zero.
Elsewhere the card shows nothing new: B0 is what the feed's own propagated delays already show.

**Selection on the test folds.** The variant and the shipped horizons are picked from the same folds
whose numbers this page reports; there is no held-out month after the choice. The bias this adds is
negligible here: the choice is between two variants far apart (MAE 2.11 for `level` against 1.65
for `change` on the common folds 2026-08 to 2026-10), and every shipped horizon wins in each of
the nine months by 0.13 to 0.32 minutes with intervals a few hundredths wide. The settings were not
tuned on these folds: the horizon buckets came from the smoke run on 2025-12, outside the test
months, and the window, the minimum of 20 and the bands were fixed before the run (the minimum
counted pairs at first and counts runs since the review, a correction of what is counted, not a
value tuned on the results). A month held out from
both choices (for example 2026-11 once converted) would remove the bias entirely.

## Results (measured)

Run: `gerlines-predict backtest --window 3 --variants change` over test months 2026-02 to 2026-10,
9 folds, 1,042,050,455 pairs, 273 test days; 39 min on the M1 Pro at 1.98 GB peak RSS (with a
level answering from 20 runs). Every pair got a B1 value; 76.8 to 84.4 % of pairs per
month were answered by the train level, 15.6 to 22.7 % by the stop level, at most 0.6 % by the
category level. MAE over all pairs: zero 3.62, B0 1.87, B1 1.65 minutes.

The first run counted 20 stop pairs instead of 20 runs (one run gives a key up to 23 pairs at 8 or
more stops ahead, so a key could rest on one day). Counting runs moves pairs from the train to the
stop level (train level 87.1 to 91.2 % before) and costs 0.004 minutes of MAE overall (1.643
before, 1.647 now), at most 0.010 in one bin (3 stops ahead, 1.061 to 1.070); one stop ahead is
unchanged, as one run gives a key one pair there. Every bin still wins in every month and the
shipped horizons are the same, 1 to 30 stops ahead.

MAE per test month, B0 against B1 (minutes): 2026-02 1.813 and 1.585, 03 1.793 and 1.562, 04 1.763
and 1.537, 05 1.873 and 1.640, 06 2.073 and 1.839, 07 1.930 and 1.712, 08 1.866 and 1.655, 09 1.900
and 1.665, 10 1.834 and 1.633. B1 is lower in every month at every stops-ahead bin.

| stops ahead | pairs | MAE zero | MAE B0 | MAE B1 | within 2 zero | within 2 B0 | within 2 B1 | within 5 zero | within 5 B0 | within 5 B1 | B1 p80 cover |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 113,368,599 | 3.24 | 0.61 | 0.48 | 69.9 | 97.2 | 97.5 | 84.4 | 99.2 | 99.2 | 92.9 |
| 2 | 103,854,228 | 3.34 | 0.95 | 0.81 | 69.0 | 93.2 | 94.0 | 83.8 | 97.8 | 98.0 | 90.8 |
| 3 | 94,668,901 | 3.43 | 1.24 | 1.07 | 68.3 | 89.7 | 91.0 | 83.3 | 96.6 | 96.9 | 86.7 |
| 4 to 5 | 163,567,943 | 3.54 | 1.59 | 1.40 | 67.3 | 85.2 | 87.3 | 82.7 | 94.9 | 95.5 | 87.7 |
| 6 to 10 | 281,720,643 | 3.72 | 2.14 | 1.90 | 65.6 | 77.9 | 80.9 | 81.5 | 91.9 | 93.1 | 85.2 |
| 11 to 20 | 233,870,047 | 3.85 | 2.73 | 2.41 | 63.9 | 70.6 | 74.6 | 80.3 | 87.8 | 90.0 | 82.8 |
| 21 to 30 | 51,000,094 | 4.01 | 3.23 | 2.95 | 63.0 | 66.4 | 69.4 | 79.1 | 84.2 | 86.2 | 78.1 |

| minutes ahead | pairs | MAE zero | MAE B0 | MAE B1 | within 2 zero | within 2 B0 | within 2 B1 | within 5 zero | within 5 B0 | within 5 B1 | B1 p80 cover |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 to 15 | 395,859,792 | 2.87 | 0.79 | 0.65 | 71.1 | 95.2 | 95.9 | 85.8 | 98.8 | 98.9 | 90.6 |
| 16 to 30 | 271,192,100 | 3.26 | 1.61 | 1.41 | 67.7 | 82.9 | 85.9 | 83.5 | 95.2 | 95.9 | 86.1 |
| 31 to 60 | 258,595,002 | 3.87 | 2.47 | 2.21 | 63.8 | 71.3 | 75.2 | 80.1 | 89.3 | 91.1 | 82.9 |
| 61 to 120 | 99,752,773 | 5.63 | 4.14 | 3.74 | 55.0 | 57.2 | 61.1 | 71.9 | 78.2 | 81.7 | 79.5 |
| over 120 | 16,650,788 | 11.13 | 8.86 | 8.05 | 42.2 | 40.2 | 42.4 | 57.6 | 60.1 | 63.6 | 76.9 |

| current delay | pairs | MAE zero | MAE B0 | MAE B1 | within 2 zero | within 2 B0 | within 2 B1 | within 5 zero | within 5 B0 | within 5 B1 | B1 p80 cover |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| on time | 368,829,820 | 1.35 | 1.35 | 1.17 | 86.6 | 86.5 | 89.4 | 94.6 | 94.5 | 95.9 | 87.2 |
| 1 to 5 | 531,362,637 | 2.46 | 1.78 | 1.55 | 68.4 | 83.6 | 85.1 | 90.1 | 94.8 | 95.0 | 86.2 |
| 6 to 15 | 108,397,387 | 9.15 | 3.15 | 2.83 | 8.1 | 62.6 | 68.1 | 24.2 | 83.6 | 87.0 | 84.0 |
| over 15 | 33,460,611 | 29.06 | 4.87 | 4.57 | 1.1 | 55.8 | 57.5 | 1.9 | 75.1 | 77.1 | 82.8 |

| stops ahead | MAE B1 minus B0 | 95 % interval | days | B1 lower every month | ships |
| --- | --- | --- | --- | --- | --- |
| 1 | -0.130 | -0.131 to -0.128 | 273 | yes | yes |
| 2 | -0.140 | -0.142 to -0.137 | 273 | yes | yes |
| 3 | -0.170 | -0.172 to -0.168 | 273 | yes | yes |
| 4 to 5 | -0.189 | -0.193 to -0.185 | 273 | yes | yes |
| 6 to 10 | -0.240 | -0.246 to -0.233 | 273 | yes | yes |
| 11 to 20 | -0.323 | -0.331 to -0.313 | 273 | yes | yes |
| 21 to 30 | -0.281 | -0.288 to -0.273 | 273 | yes | yes |


The `level` variant (quantiles of the arrival delay itself, no current delay added), test months
2026-08 to 2026-10, the same 347,314,649 pairs, run with the first count of 20 pairs: MAE 2.11 against B0 1.87 and the change variant
1.65. It loses to B0 up to 10 stops ahead (1.37 against 0.62 one stop ahead) and wins only from
11 stops on (2.61 against 2.72), because a band of 6 to 15 minutes hides where in the band the
train is. The rule therefore picks `change`.

| stops ahead | MAE B0 | MAE B1 level | B1 level minus B0, 95 % interval |
| --- | --- | --- | --- |
| 1 | 0.62 | 1.37 | +0.726 to +0.774 |
| 2 | 0.96 | 1.57 | +0.582 to +0.623 |
| 3 | 1.25 | 1.72 | +0.446 to +0.482 |
| 4 to 5 | 1.60 | 1.94 | +0.326 to +0.356 |
| 6 to 10 | 2.15 | 2.28 | +0.114 to +0.140 |
| 11 to 20 | 2.72 | 2.61 | -0.130 to -0.096 |
| 21 to 30 | 3.19 | 3.02 | -0.195 to -0.157 |

**Decision.** B1 (change variant) ships at every horizon from 1 to 30 stops ahead: its MAE is lower
than B0's in each of the nine test months and the bootstrap intervals lie well below zero (0.13 to
0.32 minutes better). It is also closer within 2 and 5 minutes at every horizon. Its 80th
percentile covers 92.9 % of arrivals one stop ahead (too wide, because whole minutes tie many
values at the bound) and 78.1 to 90.8 % further out, so the upper bound reads as 8 in 10 under
it, a little fewer at 21 to 30 stops. B2 is not built here.

## Served table

`gerlines-predict table` builds the chosen variant from the latest three months (2026-08 to
2026-10) and writes gzipped JSON (format 2) to `data/predictions/` (git-ignored, like every data
artefact). Each level is four columns sorted by the packed key: `key` (category, train number, EVA
number minus 8,000,000, band and horizon bucket in one integer below 2^48, the packing in
`meta.key`), `runs`, `median` and `p80`; `meta` adds `minRuns`, the stops-ahead values that shipped,
the band and horizon edges, the training months and the source. A train or stop row is kept only
when it has at least 20 runs and its answer differs from what the next level would give, so the
API's lookup answers every key as the full table (tested). The level and run count the card reports
are those of the level that gives the answer: where a train row was pruned because the stop level
gives the same median and p80, the card says Trains of this kind here although this train alone has
20 or more runs with that answer. The forecast is the same either way; only the caption names the
coarser level. The API reads it from `PREDICTION_TABLE` (absolute path) at
start into typed arrays and finds keys by binary search; without it details carry
`forecast: null`.

Measured for `data/predictions/b1-2026-08-2026-10.json.gz` (format 2, sha256 `356d544cb4ce9338…`):
7,753,906 bytes, 42,460,038 bytes of JSON; 1,729,687 train rows (of 7,901,217 keys
before pruning; 2,339,851 when 20 pairs sufficed), 84,890 stop rows (of 129,664), 96 category rows;
built in 231 s at 1.68 GB RSS.

**Memory for the deploy sizing (measured, Node 24 on the M1 Pro).** Loading the table takes 0.48 s
and leaves 13 MB of JavaScript heap and 28 MB of typed arrays, but the process peaks at 529 MB RSS
while it parses the JSON and stays at about 415 MB RSS after a full garbage collection (a bare Node
process with zod is at 60 MB), as V8 and the allocator keep the pages of the parsed arrays. Size the
API host for about 470 MB more than the API needs without `PREDICTION_TABLE`, and keep the table
load at start, before traffic. The table is read once and not reloaded: a new table needs an API
restart. If the host is tight, a binary column file (keys as 64-bit floats, runs as 32-bit, the
quantiles as 16-bit integers, about 28 MB uncompressed) read straight into the typed arrays would
remove the parse peak; that is a format change of the writer, the reader and the fixture, left
for later because the numbers above fit a host with 1 GB or more.

Rebuild:

```sh
uv run gerlines-predict table --converted data/backfill/piebro --first 2026-08 --last 2026-10 \
  --report <backtest folder>/backtest.json --shards 3 --out data/predictions/b1-2026-08-2026-10.json.gz
```

Licence: derived from piebro/deutsche-bahn-data (CC BY 4.0), data from Deutsche Bahn; the table's
`meta.source.attribution` is "Deutsche Bahn train data, collected and processed by piebro, data from
Deutsche Bahn", and the card names the source in the reader's language (message
`predict_attribution_piebro`; another source shows the attribution the table carries) with the licence. The test fixture cut from the table (`apps/api/test/fixtures/b1-table-sample.json`, by
`pipelines/predict/scripts/cut_fixture.py`) and its snapshot carry the same licence in REUSE.toml.

## In the API and on the card

`TrainDetail.forecast` (additive, nullable): from the last passed stop (`progress.lastPassedIndex`)
and its delay (departure, else arrival, rounded down to whole minutes), for each later served stop
with a planned arrival and an EVA number (from the search index) at a shipped horizon: the stop
index, stops ahead, expected delay, upper delay (p80), the level and its run count. Null when the train
has passed no stop, has no delay there, has no numeric train number, a category the table does not
know (buses, urban), or when no stop qualifies. The card shows up to five of these stops with all
stops open and in the expanded phone sheet: the stop, the expected delay and the p80 as 8 in 10
under it, the level (this train, trains of this kind here, trains of this kind) and a provenance
line (forecast, not measured, the four delay ranges the runs are matched by, method, training
months, source and licence). Its strings load with the lazy card chunk (`@gerlines/i18n/predict`),
not with the entry.

**Anchored on the feed (D-065).** Where the train's realtime feed predicts the stop's
arrival (`predictedArrival` and `arrivalDelaySeconds` set, provenance `realtime`), the expected
delay is the feed's, rounded down to whole minutes, and the upper delay adds B1's spread for that
stop's key and horizon (p80 minus median of the same lookup, whose level and runs the stop keeps).
Each stop carries `basis`: `feed_plus_spread` there, `b1` where the feed has no prediction and
both values are B1's as above; a stop without `basis` predates the rule and is `b1`. The card then
titles the block Forecast with a range from history, captions such a stop Live forecast, spread of
this train (or of trains of this kind here, of trains of this kind), and its provenance line says
the typical value is the arrival delay the live data from the feed predicts and the bound adds the
spread of the runs in the same delay range; when the bases mix, it adds that at stops without a
live forecast both values come from those runs. A block of B1 stops only reads as before.

## Live shadow check

**Question.** On our own recorded realtime, does the card's B1 forecast beat the forecast the feed
itself sends at the same moment, and does its 80th percentile hold, before any calibration is
quoted? The backtest above could not answer this: piebro has no forecast history.

**Data.** A replay database (read only): realtime of 2026-11-06 23:00 UTC to
2026-11-07 13:29 UTC from `delfi-gtfs-rt` and `gtfsde-rt`, 1.47 million rows of
`stop_event_forecast` and the live finals of `stop_event`. 2026-11-07 is a Saturday; this is one
morning of one day.

**Method.** At 39 instants, every 15 minutes from 03:00 to 12:30 UTC (04:00 to 13:30 local),
`pipelines/predict/scripts/shadow_details.ts` builds each running train's detail as of the instant
with the live service's own code (`DetailRepository` in history mode and `buildAll`, the path of
`live detail render`) and runs the API's `forecastOf` on it with the served table
`b1-2026-08-2026-10.json.gz`, EVA numbers from `stop_place`. That is what the card would have
shown, with one difference: offline there is no engine tick, so progress comes from the predicted
times (`progressAt`). For every served stop up to 30 ahead of the last passed stop it keeps the
feed's predicted arrival delay at that instant (the chosen source, one source per train as on the
card) and B1's expected delay and p80. `gerlines-predict shadow` joins the live final arrival of
the same source and stop and scores a pair when that final is later than the instant. The three
forecasts:

- **B0**: the current delay at the last passed stop, rounded down to whole minutes;
- **B1**: the API's expected delay, B0 plus the median change;
- **feed**: the predicted arrival delay the source carried for that stop at the instant.

The final and the feed's forecast are rounded down to whole minutes like the current delay (the
table's convention); a variant in seconds is reported below. Intervals are 95 % percentile
intervals of 2,000 bootstrap draws of trip instances, since one run gives pairs at many instants
and stops. Run: 63,928 train states of 14,303 trip instances; 343,332 pairs with a live final after
the instant; B1 answers 85.7 to 92.9 % of them and the feed 99.9 %; **313,863 pairs of 12,184 trip
instances** have all three and are compared below. 64 s for the details (637 MB RSS), 7 s for the
scores (1.39 GB RSS).

### Results (measured)

| stops ahead | pairs | trips | MAE B0 | MAE B1 | MAE feed | within 2 B0 | within 2 B1 | within 2 feed | within 5 B0 | within 5 B1 | within 5 feed | B1 p80 cover |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 39,435 | 11,969 | 1.01 | 1.00 | 0.49 | 91.6 | 91.8 | 95.9 | 97.0 | 97.1 | 98.7 | 81.7 |
| 2 | 35,340 | 11,401 | 1.30 | 1.26 | 0.85 | 87.9 | 88.6 | 91.8 | 95.7 | 95.9 | 97.5 | 84.2 |
| 3 | 31,501 | 10,666 | 1.45 | 1.40 | 1.08 | 85.2 | 86.4 | 89.0 | 94.8 | 95.1 | 96.3 | 80.7 |
| 4 to 5 | 52,105 | 10,142 | 1.64 | 1.58 | 1.33 | 82.3 | 83.5 | 85.8 | 93.6 | 94.2 | 94.9 | 84.5 |
| 6 to 10 | 83,406 | 8,530 | 1.86 | 1.79 | 1.62 | 78.6 | 80.0 | 81.5 | 92.3 | 93.2 | 93.1 | 85.2 |
| 11 to 20 | 60,270 | 5,001 | 2.00 | 1.89 | 1.82 | 75.7 | 78.1 | 78.2 | 91.5 | 92.9 | 91.8 | 86.9 |
| 21 to 30 | 11,806 | 1,470 | 1.99 | 1.93 | 1.83 | 76.6 | 78.8 | 79.6 | 91.9 | 92.8 | 92.3 | 86.1 |

| stops ahead | B1 minus feed, 95 % | B1 minus B0, 95 % | p80 minus median | feed plus that spread, cover |
| --- | --- | --- | --- | --- |
| 1 | +0.51 (+0.47 to +0.56) | -0.01 (-0.02 to +0.01) | 0.53 | 88.6 |
| 2 | +0.41 (+0.37 to +0.46) | -0.03 (-0.05 to -0.01) | 1.10 | 86.3 |
| 3 | +0.32 (+0.29 to +0.36) | -0.05 (-0.07 to -0.03) | 1.03 | 81.8 |
| 4 to 5 | +0.25 (+0.22 to +0.28) | -0.06 (-0.08 to -0.03) | 1.74 | 83.8 |
| 6 to 10 | +0.17 (+0.13 to +0.21) | -0.07 (-0.10 to -0.04) | 2.13 | 82.1 |
| 11 to 20 | +0.07 (+0.02 to +0.12) | -0.11 (-0.14 to -0.07) | 2.50 | 82.0 |
| 21 to 30 | +0.10 (-0.02 to +0.21) | -0.06 (-0.12 to +0.00) | 2.25 | 81.7 |

| minutes ahead | pairs | MAE B0 | MAE B1 | MAE feed | B1 p80 cover |
| --- | --- | --- | --- | --- | --- |
| 0 to 15 | 122,500 | 1.14 | 1.12 | 0.74 | 82.7 |
| 16 to 30 | 76,001 | 1.47 | 1.41 | 1.23 | 85.1 |
| 31 to 60 | 76,943 | 1.96 | 1.87 | 1.74 | 85.7 |
| 61 to 120 | 33,524 | 2.75 | 2.65 | 2.51 | 85.8 |
| over 120 | 4,895 | 4.38 | 3.96 | 3.71 | 90.4 |

Minutes ahead count here from the instant to the planned arrival (the backtest counts from the
planned departure at the current stop). By category, stops ahead grouped (pairs, MAE B0, B1, feed,
B1 p80 cover):

| category | 1 | 2 to 3 | 4 to 10 | 11 to 30 |
| --- | --- | --- | --- | --- |
| hsr (121 trips) | 1,254: 3.20 3.20 1.18, 84.8 | 1,670: 4.47 4.20 2.78, 88.3 | 1,261: 6.91 6.19 6.16, 89.8 | 5 pairs |
| ld (46 trips) | 350: 1.87 1.63 0.65, 84.6 | 481: 2.80 2.68 1.59, 89.2 | 562: 3.73 4.58 2.64, 90.2 | 19 pairs |
| night (3 trips) | 38: 15.79 7.89 2.71, 92.1 | 69: 23.38 17.87 5.64, 98.6 | 51: 17.73 10.65 9.27, 100 | none |
| rfast | 11,271: 1.40 1.38 0.73, 78.7 | 18,377: 1.97 1.89 1.41, 79.9 | 34,027: 2.71 2.60 2.31, 84.1 | 11,239: 3.36 3.13 3.00, 88.9 |
| reg | 13,143: 0.87 0.89 0.45, 80.9 | 21,962: 1.20 1.18 0.89, 81.2 | 42,088: 1.73 1.68 1.53, 82.8 | 17,419: 2.44 2.38 2.34, 84.7 |
| sbahn | 13,379: 0.54 0.55 0.25, 84.7 | 24,282: 0.76 0.76 0.52, 85.3 | 57,522: 1.12 1.08 0.90, 86.8 | 43,394: 1.47 1.39 1.31, 87.1 |

By current delay (MAE B0, B1, feed; B1 p80 cover): on time 1.27, 1.26, 1.07, 85.3 %; 1 to 5 minutes
1.84, 1.74, 1.49, 83.8 %; 6 to 15 minutes 3.84, 3.55, 2.87, 79.5 %; over 15 minutes 6.18, 5.71,
4.35, 79.9 %. By source: DELFI (238,154 pairs) 1.47, 1.40, 1.19; gtfs.de (75,709) 2.18, 2.16, 1.81.
The feed wins where its prediction for the stop is explicit (1.65, 1.54, 1.16) and narrowly where it
is propagated from an earlier stop (1.64, 1.61, 1.45). Every model is early on average (mean error
B1 -0.38 to -0.63 minutes, the feed -0.23 at 1 stop ahead to -1.46 at 11 to 20).

**Sensitivity.** In seconds (the final and the feed in seconds, B0 and B1 as shown) the order is the
same at every horizon (MAE B1 1.04 against the feed 0.49 at 1 stop ahead, 2.01 against 1.86 at 21 to
30); the B1 p80 cover drops to 76.0, 80.4, 76.8, 81.2, 82.3, 83.8 and 80.3 % because a final a few
seconds into the minute above the bound now counts as over it, and the feed-anchored bound covers
86.4 to 78.7 %. Scored against the other source's live final for the same stop (161,021 pairs where
both sources reported), the feed still wins at every horizon (0.47 against B1 0.89 at 1 stop ahead,
1.50 against 1.68 at 21 to 30) and the B1 p80 cover is 81.0 to 87.6 %.

**Train number and category mapping.** Of 14,303 live trip instances, 76 have a category the table
does not hold (`other`) and none in a table category lacks a numeric train number. Of the other
14,227, **81.2 % have train-level rows** under their category and number (hsr 96.2 %, rfast 87.7 %,
sbahn 81.3 %, reg 77.4 %, ld 60.0 % of 60; DELFI 81.6 %, gtfs.de 80.3 %). The 2,679 without rows,
checked against the converted piebro trips of 2026-08 to 2026-10: 886 (6.2 %) ran on fewer than 20
days there (median 13 days: weekend trains, as the run minimum of 20 in three months excludes a train
that runs only on Saturdays); 1,134 (8.0 %) ran on 20 or more days but every key was under 20 runs or
pruned to the coarser level; 659 (4.6 %) never ran under that category and number, 339 of them
under no category at all and 320 under another one. For those 320, the same number stopped at one
of the same stations in piebro's October under another category for 142 trips (1.0 % of all):
live sbahn against piebro reg 66, rfast against reg 37, reg against rfast 19, rfast against sbahn
8, ld against rfast 7, sbahn against rfast 5. Those lose their train level to the stop level of
the wrong category. The mapping itself is therefore sound; the train level misses mostly on the
run minimum and on pruning. Of the answered pairs, the card names the train level for 45.4 %, the
stop level for 30.1 % and the category level for 24.5 % (pruned rows answer as the level they
equal, see Served table).

### Verdict

- **B1 is worse than the feed's own forecast at every horizon from 1 to 20 stops ahead**, by 0.51
  minutes at 1 stop ahead (0.49 against 1.00, interval +0.47 to +0.56), shrinking to 0.07 at 11 to 20
  (+0.02 to +0.12). At 21 to 30 the difference (+0.10) is not distinguishable from zero (-0.02 to
  +0.21). It loses in every category at 1 to 3 stops ahead; it comes within 0.1 minutes only for
  regional trains and S-Bahn from 11 stops on and for hsr at 4 to 10 (6.19 against 6.16). The feed is also closer within 2 minutes everywhere and within
  5 minutes up to 5 stops ahead; B1 is closer within 5 minutes from 6 stops on (93.2 against 93.1,
  92.9 against 91.8, 92.8 against 92.3 %).
- **B1 beats B0 on live data, but by less than in the backtest**: 0.03 to 0.11 minutes at 2 to 20
  stops (intervals below zero), not at 1 stop (-0.01, interval through zero) and borderline at 21 to
  30, against 0.13 to 0.32 on piebro.
- **The p80 holds well enough to say 8 in 10 on the card, not to quote a calibration.** In whole
  minutes, the unit the card shows, 80.7 to 86.9 % of finals are at or under it (backtest 78.1 to
  92.9 %), so the bound is right to a little wide from 4 stops on; in seconds it is 76.0 to 83.8 %.
  hsr and ld sit at about 85 to 90 % on 121 and 46 trips; night trains (3 trips) say nothing. The concern
  that piebro's planned-time fill flatters the cover holds up to 5 stops ahead
  (live 81.7 against 92.9 % at one stop, 84.5 against 87.7 % at 4 to 5), is even at 6 to 10 (85.2
  both) and reverses from 11 stops on (86.9 and 86.1 against 82.8 and 78.1 %).

### Rerun with the card rule (measured)

The same 39 instants, finals and table, with the driver writing B1 from the forecaster run on the
detail without the feed's predictions ahead and the card from the forecaster as served. B1's values
equal the first run's (MAE B1 identical to three decimals in every bin), and the pairs are the same
(343,332 scored, 313,863 common). The card anchors on the feed for 99.89 to 99.97 % of the pairs it
answers; on the common pairs its expected delay is the feed's at every horizon (MAE difference card
minus feed 0.000 in every bin).

| stops ahead | pairs | MAE card | MAE feed | MAE B1 | card minus B1, 95 % | card bound cover | B1 p80 cover | bound minus expected |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 39,435 | 0.49 | 0.49 | 1.00 | -0.51 (-0.56 to -0.47) | 88.6 | 81.7 | 0.53 |
| 2 | 35,340 | 0.85 | 0.85 | 1.26 | -0.41 (-0.46 to -0.37) | 86.3 | 84.2 | 1.10 |
| 3 | 31,501 | 1.08 | 1.08 | 1.40 | -0.32 (-0.36 to -0.29) | 81.8 | 80.7 | 1.03 |
| 4 to 5 | 52,105 | 1.33 | 1.33 | 1.58 | -0.25 (-0.29 to -0.22) | 83.8 | 84.5 | 1.74 |
| 6 to 10 | 83,406 | 1.62 | 1.62 | 1.79 | -0.17 (-0.21 to -0.14) | 82.1 | 85.2 | 2.13 |
| 11 to 20 | 60,270 | 1.82 | 1.82 | 1.89 | -0.07 (-0.12 to -0.02) | 82.0 | 86.9 | 2.50 |
| 21 to 30 | 11,806 | 1.83 | 1.83 | 1.93 | -0.10 (-0.21 to +0.02) | 81.7 | 86.1 | 2.25 |

On every pair the card answers (feed or not, 39,460 at 1 stop to 11,810 at 21 to 30) the MAE is
0.49, 0.85, 1.08, 1.33, 1.62, 1.83 and 1.83 and the bound covers 88.5, 86.3, 81.8, 83.8, 82.1, 82.0
and 81.7 %. The stops without a feed prediction are 4 to 79 pairs per bin, too few to judge (MAE 1.1
to 6.5, cover 59 to 85 %). By minutes ahead the bound covers 86.3 % (0 to 15), 83.3 (16 to 30),
81.2 (31 to 60), 80.1 (61 to 120) and 82.6 % (over 120). In seconds (the final in seconds, the card
in whole minutes as shown) it covers 74.0 to 81.9 %; against the other source's finals 82.1 to
89.0 %, with the card's MAE equal to the feed's there too.

### Proposal for the card (built, D-065)

- Where the feed has a prediction for the stop (99.9 % of pairs here), the forecast
  block should not offer B1's expected delay as the forecast, because at every horizon the feed's
  own predicted delay, which the stop list already shows, is as close or closer. Keep the block as
  a range from history anchored on the feed: expected = the feed's predicted delay in whole minutes,
  8 in 10 under = that plus B1's spread (p80 minus median). Measured here, that bound covers 88.6 %
  at 1 stop ahead, 86.3 % at 2 and 81.7 to 83.8 % from 3 to 30 (78.7 to 86.4 % in seconds, 82.1 to
  89.0 % against the other source's finals). It is as tight as B1's own bound (the same spread),
  wider than needed at 1 and 2 stops (88.6 and 86.3 against 81.7 and 84.2 %) and closer to 80 %
  than B1's own bound from 4 stops on. Where the feed has no prediction for a stop, keep B1 as it is. Copy and
  method note would change from current delay plus history to the feed's forecast plus history.
- Repeat the check on weekdays and a full day once the recorder has them in a replay
  database, and on the FV trains, which are few here (121 hsr and 46 ld trips); count the run
  minimum per weekday type before deciding whether weekend trains should get a train level.

### Not verified

- One Saturday morning (04:00 to 13:30 local) of one replay; late-day and weekday patterns, works
  and disruption days are not in it.
- The live final is frozen when the predicted time passes, so the truth is the feed's own
  last prediction for that stop: at one stop ahead the feed is in part scored against itself. The
  check against the other source's final reduces this but does not remove it, as both feeds carry
  DB's prognosis. Against piebro's finals of 2026-10-27 live finals read 15 to 49 seconds earlier.
- Progress offline comes from predicted times, not the engine's tick; the live card's last passed
  stop can differ by one stop around departures.

## Limits

- **No comparison with DB's own forecast in the backtest.** piebro keeps final values only (no
  forecast history), so B0 there is persistence, not the prognosis the feed sends. The live shadow
  check above makes that comparison on one recorded morning: the feed's forecast is closer than B1
  at every horizon from 1 to 20 stops ahead. The card keeps showing the feed's predicted times; the
  forecast block is an additional, historical view.
- **An unchanged stop looks on time** in piebro (a missing change time is filled with the planned
  time), which pulls targets and current delays towards 0 for stops without realtime.
- **Whole minutes.** IRIS minutes; the live feed gives seconds, rounded down to match.
- **DB stations only.** Stops abroad have no EVA row and no forecast.
- **Timetable changes.** A train number that changed at the timetable change (2025-12-14) or later
  falls back to the stop and category levels until the table is rebuilt.
- **Seasonality.** Tables come from three months; a month with construction works the window did not
  see is forecast from the old pattern.
