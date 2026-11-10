import re
from pathlib import Path

import pytest
import yaml

from gerlines_catalog.seeds import SeedError, read_catalog
from gerlines_static_import.load import DELFI
from gerlines_static_import.operators import normalise_name, slugify

from .conftest import CATALOG, MIGRATIONS


def test_the_committed_catalogue_is_valid() -> None:
    catalog = read_catalog(CATALOG)
    counts = catalog.counts()
    assert counts["categories"] == 9
    assert counts["operators"] >= 140
    assert counts["vehicle_series"] >= 75
    assert all(counts.values())


def test_categories_match_the_migration_codes_and_order() -> None:
    sql = (MIGRATIONS / "0010_catalog.up.sql").read_text()
    seeded = re.findall(r"\('([a-z]+)', '([^']+)', '\{[^']*\}', (?:true|false), (\d+)\)", sql)
    catalog = read_catalog(CATALOG)
    assert [(c.code, c.name.en, c.sort_order) for c in catalog.categories] == [
        (code, name, int(order)) for code, name, order in seeded
    ]


def test_the_delfi_source_row_equals_the_static_import_row() -> None:
    catalog = read_catalog(CATALOG)
    row = next(s for s in catalog.sources if s.source_id == DELFI.source_id)
    assert (row.name, str(row.homepage_url), row.licence, str(row.licence_url)) == (
        DELFI.name,
        DELFI.homepage_url,
        DELFI.licence,
        DELFI.licence_url,
    )
    assert row.attribution == DELFI.attribution


def test_every_operator_slug_follows_the_static_import_rule() -> None:
    catalog = read_catalog(CATALOG)
    for operator in catalog.operators:
        assert slugify(normalise_name(operator.feed_name)) == operator.operator_id


def _edit(folder: Path, name: str, change) -> None:
    path = folder / name
    rows = yaml.safe_load(path.read_text())
    change(rows)
    path.write_text(yaml.safe_dump(rows, allow_unicode=True, sort_keys=False))


def test_an_unknown_source_is_reported(catalog_copy: Path) -> None:
    _edit(catalog_copy, "liveries.yaml", lambda rows: rows[0].update(source="nobody"))
    with pytest.raises(SeedError, match="unknown source 'nobody'"):
        read_catalog(catalog_copy)


def test_a_series_operator_must_exist(catalog_copy: Path) -> None:
    _edit(
        catalog_copy,
        "vehicle-series.yaml",
        lambda rows: rows[0].update(operators=["no-such-operator"]),
    )
    with pytest.raises(SeedError, match="no-such-operator"):
        read_catalog(catalog_copy)


def test_duplicate_keys_and_aliases_are_reported(catalog_copy: Path) -> None:
    def duplicate(rows: list[dict]) -> None:
        rows.append(dict(rows[0]))

    _edit(catalog_copy, "operators.yaml", duplicate)
    with pytest.raises(SeedError) as caught:
        read_catalog(catalog_copy)
    problems = "\n".join(caught.value.problems)
    assert "appears 2 times" in problems


def test_every_problem_is_listed_at_once(catalog_copy: Path) -> None:
    _edit(catalog_copy, "liveries.yaml", lambda rows: rows[0].update(source="nobody"))
    _edit(catalog_copy, "categories.yaml", lambda rows: rows[0].update(sort_order=2))
    with pytest.raises(SeedError) as caught:
        read_catalog(catalog_copy)
    assert len(caught.value.problems) >= 2


def test_the_digest_changes_with_the_content(catalog_copy: Path) -> None:
    before = read_catalog(catalog_copy).content_sha256
    _edit(catalog_copy, "liveries.yaml", lambda rows: rows[0].update(name="Renamed livery"))
    assert read_catalog(catalog_copy).content_sha256 != before


def test_two_liveries_for_one_operator_series_and_line_are_ambiguous(catalog_copy: Path) -> None:
    def duplicate(rows: list[dict]) -> None:
        keyed = next(r for r in rows if r.get("operator_id") and r.get("series_ids"))
        rows.append({**keyed, "livery_id": "ambiguous-copy"})

    _edit(catalog_copy, "liveries.yaml", duplicate)
    with pytest.raises(SeedError, match=r"ambiguous-copy.*same operator and series"):
        read_catalog(catalog_copy)


def test_liveries_split_by_line_or_by_validity_are_not_ambiguous(catalog_copy: Path) -> None:
    def split(rows: list[dict]) -> None:
        keyed = next(r for r in rows if r.get("operator_id") and r.get("series_ids"))
        rows.append({**keyed, "livery_id": "line-split", "lines": ["S99"]})
        rows.append(
            {
                **keyed,
                "livery_id": "day-split",
                "valid_from": "2100-01-01",
                "valid_to": "2100-12-31",
            }
        )
        keyed.update(valid_to="2099-12-31")

    _edit(catalog_copy, "liveries.yaml", split)
    assert read_catalog(catalog_copy)


def test_liveries_whose_line_sets_overlap_are_ambiguous(catalog_copy: Path) -> None:
    def overlap(rows: list[dict]) -> None:
        keyed = next(r for r in rows if r.get("operator_id") and r.get("series_ids"))
        keyed.update(lines=["S1", "S4"])
        rows.append({**keyed, "livery_id": "overlap-copy", "lines": ["S1"]})

    _edit(catalog_copy, "liveries.yaml", overlap)
    with pytest.raises(SeedError, match=r"overlap-copy.*overlapping line set"):
        read_catalog(catalog_copy)


def test_a_line_livery_beside_a_plain_one_and_disjoint_lines_are_not_ambiguous(
    catalog_copy: Path,
) -> None:
    def split(rows: list[dict]) -> None:
        keyed = next(r for r in rows if r.get("operator_id") and r.get("series_ids"))
        keyed.update(lines=[])
        rows.append({**keyed, "livery_id": "plain-and-line", "lines": ["S1", "S4"]})
        rows.append({**keyed, "livery_id": "other-lines", "lines": ["S2"]})

    _edit(catalog_copy, "liveries.yaml", split)
    assert read_catalog(catalog_copy)


def test_a_livery_also_operator_must_exist(catalog_copy: Path) -> None:
    def name_one(rows: list[dict]) -> None:
        keyed = next(r for r in rows if r.get("operator_id") and r.get("series_ids"))
        keyed.update(also_operator_ids=["no-such-bahn"])

    _edit(catalog_copy, "liveries.yaml", name_one)
    with pytest.raises(SeedError, match=r"unknown 'no-such-bahn'"):
        read_catalog(catalog_copy)


def test_two_liveries_that_reach_one_also_operator_for_a_series_are_ambiguous(
    catalog_copy: Path,
) -> None:
    def twin(rows: list[dict]) -> None:
        keyed = next(r for r in rows if r.get("operator_id") and r.get("series_ids"))
        keyed.update(also_operator_ids=["db-fernverkehr-ag"])
        twin = {**keyed, "livery_id": "also-twin", "operator_id": "sncf"}
        rows.append(twin)

    _edit(catalog_copy, "liveries.yaml", twin)
    with pytest.raises(SeedError, match=r"also-twin.*also operator"):
        read_catalog(catalog_copy)
