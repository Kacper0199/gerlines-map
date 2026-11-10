# gerlines-predict

B0 and B1 delay predictions for the train card (WP-7.5): the B1 quantile builder, its backtest
against B0 and a zero baseline on the converted piebro months (docs/history.md), and the table the
API serves. Definitions, the backtest table and the shipping decision: [docs/predictions.md](../../docs/predictions.md).

## Commands

```sh
uv run gerlines-predict backtest --converted data/backfill/piebro --first 2025-11 --last 2026-10 \
  --window 3 --variants change --shards 3 --test 2026-02 2026-03 2026-04 2026-05 2026-06 2026-07 \
  2026-08 2026-09 2026-10 --out <folder>
uv run gerlines-predict table --converted data/backfill/piebro --first 2026-08 --last 2026-10 \
  --report <folder>/backtest.json --shards 3 --out data/predictions/b1-2026-08-2026-10.json.gz
```

`backtest` writes `metrics.parquet` (sums per test day, stops ahead, minutes bin and band),
`backtest.json` and `backtest.md` to the folder and prints the tables. Nothing intermediate is
written: each fold reads its training months again, day by day. `table` builds the variant the
report chose, keeps the stops-ahead values that shipped and writes gzipped JSON.

### Live shadow check

```sh
node pipelines/predict/scripts/shadow_details.ts --table <b1 table> --out <details.jsonl.gz> \
  --at 2026-11-07T08:00:00Z --at ...
uv run gerlines-predict shadow --details <details.jsonl.gz> --finals <finals.csv.gz> \
  --table <b1 table> --converted data/backfill/piebro --months 2026-08 2026-09 2026-10 \
  --out <shadow.json>
```

`shadow_details.ts` reads `DATABASE_URL` (a replay database, read only), builds each running
train's detail as of every instant in history mode with `services/live` and runs the API's
`forecastOf` on it; it writes the train's state and, per served stop ahead, the feed's predicted
arrival delay, the B1 values (the forecaster on the detail without the feed's predictions ahead)
and the card's values with their basis (the forecaster as served, D-065). The finals file is a CSV export of `stop_event` (columns
`trip_instance_id, stop_index, source_id, scheduled_arrival, final_arrival, final_quality,
cancelled`). `shadow` scores B0, B1, the feed and the card against the live finals and writes one JSON
report (the card under `card`); method and results in docs/predictions.md.

## Memory

Run with `POLARS_MAX_THREADS=3`. Keys and values share one 64-bit cell, so a three-month window
fits; `--shards 3` builds the train level in three passes over the days (train numbers by residue)
and keeps a backtest fold of one variant under 2 GB RSS on the converted months of 2025-11 to
2026-10.
