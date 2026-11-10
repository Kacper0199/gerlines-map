from datetime import UTC, date, datetime, timedelta

import polars as pl

from gerlines_backfill.summary import FERNVERKEHR_TYPES, punctuality, stop_delay

T0 = datetime(2025, 11, 12, 8, tzinfo=UTC)


def stop(index: int, arrival_delay: int | None, *, cancelled: bool = False, **extra) -> dict:
    scheduled = T0 + timedelta(minutes=10 * index)
    return {
        "stop_index": index,
        "cancelled": cancelled,
        "scheduled_arrival": scheduled if index > 0 else None,
        "final_arrival": None
        if arrival_delay is None or cancelled
        else scheduled + timedelta(seconds=arrival_delay),
        "scheduled_departure": scheduled,
        "final_departure": None if cancelled else scheduled + timedelta(seconds=30),
        **extra,
    }


def frame(rows: list[dict]) -> pl.DataFrame:
    return pl.DataFrame(rows).with_columns(
        pl.col("^(scheduled|final)_.*$").cast(pl.Datetime("us", "UTC"))
    )


def test_stop_delay_follows_the_rollup_rule() -> None:
    rows = frame(
        [
            stop(0, None),
            stop(1, 359),
            stop(2, 360),
            stop(3, -1801),
            stop(4, 100, cancelled=True),
            stop(5, None),
        ]
    )
    assert rows.select(stop_delay()).to_series().to_list() == [30, 359, 360, None, None, None]


def test_punctuality_counts_arrivals_only_and_leaves_out_cancellations() -> None:
    rows = frame(
        [stop(0, None), stop(1, 0), stop(2, 359), stop(3, 360), stop(4, 960)]
    ).with_columns(pl.lit("ld").alias("category_code"), pl.lit("IC").alias("train_type"))
    rows = pl.concat(
        [
            rows,
            frame([stop(1, 0, cancelled=True)]).with_columns(
                pl.lit("ld").alias("category_code"), pl.lit("IC").alias("train_type")
            ),
        ]
    )
    result = punctuality(rows, by="category_code")
    assert result == {"ld": {"arrivals": 4, "lt_6min": 2, "lt_16min": 3}}


def test_fernverkehr_types_match_the_iris_operator_80_set() -> None:
    assert frozenset({"ICE", "IC", "EC", "ECE", "RJ", "RJX", "TGV"}) == FERNVERKEHR_TYPES


def test_service_date_is_unused_by_the_rule() -> None:
    rows = frame([stop(1, 0)]).with_columns(
        pl.lit(date(2025, 11, 12)).alias("service_date"),
        pl.lit("reg").alias("category_code"),
    )
    assert punctuality(rows, by="category_code") == {
        "reg": {"arrivals": 1, "lt_6min": 1, "lt_16min": 1}
    }
