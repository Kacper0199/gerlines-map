import zipfile
from pathlib import Path

import pytest

from gerlines_static_import.categories import TRAIN_CATEGORIES, Category
from gerlines_static_import.gtfs import GtfsError
from gerlines_static_import.inventory import read_agency_names
from gerlines_static_import.operators import build_catalog
from gerlines_static_import.timetable import (
    StopTimeRow,
    select_routes,
    select_services,
    select_trips,
    stream_stop_times,
)

from .conftest import FEED, write_zip


def select(archive: zipfile.ZipFile, categories: frozenset[Category] = TRAIN_CATEGORIES):
    names = read_agency_names(archive)
    routes = select_routes(archive, names, build_catalog(names), categories)
    trips = select_trips(archive, routes.routes)
    return routes, trips


def test_selects_train_routes_and_counts_the_rest(mini_feed: Path) -> None:
    with zipfile.ZipFile(mini_feed) as archive:
        routes, trips = select(archive)
    assert set(routes.routes) == {"r-ice", "r-re", "r-nj"}
    assert routes.total == 5
    assert dict(routes.by_category) == {"hsr": 1, "rfast": 1, "night": 1}
    assert dict(routes.excluded_by_category) == {"bus": 2}
    assert routes.routes["r-nj"].is_foreign
    assert routes.routes["r-re"].operator_id == "db-regio-ag"
    assert set(trips.trips) == {"t1", "t2", "t3", "t4", "t6"}
    assert (trips.total, trips.excluded) == (7, 2)


def test_category_set_is_a_parameter(mini_feed: Path) -> None:
    with zipfile.ZipFile(mini_feed) as archive:
        routes, _ = select(archive, frozenset({Category.HSR, Category.BUS}))
    assert set(routes.routes) == {"r-ice", "r-bus", "r-sev"}


def test_services_keep_weekdays_and_only_used_exceptions(mini_feed: Path) -> None:
    with zipfile.ZipFile(mini_feed) as archive:
        services = select_services(archive, {"1", "2"})
    assert services.services["1"].weekdays == 0b0011111
    assert services.services["2"].weekdays == 0b1100000
    assert [(s, d.isoformat(), k) for s, d, k in services.calendar_dates] == [
        ("1", "2026-10-03", 2),
        ("2", "2026-10-03", 1),
    ]
    assert (services.calendar_total, services.calendar_dates_total) == (2, 3)


def test_streams_stop_times_into_patterns_and_drops_broken_trips(mini_feed: Path) -> None:
    sunk: list[StopTimeRow] = []
    with zipfile.ZipFile(mini_feed) as archive:
        routes, trips = select(archive)
        result = stream_stop_times(archive, trips.trips, routes.routes, sunk.extend)
    assert result.total_rows == 11
    assert result.kept_rows == 8
    assert result.dropped_trips == {"t6": "fewer than two stops"}
    assert result.dropped_rows == 1
    assert dict(result.rows_by_category) == {"hsr": 4, "rfast": 2, "night": 2}
    assert result.trip_times["t1"].trip_pattern_id == result.trip_times["t2"].trip_pattern_id
    assert len(result.patterns) == 3
    assert result.trip_times["t3"].first_departure_s == 23 * 3600 + 51 * 60
    assert result.trip_times["t3"].last_arrival_s == 24 * 3600 + 30 * 60
    assert ("t3", 1, 7, 88200, 88200, 1, 0) in sunk
    assert [row[1] for row in sunk if row[0] == "t1"] == [0, 1]


def test_refuses_stop_times_not_grouped_by_trip(tmp_path: Path) -> None:
    members = dict(FEED)
    members["stop_times.txt"] = (
        "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n"
        't1,"de:11000:900003201:1:50",0,08:00:00,08:00:00\n'
        't2,"de:11000:900003201:1:50",0,10:00:00,10:00:00\n'
        't1,"de:02000:10950:3:5",1,09:42:00,09:42:00\n'
    )
    feed = write_zip(tmp_path / "feed.zip", members)
    with zipfile.ZipFile(feed) as archive:
        routes, trips = select(archive)
        with pytest.raises(GtfsError, match="not grouped by trip_id"):
            stream_stop_times(archive, trips.trips, routes.routes, lambda rows: None)
