"""Streaming access to the members of a GTFS zip, row by row, without extracting them."""

import csv
import io
import re
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date

_TIME = re.compile(r"^(\d{1,3}):([0-5]\d):([0-5]\d)$")
_DATE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")


class GtfsError(ValueError):
    """The feed breaks a rule the importer relies on."""


@dataclass(frozen=True, slots=True)
class Table:
    """Header positions of one member; ``rows`` yields each record as a list of strings."""

    name: str
    columns: dict[str, int]
    rows: Iterator[list[str]]

    def index(self, column: str) -> int:
        try:
            return self.columns[column]
        except KeyError:
            msg = f"{self.name} has no column {column}"
            raise GtfsError(msg) from None

    def optional_index(self, column: str) -> int | None:
        return self.columns.get(column)


@contextmanager
def open_table(archive: zipfile.ZipFile, name: str) -> Iterator[Table]:
    """Open ``name`` inside ``archive`` as a streamed CSV table (UTF-8, optional BOM)."""
    with archive.open(name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.reader(text)
        header = next(reader, None)
        if header is None:
            msg = f"{name} is empty"
            raise GtfsError(msg)
        columns = {column.strip(): position for position, column in enumerate(header)}
        yield Table(name=name, columns=columns, rows=(row for row in reader if row))


def members(archive: zipfile.ZipFile) -> set[str]:
    return {info.filename for info in archive.infolist() if not info.is_dir()}


def parse_time(value: str) -> int | None:
    """Seconds after noon minus 12 hours of the service day; ``None`` for an empty field."""
    stripped = value.strip()
    if not stripped:
        return None
    match = _TIME.match(stripped)
    if match is None:
        msg = f"invalid GTFS time {value!r}"
        raise GtfsError(msg)
    hours, minutes, seconds = (int(part) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds


def parse_date(value: str) -> date:
    match = _DATE.match(value.strip())
    if match is None:
        msg = f"invalid GTFS date {value!r}"
        raise GtfsError(msg)
    year, month, day = (int(part) for part in match.groups())
    return date(year, month, day)


def parse_int(value: str, default: int = 0) -> int:
    stripped = value.strip()
    return int(stripped) if stripped else default


@dataclass(frozen=True, slots=True)
class FeedInfo:
    publisher: str
    version: str
    start: date | None
    end: date | None


def read_feed_info(archive: zipfile.ZipFile) -> FeedInfo:
    with open_table(archive, "feed_info.txt") as table:
        row = next(table.rows, None)
        if row is None:
            msg = "feed_info.txt has no row"
            raise GtfsError(msg)
        start = row[table.index("feed_start_date")]
        end = row[table.index("feed_end_date")]
        return FeedInfo(
            publisher=row[table.index("feed_publisher_name")],
            version=row[table.index("feed_version")],
            start=parse_date(start) if start else None,
            end=parse_date(end) if end else None,
        )
