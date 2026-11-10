from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from gerlines_catalog.bodies import body_problems
from gerlines_catalog.models import IdenticalBody
from gerlines_catalog.seeds import SeedError, read_catalog

from .conftest import CATALOG

SOURCES = {"wikipedia-de-test", "gerlines"}
SERIES = {"a-old", "a-new", "b-old", "b-new", "c-new"}
FORMATIONS = {"a-new": 4, "b-new": 4, "c-new": 2}
CARS = {"a-old": (4, 4), "b-old": (2, 6), "a-new": (4, 4), "b-new": (4, 4), "c-new": (2, 2)}


def row(**overrides: Any) -> IdenticalBody:
    data: dict[str, Any] = {
        "series_id": "a-old",
        "related_series_id": "a-new",
        "verdict": "accepted",
        "source": "wikipedia-de-test",
        "evidence": "Die Wagenkästen beider Baureihen sind baugleich.",
        "reason": "The article calls the car bodies of both series identical.",
    }
    data.update(overrides)
    return IdenticalBody.model_validate(data)


def problems(*rows: IdenticalBody) -> list[str]:
    return body_problems(list(rows), SOURCES, SERIES, FORMATIONS, CARS)


def test_an_accepted_pair_with_a_source_onto_a_modelled_series_is_valid() -> None:
    assert problems(row()) == []


def test_a_row_needs_its_evidence_and_its_reason() -> None:
    with pytest.raises(ValidationError):
        row(evidence=" ")
    with pytest.raises(ValidationError):
        row(reason="")


def test_both_series_must_exist() -> None:
    found = "\n".join(problems(row(series_id="nobody"), row(related_series_id="nowhere")))
    assert "unknown series 'nobody'" in found
    assert "unknown series 'nowhere'" in found


def test_the_source_must_exist_and_may_not_be_our_own_word() -> None:
    assert any("unknown source 'nobody'" in p for p in problems(row(source="nobody")))
    assert any("own word" in p for p in problems(row(source="gerlines")))
    assert problems(row(source="gerlines", verdict="rejected")) == []


def test_a_series_is_not_its_own_body() -> None:
    assert any("itself" in p for p in problems(row(series_id="a-new", related_series_id="a-new")))


def test_an_accepted_pair_must_land_on_a_series_with_a_forge_model() -> None:
    found = problems(row(related_series_id="b-old"))
    assert any("'b-old' has no forge model" in p for p in found)


def test_an_accepted_series_that_has_its_own_model_is_refused() -> None:
    found = problems(row(series_id="b-new", related_series_id="a-new"))
    assert any("'b-new' already has a forge model" in p for p in found)


def test_a_mapped_series_may_not_be_the_related_series_of_another_row() -> None:
    first = row(series_id="a-old", related_series_id="b-old")
    second = row(series_id="b-old", related_series_id="c-new")
    found = "\n".join(problems(first, second))
    assert "chain" in found


def test_a_chain_is_refused_whatever_the_order_of_the_rows() -> None:
    first = row(series_id="b-old", related_series_id="c-new")
    second = row(series_id="a-old", related_series_id="b-old")
    assert "chain" in "\n".join(problems(first, second))


def test_our_own_word_is_refused_as_a_field_source_too() -> None:
    assert any("own word" in p for p in problems(row(field_sources={"evidence": "gerlines"})))


def test_the_related_model_must_have_as_many_cars_as_the_series_has() -> None:
    assert problems(row(series_id="b-old", related_series_id="b-new")) == []
    assert problems(row(series_id="b-old", related_series_id="c-new")) == []
    assert problems(row(series_id="b-old", related_series_id="a-new")) == []
    short = problems(row(series_id="a-old", related_series_id="c-new"))
    assert any("2 cars" in p and "4 to 4" in p for p in short)


def test_a_series_whose_car_count_is_unknown_cannot_be_checked() -> None:
    cars = {**CARS, "a-old": (None, None)}
    found = body_problems([row()], SOURCES, SERIES, FORMATIONS, cars)
    assert any("cars_min and cars_max" in p for p in found)


def test_a_series_maps_to_one_body_only() -> None:
    found = problems(row(), row(related_series_id="b-new"))
    assert any("'a-old' appears in two accepted rows" in p for p in found)


def test_a_pair_is_listed_once_and_not_as_accepted_and_rejected() -> None:
    assert any("twice" in p for p in problems(row(), row()))
    assert any("both accepted and rejected" in p for p in problems(row(), row(verdict="rejected")))


def test_a_rejected_row_may_name_a_series_without_a_forge_model() -> None:
    assert problems(row(verdict="rejected", related_series_id="b-old")) == []


def _edit(folder: Path, change) -> None:
    path = folder / "identical-bodies.yaml"
    rows = yaml.safe_load(path.read_text())
    change(rows)
    path.write_text(yaml.safe_dump(rows, allow_unicode=True, sort_keys=False))


def test_the_committed_table_is_valid_and_has_no_accepted_pair_without_a_source() -> None:
    catalog = read_catalog(CATALOG)
    assert catalog.identical_bodies
    for body in catalog.identical_bodies:
        assert body.source != "gerlines" or body.verdict == "rejected"
        assert body.evidence
        assert body.reason


def test_an_accepted_pair_in_the_file_is_checked_against_the_catalogue(catalog_copy: Path) -> None:
    def accept(rows: list[dict[str, Any]]) -> None:
        rows.append(
            {
                "series_id": "db-424",
                "related_series_id": "db-423",
                "verdict": "accepted",
                "source": "wikipedia-de-424",
                "evidence": "x",
                "reason": "y",
            }
        )
        rows.append(
            {
                "series_id": "db-425",
                "related_series_id": "db-424",
                "verdict": "accepted",
                "source": "wikipedia-de-424",
                "evidence": "x",
                "reason": "y",
            }
        )

    _edit(catalog_copy, accept)
    with pytest.raises(SeedError) as caught:
        read_catalog(catalog_copy)
    assert "chain" in "\n".join(caught.value.problems)
