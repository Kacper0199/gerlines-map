"""Distinct (route_type, route_short_name, agency) combinations of a feed with their category."""

import csv
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from gerlines_static_import.categories import classify, is_rail_type
from gerlines_static_import.gtfs import open_table, parse_int

INVENTORY_COLUMNS = ("route_type", "route_short_name", "agency_name", "routes", "category", "rule")


@dataclass(frozen=True, slots=True)
class Combination:
    route_type: int
    route_short_name: str
    agency_name: str
    routes: int
    category: str
    rule: str


def read_agency_names(archive: zipfile.ZipFile) -> dict[str, str]:
    with open_table(archive, "agency.txt") as table:
        agency_id = table.index("agency_id")
        agency_name = table.index("agency_name")
        return {row[agency_id]: row[agency_name] for row in table.rows}


def rail_route_combinations(archive: zipfile.ZipFile) -> list[Combination]:
    agencies = read_agency_names(archive)
    counts: Counter[tuple[int, str, str]] = Counter()
    with open_table(archive, "routes.txt") as table:
        route_type = table.index("route_type")
        short_name = table.index("route_short_name")
        agency_id = table.optional_index("agency_id")
        for row in table.rows:
            kind = parse_int(row[route_type])
            if not is_rail_type(kind):
                continue
            agency = agencies.get(row[agency_id], "") if agency_id is not None else ""
            counts[(kind, row[short_name], agency)] += 1
    combinations = []
    for (kind, name, agency), routes in sorted(counts.items()):
        result = classify(kind, name, agency)
        category = result.category.value if result.category is not None else ""
        combinations.append(Combination(kind, name, agency, routes, category, result.rule))
    return combinations


def write_inventory(combinations: list[Combination], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(INVENTORY_COLUMNS)
        for c in combinations:
            writer.writerow(
                [c.route_type, c.route_short_name, c.agency_name, c.routes, c.category, c.rule]
            )
