from datetime import UTC, date, datetime
from pathlib import Path

import polars as pl
import pytest

from gerlines_backfill.convert import (
    month_files,
    read_service_day,
    segment_rows,
    stop_rows,
    trip_rows,
)

FIXTURES = Path(__file__).parent / "fixtures"
ICE_1720 = "-7256490561424230809-2511302138"
RB_14557 = "6477159314363009840-2511120736"
RB_16370 = "8263797658212507001-2511120548"
S6_SPRING = "3806266644329547244-2603290048"
NJ_402 = "8868050453695511606-2610241920"


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


def fixture(month: str) -> Path:
    return FIXTURES / f"piebro-{month}.parquet"


def stops_of(frame: pl.DataFrame, trip: str) -> list[dict]:
    return frame.filter(pl.col("trip_key") == trip).sort("stop_index").to_dicts()


@pytest.fixture(scope="module")
def nov30() -> pl.DataFrame:
    return read_service_day([fixture("2025-11"), fixture("2025-12")], date(2025, 11, 30))


@pytest.fixture(scope="module")
def nov12() -> pl.DataFrame:
    return read_service_day([fixture("2025-11")], date(2025, 11, 12))


def test_a_run_is_read_whole_across_the_month_files(nov30: pl.DataFrame) -> None:
    ice = stops_of(nov30, ICE_1720)
    assert [s["stop_index"] for s in ice] == [0, 1, 2, 3, 4, 5, 6]
    assert {s["service_date"] for s in ice} == {date(2025, 11, 30)}
    assert set(nov30["trip_key"]) == {ICE_1720}


def test_times_are_berlin_wall_clock_converted_to_utc(nov30: pl.DataFrame) -> None:
    origin, _, hannover, *_, altona = stops_of(nov30, ICE_1720)
    assert origin["eva"] == 8098160
    assert origin["scheduled_arrival"] is None
    assert origin["scheduled_departure"] == utc(2025, 11, 30, 20, 38)
    assert origin["final_departure"] == utc(2025, 11, 30, 20, 49)
    assert hannover["scheduled_arrival"] == utc(2025, 11, 30, 23, 33)
    assert hannover["final_arrival"] == utc(2025, 12, 1, 0, 25)
    assert hannover["arrival_delay_s"] == 52 * 60
    assert hannover["departure_delay_s"] == 73 * 60
    assert altona["final_departure"] is None
    assert altona["final_quality"] == "final_only"
    assert not altona["cancelled"]


def test_cancelled_events_have_no_final_time(nov12: pl.DataFrame) -> None:
    munster, soltau, *_ = stops_of(nov12, RB_16370)
    assert munster["cancelled"]
    assert munster["final_departure"] is None
    assert munster["final_quality"] is None
    assert not soltau["cancelled"]
    assert soltau["final_arrival"] is None
    assert soltau["arrival_delay_s"] is None
    assert soltau["final_departure"] == utc(2025, 11, 12, 5, 37)


def test_stops_without_a_plan_record_keep_their_actual_times_only() -> None:
    day = read_service_day([fixture("2026-03")], date(2026, 3, 29))
    first, second, *_ = stops_of(day, S6_SPRING)
    assert first["scheduled_departure"] is None
    assert first["final_departure"] == utc(2026, 3, 28, 23, 48)
    assert second["final_arrival"] == utc(2026, 3, 28, 23, 51)
    assert second["arrival_delay_s"] is None


def test_delays_across_the_autumn_clock_change_use_the_wall_clock_difference() -> None:
    day = read_service_day([fixture("2026-10")], date(2026, 10, 24))
    by_eva = {s["eva"]: s for s in stops_of(day, NJ_402)}
    frankfurt = by_eva[8000105]
    assert frankfurt["stop_index"] == 7
    assert frankfurt["arrival_delay_s"] == 6 * 60
    assert frankfurt["scheduled_arrival"] == utc(2026, 10, 25, 0, 44)
    assert by_eva[8000206]["arrival_delay_s"] == 123 * 60
    assert by_eva[8000206]["scheduled_arrival"] == utc(2026, 10, 25, 4, 2)


def test_trip_rows_name_number_category_origin_and_start(nov30: pl.DataFrame) -> None:
    trip = trip_rows(nov30).to_dicts()
    assert trip == [
        {
            "service_date": date(2025, 11, 30),
            "trip_key": ICE_1720,
            "train_type": "ICE",
            "train_number": "1720",
            "line_name": None,
            "category_code": "hsr",
            "category_rule": "type:ICE",
            "origin_eva": 8098160,
            "origin_departure": utc(2025, 11, 30, 20, 38),
            "replacement": False,
            "stops": 7,
        }
    ]


def test_trip_rows_take_the_number_from_stops_that_have_a_plan_record() -> None:
    day = read_service_day([fixture("2026-03")], date(2026, 3, 29))
    trip = trip_rows(day).filter(pl.col("trip_key") == S6_SPRING).row(0, named=True)
    assert trip["train_number"] == "31650"
    assert trip["category_code"] == "sbahn"
    assert trip["line_name"] == "S6"
    assert trip["origin_eva"] == 8000098
    assert trip["origin_departure"] == utc(2026, 3, 28, 23, 48)


def test_segments_join_consecutive_served_stops(nov30: pl.DataFrame) -> None:
    legs = segment_rows(nov30).sort("from_index").to_dicts()
    assert [(leg["from_index"], leg["to_index"]) for leg in legs] == [
        (0, 1),
        (1, 2),
        (2, 3),
        (3, 4),
        (4, 5),
        (5, 6),
    ]
    spandau = legs[1]
    assert spandau["from_eva"] == 8010404
    assert spandau["to_eva"] == 8000152
    assert spandau["dep_delay_from_s"] == 12 * 60
    assert spandau["arr_delay_to_s"] == 52 * 60
    assert spandau["delay_gain_s"] == 40 * 60
    assert spandau["run_sched_s"] == 165 * 60
    assert spandau["run_act_s"] == 205 * 60
    assert spandau["dwell_delay_s"] == 0
    assert spandau["observed_at"] == utc(2025, 12, 1, 0, 25)
    assert legs[0]["dwell_delay_s"] is None


def test_segments_skip_cancelled_stops_and_need_final_times(nov12: pl.DataFrame) -> None:
    legs = segment_rows(nov12.filter(pl.col("trip_key") == RB_14557)).sort("from_index")
    assert legs["from_index"].to_list()[:2] == [1, 2]
    first = legs.row(0, named=True)
    assert first["dwell_delay_s"] is None
    assert first["dep_delay_from_s"] == 60
    assert legs.height == 12


def test_stop_rows_date_a_run_by_its_start_stamp() -> None:
    frame = stop_rows(pl.scan_parquet(fixture("2025-12"))).collect()
    assert set(frame["service_date"]) == {date(2025, 11, 30)}


def test_month_files_include_the_next_month_when_present(tmp_path: Path) -> None:
    for month in ("2025-11", "2025-12"):
        (tmp_path / f"data-{month}.parquet").touch()
    assert month_files(tmp_path, "2025-11") == [
        tmp_path / "data-2025-11.parquet",
        tmp_path / "data-2025-12.parquet",
    ]
    with pytest.warns(UserWarning, match="data-2026-01.parquet is missing"):
        assert month_files(tmp_path, "2025-12") == [tmp_path / "data-2025-12.parquet"]


def autumn_run(path: Path) -> Path:
    stamp = "2610250140"
    local = [
        (None, "2026-10-25 01:40"),
        ("2026-10-25 02:18", "2026-10-25 02:20"),
        ("2026-10-25 02:50", "2026-10-25 02:52"),
        ("2026-10-25 02:10", "2026-10-25 02:12"),
        ("2026-10-25 02:55", "2026-10-25 02:57"),
        ("2026-10-25 03:05", None),
    ]

    def moment(text: str | None) -> datetime | None:
        return None if text is None else datetime.strptime(text, "%Y-%m-%d %H:%M")

    rows = len(local)
    pl.DataFrame(
        {
            "id": [f"77-{stamp}-{n + 1}" for n in range(rows)],
            "eva": [f"0800{n:04d}" for n in range(rows)],
            "station_name": [f"Halt {n}" for n in range(rows)],
            "train_type": ["RE"] * rows,
            "train_number": ["4711"] * rows,
            "line_number": ["1"] * rows,
            "train_line_station_num": list(range(1, rows + 1)),
            "arrival_planned_time": [moment(a) for a, _ in local],
            "arrival_change_time": [moment(a) for a, _ in local],
            "departure_planned_time": [moment(d) for _, d in local],
            "departure_change_time": [moment(d) for _, d in local],
            "arrival_is_canceled": [False] * rows,
            "departure_is_canceled": [False] * rows,
            "is_additional_stop": [False] * rows,
            "is_replacement_train": [False] * rows,
            "has_plan_record": [True] * rows,
            "time": [moment(a or d) for a, d in local],
        },
        schema_overrides={
            name: pl.Datetime("ns")
            for name in (
                "arrival_planned_time",
                "arrival_change_time",
                "departure_planned_time",
                "departure_change_time",
                "time",
            )
        },
    ).write_parquet(path)
    return path


def test_the_repeated_autumn_hour_takes_the_later_instant_once_the_run_goes_back(
    tmp_path: Path,
) -> None:
    day = read_service_day([autumn_run(tmp_path / "autumn.parquet")], date(2026, 10, 25))
    arrivals = [s["scheduled_arrival"] for s in day.sort("stop_index").to_dicts()]
    assert arrivals == [
        None,
        utc(2026, 10, 25, 0, 18),
        utc(2026, 10, 25, 0, 50),
        utc(2026, 10, 25, 1, 10),
        utc(2026, 10, 25, 1, 55),
        utc(2026, 10, 25, 2, 5),
    ]
    back = day.filter(pl.col("stop_index") == 3).row(0, named=True)
    assert back["scheduled_departure"] == utc(2026, 10, 25, 1, 12)
    assert back["final_arrival"] == utc(2026, 10, 25, 1, 10)
    assert back["arrival_delay_s"] == 0
    assert "arrival_local" not in day.columns
