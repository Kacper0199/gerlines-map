import zipfile
from datetime import date
from pathlib import Path

import pytest

from gerlines_static_import.gtfs import (
    GtfsError,
    open_table,
    parse_date,
    parse_time,
    read_feed_info,
)

BOM = "\N{ZERO WIDTH NO-BREAK SPACE}"


@pytest.mark.parametrize(
    ("value", "expected"),
    [("13:35:00", 48900), ("5:00:00", 18000), ("25:01:02", 90062), ("", None), (" ", None)],
)
def test_parses_gtfs_times_past_midnight(value: str, expected: int | None) -> None:
    assert parse_time(value) == expected


@pytest.mark.parametrize("value", ["13:60:00", "abc", "13:35"])
def test_rejects_malformed_times(value: str) -> None:
    with pytest.raises(GtfsError, match="invalid GTFS time"):
        parse_time(value)


def test_parses_dates() -> None:
    assert parse_date("20261019") == date(2026, 10, 19)
    with pytest.raises(GtfsError):
        parse_date("2026-10-19")


def test_streams_quoted_and_unquoted_rows_with_a_bom(tmp_path: Path) -> None:
    path = tmp_path / "feed.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "stop_times.txt",
            BOM + 'trip_id,stop_id,stop_sequence\n1,"de:1:2:3:4",0\n\n2,"x,y",1\n',
        )
        archive.writestr(
            "feed_info.txt",
            '"feed_publisher_name","feed_version","feed_start_date","feed_end_date"\n'
            '"DELFI e.V.","2026-10-17T14:46:34",20261003,20261212\n',
        )
    with zipfile.ZipFile(path) as archive:
        with open_table(archive, "stop_times.txt") as table:
            assert table.index("trip_id") == 0
            assert list(table.rows) == [["1", "de:1:2:3:4", "0"], ["2", "x,y", "1"]]
            with pytest.raises(GtfsError, match="no column"):
                table.index("arrival_time")
        info = read_feed_info(archive)
    assert info.version == "2026-10-17T14:46:34"
    assert (info.start, info.end) == (date(2026, 10, 3), date(2026, 12, 12))
