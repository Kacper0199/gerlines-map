from gerlines_catalog.models import VehicleSeries
from gerlines_catalog.series_classes import Derived, SeriesClasses, collect, derive, disagreements

ENTITY = "http://www.wikidata.org/entity/"
EMU = "Q483373"
DIESEL_LOCO = "Q34336"
ELECTRIC_LOCO = "Q625151"
HYDROGEN = "Q1261849"
BILEVEL = "Q1243337"


def test_ancestors_of_a_class_count_for_the_series() -> None:
    class_rows = [
        {"item": f"{ENTITY}Q1", "via": "P279", "class": f"{ENTITY}Q900"},
        {"item": f"{ENTITY}Q1", "via": "P930", "class": f"{ENTITY}Q1415234"},
        {"item": f"{ENTITY}Q1", "via": "P527", "class": f"{ENTITY}Q901"},
    ]
    ancestor_rows = [{"item": f"{ENTITY}Q900", "class": f"{ENTITY}{EMU}"}]
    entry = collect(class_rows, ancestor_rows)["Q1"]
    assert entry.classes == {"Q900", EMU}
    assert entry.electrification == {"Q1415234"}
    result = derive(entry)
    assert result.values == {"unit_kind": "emu", "traction": "electric"}
    assert result.evidence["unit_kind"] == ["electric multiple unit"]
    assert "double_deck" in result.reasons


def test_classes_that_disagree_leave_the_field_empty() -> None:
    result = derive(SeriesClasses("Q2", {DIESEL_LOCO, ELECTRIC_LOCO}))
    assert result.values == {"unit_kind": "locomotive"}
    assert result.reasons["traction"].startswith("Wikidata classes disagree on the traction")


def test_hydrogen_refines_electric_and_bilevel_means_double_deck() -> None:
    result = derive(SeriesClasses("Q3", {EMU, HYDROGEN, BILEVEL}))
    assert result.values == {"unit_kind": "emu", "traction": "hydrogen", "double_deck": True}


def test_electrification_alone_gives_electric_traction() -> None:
    result = derive(SeriesClasses("Q4", set(), {"Q1415234"}))
    assert result.values == {"traction": "electric"}
    assert result.reasons["unit_kind"] == "no Wikidata class of the item states its unit kind"


def test_seed_values_cited_to_wikidata_must_match() -> None:
    base = {
        "series_id": "db-412",
        "name": "ICE 4",
        "priority": "P1",
        "source": "wikidata",
        "wikidata_qid": "Q4",
        "missing": dict.fromkeys(
            ("max_speed_kmh", "unit_length_m", "family", "double_deck", "cars_min", "cars_max"),
            "none",
        ),
    }
    derived = {"Q4": Derived({"unit_kind": "emu", "traction": "electric"}, {}, {})}
    good = VehicleSeries.model_validate(
        {
            **base,
            "unit_kind": "emu",
            "traction": "electric",
            "field_sources": {"unit_kind": "wikidata"},
        }
    )
    assert disagreements([good], derived) == []
    bad = VehicleSeries.model_validate({**base, "unit_kind": "dmu", "traction": "electric"})
    assert disagreements([bad], derived) == ["db-412: unit_kind is 'dmu', Wikidata gives 'emu'"]
    cited_elsewhere = VehicleSeries.model_validate(
        {
            **base,
            "unit_kind": "dmu",
            "traction": "electric",
            "field_sources": {"unit_kind": "gerlines"},
        }
    )
    assert disagreements([cited_elsewhere], derived) == []
