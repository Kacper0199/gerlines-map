import pytest

from gerlines_static_import.operators import build_catalog, country_of, normalise_name, slugify


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("vlexx2", "vlexx"),
        ("DB Regio AG1", "DB Regio AG"),
        ("DB-Zug  (nicht VVS)1", "DB-Zug (nicht VVS)"),
        ("Linie 1", "Linie 1"),
        ("Bus 2000", "Bus 2000"),
        ("  S-Bahn Hamburg ", "S-Bahn Hamburg"),
    ],
)
def test_drops_delfi_counters_but_keeps_real_numbers(raw: str, expected: str) -> None:
    assert normalise_name(raw) == expected


@pytest.mark.parametrize(
    ("name", "slug"),
    [
        ("Österreichische Bundesbahnen", "oesterreichische-bundesbahnen"),
        ("Harzer Schmalspurbahnen", "harzer-schmalspurbahnen"),
        ("Ceske Drahy", "ceske-drahy"),
        ("České dráhy", "ceske-drahy"),
        ("DB Fernverkehr (Codesharing)", "db-fernverkehr-codesharing"),
        ("Rhön-Zügle", "rhoen-zuegle"),
        ("1. FC Bahn", "op-1-fc-bahn"),
    ],
)
def test_slugs_are_ascii_and_stable(name: str, slug: str) -> None:
    assert slugify(name) == slug


@pytest.mark.parametrize(
    ("name", "country"),
    [
        ("SBB", "CH"),
        ("THURBO", "CH"),
        ("Österreichische Bundesbahnen", "AT"),
        ("WESTbahn", "AT"),
        ("CD", "CZ"),
        ("LEO Express", "CZ"),
        ("PKP Intercity", "PL"),
        ("SNCF", "FR"),
        ("EUROSTAR", "BE"),
        ("European Sleeper", "NL"),
        ("Dänische Staatsbahnen", "DK"),
        ("DB Fernverkehr AG", "DE"),
        ("Chemnitzer Modell", None),
        ("CD-Bus", None),
    ],
)
def test_country_where_determinable(name: str, country: str | None) -> None:
    assert country_of(name) == country


def test_catalog_merges_counted_agencies_and_keeps_aliases() -> None:
    catalog = build_catalog({"10": "vlexx1", "11": "vlexx2", "7": "SBB", "8": "Chemnitzer Modell1"})
    assert set(catalog.operators) == {"vlexx", "sbb", "chemnitzer-modell"}
    vlexx = catalog.operators["vlexx"]
    assert vlexx.aliases == {"vlexx", "vlexx1", "vlexx2"}
    assert catalog.by_agency == {
        "7": "sbb",
        "8": "chemnitzer-modell",
        "10": "vlexx",
        "11": "vlexx",
    }
    sbb = catalog.for_agency("7")
    assert sbb is not None
    assert sbb.foreign
    assert not vlexx.foreign
    assert catalog.for_agency("missing") is None
