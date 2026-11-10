"""Fleet rules of ``catalog/fleet-rules.yaml``: which series runs a line, an operator or a category.

Layer L2 of the vehicle identity (ADR-0011) reads rules of scope ``line``, layer L3 rules of scope
``operator`` and layer L4 rules of scope ``category``. Every rule cites its source; a line no source
describes has no rule and falls through to the operator or category rule.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from typing import Annotated

from pydantic import Field, model_validator

from gerlines_catalog.models import Slug, Sourced, Text

CATEGORY_CODE = r"^[a-z]{2,16}$"
MAX_UNITS = 4


class RuleScope(StrEnum):
    LINE = "line"
    OPERATOR = "operator"
    CATEGORY = "category"


def line_key(line: str) -> str:
    """The form lines are compared in: upper case without spaces ("re 1" and "RE1" are one line)."""
    return re.sub(r"\s+", "", line).upper()


class FleetRule(Sourced):
    rule_id: Slug
    scope: RuleScope
    operator_id: Slug | None = None
    category: Annotated[str, Field(pattern=CATEGORY_CODE)] | None = None
    lines: list[Text] = Field(default_factory=list)
    series_ids: list[Slug] = Field(default_factory=list)
    model_id: Slug | None = None
    units: Annotated[int, Field(ge=1, le=MAX_UNITS)] | None = None
    fleet_count: Annotated[int, Field(ge=1)] | None = None
    fleet_total: Annotated[int, Field(ge=1)] | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    match_share: Annotated[float, Field(ge=0, le=1)] | None = None
    evidence: Text

    @model_validator(mode="after")
    def _shape_fits_scope(self) -> "FleetRule":
        problems = {
            RuleScope.LINE: self._line_problems,
            RuleScope.OPERATOR: self._operator_problems,
            RuleScope.CATEGORY: self._category_problems,
        }[self.scope]()
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            problems.append("valid_to before valid_from")
        if len(set(self.series_ids)) != len(self.series_ids):
            problems.append("series_ids repeat a series")
        if len({line_key(line) for line in self.lines}) != len(self.lines):
            problems.append("lines repeat a line")
        if problems:
            msg = f"{self.rule_id}: " + ", ".join(problems)
            raise ValueError(msg)
        return self

    def _line_problems(self) -> list[str]:
        found = []
        if not self.operator_id:
            found.append("a line rule needs operator_id")
        if not self.lines:
            found.append("a line rule needs lines")
        if not self.series_ids:
            found.append("a line rule needs series_ids")
        if self.model_id or self.fleet_count or self.fleet_total:
            found.append("a line rule takes no model_id or fleet counts")
        return found

    def _operator_problems(self) -> list[str]:
        found = []
        if not self.operator_id:
            found.append("an operator rule needs operator_id")
        if self.lines or self.model_id or self.units or self.match_share is not None:
            found.append("an operator rule takes no lines, model_id, units or match_share")
        if len(self.series_ids) != 1:
            found.append("an operator rule names exactly one series, its dominant one")
        if self.fleet_count is None or self.fleet_total is None:
            found.append("an operator rule needs fleet_count and fleet_total from its source")
        elif self.fleet_count > self.fleet_total:
            found.append("fleet_count above fleet_total")
        return found

    def _category_problems(self) -> list[str]:
        found = []
        if not self.category or not self.model_id:
            found.append("a category rule needs category and model_id")
        if self.operator_id or self.lines or self.series_ids or self.units or self.match_share:
            found.append("a category rule takes no operator, lines, series, units or match_share")
        if self.fleet_count or self.fleet_total:
            found.append("a category rule takes no fleet counts")
        return found

    def overlaps(self, other: "FleetRule") -> bool:
        """True when both rules could answer the same train on the same day."""
        if self.scope is not other.scope or self.rule_id == other.rule_id:
            return False
        if (self.operator_id, self.category) != (other.operator_id, other.category):
            return False
        if self.scope is RuleScope.LINE:
            mine = {line_key(line) for line in self.lines}
            if not mine & {line_key(line) for line in other.lines}:
                return False
        starts = max(self.valid_from or date.min, other.valid_from or date.min)
        ends = min(self.valid_to or date.max, other.valid_to or date.max)
        return starts <= ends


def rule_problems(  # noqa: PLR0913, PLR0917
    rules: list[FleetRule],
    source_ids: set[str],
    operator_ids: set[str],
    category_codes: set[str],
    series_ids: set[str],
    generic_models: set[str],
) -> list[str]:
    name = "fleet-rules.yaml"
    found: list[str] = []
    for rule in rules:
        found += [
            f"{name} {rule.rule_id}: unknown source {source!r}"
            for source in sorted(rule.referenced_sources() - source_ids)
        ]
        if rule.operator_id and rule.operator_id not in operator_ids:
            found.append(f"{name} {rule.rule_id}: unknown operator {rule.operator_id!r}")
        if rule.category and rule.category not in category_codes:
            found.append(f"{name} {rule.rule_id}: unknown category {rule.category!r}")
        found += [
            f"{name} {rule.rule_id}: unknown series {series!r}"
            for series in rule.series_ids
            if series not in series_ids
        ]
        if rule.model_id and rule.model_id not in generic_models:
            found.append(f"{name} {rule.rule_id}: {rule.model_id!r} is not a generic model")
    for index, rule in enumerate(rules):
        found += [
            f"{name} {rule.rule_id}: overlaps {other.rule_id}"
            for other in rules[index + 1 :]
            if rule.overlaps(other)
        ]
    return found


ICE_LIST_TITLE = "Liste der Intercity-Express-Linien"

_OLDID = re.compile(r"[?&]oldid=(\d+)(?:&|$)")


def cited_revision_problem(
    source_id: str, source_url: str | None, fetched_revid: int
) -> str | None:
    """Why rows built from the fetched revision may not cite `source_id`, or None when they may."""
    if source_url is None:
        return f"source {source_id} is not in sources.yaml"
    match = _OLDID.search(source_url)
    if match is None:
        return f"source {source_id} names no oldid revision: {source_url}"
    cited = int(match.group(1))
    if cited != fetched_revid:
        return (
            f"source {source_id} cites revision {cited}, "
            f"the fetched page is revision {fetched_revid}: "
            "add a source row for the new revision or refresh the cache"
        )
    return None


CURRENT_SECTION_END = "== Eingestellte Linien =="

ARTICLE_SERIES: dict[str, tuple[str, ...]] = {
    "ICE 1": ("db-401",),
    "ICE 2": ("db-402",),
    "ICE 3": ("db-403", "db-406", "db-407", "db-408"),
    "DB-Baureihe 408": ("db-408",),
    "ICE 4": ("db-412",),
    "ICE T": ("db-411", "db-415"),
    "ICE L": ("db-ice-l",),
    "TGV Duplex": ("sncf-tgv-duplex",),
    "Railjet 1. Generation": ("obb-railjet",),
    "Railjet": ("obb-railjet", "obb-railjet-2"),
    "SBB RABe 501": ("sbb-rabe-501",),
}
ICE_OPERATOR = "db-fernverkehr-ag"
ICE_CATEGORY = "hsr"

_TABLE = re.compile(r"^\{\|.*?^\|\}", re.DOTALL | re.MULTILINE)
_VEHICLE_HEADER = re.compile(r"^!\s*Fahrzeuge?\s*$", re.MULTILINE)
_LINE_LABEL = re.compile(r"\{\{Bahnlinie\|ICE\|(\d+)\|ICE\}\}|'''ICE&nbsp;(\d+)'''")
_LINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
_ROW_ATTRIBUTES = re.compile(r'^\s*(?:(?:rowspan|colspan|style)="[^"]*"\s*)+\|')


@dataclass(frozen=True, slots=True)
class LineVehicles:
    line: str
    cell: str
    articles: tuple[str, ...]


def _cells(row: str) -> list[str]:
    cells = []
    for part in re.split(r"\n\|(?!\})", "\n" + row.removesuffix("|}")):
        text = _ROW_ATTRIBUTES.sub("", part).strip()
        if text and not text.startswith(("!", "-", "}")):
            cells.append(text)
    return cells


def ice_line_vehicles(wikitext: str) -> list[LineVehicles]:
    """The vehicle cell of every current line in the ICE line list, in page order.

    Each line table has a vehicle column; the first row naming a line carries the cell as its last
    cell (later rows of a rowspan only continue the route). Lines whose cell links no article are
    left out.
    """
    current = wikitext.split(CURRENT_SECTION_END, 1)[0]
    found: list[LineVehicles] = []
    for table in _TABLE.findall(current):
        if not _VEHICLE_HEADER.search(table):
            continue
        for row in re.split(r"\n\|-[^\n]*", table):
            label = _LINE_LABEL.search(row)
            cells = _cells(row)
            if not label or not cells:
                continue
            cell = cells[-1]
            articles = tuple(_LINK.findall(cell))
            if articles:
                found.append(LineVehicles(label.group(1) or label.group(2), cell, articles))
    return found


def series_of(articles: Iterable[str]) -> tuple[str, ...] | None:
    """Series of the linked articles in link order, None when an article is not mapped."""
    series: list[str] = []
    for article in articles:
        mapped = ARTICLE_SERIES.get(article)
        if mapped is None:
            return None
        series += [s for s in mapped if s not in series]
    return tuple(series)


def ice_line_rules(
    wikitext: str, source_id: str, valid_from: date, valid_to: date
) -> list[dict[str, object]]:
    """Seed rows of scope ``line`` for every current ICE line whose vehicle cell maps to series.

    A line listed twice (as a sprinter and as a regular line) gets one row with the series of both
    cells. Lines with an article the mapping does not know are left out.
    """
    merged: dict[str, tuple[list[str], list[str]]] = {}
    for entry in ice_line_vehicles(wikitext):
        series = series_of(entry.articles)
        if series is None:
            continue
        known, cells = merged.setdefault(entry.line, ([], []))
        known += [s for s in series if s not in known]
        cells.append(entry.cell)
    return [
        {
            "rule_id": f"ice-line-{line}",
            "scope": RuleScope.LINE.value,
            "operator_id": ICE_OPERATOR,
            "category": ICE_CATEGORY,
            "lines": [line],
            "series_ids": series,
            "valid_from": valid_from,
            "valid_to": valid_to,
            "source": source_id,
            "evidence": " / ".join(cells),
        }
        for line, (series, cells) in sorted(merged.items(), key=lambda item: int(item[0]))
    ]
