from datetime import date
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from gerlines_catalog.fleet import (
    FleetRule,
    cited_revision_problem,
    ice_line_rules,
    ice_line_vehicles,
    line_key,
    series_of,
)
from gerlines_catalog.seeds import SeedError, read_catalog

from .conftest import CATALOG

LINE = {
    "rule_id": "nrw-s1",
    "scope": "line",
    "operator_id": "db-regio-ag-nrw",
    "category": "sbahn",
    "lines": ["S1"],
    "series_ids": ["db-422"],
    "units": 2,
    "valid_from": "2025-12-14",
    "valid_to": "2026-12-12",
    "source": "wikipedia-de-s-bahn-rhein-ruhr",
    "evidence": "S 1: 2x 422",
}
OPERATOR = {
    "rule_id": "operator-x",
    "scope": "operator",
    "operator_id": "s-bahn-berlin-gmbh",
    "series_ids": ["db-481"],
    "fleet_count": 500,
    "fleet_total": 756,
    "source": "wikipedia-de-s-bahn-berlin",
    "evidence": "500 of 756",
}

ICE_LIST = """== Aktuelle Linien (2026) ==
{| class="wikitable"
|-
! Liniennummer
! colspan="2" | Linienverlauf
! Fahrzeuge
|-
| {{Bahnlinie|ICE|6|ICE}} (1162/1163)
| colspan="2" | [[Berlin Hauptbahnhof|Berlin]]&nbsp;- [[Stuttgart Hauptbahnhof|Stuttgart]]
| [[ICE 3]]
|-
| {{Bahnlinie|ICE|29|ICE}} (1002/1003)
| colspan="2" | [[Berlin Hauptbahnhof|Berlin]]&nbsp;- [[München Hauptbahnhof|München]]
| [[ICE 3]]
|}

==== Linie 10 ====
{| class="wikitable" style="width:100%"
|-
! Linie
! colspan="2" | Linienverlauf
! Fahrzeuge
|-
| rowspan="2" style="color:#1464A6;" | '''ICE&nbsp;10'''
| rowspan="2" | [[Berlin Hauptbahnhof|Berlin]]&nbsp;-
| [[Köln Hauptbahnhof|Köln]]
| rowspan="2" | [[ICE 2]], [[ICE 4]] (7-teilig)
|-
| [[Wuppertal Hauptbahnhof|Wuppertal]]
|}

==== Linie 11 ====
{| class="wikitable" style="width:100%"
|-
! Linie
! Linienverlauf
! Fahrzeuge
|-
| style="color:#63E0B0;" | '''ICE&nbsp;11'''
| [[Berlin Hauptbahnhof|Berlin Hbf]]&nbsp;- [[München Hauptbahnhof|München]]
| [[ICE 4]]
|}

==== Linie 20 ====
{| class="wikitable"
|-
! Linie
! Linienverlauf
! Fahrzeuge
|-
| '''ICE&nbsp;20'''
| [[Basel SBB]]
| [[ICE 4]], [[Unbekannter Zug]]
|}

==== Linie 29 ====
{| class="wikitable"
|-
! Linie
! Linienverlauf
! Fahrzeuge
|-
| '''ICE&nbsp;29'''
| [[Berlin Hauptbahnhof|Berlin]]
| [[DB-Baureihe 408|ICE 3neo]]
|}

== Eingestellte Linien ==
{| class="wikitable"
|-
! Linie
! Fahrzeuge
|-
| '''ICE&nbsp;5'''
| [[ICE 1]]
|}
"""


def test_a_line_rule_is_valid_and_lines_compare_without_case_or_spaces() -> None:
    rule = FleetRule.model_validate(LINE)
    assert rule.units == 2
    assert line_key(" re 1 ") == "RE1"


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"lines": []}, "needs lines"),
        ({"series_ids": []}, "needs series_ids"),
        ({"operator_id": None}, "needs operator_id"),
        ({"fleet_count": 3}, "no model_id or fleet counts"),
        ({"lines": ["S1", "s 1"]}, "repeat a line"),
        ({"series_ids": ["db-422", "db-422"]}, "repeat a series"),
        ({"valid_to": "2025-01-01"}, "valid_to before valid_from"),
        ({"units": 5}, "less than or equal to 4"),
    ],
)
def test_line_rules_refuse_incomplete_rows(change: dict, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        FleetRule.model_validate({**LINE, **change})


def test_operator_rules_need_one_series_and_their_fleet_share() -> None:
    assert FleetRule.model_validate(OPERATOR).fleet_count == 500
    with pytest.raises(ValidationError, match="exactly one series"):
        FleetRule.model_validate({**OPERATOR, "series_ids": ["db-481", "db-480"]})
    with pytest.raises(ValidationError, match="fleet_count above fleet_total"):
        FleetRule.model_validate({**OPERATOR, "fleet_count": 800})
    with pytest.raises(ValidationError, match="needs fleet_count"):
        FleetRule.model_validate({**OPERATOR, "fleet_total": None})


def test_category_rules_name_a_model_and_nothing_else() -> None:
    row = {
        "rule_id": "generic-hsr",
        "scope": "category",
        "category": "hsr",
        "model_id": "generic-hsr",
        "source": "gerlines",
        "evidence": "x",
    }
    assert FleetRule.model_validate(row).model_id == "generic-hsr"
    with pytest.raises(ValidationError, match="takes no operator"):
        FleetRule.model_validate({**row, "operator_id": "db-regio-ag-nrw"})


def test_rules_overlap_only_on_shared_lines_and_days() -> None:
    first = FleetRule.model_validate(LINE)
    same = FleetRule.model_validate({**LINE, "rule_id": "other", "lines": ["s1", "S2"]})
    later = FleetRule.model_validate(
        {**LINE, "rule_id": "later", "valid_from": "2026-12-13", "valid_to": None}
    )
    other_line = FleetRule.model_validate({**LINE, "rule_id": "s4", "lines": ["S4"]})
    other_category = FleetRule.model_validate({**LINE, "rule_id": "re", "category": "rfast"})
    assert first.overlaps(same)
    assert not first.overlaps(later)
    assert not first.overlaps(other_line)
    assert not first.overlaps(other_category)


def test_the_ice_list_parser_reads_the_vehicle_cell_of_current_lines_only() -> None:
    found = [(entry.line, entry.articles) for entry in ice_line_vehicles(ICE_LIST)]
    assert found == [
        ("6", ("ICE 3",)),
        ("29", ("ICE 3",)),
        ("10", ("ICE 2", "ICE 4")),
        ("11", ("ICE 4",)),
        ("20", ("ICE 4", "Unbekannter Zug")),
        ("29", ("DB-Baureihe 408",)),
    ]
    assert series_of(("ICE 4", "Unbekannter Zug")) is None
    assert series_of(("ICE 3", "DB-Baureihe 408")) == ("db-403", "db-406", "db-407", "db-408")


def test_ice_rules_merge_repeated_lines_and_skip_unmapped_ones() -> None:
    rows = ice_line_rules(
        ICE_LIST, "wikipedia-de-ice-linien", date(2025, 12, 14), date(2026, 12, 12)
    )
    assert [(r["rule_id"], r["series_ids"]) for r in rows] == [
        ("ice-line-6", ["db-403", "db-406", "db-407", "db-408"]),
        ("ice-line-10", ["db-402", "db-412"]),
        ("ice-line-11", ["db-412"]),
        ("ice-line-29", ["db-403", "db-406", "db-407", "db-408"]),
    ]
    assert rows[3]["evidence"] == "[[ICE 3]] / [[DB-Baureihe 408|ICE 3neo]]"
    for row in rows:
        FleetRule.model_validate(row)


def test_the_committed_rules_cover_every_category_and_cite_known_rows() -> None:
    rules = read_catalog(CATALOG).fleet_rules
    categories = {r.category for r in rules if r.scope == "category"}
    assert categories == {"hsr", "ld", "night", "rfast", "reg", "sbahn", "urban", "bus", "other"}
    assert all(r.source.startswith("wikipedia-de-") for r in rules if r.scope != "category")


def _edit(folder: Path, change) -> None:
    path = folder / "fleet-rules.yaml"
    rows = yaml.safe_load(path.read_text())
    change(rows)
    path.write_text(yaml.safe_dump(rows, allow_unicode=True, sort_keys=False))


def test_unknown_series_and_overlapping_rules_are_reported(catalog_copy: Path) -> None:
    def change(rows: list[dict]) -> None:
        rows[0]["series_ids"] = ["db-999"]
        rows.append({**rows[1], "rule_id": "copy-of-second"})

    _edit(catalog_copy, change)
    with pytest.raises(SeedError) as error:
        read_catalog(catalog_copy)
    text = str(error.value)
    assert "unknown series 'db-999'" in text
    assert "overlaps copy-of-second" in text


def test_a_category_rule_must_name_a_generic_model(catalog_copy: Path) -> None:
    def change(rows: list[dict]) -> None:
        rule = next(r for r in rows if r["scope"] == "category")
        rule["model_id"] = "db-412-7"

    _edit(catalog_copy, change)
    with pytest.raises(SeedError, match="is not a generic model"):
        read_catalog(catalog_copy)


def test_ice_rows_cite_only_the_revision_they_were_built_from() -> None:
    url = "https://de.wikipedia.org/w/index.php?oldid=271933115"
    assert cited_revision_problem("wikipedia-de-ice-linien", url, 271933115) is None
    assert "cites revision 271933115, the fetched page is revision 272000000" in (
        cited_revision_problem("wikipedia-de-ice-linien", url, 272000000) or ""
    )
    assert "names no oldid" in (
        cited_revision_problem("x-y", "https://de.wikipedia.org/wiki/Liste", 1) or ""
    )
    assert "not in sources.yaml" in (cited_revision_problem("x-y", None, 1) or "")
