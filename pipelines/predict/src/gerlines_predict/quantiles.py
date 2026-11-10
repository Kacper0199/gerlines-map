"""B1: empirical quantiles of the arrival delay from history, by train number, stop and band.

Every level counts whole-minute values per key (a histogram), so days and months merge by adding
counts and quantiles come out exact. The quantile is the lower empirical one: the smallest value
whose cumulative share reaches the level. Two variants: ``level`` counts the arrival delay itself,
``change`` counts the arrival delay minus the delay at the current stop, which the prediction adds
back to the current delay.

Every level adds the horizon bucket to the keys (train number and downstream stop, then
category and stop, then category, each by band), because the change from the current delay grows
with the distance to the stop. A key is packed into one unsigned 64-bit integer (category, train
number, EVA number minus 8,000,000, band, horizon bucket); a coarser level sets the fields it
drops to zero. That keeps a three-month window of every train and stop in memory on a laptop.

A level answers a key only when the key holds at least ``MIN_RUNS`` runs: distinct service days
and runs, not pairs, because one run gives a key up to 23 pairs at eight stops ahead or more.
"""

from collections.abc import Iterable, Mapping

import polars as pl

RAIL_CATEGORIES = ("hsr", "ld", "night", "rfast", "reg", "sbahn")
CATEGORY = pl.Enum(RAIL_CATEGORIES)

LEVELS: Mapping[str, tuple[str, ...]] = {
    "train": ("category", "train_number", "eva", "band", "horizon"),
    "stop": ("category", "eva", "band", "horizon"),
    "category": ("category", "band", "horizon"),
}
VARIANTS = ("level", "change")
MIN_RUNS = 20
MEDIAN = 0.5
UPPER = 0.8

EVA_BASE = 8_000_000
VALUE_LOW = -120
VALUE_HIGH = 899
VALUE_SPAN = 1024
FIELDS: Mapping[str, tuple[int, int]] = {
    "category": (45, 3),
    "train_number": (21, 24),
    "eva": (4, 17),
    "band": (2, 2),
    "horizon": (0, 2),
}


def field_value(field: str) -> pl.Expr:
    if field == "category":
        return pl.col("category").to_physical().cast(pl.UInt64)
    if field == "eva":
        return (pl.col("eva") - EVA_BASE).cast(pl.UInt64)
    return pl.col(field).cast(pl.UInt64)


def key_of(level: str) -> pl.Expr:
    """The packed key of a pair at the level."""
    expr = pl.lit(0, dtype=pl.UInt64)
    for field in LEVELS[level]:
        shift, _bits = FIELDS[field]
        expr = expr + field_value(field) * pl.lit(1 << shift, dtype=pl.UInt64)
    return expr.alias("key")


def unpack(key: pl.Expr, field: str) -> pl.Expr:
    shift, bits = FIELDS[field]
    raw = (key // pl.lit(1 << shift, dtype=pl.UInt64)) % pl.lit(1 << bits, dtype=pl.UInt64)
    if field == "eva":
        return (raw.cast(pl.Int64) + EVA_BASE).cast(pl.Int32).alias(field)
    if field == "train_number":
        return raw.cast(pl.UInt32).alias(field)
    if field == "category":
        return raw.replace_strict(
            list(range(len(RAIL_CATEGORIES))), list(RAIL_CATEGORIES), return_dtype=CATEGORY
        ).alias(field)
    return raw.cast(pl.UInt8).alias(field)


def packable() -> pl.Expr:
    """True where the EVA and train numbers fit their bits."""
    eva_bits = FIELDS["eva"][1]
    number_bits = FIELDS["train_number"][1]
    return pl.col("eva").is_between(EVA_BASE, EVA_BASE + (1 << eva_bits) - 1) & (
        pl.col("train_number") < (1 << number_bits)
    )


def value_of(variant: str) -> pl.Expr:
    if variant == "level":
        return pl.col("target_min")
    if variant == "change":
        return pl.col("target_min") - pl.col("current_min")
    msg = f"unknown variant {variant!r}"
    raise ValueError(msg)


def histogram(pairs: pl.DataFrame, level: str, variant: str) -> pl.DataFrame:
    """Counts of each whole-minute value per packed key of the level; values are clipped to
    ``VALUE_LOW`` and ``VALUE_HIGH`` minutes, so the key and the value share one integer."""
    cell = key_of(level) * pl.lit(VALUE_SPAN, dtype=pl.UInt64) + (
        value_of(variant).clip(VALUE_LOW, VALUE_HIGH) - VALUE_LOW
    ).cast(pl.UInt64)
    return (
        pairs.lazy()
        .group_by(cell.alias("cell"))
        .agg(count=pl.len().cast(pl.UInt32))
        .collect(engine="streaming")
    )


def run_counts(pairs: pl.DataFrame, level: str) -> pl.DataFrame:
    """The number of distinct runs (service day and run) per packed key of the level, as ``cell``
    and ``count``, so the counts of separate days add up with ``merge``."""
    return (
        pairs.lazy()
        .select(key_of(level).alias("cell"), "service_date", "run")
        .unique()
        .group_by("cell")
        .agg(count=pl.len().cast(pl.UInt32))
        .collect(engine="streaming")
    )


def merge(histograms: Iterable[pl.DataFrame]) -> pl.DataFrame:
    """Histograms (or run counts) of several days or months added up, sorted by cell: the cells are
    sorted and
    each run of equal cells keeps the difference of the running count at its end and before it,
    which needs no hash table over the cells."""
    frames = [frame for frame in histograms if frame.height > 0]
    if not frames:
        msg = "no histogram to merge"
        raise ValueError(msg)
    last = (pl.col("cell") != pl.col("cell").shift(-1)).fill_null(value=True)
    running = pl.col("count").cast(pl.UInt64).cum_sum()
    return (
        pl.concat(frames)
        .lazy()
        .sort("cell")
        .with_columns(running=running)
        .filter(last)
        .select(
            "cell",
            (pl.col("running") - pl.col("running").shift(1).fill_null(0))
            .cast(pl.UInt32)
            .alias("count"),
        )
        .collect()
    )


def cells(hist: pl.DataFrame) -> pl.DataFrame:
    """A histogram as key, value and count."""
    span = pl.lit(VALUE_SPAN, dtype=pl.UInt64)
    return hist.select(
        key=pl.col("cell") // span,
        value=((pl.col("cell") % span).cast(pl.Int32) + VALUE_LOW).cast(pl.Int16),
        count="count",
    )


def quantiles(hist: pl.DataFrame, runs: pl.DataFrame) -> pl.DataFrame:
    """Per key: the number of values, the number of runs (from ``run_counts`` of the same pairs),
    the median and the 80th percentile (lower empirical).

    The cells are sorted once; each key's running count comes from one cumulative sum (64-bit, as
    a window holds billions of values) minus the sum before the key's first cell, so no grouping or
    window over the cells is needed. The cell where the running count first reaches a level is the
    quantile, exactly one per key."""
    span = pl.lit(VALUE_SPAN, dtype=pl.UInt64)
    key = pl.col("cell") // span
    first = (key != key.shift(1)).fill_null(value=True)
    last = (key != key.shift(-1)).fill_null(value=True)
    total = pl.col("count").cum_sum()
    before = pl.when(first).then(total - pl.col("count")).forward_fill()
    ranked = (
        hist.lazy()
        .select("cell", pl.col("count").cast(pl.UInt64))
        .sort("cell")
        .with_columns(running=total, before=before)
        .with_columns(
            n=pl.when(last).then(pl.col("running")).backward_fill() - pl.col("before"),
            running=pl.col("running") - pl.col("before"),
        )
        .drop("before")
    )

    def reaching(share: float, name: str) -> pl.LazyFrame:
        level = pl.col("n").cast(pl.Float64) * share
        return ranked.filter(
            (pl.col("running") >= level) & ((pl.col("running") - pl.col("count")) < level)
        ).select(
            key.alias("key"),
            pl.col("n").cast(pl.UInt32),
            ((pl.col("cell") % span).cast(pl.Int32) + VALUE_LOW).cast(pl.Int16).alias(name),
        )

    median = reaching(MEDIAN, "median").collect()
    upper = reaching(UPPER, "p80").collect()
    counted = runs.sort("cell")
    if not counted["cell"].equals(median["key"], check_names=False):
        msg = "the run counts and the histogram hold different keys"
        raise ValueError(msg)
    return median.with_columns(runs=counted["count"].cast(pl.UInt32), p80=upper["p80"])


def with_fields(table: pl.DataFrame, level: str) -> pl.DataFrame:
    """A quantile table with its key unpacked into the level's fields."""
    return table.select(
        *[unpack(pl.col("key"), f) for f in LEVELS[level]], "n", "runs", "median", "p80"
    )


def predict(
    pairs: pl.DataFrame,
    tables: Mapping[str, pl.DataFrame],
    variant: str,
    min_runs: int = MIN_RUNS,
) -> pl.DataFrame:
    """The pairs with the B1 median and p80 of the most specific level holding at least
    ``min_runs`` runs (the category level takes any count), and the level used; null where no
    level knows the key."""
    names = list(LEVELS)
    frame = pairs.lazy()
    for level in names:
        table = (
            tables[level]
            .lazy()
            .select(
                pl.col("key").alias(f"key_{level}"),
                pl.col("runs").alias(f"runs_{level}"),
                pl.col("median").alias(f"median_{level}"),
                pl.col("p80").alias(f"p80_{level}"),
            )
        )
        frame = frame.with_columns(key_of(level).alias(f"key_{level}")).join(
            table, on=f"key_{level}", how="left"
        )
    usable = {
        level: (
            pl.col(f"runs_{level}") >= min_runs
            if level != names[-1]
            else pl.col(f"runs_{level}").is_not_null()
        )
        for level in names
    }

    def pick(column: str) -> pl.Expr:
        expr = pl.lit(None, dtype=pl.Int32)
        for level in reversed(names):
            expr = pl.when(usable[level]).then(pl.col(f"{column}_{level}")).otherwise(expr)
        return expr

    level_used = pl.lit(None, dtype=pl.String)
    for level in reversed(names):
        level_used = pl.when(usable[level]).then(pl.lit(level)).otherwise(level_used)
    base = pl.col("current_min") if variant == "change" else pl.lit(0)
    return (
        frame.with_columns(
            b1_median=(base + pick("median")).cast(pl.Int32),
            b1_p80=(base + pick("p80")).cast(pl.Int32),
            b1_level=level_used,
        )
        .drop([f"{c}_{level}" for level in names for c in ("key", "runs", "median", "p80")])
        .collect()
    )
