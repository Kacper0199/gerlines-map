"""Backtest of zero, B0 and B1 on the converted piebro months with a strict time split.

Each test month is predicted by B1 tables built from the ``window`` months before it only, so no
value of the test month or later reaches the tables. Everything streams day by day in memory and
nothing intermediate is written: each fold reads its training window again.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from gerlines_predict.pairs import MAX_AHEAD, served_stops, stop_pairs
from gerlines_predict.quantiles import (
    LEVELS,
    MIN_RUNS,
    VARIANTS,
    histogram,
    merge,
    quantiles,
    run_counts,
)
from gerlines_predict.quantiles import predict as b1_predict

MINUTE_EDGES = (15, 30, 60, 120)
MINUTE_BINS = ("0_15", "16_30", "31_60", "61_120", "over_120")
MERGE_EVERY_DAYS = 3

Tables = dict[str, dict[str, pl.DataFrame]]


def minutes_bin(minutes: pl.Expr) -> pl.Expr:
    expr = pl.lit(len(MINUTE_EDGES), dtype=pl.UInt8)
    for index, edge in reversed(list(enumerate(MINUTE_EDGES))):
        expr = pl.when(minutes <= edge).then(pl.lit(index, dtype=pl.UInt8)).otherwise(expr)
    return expr


@dataclass(frozen=True)
class MonthFiles:
    month: str
    days: tuple[tuple[Path, Path], ...]


def month_files(converted: Path, month: str) -> MonthFiles:
    folder = converted / month
    days = []
    for stops_file in sorted((folder / "stops").glob("*.parquet")):
        trips_file = folder / "trips" / stops_file.name
        if trips_file.exists():
            days.append((stops_file, trips_file))
    if not days:
        msg = f"no converted days in {folder}"
        raise FileNotFoundError(msg)
    return MonthFiles(month, tuple(days))


def day_pairs(stops_file: Path, trips_file: Path, max_ahead: int = MAX_AHEAD) -> pl.DataFrame:
    served = served_stops(pl.scan_parquet(stops_file), pl.scan_parquet(trips_file)).collect()
    return stop_pairs(served, max_ahead)


def window_tables(
    months: Sequence[MonthFiles],
    variants: Sequence[str] = VARIANTS,
    max_ahead: int = MAX_AHEAD,
    shards: int = 1,
) -> Tables:
    """Quantile tables per variant and level from every day of the months. With ``shards`` above
    one the days are read once per shard and the train level keeps the train numbers of one
    residue at a time, which divides its memory by the shard count. Each day's runs are counted
    per key beside its histogram; a day file holds one service day, so the counts add up."""
    parts_of: dict[tuple[str, str], list[pl.DataFrame]] = {
        (variant, level): [] for variant in variants for level in LEVELS
    }
    for shard in range(shards):
        levels = [level for level in LEVELS if shard == 0 or level == "train"]
        running: dict[tuple[str, str], list[pl.DataFrame]] = {
            (variant, level): [] for variant in variants for level in levels
        }
        runs: dict[str, list[pl.DataFrame]] = {level: [] for level in levels}

        def add(parts: list[pl.DataFrame], part: pl.DataFrame) -> list[pl.DataFrame]:
            parts.append(part)
            return [merge(parts)] if len(parts) > MERGE_EVERY_DAYS else parts

        for files in months:
            for stops_file, trips_file in files.days:
                pairs = day_pairs(stops_file, trips_file, max_ahead)
                own = pairs.filter(pl.col("train_number") % shards == shard)
                for level in levels:
                    source = own if level == "train" else pairs
                    runs[level] = add(runs[level], run_counts(source, level))
                    for variant in variants:
                        running[(variant, level)] = add(
                            running[(variant, level)], histogram(source, level, variant)
                        )
                del pairs, own
        counted = {level: merge(parts) for level, parts in runs.items()}
        for (variant, level), parts in running.items():
            parts_of[(variant, level)].append(quantiles(merge(parts), counted[level]))
        del counted, running, runs
    tables: Tables = {variant: {} for variant in variants}
    for (variant, level), parts in parts_of.items():
        tables[variant][level] = pl.concat(parts).sort("key")
    return tables


def predict_all(pairs: pl.DataFrame, tables: Tables, min_runs: int = MIN_RUNS) -> pl.DataFrame:
    """The pairs with ``<variant>_median``, ``<variant>_p80`` and ``<variant>_level``."""
    frame = pairs
    for variant, levels in tables.items():
        predicted = b1_predict(pairs, levels, variant, min_runs)
        frame = frame.with_columns(
            predicted["b1_median"].alias(f"{variant}_median"),
            predicted["b1_p80"].alias(f"{variant}_p80"),
            predicted["b1_level"].alias(f"{variant}_level"),
        )
    return frame


def score(predicted: pl.DataFrame, variants: Sequence[str] = VARIANTS) -> pl.DataFrame:
    """Sums per day, stops ahead, minutes bin and band: absolute errors, hits within 2 and 5
    minutes, values at or under the p80, and the level each B1 variant used. A pair without a B1
    value takes B0 as its B1 point and is left out of the calibration."""
    points = {"zero": pl.lit(0), "b0": pl.col("current_min")}
    for variant in variants:
        points[variant] = pl.coalesce(f"{variant}_median", "current_min")
    sums = [pl.len().alias("n")]
    for name, point in points.items():
        error = (point - pl.col("target_min")).abs()
        sums += [
            error.sum().cast(pl.Int64).alias(f"abs_{name}"),
            (error <= 2).sum().cast(pl.Int64).alias(f"within2_{name}"),
            (error <= 5).sum().cast(pl.Int64).alias(f"within5_{name}"),
        ]
    for variant in variants:
        sums += [
            pl.col(f"{variant}_p80").is_not_null().sum().cast(pl.Int64).alias(f"covered_{variant}"),
            (pl.col("target_min") <= pl.col(f"{variant}_p80"))
            .sum()
            .cast(pl.Int64)
            .alias(f"under_p80_{variant}"),
            *[
                (pl.col(f"{variant}_level") == level)
                .sum()
                .cast(pl.Int64)
                .alias(f"level_{level}_{variant}")
                for level in LEVELS
            ],
        ]
    return predicted.group_by(
        "service_date",
        "ahead",
        minutes_bin(pl.col("minutes_ahead")).alias("minutes_bin"),
        "band",
    ).agg(sums)


@dataclass(frozen=True)
class Options:
    window: int = 3
    test_months: Sequence[str] | None = None
    variants: Sequence[str] = VARIANTS
    min_runs: int = MIN_RUNS
    max_ahead: int = MAX_AHEAD
    shards: int = 1


def run_backtest(
    converted: Path,
    months: list[str],
    options: Options,
    log: Callable[[str], None] = lambda _line: None,
) -> pl.DataFrame:
    """Per-day sums of every test month (default: each month from index ``window`` on), each
    predicted by tables of the ``window`` months right before it."""
    window, variants, min_runs = options.window, options.variants, options.min_runs
    max_ahead, shards, test_months = options.max_ahead, options.shards, options.test_months
    files = {month: month_files(converted, month) for month in months}
    tests = list(test_months) if test_months is not None else months[window:]
    scored: list[pl.DataFrame] = []
    for month in tests:
        index = months.index(month)
        if index < window:
            msg = f"{month} has fewer than {window} months before it"
            raise ValueError(msg)
        training = months[index - window : index]
        tables = window_tables([files[m] for m in training], variants, max_ahead, shards)
        log(f"{month}: tables from {', '.join(training)}")
        for stops_file, trips_file in files[month].days:
            pairs = day_pairs(stops_file, trips_file, max_ahead)
            scored.append(
                score(predict_all(pairs, tables, min_runs), variants).with_columns(
                    test_month=pl.lit(month)
                )
            )
            del pairs
        del tables
        log(f"{month}: tested")
    if not scored:
        msg = "no test month"
        raise ValueError(msg)
    return pl.concat(scored)
