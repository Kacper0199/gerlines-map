"""GTFS outputs for MOTIS and for validation.

``write_enriched`` copies the full feed (all modes) and changes only ``routes.txt``: every rail
route gets the extended route type of its canonical category (MOTIS derives its transport class
from the route type) and a ``gerlines_category`` column. ``write_subset`` writes a smaller,
self-contained feed with only the trips of the chosen categories.
"""

import csv
import io
import json
import shutil
import zipfile
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

from gerlines_static_import.categories import (
    ENRICHED_ROUTE_TYPE,
    RAIL_REPLACEMENT_BUS_ROUTE_TYPE,
    Category,
    Classification,
    classify,
    is_rail_type,
)
from gerlines_static_import.inventory import read_agency_names

CATEGORY_COLUMN = "gerlines_category"
BUS_ROUTE_TYPE = 700
_COPY_CHUNK = 1 << 22


@dataclass(slots=True)
class EnrichReport:
    routes: int = 0
    changed: Counter[str] = field(default_factory=Counter)
    categories: Counter[str] = field(default_factory=Counter)

    def as_dict(self) -> dict[str, object]:
        return {
            "routes": self.routes,
            "route_type_changes": dict(sorted(self.changed.items())),
            "routes_by_category": dict(sorted(self.categories.items())),
        }


def enriched_route_type(route_type: int, result: Classification) -> int:
    if not is_rail_type(route_type) or result.category is None:
        return route_type
    if result.category is Category.BUS:
        return RAIL_REPLACEMENT_BUS_ROUTE_TYPE if result.rule == "name:SEV" else BUS_ROUTE_TYPE
    return ENRICHED_ROUTE_TYPE.get(result.category, route_type)


@contextmanager
def _csv_writer(archive: zipfile.ZipFile, name: str) -> Iterator[Any]:
    with archive.open(name, "w", force_zip64=True) as raw:
        text: TextIO = io.TextIOWrapper(raw, encoding="utf-8", newline="")
        yield csv.writer(text, lineterminator="\n")
        text.flush()
        text.detach()


def _rows(archive: zipfile.ZipFile, name: str) -> Iterator[list[str]]:
    with archive.open(name) as raw:
        yield from csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def _copy_member(source: zipfile.ZipFile, target: zipfile.ZipFile, info: zipfile.ZipInfo) -> None:
    out_info = zipfile.ZipInfo(info.filename, date_time=info.date_time)
    out_info.compress_type = zipfile.ZIP_DEFLATED
    with source.open(info) as src, target.open(out_info, "w", force_zip64=True) as dst:
        shutil.copyfileobj(src, dst, _COPY_CHUNK)


def write_enriched(feed: Path, output: Path) -> EnrichReport:
    report = EnrichReport()
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.name + ".part")
    with zipfile.ZipFile(feed) as source:
        agencies = read_agency_names(source)
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as target:
            for info in source.infolist():
                if info.filename == "routes.txt":
                    _write_routes(source, target, agencies, report)
                else:
                    _copy_member(source, target, info)
    partial.replace(output)
    return report


def _write_routes(
    source: zipfile.ZipFile,
    target: zipfile.ZipFile,
    agencies: dict[str, str],
    report: EnrichReport,
) -> None:
    rows = _rows(source, "routes.txt")
    header = next(rows)
    kind = header.index("route_type")
    short = header.index("route_short_name")
    agency = header.index("agency_id") if "agency_id" in header else None
    with _csv_writer(target, "routes.txt") as writer:
        writer.writerow([*header, CATEGORY_COLUMN])
        for row in rows:
            if not row:
                continue
            report.routes += 1
            route_type = int(row[kind])
            agency_name = agencies.get(row[agency], "") if agency is not None else ""
            result = classify(route_type, row[short], agency_name)
            new_type = enriched_route_type(route_type, result)
            category = result.category.value if result.category is not None else ""
            report.categories[category or "unmapped"] += 1
            if new_type != route_type:
                report.changed[f"{route_type}->{new_type}"] += 1
                row[kind] = str(new_type)
            writer.writerow([*row, category])


@dataclass(slots=True)
class SubsetReport:
    rows: Counter[str] = field(default_factory=Counter)


def _filter_member(
    source: zipfile.ZipFile,
    target: zipfile.ZipFile,
    name: str,
    keep: Callable[[dict[str, int], list[str]], bool],
    report: SubsetReport,
) -> None:
    if name not in source.namelist():
        return
    rows = _rows(source, name)
    header = next(rows)
    columns = {column: index for index, column in enumerate(header)}
    with _csv_writer(target, name) as writer:
        writer.writerow(header)
        for row in rows:
            if row and keep(columns, row):
                writer.writerow(row)
                report.rows[name] += 1


def write_subset(
    feed: Path,
    output: Path,
    categories: frozenset[Category],
    *,
    only_trips: frozenset[str] | None = None,
) -> SubsetReport:
    """A self-contained feed with the trips of ``categories`` (only ``only_trips`` when given),
    their stops, shapes and services."""
    report = SubsetReport()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(feed) as source:
        agencies = read_agency_names(source)
        routes: set[str] = set()
        used_agencies: set[str] = set()
        for row in _dict_rows(source, "routes.txt"):
            result = classify(
                int(row["route_type"]),
                row["route_short_name"],
                agencies.get(row.get("agency_id", ""), ""),
            )
            if result.category in categories:
                routes.add(row["route_id"])
                used_agencies.add(row.get("agency_id", ""))
        trips: set[str] = set()
        services: set[str] = set()
        shapes: set[str] = set()
        for row in _dict_rows(source, "trips.txt"):
            if row["route_id"] in routes and (only_trips is None or row["trip_id"] in only_trips):
                trips.add(row["trip_id"])
                services.add(row["service_id"])
                if row.get("shape_id"):
                    shapes.add(row["shape_id"])
        stops: set[str] = set()
        partial = output.with_name(output.name + ".part")
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as target:

            def keep_stop_time(columns: dict[str, int], row: list[str]) -> bool:
                if row[columns["trip_id"]] in trips:
                    stops.add(row[columns["stop_id"]])
                    return True
                return False

            _filter_member(source, target, "stop_times.txt", keep_stop_time, report)
            parents = _parents(source, stops)
            stops |= parents
            stops |= _parents(source, parents)
            _filter_member(
                source,
                target,
                "agency.txt",
                lambda c, r: r[c["agency_id"]] in used_agencies,
                report,
            )
            _filter_member(
                source, target, "routes.txt", lambda c, r: r[c["route_id"]] in routes, report
            )
            _filter_member(
                source, target, "trips.txt", lambda c, r: r[c["trip_id"]] in trips, report
            )
            _filter_member(
                source, target, "stops.txt", lambda c, r: r[c["stop_id"]] in stops, report
            )
            for name in ("calendar.txt", "calendar_dates.txt"):
                _filter_member(
                    source, target, name, lambda c, r: r[c["service_id"]] in services, report
                )
            _filter_member(
                source, target, "shapes.txt", lambda c, r: r[c["shape_id"]] in shapes, report
            )
            _filter_member(
                source, target, "frequencies.txt", lambda c, r: r[c["trip_id"]] in trips, report
            )
            for name in ("feed_info.txt", "levels.txt"):
                if name in source.namelist():
                    _copy_member(source, target, source.getinfo(name))
                    report.rows[name] += 1
        partial.replace(output)
    return report


def _dict_rows(archive: zipfile.ZipFile, name: str) -> Iterator[dict[str, str]]:
    with archive.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def _parents(archive: zipfile.ZipFile, stops: set[str]) -> set[str]:
    return {
        row["parent_station"]
        for row in _dict_rows(archive, "stops.txt")
        if row["stop_id"] in stops and row.get("parent_station")
    }


def write_report(path: Path, payload: dict[str, object]) -> None:
    path.write_text(json.dumps(payload, indent=2, default=str) + "\n")
