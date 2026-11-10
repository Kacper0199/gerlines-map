"""Backtest tables: metrics per horizon, a day bootstrap of B1 minus B0 and the shipping rule.

The rule, fixed before the run: one B1 variant is chosen, the one with the lower mean absolute
error over all test pairs. It ships at a stops-ahead horizon when its mean absolute error is lower
than B0's in every test month and the 95 % bootstrap interval of the difference (days resampled)
lies below zero.
"""

from collections.abc import Sequence

import polars as pl

from gerlines_predict.backtest import MINUTE_BINS
from gerlines_predict.pairs import BANDS
from gerlines_predict.quantiles import LEVELS, VARIANTS

AHEAD_BINS: Sequence[tuple[int, int]] = (
    (1, 1),
    (2, 2),
    (3, 3),
    (4, 5),
    (6, 10),
    (11, 20),
    (21, 30),
)
BASELINES = ("zero", "b0")
REPLICATES = 2000
SEED = 20261108


def variants_in(metrics: pl.DataFrame) -> list[str]:
    return [variant for variant in VARIANTS if f"abs_{variant}" in metrics.columns]


def models_in(metrics: pl.DataFrame) -> list[str]:
    return [*BASELINES, *variants_in(metrics)]


def ahead_label(low: int, high: int) -> str:
    return str(low) if low == high else f"{low}_{high}"


def with_bins(metrics: pl.DataFrame) -> pl.DataFrame:
    ahead = pl.lit(None, dtype=pl.String)
    for low, high in reversed(AHEAD_BINS):
        ahead = (
            pl.when(pl.col("ahead").is_between(low, high))
            .then(pl.lit(ahead_label(low, high)))
            .otherwise(ahead)
        )
    minutes = pl.col("minutes_bin").replace_strict(
        list(range(len(MINUTE_BINS))), list(MINUTE_BINS), return_dtype=pl.String
    )
    band = pl.col("band").replace_strict(
        list(range(len(BANDS))), list(BANDS), return_dtype=pl.String
    )
    return metrics.with_columns(ahead_bin=ahead, minutes_label=minutes, band_label=band).filter(
        pl.col("ahead_bin").is_not_null()
    )


def order_of(by: str) -> list[str]:
    if by == "ahead_bin":
        return [ahead_label(low, high) for low, high in AHEAD_BINS]
    if by == "minutes_label":
        return list(MINUTE_BINS)
    if by == "band_label":
        return list(BANDS)
    msg = f"unknown grouping {by!r}"
    raise ValueError(msg)


def summarise(metrics: pl.DataFrame, by: str) -> pl.DataFrame:
    """Per bin: pairs, MAE in minutes, share within 2 and 5 minutes per model, p80 calibration and
    the share of pairs each B1 level answered."""
    sums = [
        c
        for c in metrics.columns
        if c.startswith(("abs_", "within", "covered_", "under_", "level_"))
    ]
    grouped = (
        with_bins(metrics).group_by(by).agg(pl.col("n").sum(), *[pl.col(c).sum() for c in sums])
    )
    columns = [pl.col(by).alias("bin"), "n"]
    for model in models_in(metrics):
        columns += [
            (pl.col(f"abs_{model}") / pl.col("n")).alias(f"mae_{model}"),
            (pl.col(f"within2_{model}") / pl.col("n")).alias(f"within2_{model}"),
            (pl.col(f"within5_{model}") / pl.col("n")).alias(f"within5_{model}"),
        ]
    for variant in variants_in(metrics):
        columns.append(
            (pl.col(f"under_p80_{variant}") / pl.col(f"covered_{variant}")).alias(f"p80_{variant}")
        )
        columns += [
            (pl.col(f"level_{level}_{variant}") / pl.col("n")).alias(f"share_{level}_{variant}")
            for level in LEVELS
        ]
    order = order_of(by)
    return (
        grouped.select(columns)
        .with_columns(rank=pl.col("bin").replace_strict(order, list(range(len(order)))))
        .sort("rank")
        .drop("rank")
    )


def overall_mae(metrics: pl.DataFrame) -> dict[str, float]:
    models = models_in(metrics)
    total = metrics.select(pl.col("n").sum(), *[pl.col(f"abs_{m}").sum() for m in models]).row(
        0, named=True
    )
    return {model: total[f"abs_{model}"] / total["n"] for model in models}


def chosen_variant(metrics: pl.DataFrame) -> str:
    mae = overall_mae(metrics)
    return min(variants_in(metrics), key=lambda variant: mae[variant])


def monthly_mae(metrics: pl.DataFrame, by: str, model: str) -> pl.DataFrame:
    return (
        with_bins(metrics)
        .group_by("test_month", by)
        .agg(
            (pl.col(f"abs_{model}").sum() / pl.col("n").sum()).alias("model"),
            (pl.col("abs_b0").sum() / pl.col("n").sum()).alias("b0"),
        )
        .sort("test_month", by)
    )


def bootstrap(
    metrics: pl.DataFrame,
    by: str,
    model: str,
    replicates: int = REPLICATES,
    seed: int = SEED,
) -> pl.DataFrame:
    """Per bin: the MAE difference model minus B0 and its 95 % percentile interval, with days
    resampled."""
    daily = (
        with_bins(metrics)
        .group_by(by, "service_date")
        .agg(
            (pl.col(f"abs_{model}").sum() - pl.col("abs_b0").sum()).alias("difference"),
            pl.col("n").sum(),
        )
        .sort(by, "service_date")
    )
    rows = []
    for (label,), part in daily.group_by(by, maintain_order=True):
        days = part.height
        estimate = part["difference"].sum() / part["n"].sum()
        draws = sorted(
            float(drawn["difference"].sum() / drawn["n"].sum())
            for drawn in (
                part.sample(n=days, with_replacement=True, seed=seed + replicate)
                for replicate in range(replicates)
            )
        )
        rows.append(
            {
                "bin": label,
                "difference": estimate,
                "low": draws[int(0.025 * replicates)],
                "high": draws[int(0.975 * replicates) - 1],
                "days": days,
            }
        )
    return pl.DataFrame(rows)


def decide(metrics: pl.DataFrame, model: str) -> pl.DataFrame:
    """Per stops-ahead bin: whether ``model`` ships under the rule in the module docstring."""
    months = monthly_mae(metrics, "ahead_bin", model)
    every_month = months.group_by("ahead_bin").agg(
        (pl.col("model") < pl.col("b0")).all().alias("every_month"),
        pl.len().alias("months"),
    )
    intervals = bootstrap(metrics, "ahead_bin", model)
    order = order_of("ahead_bin")
    return (
        intervals.join(every_month, left_on="bin", right_on="ahead_bin")
        .with_columns(ships=pl.col("every_month") & (pl.col("high") < 0))
        .with_columns(rank=pl.col("bin").replace_strict(order, list(range(len(order)))))
        .sort("rank")
        .drop("rank")
    )


def shipped_ahead(decision: pl.DataFrame) -> list[int]:
    """The stops-ahead values whose bin ships."""
    labels = set(decision.filter(pl.col("ships"))["bin"].to_list())
    return [
        ahead
        for low, high in AHEAD_BINS
        if ahead_label(low, high) in labels
        for ahead in range(low, high + 1)
    ]


def bin_text(label: str) -> str:
    if label == "on_time":
        return "on time"
    if label.startswith("over_"):
        return "over " + label.removeprefix("over_")
    return label.replace("_", " to ")


def percent(value: float | None) -> str:
    return "n/a" if value is None else f"{100 * value:.1f}"


def minutes(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f}"


def markdown_table(summary: pl.DataFrame, variant: str, title: str) -> str:
    head = (
        f"| {title} | pairs | MAE zero | MAE B0 | MAE B1 | within 2 zero | within 2 B0 "
        "| within 2 B1 | within 5 zero | within 5 B0 | within 5 B1 | B1 p80 cover |"
    )
    lines = [head, "|" + " --- |" * 12]
    lines.extend(
        "| "
        + " | ".join(
            [
                bin_text(row["bin"]),
                f"{row['n']:,}",
                minutes(row["mae_zero"]),
                minutes(row["mae_b0"]),
                minutes(row[f"mae_{variant}"]),
                percent(row["within2_zero"]),
                percent(row["within2_b0"]),
                percent(row[f"within2_{variant}"]),
                percent(row["within5_zero"]),
                percent(row["within5_b0"]),
                percent(row[f"within5_{variant}"]),
                percent(row[f"p80_{variant}"]),
            ]
        )
        + " |"
        for row in summary.iter_rows(named=True)
    )
    return "\n".join(lines)


def markdown_decision(decision: pl.DataFrame) -> str:
    lines = [
        "| stops ahead | MAE B1 minus B0 | 95 % interval | days | B1 lower every month | ships |",
        "|" + " --- |" * 6,
    ]
    lines.extend(
        f"| {bin_text(row['bin'])} | {row['difference']:+.3f} "
        f"| {row['low']:+.3f} to {row['high']:+.3f} | {row['days']} "
        f"| {'yes' if row['every_month'] else 'no'} | {'yes' if row['ships'] else 'no'} |"
        for row in decision.iter_rows(named=True)
    )
    return "\n".join(lines)
