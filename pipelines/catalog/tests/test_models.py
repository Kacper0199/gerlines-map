import pytest
from pydantic import ValidationError

from gerlines_catalog.models import (
    Livery,
    LiveryColour,
    Operator,
    Source,
    VehicleSeries,
    Verbund,
)

OPERATOR = {
    "operator_id": "example-bahn",
    "feed_name": "Example Bahn",
    "brand_name": "Example Bahn",
    "source": "wikidata",
}


def test_an_operator_without_wikidata_must_say_why() -> None:
    with pytest.raises(ValidationError, match="no reason in missing"):
        Operator.model_validate(OPERATOR)
    row = Operator.model_validate({**OPERATOR, "missing": {"wikidata_qid": "not found"}})
    assert row.wikidata_qid is None


def test_a_wikidata_item_needs_its_role_and_basis() -> None:
    with pytest.raises(ValidationError, match="needs wikidata_role and wikidata_basis"):
        Operator.model_validate({**OPERATOR, "wikidata_qid": "Q1"})
    row = Operator.model_validate(
        {
            **OPERATOR,
            "wikidata_qid": "Q1",
            "wikidata_role": "company",
            "wikidata_basis": "wikidata-search",
        }
    )
    assert row.referenced_sources() == {"wikidata", "wikidata-search"}


def test_unknown_keys_and_bad_ids_are_refused() -> None:
    with pytest.raises(ValidationError):
        Operator.model_validate({**OPERATOR, "colour": "red", "missing": {"wikidata_qid": "x"}})
    with pytest.raises(ValidationError):
        Operator.model_validate({**OPERATOR, "wikidata_qid": "P31"})


def test_field_sources_must_name_real_fields() -> None:
    with pytest.raises(ValidationError, match="unknown fields"):
        Operator.model_validate(
            {**OPERATOR, "missing": {"wikidata_qid": "x"}, "field_sources": {"logo": "wikidata"}}
        )


def test_a_hex_value_needs_its_source() -> None:
    with pytest.raises(ValidationError, match="hex and hex_source go together"):
        LiveryColour.model_validate(
            {"role": "body", "name": "Lichtgrau", "hex": "#cbd0cc", "source": "wikipedia-de-481"}
        )
    with pytest.raises(ValidationError):
        LiveryColour.model_validate(
            {"role": "body", "name": "X", "hex": "#CBD0CC", "hex_source": "w", "source": "w"}
        )


def test_livery_roles_match_the_catalogue_check_of_migration_0056() -> None:
    for role in ("mask", "skirt", "roof", "accent"):
        colour = {"role": role, "name": "Basaltgrau", "ral": "RAL 7012", "source": "wikidata"}
        assert LiveryColour.model_validate(colour).role == role
    with pytest.raises(ValidationError):
        LiveryColour.model_validate({"role": "helmet", "name": "Basaltgrau", "source": "wikidata"})


def test_verbund_laender_are_codes_sorted_once() -> None:
    base = {
        "verbund_id": "vrn",
        "abbr": "VRN",
        "name": "Verkehrsverbund Rhein-Neckar",
        "spnv_integrated": True,
        "wikidata_qid": "Q1",
        "source": "wikipedia-de-verbuende",
    }
    assert Verbund.model_validate({**base, "laender": ["DE-BW", "DE-HE"]}).laender
    with pytest.raises(ValidationError, match="sorted and unique"):
        Verbund.model_validate({**base, "laender": ["DE-HE", "DE-BW"]})
    with pytest.raises(ValidationError):
        Verbund.model_validate({**base, "laender": ["DE-XX"]})


def test_series_numbers_stay_empty_only_with_a_reason() -> None:
    base = {"series_id": "db-412", "name": "ICE 4", "priority": "P1", "source": "wikidata"}
    with pytest.raises(ValidationError, match="without a reason"):
        VehicleSeries.model_validate({**base, "wikidata_qid": "Q324870"})
    row = VehicleSeries.model_validate(
        {
            **base,
            "wikidata_qid": "Q324870",
            "missing": {
                "max_speed_kmh": "two values",
                "unit_length_m": "variants",
                "family": "none",
                "traction": "none",
                "unit_kind": "none",
                "double_deck": "none",
                "cars_min": "none",
                "cars_max": "none",
            },
        }
    )
    assert row.max_speed_kmh is None


def test_source_licence_must_be_an_spdx_expression() -> None:
    base = {
        "source_id": "wikidata",
        "name": "Wikidata",
        "homepage_url": "https://www.wikidata.org/",
        "licence_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "attribution": "Wikidata contributors",
    }
    assert Source.model_validate({**base, "licence": "CC-BY-4.0 AND ODbL-1.0"})
    photos = ("CC-BY-2.0", "CC-BY-SA-2.0", "CC-BY-SA-2.0-DE", "CC-BY-SA-3.0", "CC-BY-SA-3.0-DE")
    for photo in photos:
        assert Source.model_validate({**base, "licence": photo})
    with pytest.raises(ValidationError, match="SPDX"):
        Source.model_validate({**base, "licence": "public domain (mostly)"})


ITEM = {"wikidata_qid": "Q1", "wikidata_role": "company", "wikidata_basis": "wikidata-search"}


@pytest.mark.parametrize("source", ["delfi-gtfs", "traines-delfi-eva"])
def test_aliases_never_use_a_source_the_static_import_writes(source: str) -> None:
    alias = {"alias": "Example Bahn GmbH", "source": source}
    with pytest.raises(ValidationError, match="belongs to the static import"):
        Operator.model_validate({**OPERATOR, **ITEM, "aliases": [alias]})
    row = Operator.model_validate(
        {**OPERATOR, **ITEM, "aliases": [{**alias, "source": "wikidata"}]}
    )
    assert row.aliases[0].source == "wikidata"


def test_a_parent_company_item_lends_no_names() -> None:
    parent = {**OPERATOR, **ITEM, "wikidata_role": "parent_company"}
    with pytest.raises(ValidationError, match="parent company"):
        Operator.model_validate({**parent, "legal_name": "Example Holding AG"})
    with pytest.raises(ValidationError, match="parent company"):
        Operator.model_validate(
            {**parent, "aliases": [{"alias": "Example Holding AG", "source": "wikidata"}]}
        )
    assert Operator.model_validate(parent).legal_name is None


SERIES_FIELDS = {
    "max_speed_kmh": 250,
    "unit_length_m": 202.0,
    "family": "Example family",
    "traction": "electric",
    "unit_kind": "emu",
    "double_deck": False,
    "cars_min": 7,
    "cars_max": 13,
}


@pytest.mark.parametrize("field", sorted(SERIES_FIELDS))
def test_every_series_field_is_filled_or_explained(field: str) -> None:
    base = {
        "series_id": "db-412",
        "name": "ICE 4",
        "priority": "P1",
        "source": "wikidata",
        "wikidata_qid": "Q324870",
    }
    complete = VehicleSeries.model_validate({**base, **SERIES_FIELDS})
    assert getattr(complete, field) == SERIES_FIELDS[field]
    without = {k: v for k, v in SERIES_FIELDS.items() if k != field}
    with pytest.raises(ValidationError, match=f"{field} is empty without a reason"):
        VehicleSeries.model_validate({**base, **without})
    explained = VehicleSeries.model_validate({**base, **without, "missing": {field: "none"}})
    assert getattr(explained, field) is None
    with pytest.raises(ValidationError, match=f"{field} has a value and a reason"):
        VehicleSeries.model_validate({**base, **SERIES_FIELDS, "missing": {field: "none"}})


LIVERY = {
    "livery_id": "example-livery",
    "name": "Example livery",
    "operator_id": "example-bahn",
    "series_ids": ["db-422"],
    "colours": [{"role": "body", "name": "Weiß", "source": "wikidata"}],
    "source": "wikidata",
}


def test_a_livery_may_name_the_lines_it_runs_on_and_the_days_it_is_valid() -> None:
    row = Livery.model_validate(
        {**LIVERY, "lines": ["S1", "S4"], "valid_from": "2019-12-15", "valid_to": "2026-12-12"}
    )
    assert row.lines == ["S1", "S4"]
    assert row.valid_from < row.valid_to  # type: ignore[operator]


def test_a_livery_validity_must_not_end_before_it_starts() -> None:
    with pytest.raises(ValidationError, match="valid_to before valid_from"):
        Livery.model_validate({**LIVERY, "valid_from": "2026-12-12", "valid_to": "2019-12-15"})


def test_lines_need_an_operator() -> None:
    row = {k: v for k, v in LIVERY.items() if k != "operator_id"}
    with pytest.raises(ValidationError, match="lines need an operator_id"):
        Livery.model_validate({**row, "lines": ["S1"]})


def test_a_livery_may_name_other_operators_that_run_the_series_in_it() -> None:
    row = Livery.model_validate({**LIVERY, "also_operator_ids": ["other-bahn"]})
    assert row.also_operator_ids == ["other-bahn"]
    assert Livery.model_validate(LIVERY).also_operator_ids == []


def test_also_operators_need_an_operator_and_exclude_it() -> None:
    row = {k: v for k, v in LIVERY.items() if k != "operator_id"}
    with pytest.raises(ValidationError, match="also_operator_ids need an operator_id"):
        Livery.model_validate({**row, "also_operator_ids": ["other-bahn"]})
    with pytest.raises(ValidationError, match="names its own operator"):
        Livery.model_validate({**LIVERY, "also_operator_ids": ["example-bahn"]})
