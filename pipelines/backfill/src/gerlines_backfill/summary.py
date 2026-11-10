"""Monthly figures of converted rows by the rollups' rule (pipelines/rollups/README.md).

The stop delay is the arrival delay where a scheduled arrival exists, else the departure delay;
earlier than 30 minutes ahead is no data; cancelled stops are never observed. Punctuality is DB's
operational one: observed arrivals (stop index above 0) less than 6 minutes late (5:59).
"""

import polars as pl

FERNVERKEHR_TYPES = frozenset({"ICE", "IC", "EC", "ECE", "RJ", "RJX", "TGV"})
NAHVERKEHR_CATEGORIES = ("rfast", "reg", "sbahn")
EARLIEST_S = -1800
PUNCTUAL_S = 360
SECOND_LIMIT_S = 960


def _delay(final: str, scheduled: str) -> pl.Expr:
    seconds = (pl.col(final) - pl.col(scheduled)).dt.total_seconds()
    return pl.when(seconds >= EARLIEST_S).then(seconds)


def stop_delay() -> pl.Expr:
    return (
        pl.when(pl.col("cancelled"))
        .then(None)
        .when(pl.col("scheduled_arrival").is_not_null())
        .then(_delay("final_arrival", "scheduled_arrival"))
        .otherwise(_delay("final_departure", "scheduled_departure"))
        .cast(pl.Int32)
        .alias("stop_delay_s")
    )


def punctuality(stops: pl.DataFrame, by: str) -> dict[str, dict[str, int]]:
    observed = stops.with_columns(stop_delay()).filter(
        (pl.col("stop_index") > 0) & pl.col("stop_delay_s").is_not_null()
    )
    counts = (
        observed.group_by(by)
        .agg(
            pl.len().alias("arrivals"),
            (pl.col("stop_delay_s") < PUNCTUAL_S).sum().alias("lt_6min"),
            (pl.col("stop_delay_s") < SECOND_LIMIT_S).sum().alias("lt_16min"),
        )
        .sort(by)
    )
    return {
        str(row[by]): {
            "arrivals": int(row["arrivals"]),
            "lt_6min": int(row["lt_6min"]),
            "lt_16min": int(row["lt_16min"]),
        }
        for row in counts.iter_rows(named=True)
    }


def comparison_group() -> pl.Expr:
    """DB's published groups: Fernverkehr by IRIS product, Nahverkehr all regional rail."""
    return (
        pl.when(pl.col("train_type").is_in(list(FERNVERKEHR_TYPES)))
        .then(pl.lit("fernverkehr"))
        .when(pl.col("category_code").is_in(NAHVERKEHR_CATEGORIES))
        .then(pl.lit("nahverkehr"))
        .otherwise(pl.lit("other"))
        .alias("group")
    )
