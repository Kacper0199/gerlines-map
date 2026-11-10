from datetime import date
from itertools import count

import polars as pl
import pytest

from gerlines_predict.quantiles import (
    CATEGORY,
    FIELDS,
    LEVELS,
    cells,
    histogram,
    key_of,
    merge,
    predict,
    quantiles,
    run_counts,
    with_fields,
)

DAY = date(2026, 10, 5)
RUN_IDS = count(1)


def pairs_frame(rows: list[tuple], band: int = 0, run: int | None = None) -> pl.DataFrame:
    """Rows of (train_number, eva, current_min, target_min) for reg trains in horizon 0, each
    from its own run on one day unless ``run`` puts them all on one run."""
    return pl.DataFrame(
        [
            {
                "service_date": DAY,
                "run": next(RUN_IDS) if run is None else run,
                "category": "reg",
                "train_number": number,
                "eva": eva,
                "band": band,
                "horizon": 0,
                "current_min": current,
                "target_min": target,
            }
            for number, eva, current, target in rows
        ],
        schema={
            "service_date": pl.Date,
            "run": pl.UInt32,
            "category": CATEGORY,
            "train_number": pl.UInt32,
            "eva": pl.Int32,
            "band": pl.UInt8,
            "horizon": pl.UInt8,
            "current_min": pl.Int32,
            "target_min": pl.Int32,
        },
    )


def table_of(pairs: pl.DataFrame, level: str, variant: str) -> pl.DataFrame:
    return quantiles(histogram(pairs, level, variant), run_counts(pairs, level))


def tables_of(pairs: pl.DataFrame, variant: str) -> dict[str, pl.DataFrame]:
    return {level: table_of(pairs, level, variant) for level in LEVELS}


def test_key_fields_do_not_overlap_and_fit_64_bits():
    used = 0
    for shift, bits in FIELDS.values():
        mask = ((1 << bits) - 1) << shift
        assert used & mask == 0
        used |= mask
    assert used < 1 << 63


def test_keys_pack_and_unpack_every_field():
    pairs = pl.DataFrame(
        {
            "category": ["sbahn", "hsr"],
            "train_number": [9_999_999, 1],
            "eva": [8_098_553, 8_000_001],
            "band": [3, 0],
            "horizon": [2, 1],
        },
        schema={
            "category": CATEGORY,
            "train_number": pl.UInt32,
            "eva": pl.Int32,
            "band": pl.UInt8,
            "horizon": pl.UInt8,
        },
    )
    for level, fields in LEVELS.items():
        table = pairs.select(
            key_of(level), n=pl.lit(1), runs=pl.lit(1), median=pl.lit(0), p80=pl.lit(0)
        )
        unpacked = with_fields(table, level).select(fields)
        assert unpacked.equals(pairs.select(fields)), level
    stop_keys = pairs.select(key_of("stop"))["key"]
    assert stop_keys.n_unique() == 2
    assert (
        pairs.with_columns(train_number=pl.lit(5, dtype=pl.UInt32))
        .select(key_of("stop"))["key"]
        .equals(stop_keys)
    )


def test_lower_empirical_quantiles():
    pairs = pairs_frame([(1, 8000010, 0, value) for value in (5, 1, 4, 2, 3)])
    table = table_of(pairs, "train", "level")
    assert table.select("n", "runs", "median", "p80").row(0) == (5, 5, 3, 4)


def test_quantiles_on_a_skewed_histogram():
    pairs = pairs_frame([(1, 8000010, 0, 0)] * 8 + [(1, 8000010, 0, 10)] * 2)
    assert table_of(pairs, "train", "level").select("median", "p80").row(0) == (0, 0)
    pairs = pairs_frame([(1, 8000010, 0, 0)] * 7 + [(1, 8000010, 0, 10)] * 3)
    assert table_of(pairs, "train", "level").select("median", "p80").row(0) == (0, 10)


def test_change_counts_the_difference_to_the_current_delay():
    pairs = pairs_frame([(1, 8000010, 4, 6), (1, 8000010, 2, 2), (1, 8000010, 0, 1)])
    hist = cells(histogram(pairs, "train", "change"))
    assert dict(zip(hist["value"], hist["count"], strict=True)) == {0: 1, 1: 1, 2: 1}


def test_values_are_clipped_into_the_cell():
    pairs = pairs_frame([(1, 8000010, 0, -500), (1, 8000010, 0, 5000), (1, 8000010, 0, 7)])
    hist = cells(histogram(pairs, "train", "level")).sort("value")
    assert hist["value"].to_list() == [-120, 7, 899]
    assert hist["key"].n_unique() == 1


def test_merged_days_equal_one_histogram_of_all():
    first = pairs_frame([(1, 8000010, 0, v) for v in (0, 1, 2)])
    second = pairs_frame([(1, 8000010, 0, v) for v in (2, 3, 9)] + [(1, 8000011, 0, 4)])
    merged = merge([histogram(first, "stop", "level"), histogram(second, "stop", "level")])
    whole = histogram(pl.concat([first, second]), "stop", "level")
    assert merged.sort("cell").equals(whole.sort("cell"))
    with pytest.raises(ValueError, match="no histogram"):
        merge([])


def test_predict_falls_back_to_the_stop_then_the_category():
    history = pl.concat(
        [
            pairs_frame([(1, 8000010, 0, 2)] * 25),
            pairs_frame([(2, 8000010, 0, 6)] * 5),
            pairs_frame([(3, 8000020, 0, 9)] * 30),
        ]
    )
    tables = tables_of(history, "level")
    query = pairs_frame([(1, 8000010, 0, 0), (2, 8000010, 0, 0), (4, 8000030, 0, 0)])
    result = predict(query, tables, "level", min_runs=20).sort("train_number")
    assert result.select("b1_median", "b1_level").rows() == [
        (2, "train"),
        (2, "stop"),
        (6, "category"),
    ]


def test_change_variant_adds_the_current_delay():
    tables = tables_of(pairs_frame([(1, 8000010, 3, 5)] * 20), "change")
    query = pairs_frame([(1, 8000010, 4, 0)])
    assert predict(query, tables, "change").select("b1_median", "b1_p80").row(0) == (6, 6)


def test_unknown_band_has_no_prediction():
    tables = tables_of(pairs_frame([(1, 8000010, 0, 2)] * 20), "level")
    query = pairs_frame([(1, 8000010, 0, 0)], band=3)
    assert predict(query, tables, "level").select("b1_median", "b1_level").row(0) == (None, None)


def test_runs_count_each_run_of_each_day_once():
    one_run = pairs_frame([(1, 8000010, 0, 2)] * 25, run=7)
    same_run_next_day = one_run.with_columns(service_date=pl.lit(date(2026, 10, 6)))
    table = table_of(pl.concat([one_run, same_run_next_day]), "train", "level")
    assert table.select("n", "runs").row(0) == (50, 2)


def test_run_counts_of_days_add_up_when_merged():
    first = pairs_frame([(1, 8000010, 0, 2)] * 3, run=1)
    second = first.with_columns(service_date=pl.lit(date(2026, 10, 6)))
    merged = merge([run_counts(first, "stop"), run_counts(second, "stop")])
    assert merged["count"].to_list() == [2]
    assert run_counts(pl.concat([first, second]), "stop").equals(merged)


def test_a_key_with_many_pairs_from_few_runs_falls_back():
    history = pl.concat(
        [
            pairs_frame([(1, 8000010, 0, 9)] * 23, run=1),
            pairs_frame([(2, 8000010, 0, 2)] * 25),
        ]
    )
    tables = tables_of(history, "level")
    train = tables["train"].sort("key")
    assert train.select("n", "runs").rows() == [(23, 1), (25, 25)]
    query = pairs_frame([(1, 8000010, 0, 0)])
    assert predict(query, tables, "level", min_runs=20).select("b1_level").item() == "stop"


def test_quantiles_count_past_the_32_bit_range():
    big = 3_000_000_000
    span = 1024
    hist = pl.DataFrame(
        {"cell": [1 * span + 120, 2 * span + 120, 2 * span + 121], "count": [big, big, 1]},
        schema={"cell": pl.UInt64, "count": pl.UInt32},
    )
    runs = pl.DataFrame(
        {"cell": [1, 2], "count": [5, 6]}, schema={"cell": pl.UInt64, "count": pl.UInt32}
    )
    table = quantiles(hist, runs).sort("key")
    assert table.select("key", "n", "runs", "median", "p80").rows() == [
        (1, big, 5, 0, 0),
        (2, big + 1, 6, 0, 0),
    ]
