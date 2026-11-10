"""Read every seed file of ``catalog/``, validate rows and the references between files."""

import csv
import hashlib
import io
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import yaml
from pydantic import BaseModel, ValidationError

from gerlines_catalog.bodies import body_problems
from gerlines_catalog.fleet import FleetRule, rule_problems
from gerlines_catalog.models import (
    Category,
    IdenticalBody,
    LineColour,
    Livery,
    Operator,
    Source,
    VehicleSeries,
    Verbund,
)
from gerlines_catalog.vehicles import VehicleModel

FILES = {
    "sources": "sources.yaml",
    "categories": "categories.yaml",
    "operators": "operators.yaml",
    "verbuende": "verbuende.yaml",
    "vehicle_series": "vehicle-series.yaml",
    "liveries": "liveries.yaml",
    "line_colours": "line-colours.csv",
    "vehicles": "vehicles.yaml",
    "fleet_rules": "fleet-rules.yaml",
    "identical_bodies": "identical-bodies.yaml",
}


class SeedError(ValueError):
    """One or more seed files are invalid; ``problems`` lists every finding."""

    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__(f"{len(problems)} problem(s) in the seeds:\n" + "\n".join(problems))
        self.problems = list(problems)


@dataclass(frozen=True, slots=True)
class Catalog:
    sources: list[Source]
    categories: list[Category]
    operators: list[Operator]
    verbuende: list[Verbund]
    vehicle_series: list[VehicleSeries]
    liveries: list[Livery]
    line_colours: list[LineColour]
    vehicles: list[VehicleModel]
    fleet_rules: list[FleetRule]
    identical_bodies: list[IdenticalBody]
    content_sha256: str

    def counts(self) -> dict[str, int]:
        return {name: len(getattr(self, name)) for name in FILES}


def _rows[T: BaseModel](
    model: type[T], records: object, file_name: str, problems: list[str]
) -> list[T]:
    if not isinstance(records, list):
        problems.append(f"{file_name}: expected a list of rows")
        return []
    rows: list[T] = []
    for index, record in enumerate(records):
        try:
            rows.append(model.model_validate(record))
        except ValidationError as error:
            for item in error.errors():
                where = ".".join(str(part) for part in item["loc"])
                problems.append(f"{file_name}[{index}] {where}: {item['msg']}")
    return rows


def _duplicates(file_name: str, keys: Iterable[str], problems: list[str]) -> None:
    for key, count in Counter(keys).items():
        if count > 1:
            problems.append(f"{file_name}: key {key!r} appears {count} times")


def _load_csv(text: str) -> list[dict[str, str | None]]:
    return [
        {key: (value if value != "" else None) for key, value in row.items()}
        for row in csv.DictReader(io.StringIO(text))
    ]


def _reference_problems(  # noqa: PLR0913, PLR0917
    sources: list[Source],
    categories: list[Category],
    operators: list[Operator],
    verbuende_rows: list[Verbund],
    series: list[VehicleSeries],
    liveries: list[Livery],
    lines: list[LineColour],
) -> list[str]:
    source_ids = {s.source_id for s in sources}
    operator_ids = {o.operator_id for o in operators}
    series_ids = {s.series_id for s in series}
    sourced: list[tuple[str, str, set[str]]] = [
        *((FILES["categories"], c.code, c.referenced_sources()) for c in categories),
        *((FILES["operators"], o.operator_id, o.referenced_sources()) for o in operators),
        *((FILES["verbuende"], v.verbund_id, v.referenced_sources()) for v in verbuende_rows),
        *((FILES["vehicle_series"], s.series_id, s.referenced_sources()) for s in series),
        *((FILES["liveries"], lv.livery_id, lv.referenced_sources()) for lv in liveries),
        *((FILES["line_colours"], lc.line_colour_id, {lc.source}) for lc in lines),
    ]
    return [
        *(
            f"{file_name} {key}: unknown source {source!r}"
            for file_name, key, used in sourced
            for source in sorted(used - source_ids)
        ),
        *(
            f"{FILES['vehicle_series']} {s.series_id}: unknown {operator!r}"
            for s in series
            for operator in s.operators
            if operator not in operator_ids
        ),
        *(
            f"{FILES['liveries']} {lv.livery_id}: unknown {lv.operator_id!r}"
            for lv in liveries
            if lv.operator_id and lv.operator_id not in operator_ids
        ),
        *(
            f"{FILES['liveries']} {lv.livery_id}: unknown {operator!r}"
            for lv in liveries
            for operator in lv.also_operator_ids
            if operator not in operator_ids
        ),
        *(
            f"{FILES['liveries']} {lv.livery_id}: unknown {series_id!r}"
            for lv in liveries
            for series_id in lv.series_ids
            if series_id not in series_ids
        ),
        *(
            f"{FILES['line_colours']} {lc.line_colour_id}: unknown operator"
            for lc in lines
            if lc.operator_id and lc.operator_id not in operator_ids
        ),
    ]


def _vehicle_problems(
    vehicles: list[VehicleModel],
    sources: list[Source],
    categories: list[Category],
    series: list[VehicleSeries],
    liveries: list[Livery],
) -> list[str]:
    source_ids = {s.source_id for s in sources}
    codes = {c.code for c in categories}
    series_ids = {s.series_id for s in series}
    livery_ids = {lv.livery_id for lv in liveries}
    name = FILES["vehicles"]
    return [
        *(
            f"{name} {v.model_id}: unknown source {source!r}"
            for v in vehicles
            for source in sorted(v.referenced_sources() - source_ids)
        ),
        *(
            f"{name} {v.model_id}: unknown category {v.category!r}"
            for v in vehicles
            if v.category not in codes
        ),
        *(
            f"{name} {v.model_id}: unknown series {v.series_id!r}"
            for v in vehicles
            if v.series_id and v.series_id not in series_ids
        ),
        *(
            f"{name} {v.model_id}: unknown livery {v.livery_id!r}"
            for v in vehicles
            if v.livery_id and v.livery_id not in livery_ids
        ),
    ]


def _livery_series(livery: Livery, vehicles: list[VehicleModel]) -> set[str]:
    named = {v.series_id for v in vehicles if v.livery_id == livery.livery_id and v.series_id}
    return named | set(livery.series_ids)


def _days_overlap(a: Livery, b: Livery) -> bool:
    starts = max(a.valid_from or date.min, b.valid_from or date.min)
    ends = min(a.valid_to or date.max, b.valid_to or date.max)
    return starts <= ends


def _lines_overlap(a: Livery, b: Livery) -> bool:
    if not a.lines and not b.lines:
        return True
    return bool(set(a.lines) & set(b.lines))


def _livery_rule_problems(vehicles: list[VehicleModel], liveries: list[Livery]) -> list[str]:
    """Liveries of one operator and series must not share a line (or both name none) on a day."""
    keyed = [(lv, _livery_series(lv, vehicles)) for lv in liveries if lv.operator_id]
    same = [
        f"{FILES['liveries']} {later.livery_id}: same operator and series and an overlapping "
        f"line set as {earlier.livery_id} on the same days"
        for index, (later, later_series) in enumerate(keyed)
        for earlier, earlier_series in keyed[:index]
        if earlier.operator_id == later.operator_id
        and _lines_overlap(earlier, later)
        and earlier_series & later_series
        and _days_overlap(earlier, later)
    ]
    also = [
        f"{FILES['liveries']} {later.livery_id}: reaches the also operator "
        f"{min(set(earlier.also_operator_ids) & set(later.also_operator_ids))!r} of "
        f"{earlier.livery_id} for the same series on the same days"
        for index, (later, later_series) in enumerate(keyed)
        for earlier, earlier_series in keyed[:index]
        if set(earlier.also_operator_ids) & set(later.also_operator_ids)
        and earlier_series & later_series
        and _days_overlap(earlier, later)
    ]
    return same + also


def _drawn_formations(vehicles: list[VehicleModel]) -> dict[str, int]:
    """Cars of the first non-generic model per series, the one the web draws for it."""
    drawn: dict[str, int] = {}
    for model in vehicles:
        if model.series_id and not model.generic:
            drawn.setdefault(model.series_id, len(model.formation))
    return drawn


def content_digest(folder: Path) -> str:
    digest = hashlib.sha256()
    for name in sorted(FILES.values()):
        digest.update(name.encode() + b"\0" + (folder / name).read_bytes() + b"\0")
    return digest.hexdigest()


def read_catalog(folder: Path) -> Catalog:
    """Parse and validate ``folder``; raise ``SeedError`` with every problem found."""
    problems: list[str] = []
    raw: dict[str, object] = {}
    for key, name in FILES.items():
        path = folder / name
        if not path.is_file():
            problems.append(f"{name}: missing")
            raw[key] = []
            continue
        text = path.read_text(encoding="utf-8")
        try:
            raw[key] = _load_csv(text) if name.endswith(".csv") else yaml.safe_load(text)
        except yaml.YAMLError as error:
            problems.append(f"{name}: not valid YAML ({error})")
            raw[key] = []
    sources = _rows(Source, raw["sources"], FILES["sources"], problems)
    categories = _rows(Category, raw["categories"], FILES["categories"], problems)
    operators = _rows(Operator, raw["operators"], FILES["operators"], problems)
    verbuende_rows = _rows(Verbund, raw["verbuende"], FILES["verbuende"], problems)
    series = _rows(VehicleSeries, raw["vehicle_series"], FILES["vehicle_series"], problems)
    liveries = _rows(Livery, raw["liveries"], FILES["liveries"], problems)
    lines = _rows(LineColour, raw["line_colours"], FILES["line_colours"], problems)
    vehicles = _rows(VehicleModel, raw["vehicles"], FILES["vehicles"], problems)
    fleet_rules = _rows(FleetRule, raw["fleet_rules"], FILES["fleet_rules"], problems)
    bodies = _rows(IdenticalBody, raw["identical_bodies"], FILES["identical_bodies"], problems)

    _duplicates(FILES["sources"], (s.source_id for s in sources), problems)
    _duplicates(FILES["categories"], (c.code for c in categories), problems)
    _duplicates(FILES["categories"], (str(c.sort_order) for c in categories), problems)
    _duplicates(FILES["operators"], (o.operator_id for o in operators), problems)
    _duplicates(
        FILES["operators"] + " aliases",
        (f"{a.source}:{a.alias}" for o in operators for a in o.aliases),
        problems,
    )
    _duplicates(FILES["verbuende"], (v.verbund_id for v in verbuende_rows), problems)
    _duplicates(FILES["vehicle_series"], (s.series_id for s in series), problems)
    _duplicates(FILES["liveries"], (lv.livery_id for lv in liveries), problems)
    _duplicates(FILES["line_colours"], (lc.line_colour_id for lc in lines), problems)
    _duplicates(FILES["vehicles"], (v.model_id for v in vehicles), problems)
    _duplicates(FILES["fleet_rules"], (r.rule_id for r in fleet_rules), problems)

    problems += _reference_problems(
        sources, categories, operators, verbuende_rows, series, liveries, lines
    )
    problems += _vehicle_problems(vehicles, sources, categories, series, liveries)
    problems += _livery_rule_problems(vehicles, liveries)
    problems += body_problems(
        bodies,
        {s.source_id for s in sources},
        {s.series_id for s in series},
        _drawn_formations(vehicles),
        {s.series_id: (s.cars_min, s.cars_max) for s in series},
    )
    problems += rule_problems(
        fleet_rules,
        {s.source_id for s in sources},
        {o.operator_id for o in operators},
        {c.code for c in categories},
        {s.series_id for s in series},
        {v.model_id for v in vehicles if v.generic},
    )
    if problems:
        raise SeedError(problems)
    return Catalog(
        sources=sources,
        categories=categories,
        operators=operators,
        verbuende=verbuende_rows,
        vehicle_series=series,
        liveries=liveries,
        line_colours=lines,
        vehicles=vehicles,
        fleet_rules=fleet_rules,
        identical_bodies=bodies,
        content_sha256=content_digest(folder),
    )
