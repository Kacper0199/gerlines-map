from datetime import UTC, date, datetime, timedelta

import polars as pl
import pytest

DAY = date(2026, 10, 5)
START = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)

STOP_SCHEMA = {
    "service_date": pl.Date,
    "trip_key": pl.String,
    "stop_index": pl.Int16,
    "eva": pl.Int32,
    "scheduled_arrival": pl.Datetime("us", "UTC"),
    "scheduled_departure": pl.Datetime("us", "UTC"),
    "final_arrival": pl.Datetime("us", "UTC"),
    "final_departure": pl.Datetime("us", "UTC"),
    "arrival_delay_s": pl.Int32,
    "departure_delay_s": pl.Int32,
    "final_quality": pl.String,
    "cancelled": pl.Boolean,
    "additional": pl.Boolean,
    "has_plan_record": pl.Boolean,
    "trip_start": pl.Datetime("us", "UTC"),
}

TRIP_SCHEMA = {
    "service_date": pl.Date,
    "trip_key": pl.String,
    "train_type": pl.String,
    "train_number": pl.String,
    "line_name": pl.String,
    "category_code": pl.String,
    "category_rule": pl.String,
    "origin_eva": pl.Int32,
    "origin_departure": pl.Datetime("us", "UTC"),
    "replacement": pl.Boolean,
    "stops": pl.Int32,
}


def run_rows(
    key: str,
    evas: list[int],
    arrival_min: list[int | None],
    departure_min: list[int | None],
    cancelled: list[bool] | None = None,
) -> list[dict]:
    """Stops of one run in the converted layout, ten minutes apart: no arrival at the first, no
    departure at the last."""
    rows = []
    last = len(evas) - 1
    for index, eva in enumerate(evas):
        planned = START + timedelta(minutes=10 * index)
        arrival = arrival_min[index] if index > 0 else None
        departure = departure_min[index] if index < last else None
        rows.append(
            {
                "service_date": DAY,
                "trip_key": key,
                "stop_index": index,
                "eva": eva,
                "scheduled_arrival": planned if index > 0 else None,
                "scheduled_departure": planned + timedelta(minutes=1) if index < last else None,
                "final_arrival": None,
                "final_departure": None,
                "arrival_delay_s": None if arrival is None else arrival * 60,
                "departure_delay_s": None if departure is None else departure * 60,
                "final_quality": "final_only",
                "cancelled": bool(cancelled and cancelled[index]),
                "additional": False,
                "has_plan_record": True,
                "trip_start": START,
            }
        )
    return rows


def trip_row(key: str, number: str, category: str, stops: int) -> dict:
    return {
        "service_date": DAY,
        "trip_key": key,
        "train_type": "RE",
        "train_number": number,
        "line_name": None,
        "category_code": category,
        "category_rule": "train_type",
        "origin_eva": 8000001,
        "origin_departure": START,
        "replacement": False,
        "stops": stops,
    }


@pytest.fixture
def day_frames() -> tuple[pl.DataFrame, pl.DataFrame]:
    stops = [
        *run_rows("a", [8000001, 8000002, 8000003, 8000004], [None, 2, 4, 3], [0, 2, 5, None]),
        *run_rows(
            "b",
            [8000001, 8000002, 8000003, 8000004],
            [None, 7, 9, 20],
            [1, 8, 9, None],
            cancelled=[False, False, True, False],
        ),
        *run_rows("bus", [8000001, 8000002], [None, 0], [0, None]),
    ]
    trips = [
        trip_row("a", "4711", "reg", 4),
        trip_row("b", "4712", "reg", 4),
        trip_row("bus", "9001", "bus", 2),
    ]
    return pl.DataFrame(stops, schema=STOP_SCHEMA), pl.DataFrame(trips, schema=TRIP_SCHEMA)
