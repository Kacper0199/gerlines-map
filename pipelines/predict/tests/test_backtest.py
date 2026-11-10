from datetime import date, timedelta
from pathlib import Path

import polars as pl
import pytest

from gerlines_predict.backtest import Options, month_files, run_backtest, window_tables
from gerlines_predict.quantiles import (
    CATEGORY,
    LEVELS,
    histogram,
    key_of,
    predict,
    quantiles,
    run_counts,
    with_fields,
)
from gerlines_predict.report import chosen_variant, decide, summarise
from gerlines_predict.table import build_table, table_document, write_table


def write_month(root: Path, month: str, stops: pl.DataFrame, trips: pl.DataFrame, days: int):
    first = date.fromisoformat(f"{month}-01")
    for offset in range(days):
        day = first + timedelta(days=offset)
        shift = pl.duration(days=(day - stops["service_date"][0]).days)
        for name, frame in (("stops", stops), ("trips", trips)):
            folder = root / month / name
            folder.mkdir(parents=True, exist_ok=True)
            moved = frame.with_columns(service_date=pl.lit(day))
            if name == "stops":
                moved = moved.with_columns(
                    pl.col(c) + shift
                    for c in ("scheduled_arrival", "scheduled_departure", "trip_start")
                )
            moved.write_parquet(folder / f"{day.isoformat()}.parquet")


@pytest.fixture
def converted(tmp_path, day_frames) -> Path:
    stops, trips = day_frames
    for month in ("2026-08", "2026-09", "2026-10"):
        write_month(tmp_path, month, stops, trips, days=3)
    return tmp_path


LATE_BY = 6


@pytest.fixture
def converted_late_test_month(tmp_path, day_frames) -> Path:
    """The training months as in ``converted``; on the nine days of 2026-10 run a arrives at its
    last stop ``LATE_BY`` minutes later than on every training day, so tables that saw the test
    month would answer with the late value."""
    stops, trips = day_frames
    for month in ("2026-08", "2026-09"):
        write_month(tmp_path, month, stops, trips, days=3)
    last = (pl.col("trip_key") == "a") & (pl.col("stop_index") == 3)
    late = stops.with_columns(
        arrival_delay_s=pl.when(last)
        .then(pl.col("arrival_delay_s") + LATE_BY * 60)
        .otherwise(pl.col("arrival_delay_s"))
    )
    write_month(tmp_path, "2026-10", late, trips, days=9)
    return tmp_path


def test_month_files_need_converted_days(tmp_path):
    with pytest.raises(FileNotFoundError):
        month_files(tmp_path, "2026-10")


def test_shards_give_the_same_tables(converted):
    months = [month_files(converted, m) for m in ("2026-08", "2026-09")]
    whole = window_tables(months)
    sharded = window_tables(months, shards=2)
    for variant, levels in whole.items():
        for level, table in levels.items():
            assert table.sort("key").equals(sharded[variant][level].sort("key")), (variant, level)


def test_backtest_scores_every_pair_of_the_test_month(converted):
    months = ["2026-08", "2026-09", "2026-10"]
    metrics = run_backtest(converted, months, Options(window=2, min_runs=5))
    assert metrics["test_month"].unique().to_list() == ["2026-10"]
    assert metrics["n"].sum() == 9 * 3
    assert metrics["abs_zero"].sum() == 3 * ((2 + 4 + 3 + 4 + 3 + 3) + (7 + 20 + 20))
    assert metrics["abs_b0"].sum() == 3 * ((2 + 4 + 3 + 2 + 1 + 2) + (6 + 19 + 12))
    assert metrics["abs_change"].sum() == 0
    assert metrics["under_p80_change"].sum() == metrics["covered_change"].sum() == 27
    summary = summarise(metrics, "ahead_bin")
    assert summary["bin"].to_list() == ["1", "2", "3"]
    assert chosen_variant(metrics.drop("abs_level")) == "change"
    decision = decide(metrics, "change")
    assert decision.filter(pl.col("bin") == "1")["ships"].to_list() == [True]


def test_b1_predicts_the_test_month_from_the_training_months_only(converted_late_test_month):
    months = ["2026-08", "2026-09", "2026-10"]
    metrics = run_backtest(converted_late_test_month, months, Options(window=2, min_runs=5))
    test_days, late_pairs_per_day = 9, 3
    assert metrics["n"].sum() == 9 * test_days
    assert metrics["abs_change"].sum() == test_days * late_pairs_per_day * LATE_BY
    assert metrics["abs_level"].sum() == test_days * late_pairs_per_day * LATE_BY
    assert metrics["level_train_change"].sum() == 9 * test_days
    one_ahead = metrics.filter(pl.col("ahead") == 1)
    assert one_ahead["under_p80_change"].sum() == one_ahead["covered_change"].sum() - test_days
    leaked = window_tables([month_files(converted_late_test_month, m) for m in months], ["change"])
    late_key = with_fields(leaked["change"]["train"], "train").filter(
        (pl.col("train_number") == 4711) & (pl.col("eva") == 8000004) & (pl.col("band") == 1)
    )
    assert late_key.select("median", "p80").row(0) == (3 + LATE_BY - 5, 3 + LATE_BY - 5)


def test_backtest_refuses_a_test_month_without_its_window(converted):
    with pytest.raises(ValueError, match="fewer than"):
        run_backtest(converted, ["2026-08", "2026-09"], Options(window=2, test_months=["2026-09"]))


def test_table_answers_like_the_full_levels(converted, tmp_path):
    months = [month_files(converted, m) for m in ("2026-08", "2026-09", "2026-10")]
    table = build_table(months, "change", shipped_ahead=[1, 2], min_runs=5)
    meta = table["meta"]
    assert table["format"] == 2
    assert meta["method"] == "b1-change"
    assert meta["minRuns"] == 5
    assert meta["trainedFrom"] == "2026-08"
    assert meta["source"]["licence"] == "CC-BY-4.0"
    assert meta["key"]["fields"]["train_number"] == [21, 24]
    assert meta["key"]["categories"][4] == "reg"
    assert set(table["category"]) == {"key", "runs", "median", "p80"}
    assert table["train"]["runs"] == [9] * len(table["train"]["key"])
    reg = 4 << 45
    assert all(reg <= key < 5 << 45 for key in table["category"]["key"])
    out = tmp_path / "b1.json.gz"
    first = write_table(table, out)
    assert first == write_table(table, out)
    assert out.read_bytes()[:2] == b"\x1f\x8b"


def test_pruned_table_answers_every_key_like_the_full_chain():

    rows = []
    for number, eva, band, horizon, current, target, runs in [
        (1, 8000010, 0, 0, 0, 2, 25),
        (2, 8000010, 0, 0, 0, 1, 30),
        (3, 8000010, 0, 0, 0, 1, 5),
        (4, 8000020, 1, 1, 3, 9, 40),
        (5, 8000020, 1, 1, 3, 4, 40),
        (6, 8000030, 0, 0, 0, 1, 22),
    ]:
        rows += [(number, eva, band, horizon, current, target)] * runs
    pairs = pl.DataFrame(
        [
            {
                "service_date": date(2026, 10, 5),
                "run": run,
                "category": "reg",
                "train_number": n,
                "eva": e,
                "band": b,
                "horizon": h,
                "current_min": c,
                "target_min": t,
            }
            for run, (n, e, b, h, c, t) in enumerate(rows)
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
    packed = {
        level: quantiles(histogram(pairs, level, "change"), run_counts(pairs, level))
        for level in LEVELS
    }
    document = table_document(
        {level: with_fields(packed[level], level) for level in LEVELS},
        ["2026-10"],
        "change",
        [1],
        min_runs=20,
    )
    answers = {
        level: dict(
            zip(
                document[level]["key"],
                zip(document[level]["median"], document[level]["p80"], strict=True),
                strict=True,
            )
        )
        for level in LEVELS
    }
    assert len(answers["train"]) < packed["train"].height
    assert document["train"]["key"] == sorted(document["train"]["key"])

    def lookup(row):
        frame = pl.DataFrame([row]).cast(
            {"train_number": pl.UInt32, "eva": pl.Int32, "band": pl.UInt8, "horizon": pl.UInt8}
        )
        frame = frame.with_columns(category=pl.lit("reg", dtype=CATEGORY))
        for level in LEVELS:
            key = frame.select(key_of(level))["key"][0]
            if key in answers[level]:
                return answers[level][key]
        return None

    keys = pairs.select("train_number", "eva", "band", "horizon").unique()
    query = keys.with_columns(
        category=pl.lit("reg", dtype=CATEGORY), current_min=pl.lit(0), target_min=pl.lit(0)
    )
    full = predict(query, packed, "change", min_runs=20)
    for row in full.iter_rows(named=True):
        fields = {f: row[f] for f in ("train_number", "eva", "band", "horizon")}
        answer = lookup(fields)
        assert answer == (row["b1_median"], row["b1_p80"]), row
    assert document["category"]["key"]
