"""Stop pairs of one service day: the delay known at a stop and the arrival delay at a later stop.

A pair stands for the moment a train leaves stop ``i`` with its delay known there (the departure
delay, else the arrival delay) and asks for its arrival delay at a stop ``j`` after it. Cancelled
stops are left out of the run before stops are counted, so ``ahead`` is the number of served stops
from ``i`` to ``j``. Delays are whole minutes (IRIS), rounded down from seconds. Stops whose EVA
number lies outside 8,000,000 to 8,131,071 (every piebro station lies inside) are left out, so keys
pack.
"""

import polars as pl

from gerlines_predict.quantiles import CATEGORY, RAIL_CATEGORIES, packable

MAX_AHEAD = 30

BANDS = ("on_time", "1_5", "6_15", "over_15")
HORIZONS = ("1", "2_3", "4_7", "8_plus")

PAIR_SCHEMA = {
    "service_date": pl.Date,
    "run": pl.UInt32,
    "category": CATEGORY,
    "train_number": pl.UInt32,
    "eva": pl.Int32,
    "ahead": pl.UInt8,
    "minutes_ahead": pl.Int32,
    "current_min": pl.Int32,
    "target_min": pl.Int32,
    "band": pl.UInt8,
    "horizon": pl.UInt8,
}


def band_of(minutes: pl.Expr) -> pl.Expr:
    """The current delay band: on time (at most 0), 1 to 5, 6 to 15, over 15 minutes."""
    return (
        pl.when(minutes <= 0)
        .then(0)
        .when(minutes <= 5)
        .then(1)
        .when(minutes <= 15)
        .then(2)
        .otherwise(3)
        .cast(pl.UInt8)
    )


def horizon_of(ahead: pl.Expr) -> pl.Expr:
    """The horizon bucket of a pair by served stops ahead: 1, 2 to 3, 4 to 7, 8 or more."""
    return (
        pl.when(ahead <= 1)
        .then(0)
        .when(ahead <= 3)
        .then(1)
        .when(ahead <= 7)
        .then(2)
        .otherwise(3)
        .cast(pl.UInt8)
    )


def whole_minutes(seconds: pl.Expr) -> pl.Expr:
    return seconds.floordiv(60).cast(pl.Int32)


def served_stops(stops: pl.LazyFrame, trips: pl.LazyFrame) -> pl.LazyFrame:
    """The served stops of the rail runs of a day, numbered from 0 in each run."""
    runs = (
        trips.filter(pl.col("category_code").is_in(RAIL_CATEGORIES))
        .filter(pl.col("train_number").str.contains(r"^\d{1,9}$"))
        .select(
            "trip_key",
            pl.col("category_code").cast(CATEGORY).alias("category"),
            pl.col("train_number").cast(pl.UInt32),
        )
        .unique("trip_key", keep="first")
    )
    return (
        stops.filter(~pl.col("cancelled"))
        .join(runs, on="trip_key", how="inner")
        .filter(packable())
        .sort("trip_key", "stop_index")
        .with_columns(
            run=pl.col("trip_key").rank("dense").cast(pl.UInt32),
            position=pl.int_range(pl.len()).over("trip_key").cast(pl.Int32),
            current_min=whole_minutes(pl.coalesce("departure_delay_s", "arrival_delay_s")),
            arrival_min=whole_minutes(pl.col("arrival_delay_s")),
        )
        .select(
            "service_date",
            "run",
            "position",
            "category",
            "train_number",
            "eva",
            "scheduled_arrival",
            "scheduled_departure",
            "current_min",
            "arrival_min",
        )
    )


def stop_pairs(served: pl.DataFrame, max_ahead: int = MAX_AHEAD) -> pl.DataFrame:
    """Every pair of a stop with a known delay and a departure and a later stop with an arrival
    delay."""
    origins = served.filter(
        pl.col("current_min").is_not_null() & pl.col("scheduled_departure").is_not_null()
    ).select(
        "service_date",
        "run",
        "position",
        "category",
        "train_number",
        "scheduled_departure",
        "current_min",
    )
    targets = served.filter(pl.col("arrival_min").is_not_null()).select(
        "run",
        "position",
        "eva",
        "scheduled_arrival",
        pl.col("arrival_min").alias("target_min"),
    )
    parts = []
    for ahead in range(1, max_ahead + 1):
        part = origins.with_columns(target_position=pl.col("position") + ahead).join(
            targets,
            left_on=["run", "target_position"],
            right_on=["run", "position"],
            how="inner",
        )
        parts.append(
            part.select(
                "service_date",
                "run",
                "category",
                "train_number",
                "eva",
                pl.lit(ahead, dtype=pl.UInt8).alias("ahead"),
                (
                    (pl.col("scheduled_arrival") - pl.col("scheduled_departure"))
                    .dt.total_minutes()
                    .cast(pl.Int32)
                    .alias("minutes_ahead")
                ),
                "current_min",
                "target_min",
                band_of(pl.col("current_min")).alias("band"),
                horizon_of(pl.lit(ahead)).alias("horizon"),
            )
        )
    if not parts:
        return pl.DataFrame(schema=PAIR_SCHEMA)
    return pl.concat(parts).cast(PAIR_SCHEMA)  # type: ignore[arg-type]
