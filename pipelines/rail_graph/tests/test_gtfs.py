import zipfile
from datetime import date
from pathlib import Path

import pytest

from gerlines_rail_graph.gtfs import active_services, gtfs_seconds, read_shapes, read_stop_times


@pytest.fixture
def feed(tmp_path: Path) -> Path:
    path = tmp_path / "feed.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "calendar.txt",
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "weekdays,1,1,1,1,1,0,0,20261001,20261231\n"
            "sundays,0,0,0,0,0,0,1,20261001,20261231\n",
        )
        archive.writestr(
            "calendar_dates.txt",
            "service_id,date,exception_type\nweekdays,20261027,2\nextra,20261027,1\nextra,20261028,1\n",
        )
        archive.writestr(
            "stop_times.txt",
            "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n"
            "t1,b,2,10:05:00,10:06:00\nt1,a,1,,10:00:00\nt2,x,1,25:00:00,25:00:00\nt1,c,3,10:10:00,\n",
        )
        archive.writestr(
            "shapes.txt",
            "﻿shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns1,50.1,8.1,2\ns1,50.0,8.0,1\ns2,1,1,1\n",
        )
    return path


def test_services_on_a_day_apply_calendar_then_exceptions(feed: Path):
    assert active_services(feed, date(2026, 10, 27)) == {"extra"}
    assert active_services(feed, date(2026, 10, 28)) == {"weekdays", "extra"}


def test_stop_times_come_sorted_by_sequence_with_missing_times_filled(feed: Path):
    result = read_stop_times(feed, {"t1"})

    assert result == {"t1": [("a", 36000, 36000), ("b", 36300, 36360), ("c", 36600, 36600)]}


def test_times_after_midnight_stay_above_24_hours():
    assert gtfs_seconds("25:00:00") == 90000


def test_shapes_come_sorted_as_lon_lat_and_survive_a_byte_order_mark(feed: Path):
    assert read_shapes(feed, {"s1"}) == {"s1": [(8.0, 50.0), (8.1, 50.1)]}


def test_an_unpacked_feed_folder_reads_like_the_zip(feed: Path, tmp_path: Path):
    folder = tmp_path / "out"
    with zipfile.ZipFile(feed) as archive:
        archive.extractall(folder)

    assert read_shapes(folder, {"s1"}) == read_shapes(feed, {"s1"})
