from datetime import UTC, datetime, timedelta

import polars as pl

from gerlines_backfill.comparison import (
    db_method_scope,
    final_origin,
    fv_operator_of_numbers,
    runs_with_cancelled_stop,
)

T0 = datetime(2026, 10, 27, 8, tzinfo=UTC)


def test_a_run_with_one_cancelled_stop_is_partly_cancelled() -> None:
    stops = pl.DataFrame(
        {
            "trip_key": ["a", "a", "a", "b", "b"],
            "cancelled": [False, True, False, False, False],
        }
    )
    runs = runs_with_cancelled_stop(stops).sort("trip_key")
    assert runs.to_dicts() == [
        {"trip_key": "a", "run_has_cancelled": True},
        {"trip_key": "b", "run_has_cancelled": False},
    ]


def test_fv_operator_groups_follow_the_operator_codes_of_a_number() -> None:
    frame = pl.DataFrame(
        {
            "operator": ["80", "80", "81", "80", "85", "80", "80"],
            "category": ["ICE", "ICE", "EC", "EC", "EC", "RE", "IC"],
            "number": ["0022", "22", "395", "100", "100", "4711", "2023"],
        }
    )
    groups = dict(fv_operator_of_numbers(frame).iter_rows())
    assert groups == {"22": "db_fv", "395": "foreign", "100": "cooperation", "2023": "db_fv"}


def arrivals() -> pl.DataFrame:
    return pl.DataFrame(
        {
            "trip_key": ["ice", "ice", "ice-pc", "ec", "rb", "rb-other", "ice-abroad"],
            "train_type": ["ICE", "ICE", "ICE", "EC", "RB", "RB", "ICE"],
            "category_code": ["hsr", "hsr", "hsr", "ld", "reg", "reg", "hsr"],
            "fv_operator": ["db_fv", "db_fv", "db_fv", "foreign", None, None, "db_fv"],
            "operator_group": [None, None, None, None, "db_regio", "other", None],
            "run_has_cancelled": [False, False, True, False, False, False, False],
            "eva": [8000105, 8000207, 8000105, 8000261, 8000096, 8000096, 8500010],
        }
    )


def test_db_method_scope_keeps_db_trains_without_partial_cancellation_at_home() -> None:
    scoped = arrivals().with_columns(db_method_scope([8500010]))
    assert dict(scoped.select("trip_key", "db_scope").unique().iter_rows()) == {
        "ice": "fernverkehr",
        "ice-pc": None,
        "ec": None,
        "rb": "nahverkehr",
        "rb-other": None,
        "ice-abroad": None,
    }


def test_final_origin_says_which_snapshot_gave_the_final() -> None:
    live = T0 + timedelta(minutes=5)
    frame = pl.DataFrame(
        {
            "change_taken": [T0 + timedelta(hours=3), T0 - timedelta(hours=1), None, live],
            "live_final": [live, live, live, live],
        }
    ).with_columns(pl.all().cast(pl.Datetime("us", "UTC")))
    assert frame.select(final_origin())["origin"].to_list() == [
        "taken_after_arrival",
        "forecast_before_arrival",
        "no_change_planned_time",
        "taken_after_arrival",
    ]
