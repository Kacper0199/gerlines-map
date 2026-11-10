"""Backfilled punctuality on the population of DB's published figures (G7, docs/history.md).

DB counts the share of punctual arrivals at all intermediate and final stops of DB passenger trains
(deutschebahn.com, Pünktlichkeitswerte) and takes wholly or partly cancelled trains out of the
population (DB AG in Bundestag Drucksache 19/1999, answer 3). Fernverkehr here is ICE, IC and EC
whose train number IRIS gives only DB Fernverkehr (operator code 80) in Bahn-Vorhersage;
Nahverkehr the regional rail runs whose number the DELFI feed gives only to DB Regio companies.
Both at stations inside Germany.
"""

from collections.abc import Iterable

import polars as pl

from gerlines_backfill.summary import NAHVERKEHR_CATEGORIES

FERNVERKEHR_PRODUCTS = ("ICE", "IC", "EC")
LONG_DISTANCE_PRODUCTS = ("ICE", "IC", "EC", "ECE", "RJ", "RJX", "TGV", "NJ", "EN", "FLX")
DB_FERNVERKEHR_OPERATOR = "80"


def runs_with_cancelled_stop(stops: pl.DataFrame) -> pl.DataFrame:
    return stops.group_by("trip_key").agg(pl.col("cancelled").any().alias("run_has_cancelled"))


def fv_operator_of_numbers(frame: pl.DataFrame) -> pl.DataFrame:
    """Train number to db_fv (operator 80 only), cooperation (80 and others) or foreign.

    ``frame`` holds Bahn-Vorhersage rows with ``operator``, ``category`` and ``number``.
    """
    numbered = (
        frame.filter(pl.col("category").is_in(LONG_DISTANCE_PRODUCTS))
        .with_columns(pl.col("number").str.extract(r"^0*(\d+)$", 1))
        .drop_nulls("number")
        .unique(["operator", "number"])
    )
    db = pl.col("operator") == DB_FERNVERKEHR_OPERATOR
    return numbered.group_by("number").agg(
        pl.when(db.all())
        .then(pl.lit("db_fv"))
        .when(db.any())
        .then(pl.lit("cooperation"))
        .otherwise(pl.lit("foreign"))
        .first()
        .alias("fv_operator")
    )


def db_method_scope(abroad: Iterable[int]) -> pl.Expr:
    """``fernverkehr``, ``nahverkehr`` or null for each arrival, by DB's population."""
    kept = ~pl.col("run_has_cancelled") & ~pl.col("eva").is_in(list(abroad))
    fernverkehr = pl.col("train_type").is_in(FERNVERKEHR_PRODUCTS) & (
        pl.col("fv_operator") == "db_fv"
    )
    nahverkehr = pl.col("category_code").is_in(NAHVERKEHR_CATEGORIES) & (
        pl.col("operator_group") == "db_regio"
    )
    return (
        pl.when(kept & fernverkehr)
        .then(pl.lit("fernverkehr"))
        .when(kept & nahverkehr)
        .then(pl.lit("nahverkehr"))
        .alias("db_scope")
    )


def final_origin() -> pl.Expr:
    """Where piebro's final arrival came from, against the recorded live arrival."""
    return (
        pl.when(pl.col("change_taken").is_null())
        .then(pl.lit("no_change_planned_time"))
        .when(pl.col("change_taken") >= pl.col("live_final"))
        .then(pl.lit("taken_after_arrival"))
        .otherwise(pl.lit("forecast_before_arrival"))
        .alias("origin")
    )
