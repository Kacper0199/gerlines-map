import json
import shutil
from datetime import date
from pathlib import Path

import polars as pl
import pytest

from gerlines_backfill.convert import month_days
from gerlines_backfill.month import clock_change_days, convert_month

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def inputs(tmp_path: Path) -> Path:
    folder = tmp_path / "inputs"
    folder.mkdir()
    for month in ("2025-11", "2025-12"):
        shutil.copy(FIXTURES / f"piebro-{month}.parquet", folder / f"data-{month}.parquet")
    return folder


def test_convert_month_writes_days_and_a_summary(inputs: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    summary = convert_month(inputs, "2025-11", out)
    assert summary["month"] == "2025-11"
    assert summary["source_rows"] == 108
    assert summary["source_rows_of_earlier_runs"] == 0
    assert summary["stops"] == 113
    assert summary["trips"] == 8
    stops = pl.read_parquet(out / "2025-11" / "stops" / "*.parquet")
    trips = pl.read_parquet(out / "2025-11" / "trips" / "*.parquet")
    segments = pl.read_parquet(out / "2025-11" / "segments" / "*.parquet")
    assert stops.height == summary["stops"]
    assert trips.height == summary["trips"]
    assert segments.height == summary["segments"]
    assert sorted(path.name for path in (out / "2025-11" / "trips").iterdir()) == [
        "2025-11-12.parquet",
        "2025-11-30.parquet",
    ]
    assert summary["by_category"]["hsr"]["trips"] == 1
    assert summary["punctuality"]["fernverkehr"]["arrivals"] == 6
    assert summary["punctuality"]["fernverkehr"]["lt_6min"] == 0
    assert summary["stations"]["8098160"] == "Berlin Hauptbahnhof"
    written = json.loads((out / "2025-11" / "summary.json").read_text())
    assert written == summary


def test_the_next_month_skips_rows_of_runs_that_started_before_it(
    inputs: Path, tmp_path: Path
) -> None:
    with pytest.warns(UserWarning, match="data-2026-01.parquet is missing"):
        summary = convert_month(inputs, "2025-12", tmp_path / "out")
    assert summary["source_rows"] == 5
    assert summary["source_rows_of_earlier_runs"] == 5
    assert summary["stops"] == 0
    assert summary["trips"] == 0


def test_a_month_without_the_next_file_says_its_last_day_may_be_short(
    inputs: Path, tmp_path: Path
) -> None:
    assert convert_month(inputs, "2025-11", tmp_path / "out")["next_month_missing"] is False
    with pytest.warns(UserWarning, match="data-2026-01.parquet"):
        summary = convert_month(inputs, "2025-12", tmp_path / "out")
    assert summary["next_month_missing"] is True


def test_clock_change_days_are_the_last_sundays_of_march_and_october() -> None:
    assert clock_change_days(month_days("2026-03")) == [date(2026, 3, 29)]
    assert clock_change_days(month_days("2026-10")) == [date(2026, 10, 25)]
    assert clock_change_days(month_days("2025-11")) == []
