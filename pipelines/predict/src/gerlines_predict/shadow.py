"""Shadow check of the served B1 table against recorded live arrivals.

Input is what ``scripts/shadow_details.ts`` wrote for replay instants (the train card's state:
current delay at the last passed stop, the feed's own predicted arrival delay at each served stop
ahead, the API's B1 expected and p80 delay there) and the live finals of ``stop_event``. A pair is
scored when its stop has a live final arrival after the instant. Three point forecasts are compared
on the pairs where all three exist:

- **B0**: the current delay in whole minutes rounded down (what B1 starts from);
- **B1**: the API's expected delay (current delay plus the median change);
- **feed**: the predicted arrival delay the chosen source carried for that stop at the instant.

The **card** (D-065) is what the API serves since then: the feed's delay with B1's spread
where the feed predicts the stop (``basis`` ``feed_plus_spread``), B1 elsewhere. It is scored
beside the three; files written before it have no card columns and score without it.

In the default unit (``minutes``) the final and the feed's forecast are rounded down to whole
minutes like the current delay, which is the convention of the table (IRIS minutes); ``seconds``
keeps the final and the feed in seconds and B0 and B1 as shown. Intervals resample trip instances,
since one run gives pairs at many instants and stops.
"""

import gzip
import json
from collections.abc import Sequence
from pathlib import Path

import polars as pl

from gerlines_predict.report import AHEAD_BINS, REPLICATES, SEED, ahead_label

MODELS = ("b0", "b1", "feed")
SCORED = (*MODELS, "card")
ANCHORED = "feed_plus_spread"
UNITS = ("minutes", "seconds")
MINUTES_AHEAD: Sequence[tuple[str, int]] = (
    ("0_15", 15),
    ("16_30", 30),
    ("31_60", 60),
    ("61_120", 120),
)
OVER_MINUTES = "over_120"
SOURCES = ("delfi-gtfs-rt", "gtfsde-rt")
TRAIN_NUMBER_SHIFT = 21
TRAIN_NUMBER_BITS = 24
CATEGORY_SHIFT = 45

TRIP_COLUMNS = {
    "at": pl.String,
    "trip": pl.String,
    "service_date": pl.String,
    "category": pl.String,
    "train_number": pl.String,
    "source": pl.String,
    "from_index": pl.Int32,
    "from_delay_s": pl.Int64,
    "forecast_stops": pl.Int32,
    "null_reason": pl.String,
    "product": pl.String,
}
STOP_COLUMNS = {
    "at": pl.String,
    "trip": pl.String,
    "stop_index": pl.Int32,
    "ahead": pl.Int32,
    "scheduled_arrival": pl.String,
    "feed_delay_s": pl.Int64,
    "prediction": pl.String,
    "eva": pl.Int64,
    "b1": pl.Int64,
    "b1_upper": pl.Int64,
    "level": pl.String,
    "runs": pl.Int64,
    "card": pl.Int64,
    "card_upper": pl.Int64,
    "basis": pl.String,
}


def read_details(path: Path) -> tuple[pl.DataFrame, pl.DataFrame]:
    """The train rows and the stop rows of a ``shadow_details.ts`` output."""
    trips: list[list] = []
    stops: list[list] = []
    width = len(STOP_COLUMNS)
    with gzip.open(path, "rt", encoding="utf-8") as lines:
        for line in lines:
            row = json.loads(line)
            if row[0] == "t":
                trips.append(row[1:])
            else:
                stops.append(row[1:] + [None] * (width - len(row) + 1))
    return frame(trips, TRIP_COLUMNS), frame(stops, STOP_COLUMNS)


def frame(rows: list[list], columns: dict[str, pl.DataType]) -> pl.DataFrame:
    data = pl.DataFrame(rows, schema=list(columns), orient="row", infer_schema_length=None)
    return data.cast(columns).with_columns(
        pl.col(name).str.to_datetime(time_zone="UTC", time_unit="ms")
        for name in ("at", "scheduled_arrival")
        if name in columns
    )


def read_finals(path: Path) -> pl.DataFrame:
    """Live finals of ``stop_event`` (CSV with header) as the arrival delay in seconds."""
    return (
        pl.read_csv(path, schema_overrides={"stop_index": pl.Int32}, try_parse_dates=False)
        .with_columns(
            pl.col(name).str.to_datetime("%Y-%m-%d %H:%M:%S%#z", time_zone="UTC", time_unit="ms")
            for name in ("scheduled_arrival", "final_arrival")
        )
        .filter(
            (pl.col("final_quality") == "live")
            & (pl.col("cancelled") == "f")
            & pl.col("final_arrival").is_not_null()
            & pl.col("scheduled_arrival").is_not_null()
        )
        .select(
            pl.col("trip_instance_id").alias("trip"),
            "stop_index",
            pl.col("source_id").alias("source"),
            "final_arrival",
            (pl.col("final_arrival") - pl.col("scheduled_arrival"))
            .dt.total_seconds()
            .alias("final_delay_s"),
        )
    )


def ahead_bin() -> pl.Expr:
    expr = pl.lit(None, dtype=pl.String)
    for low, high in reversed(AHEAD_BINS):
        expr = (
            pl.when(pl.col("ahead").is_between(low, high))
            .then(pl.lit(ahead_label(low, high)))
            .otherwise(expr)
        )
    return expr.alias("ahead_bin")


def minutes_bin() -> pl.Expr:
    """Planned arrival minus the instant in minutes; a planned time already past is 0 to 15."""
    minutes = (pl.col("scheduled_arrival") - pl.col("at")).dt.total_seconds() / 60
    expr = pl.lit(OVER_MINUTES)
    for label, high in reversed(MINUTES_AHEAD):
        expr = pl.when(minutes <= high).then(pl.lit(label)).otherwise(expr)
    return expr.alias("minutes_bin")


def pairs(
    trips: pl.DataFrame,
    stops: pl.DataFrame,
    finals: pl.DataFrame,
    truth: str = "same",
) -> pl.DataFrame:
    """Stop rows with their train, the final of the card's source (``same``) or of the other
    source (``other``), and the bins; only stops with a live final after the instant."""
    joined = stops.join(
        trips.select("at", "trip", "category", "train_number", "source", "from_delay_s"),
        on=["at", "trip"],
        how="inner",
    ).filter(pl.col("from_delay_s").is_not_null())
    if truth == "other":
        joined = joined.with_columns(
            pl.when(pl.col("source") == SOURCES[0])
            .then(pl.lit(SOURCES[1]))
            .otherwise(pl.lit(SOURCES[0]))
            .alias("truth_source")
        )
    else:
        joined = joined.with_columns(pl.col("source").alias("truth_source"))
    return (
        joined.join(
            finals.rename({"source": "truth_source"}),
            on=["trip", "stop_index", "truth_source"],
            how="inner",
        )
        .filter(pl.col("final_arrival") > pl.col("at"))
        .with_columns(ahead_bin(), minutes_bin())
    )


def forecasts(scored: pl.DataFrame, unit: str = "minutes") -> pl.DataFrame:
    """The truth and the three point forecasts in minutes, and the p80 bound, per pair."""
    if unit not in UNITS:
        raise ValueError(unit)
    current = pl.col("from_delay_s").floordiv(60)
    if unit == "minutes":
        final = pl.col("final_delay_s").floordiv(60).cast(pl.Float64)
        feed = pl.col("feed_delay_s").floordiv(60).cast(pl.Float64)
    else:
        final = pl.col("final_delay_s") / 60
        feed = pl.col("feed_delay_s") / 60
    return scored.with_columns(
        final.alias("truth"),
        current.cast(pl.Float64).alias("b0"),
        pl.col("b1").cast(pl.Float64).alias("b1"),
        feed.alias("feed"),
        (final <= pl.col("b1_upper")).alias("covered"),
        (final <= feed + pl.col("b1_upper") - pl.col("b1")).alias("feed_covered"),
        pl.col("card").cast(pl.Float64).alias("card"),
        (final <= pl.col("card_upper")).alias("card_covered"),
    )


def common(scored: pl.DataFrame) -> pl.DataFrame:
    """Pairs where B0, B1 and the feed all give a forecast."""
    return scored.filter(pl.all_horizontal(pl.col(model).is_not_null() for model in MODELS))


def summarise(scored: pl.DataFrame, by: Sequence[str]) -> pl.DataFrame:
    """Per group: pairs, trips, MAE, mean error and shares within 2 and 5 minutes of each model
    present, the share of finals at or under B1's p80 and the feed-anchored bound, and the card's
    when it is scored."""
    aggregates = [pl.len().alias("pairs"), pl.col("trip").n_unique().alias("trips")]
    for model in (name for name in SCORED if name in scored.columns):
        error = pl.col(model) - pl.col("truth")
        aggregates += [
            error.abs().mean().alias(f"mae_{model}"),
            error.mean().alias(f"bias_{model}"),
            (error.abs() <= 2).mean().alias(f"within2_{model}"),
            (error.abs() <= 5).mean().alias(f"within5_{model}"),
        ]
    aggregates += [
        pl.col("covered").mean().alias("p80_cover"),
        pl.col("feed_covered").mean().alias("feed_p80_cover"),
        (pl.col("b1_upper") - pl.col("b1")).mean().alias("p80_width"),
    ]
    if "card" in scored.columns:
        aggregates += [
            pl.col("card_covered").mean().alias("card_p80_cover"),
            (pl.col("card_upper") - pl.col("card")).mean().alias("card_p80_width"),
        ]
    return scored.group_by(by).agg(aggregates).sort(by)


def card_report(scored: pl.DataFrame, replicates: int = REPLICATES) -> dict:
    """The card's forecast by stops ahead: on every pair it answers (``scored``), split by basis,
    the share of pairs anchored on the feed, and its MAE difference to the feed and to B1 on the
    pairs where all forecasts exist, with trip bootstrap intervals."""
    answered = scored.filter(pl.col("card").is_not_null() & pl.col("b0").is_not_null())
    both = common(answered)
    return {
        "scored": summarise(answered, ["ahead_bin"]).to_dicts(),
        "by_basis": summarise(answered, ["ahead_bin", "basis"]).to_dicts(),
        "basis_share": answered.group_by("ahead_bin")
        .agg(
            pl.len().alias("pairs"),
            (pl.col("basis") == ANCHORED).mean().alias(ANCHORED),
        )
        .sort("ahead_bin")
        .to_dicts(),
        "card_minus_feed": bootstrap(both, "ahead_bin", "card", "feed", replicates).to_dicts(),
        "card_minus_b1": bootstrap(both, "ahead_bin", "card", "b1", replicates).to_dicts(),
    }


def coverage(scored: pl.DataFrame, by: Sequence[str]) -> pl.DataFrame:
    """Per group: pairs with a live final, and the shares that B1 and the feed answer."""
    return (
        scored.group_by(by)
        .agg(
            pl.len().alias("pairs"),
            pl.col("b1").is_not_null().mean().alias("b1_share"),
            pl.col("feed").is_not_null().mean().alias("feed_share"),
        )
        .sort(by)
    )


def bootstrap(
    scored: pl.DataFrame,
    by: str,
    model: str,
    against: str,
    replicates: int = REPLICATES,
) -> pl.DataFrame:
    """Per bin: the MAE difference ``model`` minus ``against`` and its 95 % percentile interval,
    with trip instances resampled."""
    per_trip = (
        scored.group_by(by, "trip")
        .agg(
            ((pl.col(model) - pl.col("truth")).abs() - (pl.col(against) - pl.col("truth")).abs())
            .sum()
            .alias("difference"),
            pl.len().alias("n"),
        )
        .sort(by, "trip")
    )
    rows = []
    for (label,), part in per_trip.group_by(by, maintain_order=True):
        trips = part.height
        draws = sorted(
            float(drawn["difference"].sum() / drawn["n"].sum())
            for drawn in (
                part.sample(n=trips, with_replacement=True, seed=SEED + replicate)
                for replicate in range(replicates)
            )
        )
        rows.append(
            {
                by: label,
                "difference": float(part["difference"].sum() / part["n"].sum()),
                "low": draws[int(0.025 * replicates)],
                "high": draws[int(0.975 * replicates) - 1],
                "trips": trips,
            }
        )
    return pl.DataFrame(rows).sort(by)


def train_numbers(table: dict) -> pl.DataFrame:
    """Category and train number of every train-level row of a served table (format 2)."""
    categories = table["meta"]["key"]["categories"]
    keys = pl.Series("key", table["train"]["key"], dtype=pl.Float64).cast(pl.UInt64)
    return (
        pl.DataFrame({"key": keys})
        .select(
            pl.col("key")
            .floordiv(2**CATEGORY_SHIFT)
            .cast(pl.Int64)
            .replace_strict(list(range(len(categories))), categories, return_dtype=pl.String)
            .alias("table_category"),
            (pl.col("key").floordiv(2**TRAIN_NUMBER_SHIFT) % 2**TRAIN_NUMBER_BITS)
            .cast(pl.Int64)
            .alias("number"),
        )
        .unique()
    )


def read_table(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as body:
        return json.load(body)


def mapping(trips: pl.DataFrame, table_numbers: pl.DataFrame, categories: Sequence[str]) -> dict:
    """How live trains find train-level rows: per trip instance (once, however many instants),
    whether its category and number has rows, else whether the number has rows under another
    category, by live category."""
    live = (
        trips.select("trip", "category", "train_number", "source")
        .unique("trip", keep="first")
        .with_columns(
            pl.col("train_number").str.contains(r"^\d{1,9}$").fill_null(False).alias("numeric")
        )
    )
    known = live.filter(pl.col("category").is_in(list(categories)) & pl.col("numeric"))
    with_number = known.with_columns(pl.col("train_number").cast(pl.Int64).alias("number"))
    hits = table_numbers.rename({"table_category": "category"}).with_columns(
        pl.lit(True).alias("hit")
    )
    same = with_number.join(
        hits,
        on=["category", "number"],
        how="left",
    ).with_columns(pl.col("hit").fill_null(False))
    elsewhere = (
        same.filter(~pl.col("hit"))
        .join(table_numbers, on="number", how="inner")
        .group_by("category", "table_category")
        .agg(pl.col("trip").n_unique().alias("trips"))
        .sort("trips", descending=True)
    )
    by_category = (
        same.group_by("category")
        .agg(pl.len().alias("trips"), pl.col("hit").mean().alias("train_rows_share"))
        .sort("category")
    )
    by_source = (
        same.group_by("source")
        .agg(pl.len().alias("trips"), pl.col("hit").mean().alias("train_rows_share"))
        .sort("source")
    )
    return {
        "trips": live.height,
        "outside_table": live.filter(~pl.col("category").is_in(list(categories))).height,
        "outside_by_category": live.filter(~pl.col("category").is_in(list(categories)))
        .group_by("category")
        .len()
        .sort("len", descending=True)
        .to_dicts(),
        "not_numeric_in_table_categories": live.filter(
            pl.col("category").is_in(list(categories)) & ~pl.col("numeric")
        ).height,
        "known": known.height,
        "train_rows_share": float(same["hit"].mean()) if same.height else None,
        "by_category": by_category.to_dicts(),
        "by_source": by_source.to_dicts(),
        "number_under_other_category": elsewhere.to_dicts(),
    }


def levels(scored: pl.DataFrame) -> pl.DataFrame:
    """Share of answered pairs by the level that answers, per category."""
    answered = scored.filter(pl.col("level").is_not_null())
    return (
        answered.group_by("category", "level")
        .len()
        .with_columns((pl.col("len") / pl.col("len").sum().over("category")).alias("share"))
        .sort("category", "level")
    )


def piebro_days(trip_files: Sequence[Path]) -> pl.DataFrame:
    """Service days per category and numeric train number in converted piebro trip files."""
    return (
        pl.scan_parquet(list(trip_files))
        .filter(pl.col("train_number").str.contains(r"^\d{1,9}$"))
        .select(
            "service_date",
            pl.col("category_code").alias("category"),
            pl.col("train_number").cast(pl.Int64).alias("number"),
        )
        .unique()
        .group_by("category", "number")
        .agg(pl.len().alias("days"))
        .collect()
    )


def missing_reasons(
    trips: pl.DataFrame,
    table_numbers: pl.DataFrame,
    days: pl.DataFrame,
    min_runs: int,
) -> dict[str, int]:
    """Why live trips in a table category have no train-level row: the category and number never
    ran in the training months (``absent``, and of those ``other_category`` when the number ran
    under another category), ran on fewer than ``min_runs`` days (``few_days``), or ran on enough
    days but every key fell under the run minimum or was pruned to the coarser level
    (``pruned``)."""
    live = (
        trips.select("trip", "category", "train_number")
        .unique("trip", keep="first")
        .filter(
            pl.col("category").is_in(days["category"].unique().to_list())
            & pl.col("train_number").str.contains(r"^\d{1,9}$").fill_null(False)
        )
        .with_columns(pl.col("train_number").cast(pl.Int64).alias("number"))
    )
    missing = live.join(
        table_numbers.rename({"table_category": "category"}), on=["category", "number"], how="anti"
    ).join(days, on=["category", "number"], how="left")
    absent = missing.filter(pl.col("days").is_null())
    return {
        "missing": missing.height,
        "absent": absent.height,
        "other_category": absent.join(
            days.select("number").unique(), on="number", how="semi"
        ).height,
        "few_days": missing.filter(pl.col("days") < min_runs).height,
        "pruned": missing.filter(pl.col("days") >= min_runs).height,
    }


def with_groups(scored: pl.DataFrame) -> pl.DataFrame:
    """Adds the current delay band (as the table's) and a coarse horizon for category tables."""
    current = pl.col("from_delay_s").floordiv(60)
    ahead = pl.col("ahead")
    return scored.with_columns(
        pl.when(current <= 0)
        .then(pl.lit("on_time"))
        .when(current <= 5)
        .then(pl.lit("1_5"))
        .when(current <= 15)
        .then(pl.lit("6_15"))
        .otherwise(pl.lit("over_15"))
        .alias("band"),
        pl.when(ahead <= 1)
        .then(pl.lit("1"))
        .when(ahead <= 3)
        .then(pl.lit("2_3"))
        .when(ahead <= 10)
        .then(pl.lit("4_10"))
        .otherwise(pl.lit("11_30"))
        .alias("horizon_group"),
    )


def run(
    details: Path,
    finals: Path,
    table: Path,
    trip_files: Sequence[Path] = (),
    replicates: int = REPLICATES,
) -> dict:
    """The whole shadow check as one JSON-ready report."""
    trips, stops = read_details(details)
    final_rows = read_finals(finals)
    served = read_table(table)
    meta = served["meta"]
    numbers = train_numbers(served)
    scored = with_groups(forecasts(pairs(trips, stops, final_rows)))
    both = common(scored)
    groups = ("ahead_bin", "minutes_bin", "category", "band", "source", "prediction")
    report: dict = {
        "instants": sorted(str(at) for at in trips["at"].unique().to_list()),
        "train_rows": trips.height,
        "stop_rows": stops.height,
        "trips": trips["trip"].n_unique(),
        "scored_pairs": scored.height,
        "common_pairs": both.height,
        "common_trips": both["trip"].n_unique(),
        "coverage": coverage(scored, ["ahead_bin"]).to_dicts(),
        "tables": {by: summarise(both, [by]).to_dicts() for by in groups},
        "category_horizon": summarise(both, ["category", "horizon_group"]).to_dicts(),
        "seconds": summarise(
            common(forecasts(pairs(trips, stops, final_rows), "seconds")), ["ahead_bin"]
        ).to_dicts(),
        "other_source_truth": summarise(
            common(forecasts(pairs(trips, stops, final_rows, "other"))), ["ahead_bin"]
        ).to_dicts(),
        "b1_minus_feed": bootstrap(both, "ahead_bin", "b1", "feed", replicates).to_dicts(),
        "b1_minus_b0": bootstrap(both, "ahead_bin", "b1", "b0", replicates).to_dicts(),
        "mapping": mapping(trips, numbers, meta["key"]["categories"]),
        "card": card_report(scored, replicates) if scored["card"].is_not_null().any() else None,
        "levels": levels(both).to_dicts(),
    }
    if trip_files:
        report["mapping"]["missing_reasons"] = missing_reasons(
            trips, numbers, piebro_days(trip_files), meta["minRuns"]
        )
    return report
