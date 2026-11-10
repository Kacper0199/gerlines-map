"""Compare backfilled stops of one day with realtime stop events recorded by our own ingest.

Usage: ``uv run python pipelines/backfill/scripts/spot_check.py <converted month folder> <day>
<realtime csv> <out json> [trains per category]``. The CSV holds ``stop_event`` rows of that day
with train number, category, EVA and scheduled and final times in UTC (export query in
docs/history.md). Stops are matched on train number, EVA number and scheduled arrival or
departure, live finals only (a carried final is a frozen prediction); the sample takes the trains
with most matched stops per category, ties by number.
"""

import json
import sys
from pathlib import Path

import polars as pl

CATEGORIES = ("hsr", "ld", "rfast", "reg", "sbahn")
TOLERANCE_S = 60


def _utc(name: str) -> pl.Expr:
    return pl.col(name).str.to_datetime("%Y-%m-%dT%H:%M:%SZ", time_zone="UTC")


def main(folder: Path, day: str, realtime_csv: Path, out: Path, per_category: int) -> None:
    trips = pl.read_parquet(folder / "trips" / f"{day}.parquet").select(
        "trip_key", "train_number", "category_code"
    )
    ours = pl.read_parquet(folder / "stops" / f"{day}.parquet").join(trips, on="trip_key")
    live = (
        pl.read_csv(realtime_csv, schema_overrides={"train_number": pl.String, "eva": pl.Int32})
        .filter(
            ~pl.col("cancelled").cast(pl.String).is_in(["t", "true"])
            & (pl.col("final_quality") == "live")
        )
        .with_columns(_utc("sa"), _utc("fa"), _utc("sd"), _utc("fd"))
    )
    events = []
    for kind, scheduled, final, live_scheduled, live_final in (
        ("arrival", "scheduled_arrival", "final_arrival", "sa", "fa"),
        ("departure", "scheduled_departure", "final_departure", "sd", "fd"),
    ):
        mine = ours.filter(pl.col(final).is_not_null()).select(
            "train_number",
            "category_code",
            "eva",
            pl.col(scheduled).alias("scheduled"),
            pl.col(final).alias("ours"),
        )
        theirs = (
            live.filter(pl.col(live_final).is_not_null())
            .select(
                "train_number",
                "eva",
                pl.col(live_scheduled).alias("scheduled"),
                pl.col(live_final).alias("live"),
                "source_id",
            )
            .unique(["train_number", "eva", "scheduled"], keep="first")
        )
        events.append(
            mine.join(theirs, on=["train_number", "eva", "scheduled"]).with_columns(
                pl.lit(kind).alias("event")
            )
        )
    matched = pl.concat(events).with_columns(
        (pl.col("ours") - pl.col("live")).dt.total_seconds().alias("difference_s")
    )
    ranked = (
        matched.group_by("category_code", "train_number")
        .agg(
            pl.len().alias("events"),
            (pl.col("difference_s").abs() <= TOLERANCE_S).mean().alias("within_60s"),
            pl.col("difference_s").abs().max().alias("max_abs_s"),
            pl.col("difference_s").median().alias("median_s"),
            (pl.col("live") == pl.col("scheduled")).mean().alias("live_on_schedule"),
            (pl.col("ours") == pl.col("scheduled")).mean().alias("ours_on_schedule"),
            pl.col("source_id").first(),
        )
        .sort(["category_code", "events", "train_number"], descending=[False, True, False])
    )
    sample = pl.concat(
        [ranked.filter(pl.col("category_code") == c).head(per_category) for c in CATEGORIES]
    )
    report = {
        "day": day,
        "matched_events": matched.height,
        "within_60s": float((matched["difference_s"].abs() <= TOLERANCE_S).mean()),
        "identical": float((matched["difference_s"] == 0).mean()),
        "median_abs_s": float(matched["difference_s"].abs().median()),
        "p95_abs_s": float(matched["difference_s"].abs().quantile(0.95)),
        "live_on_schedule": float((matched["live"] == matched["scheduled"]).mean()),
        "ours_on_schedule": float((matched["ours"] == matched["scheduled"]).mean()),
        "trains": sample.to_dicts(),
    }
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "trains"}))


if __name__ == "__main__":
    main(
        Path(sys.argv[1]),
        sys.argv[2],
        Path(sys.argv[3]),
        Path(sys.argv[4]),
        int(sys.argv[5]) if len(sys.argv) > 5 else 5,
    )
