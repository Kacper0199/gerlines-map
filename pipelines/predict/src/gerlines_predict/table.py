"""The served B1 table: quantiles of the chosen variant per level, built from converted months.

Each level is written as columns sorted by the packed key (``key``, ``runs``, ``median``, ``p80``;
the packing is in ``meta.key``), so a reader parses four flat number arrays and finds a key by
binary search. ``runs`` counts distinct service days and runs, not stop pairs. A train or stop row
is written only when it holds at least ``min_runs`` runs and its answer differs from the answer the
next level would give in its place, so the API answers every key exactly as the full table would.
The category level is written whole.
"""

import gzip
import json
from pathlib import Path

import polars as pl

from gerlines_predict.backtest import MonthFiles, window_tables
from gerlines_predict.pairs import BANDS, HORIZONS, MAX_AHEAD
from gerlines_predict.quantiles import (
    EVA_BASE,
    FIELDS,
    LEVELS,
    RAIL_CATEGORIES,
    key_of,
    with_fields,
)

FORMAT = 2
SOURCE = {
    "id": "piebro-deutsche-bahn-data",
    "name": "piebro/deutsche-bahn-data",
    "url": "https://huggingface.co/datasets/piebro/deutsche-bahn-data",
    "licence": "CC-BY-4.0",
    "attribution": (
        "Deutsche Bahn train data, collected and processed by piebro, data from Deutsche Bahn"
    ),
}
BAND_UPPER_MINUTES = (0, 5, 15)
HORIZON_UPPER_STOPS = (1, 3, 7)


def answers(frame: pl.DataFrame, prefix: str) -> pl.DataFrame:
    return frame.drop("n", "runs").rename({"median": f"{prefix}_median", "p80": f"{prefix}_p80"})


def pruned_levels(tables: dict[str, pl.DataFrame], min_runs: int) -> dict[str, pl.DataFrame]:
    train, stop, category = tables["train"], tables["stop"], tables["category"]
    stop_usable = stop.filter(pl.col("runs") >= min_runs)
    category_keys = list(LEVELS["category"])
    stop_keys = list(LEVELS["stop"])
    stop_kept = (
        stop_usable.join(answers(category, "c"), on=category_keys, how="left")
        .filter((pl.col("median") != pl.col("c_median")) | (pl.col("p80") != pl.col("c_p80")))
        .select(stop.columns)
    )
    train_kept = (
        train.filter(pl.col("runs") >= min_runs)
        .join(answers(stop_usable, "s"), on=stop_keys, how="left")
        .join(answers(category, "c"), on=category_keys, how="left")
        .with_columns(
            f_median=pl.coalesce("s_median", "c_median"), f_p80=pl.coalesce("s_p80", "c_p80")
        )
        .filter(
            pl.col("f_median").is_null()
            | (pl.col("median") != pl.col("f_median"))
            | (pl.col("p80") != pl.col("f_p80"))
        )
        .select(train.columns)
    )
    return {"train": train_kept, "stop": stop_kept, "category": category}


def build_table(
    months: list[MonthFiles],
    variant: str,
    shipped_ahead: list[int],
    min_runs: int,
    shards: int = 1,
) -> dict:
    packed = window_tables(months, [variant], shards=shards)[variant]
    tables = {level: with_fields(packed[level], level) for level in LEVELS}
    return table_document(tables, [m.month for m in months], variant, shipped_ahead, min_runs)


def table_document(
    tables: dict[str, pl.DataFrame],
    months: list[str],
    variant: str,
    shipped_ahead: list[int],
    min_runs: int,
) -> dict:
    kept = pruned_levels(tables, min_runs)
    columns = {
        level: kept[level]
        .select(key_of(level), "runs", "median", "p80")
        .sort("key")
        .to_dict(as_series=False)
        for level in LEVELS
    }
    return {
        "format": FORMAT,
        "meta": {
            "method": f"b1-{variant}",
            "variant": variant,
            "trainedFrom": months[0],
            "trainedTo": months[-1],
            "minRuns": min_runs,
            "maxAhead": MAX_AHEAD,
            "shippedAhead": shipped_ahead,
            "bands": list(BANDS),
            "bandUpperMinutes": list(BAND_UPPER_MINUTES),
            "horizons": list(HORIZONS),
            "horizonUpperStops": list(HORIZON_UPPER_STOPS),
            "key": {
                "categories": list(RAIL_CATEGORIES),
                "evaBase": EVA_BASE,
                "fields": {field: list(place) for field, place in FIELDS.items()},
                "levels": {level: list(fields) for level, fields in LEVELS.items()},
            },
            "source": SOURCE,
            "counts": {f"{level}_rows": len(columns[level]["key"]) for level in LEVELS}
            | {f"{level}_keys_before_pruning": tables[level].height for level in LEVELS},
        },
        **columns,
    }


def write_table(table: dict, out: Path) -> int:
    """Writes the table as gzipped JSON with a fixed gzip time, so equal tables give equal bytes."""
    out.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(table, separators=(",", ":"), sort_keys=False).encode()
    out.write_bytes(gzip.compress(body, compresslevel=9, mtime=0))
    return out.stat().st_size
