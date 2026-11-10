"""piebro's final arrival against our realtime final per stop, by the snapshot behind it.

piebro reads IRIS `fchg` a few times a day and keeps the latest snapshot per stop id, so a final
is either taken after the train arrived, a forecast from a snapshot before it, or the planned time
when no snapshot carried a change. The raw snapshots (`raw_data/year=/month=/day=/*.parquet` of the
dataset) say which. Usage:

    uv run python pipelines/backfill/scripts/final_vs_live.py --raw <folder of raw snapshot files> \
        --converted data/backfill/piebro/2026-10 --day 2026-10-27 --live <export csv> --out <json>

The live CSV is the export query in docs/history.md (live finals only). Stops are matched on train
number, EVA number and scheduled arrival; equal means the same whole minute (IRIS truncates).
"""

import argparse
import json
import re
import sys
from pathlib import Path

import polars as pl
import polars.selectors as cs

from gerlines_backfill.comparison import FERNVERKEHR_PRODUCTS, final_origin
from gerlines_backfill.summary import PUNCTUAL_S

STOP = re.compile(r'<s id="([^"]+)"[^>]*>(.*?)</s>', re.DOTALL)
ARRIVAL = re.compile(r"<ar\b([^>]*)")
CHANGED = re.compile(r'\bct="(\d{10})"')


def snapshot_rows(raw: Path) -> tuple[pl.DataFrame, list[dict[str, str]]]:
    rows: list[tuple[str, object, str | None]] = []
    snapshots = []
    for path in sorted(raw.glob("*.parquet")):
        frame = pl.read_parquet(path, columns=["timestamp", "url", "response_data"]).filter(
            pl.col("url").str.contains("/fchg/")
        )
        snapshots.append(
            {
                "file": path.name,
                "from_utc": str(frame["timestamp"].min()),
                "to_utc": str(frame["timestamp"].max()),
            }
        )
        for taken, xml in frame.select("timestamp", "response_data").iter_rows():
            for stop_id, body in STOP.findall(xml or ""):
                arrival = ARRIVAL.search(body)
                changed = CHANGED.search(arrival.group(1)) if arrival else None
                rows.append((stop_id, taken, changed.group(1) if changed else None))
    frame = pl.DataFrame(
        rows,
        schema={"piebro_id": pl.String, "taken": pl.Datetime("us"), "ct": pl.String},
        orient="row",
    ).with_columns(pl.col("taken").dt.replace_time_zone("UTC"))
    return frame, snapshots


def matched_stops(
    converted: Path, day: str, live_csv: Path, snapshots: pl.DataFrame
) -> pl.DataFrame:
    trips = pl.read_parquet(converted / "trips" / f"{day}.parquet").select(
        "trip_key", "train_number", "train_type", "category_code"
    )
    ours = (
        pl.read_parquet(converted / "stops" / f"{day}.parquet")
        .join(trips, on="trip_key")
        .filter(
            (pl.col("stop_index") > 0)
            & pl.col("scheduled_arrival").is_not_null()
            & pl.col("final_arrival").is_not_null()
            & ~pl.col("cancelled")
        )
        .select(
            (
                pl.col("trip_key") + "-" + (pl.col("stop_index").cast(pl.Int32) + 1).cast(pl.String)
            ).alias("piebro_id"),
            "train_number",
            "train_type",
            "category_code",
            "eva",
            pl.col("scheduled_arrival").alias("sa"),
            pl.col("final_arrival").alias("piebro_final"),
        )
    )
    utc = lambda name: pl.col(name).str.to_datetime("%Y-%m-%dT%H:%M:%SZ", time_zone="UTC")  # noqa: E731
    live = (
        pl.read_csv(live_csv, schema_overrides={"train_number": pl.String, "eva": pl.Int32})
        .filter(
            (pl.col("final_quality") == "live")
            & ~pl.col("cancelled").cast(pl.String).is_in(["t", "true"])
            & pl.col("fa").is_not_null()
            & pl.col("sa").is_not_null()
        )
        .with_columns(utc("sa"), utc("fa"))
        .unique(["train_number", "eva", "sa"], keep="first")
        .select("train_number", "eva", "sa", pl.col("fa").alias("live_final"), "source_id")
    )
    last_change = (
        snapshots.filter(pl.col("ct").is_not_null())
        .sort("taken")
        .group_by("piebro_id")
        .agg(pl.col("taken").last().alias("change_taken"))
    )
    seconds = lambda name: (pl.col(name) - pl.col("sa")).dt.total_seconds()  # noqa: E731
    return (
        ours.join(live, on=["train_number", "eva", "sa"])
        .join(last_change, on="piebro_id", how="left")
        .with_columns(
            seconds("piebro_final").alias("piebro_s"),
            seconds("live_final").alias("live_s"),
            final_origin(),
        )
        .with_columns(
            (pl.col("piebro_s") - (pl.col("live_s") / 60).floor() * 60).alias("minute_difference_s")
        )
    )


def figures(frame: pl.DataFrame, *keys: str | pl.Expr) -> list[dict[str, object]]:
    grouped = frame.group_by(*keys) if keys else frame.group_by(pl.lit("all").alias("scope"))
    return (
        grouped.agg(
            pl.len().alias("arrivals"),
            (pl.col("piebro_s") - pl.col("live_s")).mean().round(1).alias("bias_s"),
            (pl.col("minute_difference_s") == 0).mean().round(4).alias("equal"),
            (pl.col("minute_difference_s") > 0).mean().round(4).alias("piebro_later"),
            (pl.col("minute_difference_s") < 0).mean().round(4).alias("piebro_earlier"),
            (pl.col("piebro_s") < PUNCTUAL_S).mean().round(4).alias("punctual_piebro"),
            (pl.col("live_s") < PUNCTUAL_S).mean().round(4).alias("punctual_live"),
        )
        .sort(cs.by_dtype(pl.String, pl.Boolean))
        .to_dicts()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--converted", type=Path, required=True)
    parser.add_argument("--day", required=True)
    parser.add_argument("--live", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    snapshots, files = snapshot_rows(args.raw)
    matched = matched_stops(args.converted, args.day, args.live, snapshots)
    fernverkehr = pl.col("train_type").is_in(FERNVERKEHR_PRODUCTS).alias("fernverkehr")
    result = {
        "day": args.day,
        "snapshots": files,
        "all": figures(matched),
        "by_origin": figures(matched, "origin"),
        "by_source": figures(matched, "source_id", fernverkehr),
        "taken_after_arrival_by_source": figures(
            matched.filter(pl.col("origin") == "taken_after_arrival"), "source_id", fernverkehr
        ),
    }
    args.out.write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
