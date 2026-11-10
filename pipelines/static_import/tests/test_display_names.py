import json
from pathlib import Path
from uuid import UUID

import pytest
import shapely

from gerlines_static_import.display_names import (
    RULE_CODE,
    RULE_EVA,
    RULE_NORMALISED,
    RULE_STADA,
    RULE_STADA_AS_NAMED,
    RULE_STADA_QUALIFIED,
    RULE_TOWN,
    RULE_TOWN_FIRST,
    DisplayName,
    MunicipalityIndex,
    PlaceInput,
    SearchName,
    StadaIndex,
    StadaStation,
    Town,
    compute_names,
    display_name,
    names_town,
    normalise,
    read_stada,
    search_names,
    town_of,
    with_town,
)

PLACE = UUID("0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c70")
STUTTGART = town_of("Stuttgart")
MUENCHEN = town_of("München")
KARLSRUHE = town_of("Karlsruhe")
BERLIN = town_of("Berlin")
DUESSELDORF = town_of("Düsseldorf")


def place(name: str, *, dhid: str | None = None, eva: int | None = None) -> PlaceInput:
    return PlaceInput(PLACE, name, dhid, eva, 9.18, 48.78)


@pytest.mark.parametrize(
    ("gen", "name", "shared", "words"),
    [
        ("Stuttgart", "Stuttgart", set(), (("stuttgart",),)),
        ("Frankfurt am Main", "Frankfurt am Main", {"frankfurt"}, (("frankfurt",),)),
        ("Mühldorf a.Inn", "Mühldorf", set(), (("muhldorf",),)),
        ("Neumarkt i.d.OPf.", "Neumarkt i.d.OPf.", {"neumarkt"}, (("neumarkt",),)),
        ("Halle (Saale)", "Halle (Saale)", {"halle"}, (("halle",),)),
        ("Bad Homburg v.d. Höhe", "Bad Homburg", set(), (("bad", "homburg"),)),
        (
            "Leinfelden-Echterdingen",
            "Leinfelden-Echterdingen",
            set(),
            (("leinfelden", "echterdingen"), ("leinfelden",), ("echterdingen",)),
        ),
        ("Falkenberg/Elster", "Falkenberg", set(), (("falkenberg",), ("elster",))),
        ("St. Ingbert", "St. Ingbert", set(), (("st", "ingbert"),)),
    ],
)
def test_a_town_is_written_short_unless_another_municipality_shares_it(
    gen: str, name: str, shared: set[str], words: tuple[tuple[str, ...], ...]
) -> None:
    town = town_of(gen, shared)
    assert town.name == name
    assert town.words == words


@pytest.mark.parametrize(
    ("name", "town", "named"),
    [
        ("Stuttgart Hbf", STUTTGART, True),
        ("Hauptbahnhof (tief)", STUTTGART, False),
        ("Frankfurt (Main) Hauptbahnhof", town_of("Frankfurt am Main", {"frankfurt"}), True),
        ("Muenchen Ost", MUENCHEN, True),
        ("Echterdingen", town_of("Leinfelden-Echterdingen"), True),
        ("Stuttgarter Straße", STUTTGART, False),
        ("Sankt Ingbert", town_of("St. Ingbert"), True),
    ],
)
def test_a_name_names_its_town_as_whole_words(name: str, town: Town, named: bool) -> None:
    assert names_town(name, [town]) is named


@pytest.mark.parametrize(
    ("raw", "normal"),
    [
        ("Hauptbahnhof", "Hbf"),
        ("Freiburg Hauptbahnhof", "Freiburg Hbf"),
        ("Köln Ehrenfeld Bf Ehrenfeld", "Köln Ehrenfeld"),
        ("Köln Mülheim Bf Mülheim", "Köln Mülheim"),
        ("Kassel Bahnhof Wilhelmshöhe", "Kassel Wilhelmshöhe"),
        ("Lindau, Reutin Bahnhof", "Lindau Reutin"),
        ("Hamm (Westf), Hauptbahnhof", "Hamm (Westf) Hbf"),
        ("Fröndenberg, Bahnhof", "Fröndenberg"),
        ("S Ostkreuz Bhf (Berlin)", "Ostkreuz (Berlin)"),
        ("S+U Berlin Hauptbahnhof", "Berlin Hbf"),
        ("S Anhalter Bahnhof (Berlin)", "Anhalter Bahnhof (Berlin)"),
        ("D-Wehrhahn S", "D-Wehrhahn"),
        ("Köln Wahn S-Bahn", "Köln Wahn"),
        ("Bonn (Bahnhof)", "Bonn"),
        ("Dresden S-Bf. Zschachwitz", "Dresden Zschachwitz"),
        ("MA-Käfertal, DB-Bahnhof", "MA-Käfertal"),
        ("OB Sterkrade Bf.", "OB Sterkrade"),
        ("Neuwirtshaus(Porscheplatz)", "Neuwirtshaus (Porscheplatz)"),
        ("Frankfurt(Main)Hbf", "Frankfurt (Main) Hbf"),
        ("MG Hbf /Europaplatz", "MG Hbf/Europaplatz"),
        ("Hauptbahnhof (U, Tram)", "Hbf (U, Tram)"),
        ("KA Europaplatz (U)", "KA Europaplatz (U)"),
        ("Köln Chorweiler Nord (S)", "Köln Chorweiler Nord (S)"),
        ("Lauf Am Bahnhof", "Lauf Am Bahnhof"),
        ("Delitzsch ob Bf", "Delitzsch ob Bf"),
        ("Appenweier Bahnhof", "Appenweier"),
        ("Hannover Bahnhof Kleefeld", "Hannover Kleefeld"),
        ("Freiburg Littenweiler Bahnhof", "Freiburg Littenweiler Bahnhof"),
        ("Stolberg, Mühlener Bf", "Stolberg Mühlener Bf"),
        ("Aachen, West Bf", "Aachen West"),
        ("Bahnhof Ingolstadt Audi", "Ingolstadt Audi"),
        ("Ulm S-Bahnhalt Ulm-Söflingen", "Ulm Ulm-Söflingen"),
        ("Marbeck, Bahnh. Marbeck-Heiden", "Marbeck Marbeck-Heiden"),
        ("Bad Neuenahr-Ahrweiler Ahrweiler Bahnhof", "Bad Neuenahr-Ahrweiler Ahrweiler Bahnhof"),
        ("Berlin Hbf (Berlin)", "Berlin Hbf"),
        ("Bahnhof", "Bahnhof"),
        ("Baden-Baden", "Baden-Baden"),
        ("Ostbahnhof", "Ostbahnhof"),
        ("  Hamburg   Hbf ", "Hamburg Hbf"),
        ("Berbisdorf Hp", "Berbisdorf"),
        ("Auerbach, HP", "Auerbach"),
        ("Erfenstein, Haltepunkt", "Erfenstein"),
        ("Dresden Hp Cotta", "Dresden Cotta"),
        ("Frankenthal, Haltepunkt Süd", "Frankenthal Süd"),
        ("Görlitz Weinhübel (Haltepunkt)", "Görlitz Weinhübel"),
    ],
)
def test_normalise_writes_the_common_forms_once(raw: str, normal: str) -> None:
    assert normalise(raw) == normal


@pytest.mark.parametrize(
    ("raw", "towns", "result"),
    [
        ("Stuttgart Hauptbahnhof", [STUTTGART], ("Stuttgart Hbf", RULE_NORMALISED)),
        ("S Ostkreuz Bhf (Berlin)", [BERLIN], ("Berlin Ostkreuz", RULE_TOWN_FIRST)),
        ("S Anhalter Bahnhof (Berlin)", [BERLIN], ("Berlin Anhalter Bahnhof", RULE_TOWN_FIRST)),
        ("D-Wehrhahn S", [DUESSELDORF], ("Düsseldorf-Wehrhahn", RULE_CODE)),
        (
            "KA Tullastraße/Alter Schlachthof",
            [KARLSRUHE],
            ("Karlsruhe Tullastraße/Alter Schlachthof", RULE_CODE),
        ),
        ("Hauptbahnhof", [STUTTGART], None),
        ("Rüppurr Battstraße", [KARLSRUHE], None),
        ("D-Wehrhahn", [DUESSELDORF, town_of("Duisburg")], ("Düsseldorf-Wehrhahn", RULE_CODE)),
        (
            "BOT-Vonderort Bf",
            [town_of("Oberhausen"), town_of("Bottrop")],
            ("Bottrop-Vonderort", RULE_CODE),
        ),
        ("H-BM-Horn, Bahnhof", [town_of("Horn-Bad Meinberg")], ("H-BM-Horn", RULE_NORMALISED)),
        (
            "Neuenhagen (b Berlin)",
            [town_of("Neuenhagen bei Berlin"), BERLIN],
            ("Neuenhagen (b Berlin)", RULE_NORMALISED),
        ),
        ("D-Wehrhahn", [STUTTGART, town_of("Dortmund")], None),
        (
            "PW-Hausberge, Porta Bahnhof",
            [town_of("Porta Westfalica")],
            ("Porta Westfalica-Hausberge", RULE_CODE),
        ),
    ],
)
def test_with_town_keeps_moves_or_expands_the_town(
    raw: str, towns: list[Town], result: tuple[str, str] | None
) -> None:
    assert with_town(raw, towns) == result


OFFENBACH = town_of("Offenbach am Main", {"offenbach"})


@pytest.mark.parametrize(
    ("raw", "towns", "result"),
    [
        (
            "Offenbach (Main)-Bieber Bieber Bahnhof",
            [OFFENBACH],
            ("Offenbach (Main)-Bieber", RULE_NORMALISED),
        ),
        (
            "Offenbach (Main)-Bieber Bieber Waldhof",
            [OFFENBACH],
            ("Offenbach (Main)-Bieber Waldhof", RULE_NORMALISED),
        ),
        (
            "Offenbach (Main)-Kaiserlei Kaiserlei",
            [OFFENBACH],
            ("Offenbach (Main)-Kaiserlei", RULE_NORMALISED),
        ),
        ("Witten Witten-Annen", [town_of("Witten")], ("Witten-Annen", RULE_NORMALISED)),
        ("Dorsten Hervest-Dorsten Bf", [town_of("Dorsten")], ("Hervest-Dorsten", RULE_NORMALISED)),
        (
            "Lindheim Altenstadt-Lindheim Bahnhof",
            [town_of("Altenstadt")],
            ("Altenstadt-Lindheim", RULE_NORMALISED),
        ),
        (
            "Herzogenrath, Merkstein Alt-Merkstein Bf",
            [town_of("Herzogenrath")],
            ("Herzogenrath Alt-Merkstein", RULE_NORMALISED),
        ),
        ("Ulm S-Bahnhalt Ulm-Söflingen", [town_of("Ulm")], ("Ulm-Söflingen", RULE_NORMALISED)),
        (
            "Marbeck, Bahnh. Marbeck-Heiden",
            [town_of("Heiden")],
            ("Marbeck-Heiden", RULE_NORMALISED),
        ),
        (
            "Wiesbaden-Biebrich Bahnhof Wiesbaden Ost",
            [town_of("Wiesbaden")],
            ("Wiesbaden Ost", RULE_NORMALISED),
        ),
        (
            "Wiesbaden-Biebrich Wiesbaden",
            [town_of("Wiesbaden")],
            ("Wiesbaden-Biebrich Wiesbaden", RULE_NORMALISED),
        ),
        (
            "Mücke-Flensungen Mücke Bahnhof",
            [town_of("Mücke")],
            ("Mücke-Flensungen Mücke", RULE_NORMALISED),
        ),
        (
            "Mücke-Nieder-Ohmen Mücke",
            [town_of("Mücke")],
            ("Mücke-Nieder-Ohmen Mücke", RULE_NORMALISED),
        ),
        (
            "Mühltal-Nieder-Ramstadt Mühltal Bahnhof",
            [town_of("Mühltal")],
            ("Mühltal-Nieder-Ramstadt Mühltal", RULE_NORMALISED),
        ),
        (
            "Ziltendorf Brieskow-Finkenheerd Finkenheerd",
            [town_of("Brieskow-Finkenheerd"), town_of("Ziltendorf")],
            ("Ziltendorf Brieskow-Finkenheerd Finkenheerd", RULE_NORMALISED),
        ),
        (
            "Brohl-Lützing Brohl Bahnhof",
            [town_of("Brohl-Lützing")],
            ("Brohl-Lützing Brohl", RULE_NORMALISED),
        ),
        (
            "Brieskow-Finkenheerd, Finkenheerd Bhf",
            [town_of("Brieskow-Finkenheerd")],
            ("Brieskow-Finkenheerd Finkenheerd", RULE_NORMALISED),
        ),
        (
            "Bad Neuenahr-Ahrweiler Ahrweiler Bahnhof",
            [town_of("Bad Neuenahr-Ahrweiler")],
            ("Bad Neuenahr-Ahrweiler Ahrweiler Bahnhof", RULE_NORMALISED),
        ),
        (
            "Offenbach (Main)-Offenbach Ost Ostbahnhof",
            [OFFENBACH],
            ("Offenbach (Main)-Offenbach Ost Ostbahnhof", RULE_NORMALISED),
        ),
        (
            "Walldorf Mörfelden-Walldorf",
            [town_of("Mörfelden-Walldorf")],
            ("Walldorf Mörfelden-Walldorf", RULE_NORMALISED),
        ),
        (
            "Ginsheim-Gustavsburg Mainz-Gustavsburg Bf",
            [town_of("Ginsheim-Gustavsburg")],
            ("Ginsheim-Gustavsburg Mainz-Gustavsburg", RULE_NORMALISED),
        ),
    ],
)
def test_a_district_or_town_written_twice_side_by_side_is_shown_once(
    raw: str, towns: list[Town], result: tuple[str, str]
) -> None:
    assert with_town(raw, towns) == result


@pytest.mark.parametrize(
    ("raw", "town", "known", "shown"),
    [
        ("Mücke-Flensungen Mücke Bahnhof", "Mücke", ["Mücke (Hess)", "Mücke(Hess)"], "Mücke"),
        ("Mühltal-Nieder-Ramstadt Mühltal Bahnhof", "Mühltal", ["Mühltal"], "Mühltal"),
        ("Mücke-Nieder-Ohmen Mücke", "Mücke", ["Nieder Ohmen", "Nieder-Ohmen"], None),
        ("Wiesbaden-Biebrich Wiesbaden", "Wiesbaden", ["Wiesbaden-Biebrich"], None),
    ],
)
def test_the_town_alone_replaces_a_town_and_district_only_when_db_names_the_place_so(
    raw: str, town: str, known: list[str], shown: str | None
) -> None:
    result = with_town(raw, [town_of(town)], known)
    assert result is not None
    assert (result[0] == shown) if shown is not None else (result[0] != town)


MUECKE_AREA = MunicipalityIndex([("Mücke", shapely.box(9.0, 48.0, 10.0, 49.0))], crs=4326)


def test_a_repeat_removed_never_gives_a_station_the_shown_name_of_another() -> None:
    flensungen = PlaceInput(
        PLACE, "Mücke-Flensungen Mücke Bahnhof", "de:06535:1", None, 9.18, 48.78
    )
    bus = PlaceInput(UUID(int=7), "Mücke", None, None, 9.2, 48.8)
    stada = StadaIndex([StadaStation("Mücke (Hess)", "de:06535:1", (8003983,), 9.18, 48.78)])
    shown, _ = compute_names([(flensungen, "DE"), (bus, "DE")], MUECKE_AREA, stada, {})
    assert [(name.stop_place_id, name.name) for name in shown] == [
        (PLACE, "Mücke-Flensungen Mücke")
    ]
    alone, _ = compute_names([(flensungen, "DE")], MUECKE_AREA, stada, {})
    assert [name.name for name in alone] == ["Mücke"]


BECKINGEN = town_of("Beckingen")
DILLINGEN_SAAR = town_of("Dillingen/Saar", {"dillingen"})
FRIEDRICHSTHAL = town_of("Friedrichsthal")
SULZBACH_SAAR = town_of("Sulzbach/Saar", {"sulzbach"})
NEUSTADT_DOSSE = town_of("Neustadt (Dosse)", {"neustadt"})
WUSTERHAUSEN_DOSSE = town_of("Wusterhausen/Dosse")
BAD_GRUND = town_of("Bad Grund (Harz)")
HARZ_GOETTINGEN = town_of("Harz (Landkreis Göttingen)", {"harz"})


@pytest.mark.parametrize(
    ("raw", "towns", "result"),
    [
        ("Beckingen (Saar)", [BECKINGEN, DILLINGEN_SAAR], ("Beckingen (Saar)", RULE_NORMALISED)),
        ("Beckingen (Saar)", [DILLINGEN_SAAR, BECKINGEN], ("Beckingen (Saar)", RULE_NORMALISED)),
        (
            "Friedrichsthal (Saar)",
            [FRIEDRICHSTHAL, SULZBACH_SAAR],
            ("Friedrichsthal (Saar)", RULE_NORMALISED),
        ),
        (
            "Neustadt (Dosse), Bahnhof",
            [NEUSTADT_DOSSE, WUSTERHAUSEN_DOSSE],
            ("Neustadt (Dosse)", RULE_NORMALISED),
        ),
        (
            "Gittelde/Bad Grund (Harz)",
            [HARZ_GOETTINGEN, BAD_GRUND],
            ("Gittelde/Bad Grund (Harz)", RULE_NORMALISED),
        ),
        (
            "S Ostkreuz Bhf (Berlin)",
            [BERLIN, town_of("Falkenberg/Elster")],
            ("Berlin Ostkreuz", RULE_TOWN_FIRST),
        ),
    ],
)
def test_the_town_in_parentheses_is_a_main_word_and_never_one_already_named(
    raw: str, towns: list[Town], result: tuple[str, str] | None
) -> None:
    assert with_town(raw, towns) == result


@pytest.mark.parametrize(
    ("given", "towns", "expected"),
    [
        (place("Beckingen (Saar)"), [BECKINGEN, DILLINGEN_SAAR], None),
        (place("Friedrichsthal (Saar)"), [FRIEDRICHSTHAL, SULZBACH_SAAR], None),
        (
            place("Neustadt (Dosse), Bahnhof"),
            [NEUSTADT_DOSSE, WUSTERHAUSEN_DOSSE],
            ("Neustadt (Dosse)", RULE_NORMALISED, "delfi-gtfs"),
        ),
        (place("Gittelde/Bad Grund (Harz)"), [BAD_GRUND], None),
    ],
)
def test_the_four_names_v073_found_keep_their_own_town(
    given: PlaceInput, towns: list[Town], expected: tuple[str, str, str] | None
) -> None:
    result = display_name(given, towns, StadaIndex([]), None)
    assert result == (None if expected is None else DisplayName(PLACE, *expected))


STADA = StadaIndex(
    [
        StadaStation("Stuttgart Hbf", "de:08111:6115", (8000096,), 9.181636, 48.784081),
        StadaStation("München Ost", "de:09162:5", (8000262,), 11.604913, 48.127311),
        StadaStation("Lohhof", None, (8003732,), 11.5875, 48.2475),
        StadaStation("Reeperbahn", "de:02000:11906", (8006705,), 9.957668, 53.549668),
        StadaStation("Mülheim (Ruhr) Hbf", "de:05117:8000259", (8000259,), 9.18, 48.78),
        StadaStation("Neustadt (Dosse)", "de:12068:8010255", (8010255,), 9.18, 48.78),
        StadaStation("Neustadt (Aisch) Bahnhof", "de:09575:8004266", (8004266,), 9.18, 48.78),
        StadaStation("Frankfurt am Main Messe", "de:06412:1", (8002041,), 9.18, 48.78),
        StadaStation("Rotenburg an der Fulda", "de:06632:1", (8000325,), 9.18, 48.78),
    ]
)
MUELHEIM_RUHR = town_of("Mülheim an der Ruhr", {"mulheim"})


@pytest.mark.parametrize(
    ("given", "towns", "eva_name", "expected"),
    [
        (place("Hamburg Hbf"), [town_of("Hamburg")], None, None),
        (
            place("Freiburg Hauptbahnhof"),
            [town_of("Freiburg im Breisgau", {"freiburg"})],
            None,
            ("Freiburg Hbf", RULE_NORMALISED, "delfi-gtfs"),
        ),
        (
            place("Hauptbahnhof", dhid="de:08111:6115"),
            [STUTTGART],
            None,
            ("Stuttgart Hbf", RULE_STADA, "db-stada-stations"),
        ),
        (
            place("Ostbahnhof", dhid="de:09162:5", eva=8000262),
            [MUENCHEN],
            "München Ost",
            ("München Ost", RULE_STADA, "db-stada-stations"),
        ),
        (
            place("Reeperbahn", dhid="de:02000:11906", eva=8006705),
            [town_of("Hamburg")],
            "Hamburg Reeperbahn",
            ("Hamburg Reeperbahn", RULE_EVA, "traines-delfi-eva"),
        ),
        (
            PlaceInput(PLACE, "Lohhof", None, 8003732, 11.588, 48.248),
            [town_of("Unterschleißheim")],
            "Lohhof",
            None,
        ),
        (
            PlaceInput(PLACE, "Lohhof Bahnhof", None, 8003732, 11.588, 48.248),
            [town_of("Unterschleißheim")],
            None,
            ("Lohhof", RULE_STADA_AS_NAMED, "db-stada-stations"),
        ),
        (
            place("Pasing", eva=8004158),
            [MUENCHEN],
            "München-Pasing",
            ("München-Pasing", RULE_EVA, "traines-delfi-eva"),
        ),
        (
            place("Leuchtenbergring", eva=8004127),
            [MUENCHEN],
            "Leuchtenbergring",
            ("München Leuchtenbergring", RULE_TOWN, "bkg-vg250"),
        ),
        (
            place("Hauptbahnhof (tief)", dhid="de:08111:6118"),
            [STUTTGART],
            None,
            ("Stuttgart Hbf (tief)", RULE_TOWN, "bkg-vg250"),
        ),
        (
            place("Rüppurr Battstraße"),
            [KARLSRUHE],
            None,
            ("Karlsruhe Rüppurr Battstraße", RULE_TOWN, "bkg-vg250"),
        ),
        (
            place("Mülheim Hauptbahnhof", dhid="de:05117:8000259"),
            [MUELHEIM_RUHR],
            None,
            ("Mülheim (Ruhr) Hbf", RULE_STADA_QUALIFIED, "db-stada-stations"),
        ),
        (
            place("Neustadt (Dosse), Bahnhof", dhid="de:12068:8010255"),
            [NEUSTADT_DOSSE, WUSTERHAUSEN_DOSSE],
            None,
            ("Neustadt (Dosse)", RULE_NORMALISED, "delfi-gtfs"),
        ),
        (
            place("Neustadt (Aisch) Bahnhof", dhid="de:09575:8004266"),
            [town_of("Neustadt a.d.Aisch", {"neustadt"})],
            None,
            ("Neustadt (Aisch)", RULE_NORMALISED, "delfi-gtfs"),
        ),
        (
            place("Frankfurt (Main) Messe", dhid="de:06412:1"),
            [town_of("Frankfurt am Main", {"frankfurt"})],
            None,
            None,
        ),
        (
            place("Rotenburg (Fulda) Bahnhof", dhid="de:06632:1"),
            [town_of("Rotenburg a. d. Fulda", {"rotenburg"})],
            None,
            ("Rotenburg (Fulda)", RULE_NORMALISED, "delfi-gtfs"),
        ),
        (
            place("Hamburg Hauptbahnhof", dhid="de:05117:8000259"),
            [town_of("Hamburg")],
            None,
            ("Hamburg Hbf", RULE_NORMALISED, "delfi-gtfs"),
        ),
        (place("Basel Bad Bf"), [], None, ("Basel Bad", RULE_NORMALISED, "delfi-gtfs")),
        (place("Kufstein"), [], None, None),
    ],
)
def test_display_name_takes_the_first_rule_that_names_the_town(
    given: PlaceInput,
    towns: list[Town],
    eva_name: str | None,
    expected: tuple[str, str, str] | None,
) -> None:
    result = display_name(given, towns, STADA, eva_name)
    assert result == (None if expected is None else DisplayName(PLACE, *expected))


def test_search_names_keep_the_timetable_db_and_eva_names_that_are_not_shown() -> None:
    freiburg = place("Freiburg Hauptbahnhof", eva=8000107)
    stada = StadaIndex([StadaStation("Freiburg (Breisgau) Hbf", None, (8000107,), 9.18, 48.78)])
    shown = DisplayName(PLACE, "Freiburg Hbf", RULE_NORMALISED, "delfi-gtfs")
    freiburg_town = [town_of("Freiburg im Breisgau", {"freiburg"})]
    assert search_names(freiburg, shown, stada, "Freiburg(Breisgau) Hbf", freiburg_town) == [
        SearchName(PLACE, "Freiburg Hauptbahnhof", "delfi-gtfs"),
        SearchName(PLACE, "Freiburg (Breisgau) Hbf", "db-stada-stations"),
    ]
    hamburg = place("Hamburg Hbf")
    assert search_names(hamburg, None, StadaIndex([]), "Hamburg Hbf", [town_of("Hamburg")]) == []
    reeperbahn = place("Reeperbahn", dhid="de:02000:11906", eva=8006705)
    shown = DisplayName(PLACE, "Hamburg Reeperbahn", RULE_EVA, "traines-delfi-eva")
    assert search_names(reeperbahn, shown, STADA, "Hamburg Reeperbahn", []) == [
        SearchName(PLACE, "Reeperbahn", "delfi-gtfs")
    ]


def test_search_names_skip_a_timetable_name_that_names_no_town() -> None:
    ost = place("Ostbahnhof", dhid="de:09162:5", eva=8000262)
    shown = DisplayName(PLACE, "München Ost", RULE_STADA, "db-stada-stations")
    assert search_names(ost, shown, STADA, "München Ost", [MUENCHEN]) == []
    stuttgart = place("Hauptbahnhof", dhid="de:08111:6115")
    shown = DisplayName(PLACE, "Stuttgart Hbf", RULE_STADA, "db-stada-stations")
    assert search_names(stuttgart, shown, STADA, None, [STUTTGART]) == []
    reeperbahn = place("Reeperbahn", dhid="de:02000:11906", eva=8006705)
    shown = DisplayName(PLACE, "Hamburg Reeperbahn", RULE_EVA, "traines-delfi-eva")
    assert search_names(reeperbahn, shown, STADA, "Hamburg Reeperbahn", [town_of("Hamburg")]) == [
        SearchName(PLACE, "Reeperbahn", "db-stada-stations")
    ]
    berlin = place("S Ostbahnhof (Berlin)")
    shown = DisplayName(PLACE, "Berlin Ostbahnhof", RULE_TOWN_FIRST, "delfi-gtfs")
    assert search_names(berlin, shown, StadaIndex([]), None, [BERLIN]) == [
        SearchName(PLACE, "S Ostbahnhof (Berlin)", "delfi-gtfs")
    ]


def test_stada_by_eva_alone_must_keep_every_word_of_the_timetable_name() -> None:
    stada = StadaIndex(
        [
            StadaStation("Friedrichstal (Baden)", None, (8002079,), 8.47, 49.11),
            StadaStation("Mönchengladbach-Lürrip", None, (8004101,), 6.47, 51.19),
            StadaStation(
                "Stuttgart Neuwirtshaus (Porscheplatz)", "de:08111:9", (8004357,), 9.1, 48.8
            ),
        ]
    )
    at = {"lon": 8.47, "lat": 49.11}
    tram = PlaceInput(PLACE, "Friedrichstal St-Riquier-Platz", None, 8002079, **at)
    assert stada.name_for(tram) is None
    lurrip = PlaceInput(PLACE, "Mönchengladb. Lürrip S-Bf.", None, 8004101, 6.47, 51.19)
    assert stada.name_for(lurrip) == "Mönchengladbach-Lürrip"
    by_ifopt = PlaceInput(PLACE, "Neuwirtsh. (Porschep.)", "de:08111:9", None, None, None)
    assert stada.name_for(by_ifopt) == "Stuttgart Neuwirtshaus (Porscheplatz)"


def test_stada_is_found_by_ifopt_first_then_by_eva_near_the_place() -> None:
    assert STADA.name_for(place("x", dhid="de:08111:6115", eva=8000262)) == "Stuttgart Hbf"
    assert STADA.name_for(PlaceInput(PLACE, "Lohhof", None, 8003732, 11.588, 48.248)) == "Lohhof"
    assert STADA.name_for(PlaceInput(PLACE, "Lohhof", None, 8003732, 13.4, 52.5)) is None
    assert STADA.name_for(PlaceInput(PLACE, "Lohhof", None, 8003732, None, None)) == "Lohhof"
    assert STADA.name_for(place("x", dhid="de:09999:1")) is None


def test_read_stada_keeps_name_ifopt_and_eva_numbers(tmp_path: Path) -> None:
    path = tmp_path / "stada.json"
    path.write_text(
        json.dumps(
            {
                "total": 2,
                "result": [
                    {
                        "number": 6071,
                        "name": "Stuttgart Hbf",
                        "ifopt": "de:08111:6115",
                        "evaNumbers": [
                            {
                                "number": 8000096,
                                "isMain": True,
                                "geographicCoordinates": {
                                    "type": "Point",
                                    "coordinates": [9.181636, 48.784081],
                                },
                            },
                            {"number": 8098096, "isMain": False},
                        ],
                    },
                    {"number": 1, "name": " ", "evaNumbers": []},
                ],
            }
        )
    )
    assert read_stada(path) == [
        StadaStation("Stuttgart Hbf", "de:08111:6115", (8000096, 8098096), 9.181636, 48.784081)
    ]


def test_municipality_index_lists_the_containing_town_first_then_neighbours() -> None:
    stuttgart = shapely.box(500_000, 5_400_000, 510_000, 5_410_000)
    fellbach = shapely.box(510_000, 5_400_000, 515_000, 5_410_000)
    far = shapely.box(530_000, 5_400_000, 540_000, 5_410_000)
    index = MunicipalityIndex(
        [("Stuttgart", stuttgart), ("Fellbach", fellbach), ("Fernau", far)], crs=25832
    )
    near_border = index.towns_at_xy(509_000, 5_405_000)
    assert [town.name for town in near_border] == ["Stuttgart", "Fellbach"]
    assert [town.name for town in index.towns_at_xy(505_000, 5_405_000)] == ["Stuttgart"]
    assert index.towns_at_xy(600_000, 5_405_000) == []
    assert index.towns_at_xy(499_000, 5_405_000) == []


def test_an_area_without_a_municipality_is_never_a_town() -> None:
    bad_grund = shapely.box(500_000, 5_400_000, 510_000, 5_410_000)
    harz = shapely.box(510_000, 5_400_000, 530_000, 5_410_000)
    index = MunicipalityIndex(
        [("Bad Grund (Harz)", bad_grund)],
        crs=25832,
        without_town=[("Harz (Landkreis Göttingen)", harz)],
    )
    assert [town.name for town in index.towns_at_xy(509_500, 5_405_000)] == ["Bad Grund"]
    assert [town.name for town in index.towns_at_xy(510_500, 5_405_000)] == ["Bad Grund"]
    assert index.towns_at_xy(525_000, 5_405_000) == []
