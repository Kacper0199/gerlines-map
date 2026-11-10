# ruff: noqa: RUF001
from datetime import date
from pathlib import Path

import pytest
import yaml

from gerlines_catalog import commands
from gerlines_catalog.cli import build_parser
from gerlines_catalog.fleet import FleetRule
from gerlines_catalog.fleet_cells import Catalogue, read_cell
from gerlines_catalog.fleet_lists import (
    LISTS_BY_SHORT,
    MATCH_SHARE_FLOOR,
    FeedFile,
    OperatorIndex,
    PairTrips,
    SourceChangedError,
    build_rules,
    list_lines,
    match_exception,
    match_share,
    pair_trips,
)
from gerlines_catalog.wikipedia import parse_revisions
from gerlines_catalog.wikitables import quote, table_rows, text_lines

from .conftest import CATALOG

FIXTURES = Path(__file__).parent / "fixtures" / "fleet-lists"
VALID = (date(2025, 12, 14), date(2026, 12, 12))


def page(short: str) -> str:
    return next(FIXTURES.glob(f"{short}-*.wiki")).read_text()


@pytest.fixture(scope="module")
def catalogue() -> Catalogue:
    return Catalogue.of(yaml.safe_load((CATALOG / "vehicle-series.yaml").read_text()))


@pytest.fixture(scope="module")
def operators() -> OperatorIndex:
    return OperatorIndex.of(yaml.safe_load((CATALOG / "operators.yaml").read_text()))


def read(cell: str, catalogue: Catalogue) -> tuple[tuple[str, ...], tuple[str, ...]]:
    reading = read_cell(cell, catalogue)
    return reading.series, reading.unmapped


def test_text_lines_decode_entities_and_quotes_join_cell_lines() -> None:
    cell = (
        "1–2× [[Stadler Flirt|Stadler Flirt 1]] (428&#x202F;/&#x2009;429)"
        "<br />''neu'' {{nowrap|ab 2026}}"
    )
    assert text_lines(cell) == ["1–2× Stadler Flirt 1 (428 / 429)", "neu ab 2026"]
    assert (
        quote("LINT 54 (622)<br />[[Stadler Flirt|Stadler]]<ref>x</ref>")
        == "LINT 54 (622); Stadler"
    )


def test_table_rows_follow_headings_inside_tables_and_spread_rowspans() -> None:
    rows = table_rows(page("sh"))
    section = {line: next(r.section for r in rows if f"|{line}}}}}" in r.cells[0])
               for line in ("RE|6", "RB|65")}  # fmt: skip
    assert section["RE|6"].endswith("Regional-Express (vor/nach Generalsanierung)")
    assert section["RB|65"].endswith("Regionalbahn (vor/nach Generalsanierung)")
    nrw = [r for r in table_rows(page("nrw")) if "RB|33" in r.cells[0]]
    assert len(nrw) == 2
    assert nrw[0].cells[-1] == nrw[1].cells[-1]


def test_a_vehicle_the_catalogue_lacks_is_reported_not_dropped(catalogue: Catalogue) -> None:
    assert read("1× [[Pesa Link II]] (632)<br />1× [[Bombardier Talent]] (644)", catalogue) == (
        ("db-644",),
        ("Pesa Link",),
    )
    assert read("[[Siemens Desiro Classic|BR 642]]<br />[[DB-Baureihe 641|BR 641]]", catalogue)[
        1
    ] == ("DB-Baureihe 641",)
    assert read("[[ÖBB 5047|T4]] / [[DB-Baureihe 628#628.9/629|628.9/629]]", catalogue) == (
        ("db-628",),
        ("ÖBB 5047",),
    )


def test_a_class_number_on_its_own_line_belongs_to_the_line_above(catalogue: Catalogue) -> None:
    cell = (
        "[[Stadler Flirt&nbsp;3]] (1428, 1430)\n[[Bombardier Talent 3]]\n(6442)\n\n"
        "[[Siemens Mireo]] (463)"
    )
    assert read(cell, catalogue) == (("db-1428", "stadler-flirt-3", "db-463"), ("Talent 3",))


def test_kiss_with_class_445_stays_kiss(catalogue: Catalogue) -> None:
    assert read("1–2 × 445 ([[Stadler KISS|KISS]], vierteilig)", catalogue) == (
        ("stadler-kiss",),
        (),
    )
    assert read("[[Stadler KISS|445.1]] [KISS, vierteilig]", catalogue) == (("stadler-kiss",), ())
    assert read("2 × 445 ([[Bombardier Twindexx Vario|Twindexx]], vierteilig)", catalogue) == (
        ("db-445",),
        (),
    )


def test_one_cell_token_names_one_series(catalogue: Catalogue) -> None:
    assert read("[[Bombardier Talent 2|442.1]] [Talent 2, dreiteilig]", catalogue) == (
        ("db-442",),
        (),
    )
    assert read("1–3× [[Bombardier Talent 2|Talent 2]] (442)", catalogue) == (("db-442",), ())
    assert read("[[Siemens Mireo|463]] [Mireo, dreiteilig]", catalogue) == (("db-463",), ())


def test_mireo_class_563_names_the_two_car_mireo_plus_also_with_a_leading_zero(
    catalogue: Catalogue,
) -> None:
    assert read("[[Siemens Mireo|563]] [Mireo Plus B, zweiteilig]", catalogue) == (("db-563",), ())
    assert read("[[Siemens Mireo#Mireo Plus B|Siemens Mireo Plus B]] (563)", catalogue) == (
        ("db-563",),
        (),
    )
    assert read("[[Siemens Mireo Plus H]] (0563)", catalogue) == (("db-563",), ())
    assert read("Siemens Mireo (2463)", catalogue) == (("siemens-mireo",), ())


def test_flirt_classes_name_their_model_only_for_a_flirt_3(catalogue: Catalogue) -> None:
    assert read("[[Stadler Flirt|Stadler Flirt 1]] (428)", catalogue) == (("stadler-flirt",), ())
    assert read("1–2× [[Stadler Flirt|Stadler Flirt 1]] (428&#x202F;/&#x2009;429)", catalogue) == (
        ("stadler-flirt",),
        (),
    )
    assert read("1–2 × [[Stadler Flirt|Flirt 3]] (1428)", catalogue) == (("db-1428",), ())
    assert read("[[Stadler Flirt 3]] (428)", catalogue) == (("db-428",), ())
    assert read("1–2 × [[Flirt Akku|FLIRT Akku]]", catalogue) == (("stadler-flirt",), ())
    descriptor = "1–2x Stadler Flirt 3 ([[Elektrotriebwagen]], 429.1, 160&nbsp;km/h)"
    assert read(descriptor, catalogue) == (("db-429",), ())


def test_a_four_digit_variant_adds_nothing_beside_a_refined_class(catalogue: Catalogue) -> None:
    lint_41 = "[[Alstom Coradia LINT|Alstom Coradia LINT 41]] (648, 2648)"
    assert read(lint_41, catalogue) == (("db-648",), ())
    assert read("[[Stadler Flirt 3]]XL (3429 / 3427)", catalogue) == (("db-3429",), ())
    lint_54 = "[[Alstom Coradia LINT|Alstom Coradia LINT 54]] (1622)"
    assert read(f"{lint_41}\n{lint_54}", catalogue) == (("db-648", "db-622"), ())
    assert read("[[Alstom Coradia LINT|LINT 41]] (2648)", catalogue) == (
        ("alstom-coradia-lint",),
        (),
    )


def test_a_lint_size_names_its_class_series_not_the_lint_41(catalogue: Catalogue) -> None:
    assert read("1–2 × LINT 54", catalogue) == (("db-622",), ())
    assert read("Alstom Coradia LINT 54", catalogue) == (("db-622",), ())
    assert read("1622 [LINT 54]", catalogue) == (("db-622",), ())
    assert read("[[DB-Baureihe 622|1622]] [LINT 54]", catalogue) == (("db-622",), ())
    assert read("[[DB-Baureihe 622|1622]] [LINT 54] /\nStadler GTW 2/6", catalogue)[0] == (
        "db-622",
    )
    assert read("[[Alstom Coradia LINT|Alstom Coradia LINT 81]]", catalogue) == (("db-620",), ())
    assert read("Alstom Coradia LINT 81 (620)", catalogue) == (("db-620",), ())
    assert read("2 × LINT 27 (640), 1 × LINT 41 (648)", catalogue) == (("db-640", "db-648"), ())
    tail = read_cell("Alstom Coradia LINT 41 (648/1648); (vereinzelt LINT 41+LINT27)", catalogue)
    assert tail.series == ("db-648", "db-1648", "alstom-coradia-lint", "db-640")
    assert tail.rare == {"alstom-coradia-lint", "db-640"}
    assert read("1 × LINT 41", catalogue) == (("alstom-coradia-lint",), ())
    assert read("Alstom Coradia LINT", catalogue) == (("alstom-coradia-lint",), ())
    assert read("iLINT 54 (654)", catalogue) == (("alstom-coradia-ilint",), ())


def test_cell_order_is_kept_and_rare_vehicles_go_last(catalogue: Catalogue) -> None:
    assert read("1–3 × [[Alstom Coradia LINT#LINT 41|LINT 41]] (648/1648)", catalogue)[0] == (
        "db-648",
        "db-1648",
    )
    rows = {r.label: r for r in list_lines(LISTS_BY_SHORT["by"], page("by"), catalogue)}
    rb40 = rows["RB40"].reading
    assert rb40.series == ("doppelstockwagen", "db-628", "db-642")
    assert rb40.rare == {"db-628", "db-642"}
    nds = list_lines(LISTS_BY_SHORT["nds"], page("nds"), catalogue)
    re8 = next(r for r in nds if r.label == "RE8").reading
    assert re8.series == ("db-442", "doppelstockwagen")
    assert re8.rare == {"doppelstockwagen"}
    tail = read_cell("[[DB-Baureihe 628|Baureihe 628]] (vereinzelt)<br />"
                     "[[Bombardier Talent]] (643)",
                     catalogue)  # fmt: skip
    assert tail.series == ("db-643", "db-628")


def test_consists_name_the_coaches_or_the_locomotive(catalogue: Catalogue) -> None:
    sh = {r.label: r for r in list_lines(LISTS_BY_SHORT["sh"], page("sh"), catalogue)}
    assert sh["RE 6"].reading.series == ("db-245", "doppelstockwagen")
    bb = {r.label: r for r in list_lines(LISTS_BY_SHORT["bb"], page("bb"), catalogue)}
    assert bb["RE 4"].reading.series == ("doppelstockwagen", "db-463")
    by = {r.label: r for r in list_lines(LISTS_BY_SHORT["by"], page("by"), catalogue)}
    assert by["RE1"].reading.series == ("db-101", "db-445")
    assert by["RE1"].reading.unmapped == ("DB-Baureihe 102",)


def test_units_only_when_the_cell_fixes_them(catalogue: Catalogue) -> None:
    nrw = {r.label: r for r in list_lines(LISTS_BY_SHORT["nrw"], page("nrw"), catalogue)}
    assert nrw["RB 33"].reading.series == ("db-1440",)
    assert nrw["RB 33"].reading.units is None
    assert (
        read_cell("2 × 445 ([[Bombardier Twindexx Vario|Twindexx]], vierteilig)", catalogue).units
        == 2
    )
    assert read_cell("1–2 × [[Stadler KISS|KISS]]", catalogue).units is None


def test_the_ic2_article_rows_count_only_lines_in_service(catalogue: Catalogue) -> None:
    rows = list_lines(LISTS_BY_SHORT["ic2"], page("ic2"), catalogue)
    assert [r.label for r in rows] == [
        "IC 17",
        "IC 34",
        "IC 35",
        "IC 55",
        "IC 56",
        "IC 61",
        "IC 87",
    ]
    assert all(r.reading.series == ("db-intercity-2",) for r in rows)
    assert rows[5].evidence.startswith("IC 61: Karlsruhe – Pforzheim")
    assert rows[5].evidence.endswith("; unter Verkehr")


def ends(*items: tuple[str, str, int]) -> PairTrips:
    counts = {(first, last): n for first, last, n in items}
    return PairTrips(sum(counts.values()), counts)


def test_match_share_counts_trips_ending_at_a_named_station() -> None:
    trips = ends(("Köln Hbf", "Hauptbahnhof", 6), ("Dresden Hauptbahnhof", "Dortmund Hbf", 3),
                 ("Konstanz Bahnhof", "Hauptbahnhof", 1))  # fmt: skip
    assert match_share(trips, "Dresden – Leipzig – Köln") == pytest.approx(0.9)
    assert pair_trips([("op", "reg", "RE 1", "A", "B", 2), ("op", "reg", "re1", "A", "B", 3)]) == {
        ("op", "reg", "RE1"): PairTrips(5, {("A", "B"): 5})
    }


def long_distance_pages() -> dict[str, str]:
    return {"ic": page("ic"), "ic2": page("ic2"), "ice": page("ice")}


def test_long_distance_rules(catalogue: Catalogue, operators: OperatorIndex) -> None:
    timetable = {
        ("db-fernverkehr-ag", "ld", "87"): ends(("Stuttgart Hbf", "Zürich HB", 41),
                                                 ("Konstanz Bahnhof", "Vaihingen", 4)),
        ("sbb", "ld", "IC"): ends(("Schaffhausen", "Zürich HB", 31)),
        ("db-fernverkehr-ag", "ld", "61"): ends(("Karlsruhe Hbf", "Nürnberg Hbf", 17)),
        ("db-fernverkehr-ag", "ld", "60"): ends(("Karlsruhe Hbf", "Stuttgart Hbf", 2)),
        ("db-fernverkehr-ag", "ld", "89"): ends(("München Hbf", "Verona Porta Nuova", 24)),
        ("db-fernverkehr-ag", "ld", "85"): ends(("Basel SBB", "Frankfurt Hbf", 2)),
        ("daenische-staatsbahnen", "ld", "IC"): ends(("Flensburg", "Fredericia", 16)),
    }  # fmt: skip
    generated = build_rules(long_distance_pages(), timetable, catalogue, operators, VALID)
    rules = {r["rule_id"]: r for r in generated.rules}
    assert set(rules) == {"ic-87-db-fernverkehr-ag", "ic-ic-sbb", "ic2-61-db-fernverkehr-ag",
                          "ice-85-db-fernverkehr-ag", "ice-89-db-fernverkehr-ag"}  # fmt: skip
    assert rules["ice-85-db-fernverkehr-ag"]["series_ids"] == ["sbb-rabe-501"]
    assert rules["ic-87-db-fernverkehr-ag"]["match_share"] == pytest.approx(0.911, abs=1e-3)
    assert match_exception("ic", "IC87") is not None
    assert match_exception("ice", "IC87") is None
    assert rules["ice-89-db-fernverkehr-ag"]["series_ids"] == ["obb-railjet", "obb-railjet-2"]
    assert rules["ice-89-db-fernverkehr-ag"]["evidence"] == "ICE 89: Railjet | ICE 89: Railjet 2"
    assert rules["ic-ic-sbb"]["evidence"] == "IC 87: IC2"
    reasons = {s.reason for s in generated.skipped}
    assert "names ICE trainsets, whose trips are not of category ld" in reasons
    assert "not in the catalogue: DSB MF" in reasons
    for rule in generated.rules:
        FleetRule.model_validate(rule)


def test_a_match_exception_has_a_lower_bound(
    catalogue: Catalogue, operators: OperatorIndex
) -> None:
    exception = match_exception("ic", "IC87")
    assert exception is not None
    assert 0.5 < exception.floor < MATCH_SHARE_FLOOR
    timetable = {
        ("db-fernverkehr-ag", "ld", "87"): ends(("Stuttgart Hbf", "Zürich HB", 41),
                                                 ("Konstanz Bahnhof", "Vaihingen", 20)),
    }  # fmt: skip
    generated = build_rules(long_distance_pages(), timetable, catalogue, operators, VALID)
    assert generated.rules == []
    skipped = [s for s in generated.skipped if s.pair == ("db-fernverkehr-ag", "ld", "87")]
    assert ("ic", "route match below the floor") in {(s.list, s.reason) for s in skipped}


def test_ic_rules_stop_when_the_ic_list_no_longer_says_the_kiss_were_sold(
    catalogue: Catalogue, operators: OperatorIndex
) -> None:
    pages = long_distance_pages()
    pages["ic"] = pages["ic"].replace("verkauft", "vermietet")
    with pytest.raises(SourceChangedError, match="KISS"):
        build_rules(pages, {}, catalogue, operators, VALID)


def test_regional_rules_need_the_operator_and_the_route(
    catalogue: Catalogue, operators: OperatorIndex
) -> None:
    timetable = {
        ("db-regio-ag-nord", "rfast", "RE6"): ends(("Hamburg-Altona", "Westerland (Sylt)", 30)),
        ("db-regio-ag-nord", "rfast", "RE6X"): ends(("Hamburg-Altona", "Westerland (Sylt)", 9)),
        ("db-regio-ag-nord", "rfast", "RE80"): ends(("Hamburg Hbf", "Lübeck Hbf", 20)),
        ("db-regio-ag-nordost", "rfast", "RE80"): ends(("Berlin Hbf", "Cottbus", 20)),
        ("eurobahn", "rfast", "RE13"): ends(("Venlo", "Hamm (Westf) Hbf", 19),
                                            ("Bonn Hbf", "Koblenz Hbf", 2)),
        ("eurobahn", "reg", "RB59"): ends(("Dortmund Hbf", "Soest", 30)),
        ("db-regio-ag-nrw", "reg", "RB43"): ends(("Dortmund Hbf", "Dorsten", 30)),
        ("norddeutsche-eisenbahn-gesellschaft", "reg", "RB65"): ends(
            ("Niebüll", "Dagebüll Mole", 9)),
    }  # fmt: skip
    pages = {"sh": page("sh"), "nrw": page("nrw")}
    generated = build_rules(pages, timetable, catalogue, operators, VALID)
    rules = {r["rule_id"]: r for r in generated.rules}
    assert set(rules) == {"sh-re6-db-regio-ag-nord", "sh-re6x-db-regio-ag-nord",
                          "sh-re80-db-regio-ag-nord", "nrw-rb59-eurobahn"}  # fmt: skip
    assert rules["sh-re80-db-regio-ag-nord"]["series_ids"] == ["stadler-kiss"]
    cell = "1–2 × 245 + 4–12; Married-Pair-Wagen; 218 / 245 + 5 Doppelstockwagen"
    assert rules["sh-re6-db-regio-ag-nord"]["evidence"] == f"RE 6, DB Regio Marschbahn: {cell}"
    assert rules["sh-re6x-db-regio-ag-nord"]["lines"] == ["RE6X"]
    assert rules["sh-re6x-db-regio-ag-nord"]["evidence"] == (
        f"RE 6x (RE 60), DB Regio Marschbahn: {cell}"
    )
    skipped = {(s.list, s.label): s for s in generated.skipped}
    assert skipped[("nrw", "RE 13")].share == pytest.approx(19 / 21, abs=1e-3)
    assert skipped[("nrw", "RB 43")].reason == "not in the catalogue: Pesa Link"
    assert skipped[("sh", "RB 65")].reason == "not in the catalogue: ÖBB 5047"
    assert all(float(r["match_share"]) >= MATCH_SHARE_FLOOR for r in generated.rules)


def test_a_line_label_keeps_its_letter_suffix(catalogue: Catalogue) -> None:
    sh = {r.label: r.line for r in list_lines(LISTS_BY_SHORT["sh"], page("sh"), catalogue)}
    assert sh["RE 6x (RE 60)"] == "RE6X"
    assert sh["RE 6"] == "RE6"
    table = (
        '{| class="wikitable"\n! Linie !! Zuglauf !! Fahrzeuge !! Betreiber\n|-\n'
        "| RE 8X || Hamburg – Lübeck || 445 ([[Stadler KISS|KISS]]) || DB Regio Nord\n|-\n"
        "| S 5X || Halle – Leipzig || [[Bombardier Talent 2|BR 1442]] || DB Regio Südost\n|}\n"
    )
    found = list_lines(LISTS_BY_SHORT["sh"], table, catalogue)
    assert [(r.label, r.line) for r in found] == [("RE 8X", "RE8X"), ("S 5X", "S5X")]


FEED = FeedFile(
    source_id="delfi-gtfs",
    published_on=date(2026, 10, 19),
    name="20261019_fahrplaene_gesamtdeutschland_gtfs.zip",
    sha256="ad8cce13001c3c5d08c2d002ac5550235767d53ac11eb1c4b6008c8054e767db",
    valid_from=date(2026, 10, 3),
    valid_to=date(2026, 12, 12),
)


def test_the_feed_file_is_named_by_its_published_file() -> None:
    feed = FeedFile.of_row(
        ("delfi-gtfs", date(2026, 10, 19), FEED.sha256,
         "https://www.opendata-oepnv.de/fileadmin/datasets/delfi/"
         "20261019_fahrplaene_gesamtdeutschland_gtfs.zip?x=1",
         "inputs/delfi/2026-10-19/delfi-gtfs.zip", date(2026, 10, 3), date(2026, 12, 12))
    )  # fmt: skip
    assert feed == FEED
    local = FeedFile.of_row(("delfi-gtfs", date(2026, 10, 19), FEED.sha256, None,
                             "inputs/delfi/2026-10-19/delfi-gtfs.zip", None, None))  # fmt: skip
    assert local.name == "delfi-gtfs.zip"
    assert FEED.covers(date(2026, 10, 20))
    assert not FEED.covers(date(2026, 12, 14))
    assert local.covers(date(2026, 12, 14))


def test_the_feed_version_must_be_named() -> None:
    base = ["fleet-ic-regional-lines", "--day", "2026-10-20", "--valid-from", "2025-12-14",
            "--valid-to", "2026-12-12"]  # fmt: skip
    with pytest.raises(SystemExit):
        build_parser().parse_args(base)
    assert build_parser().parse_args([*base, "--feed-version", "3"]).feed_version == 3


def test_the_generated_block_names_its_command_and_replaces_only_itself() -> None:
    generated = build_rules({}, {}, Catalogue({}, {}, {}, {}), OperatorIndex({}), VALID)
    command = "gerlines-catalog fleet-ic-regional-lines --day x --feed-version <id>"
    section = commands.fleet_section(generated, command, FEED)
    assert section.startswith(commands.GENERATED_SECTION)
    assert f"`{command}`" in section
    assert "20261019_fahrplaene_gesamtdeutschland_gtfs.zip" in section
    assert FEED.sha256 in section
    assert "list ic line IC87 from 0.85" in section
    assert "evidence is adapted from the article (CC BY-SA" in section
    text = (
        f"# head\n- a: 1\n{commands.GENERATED_SECTION}\n- old: 1\n"
        f"{commands.NEXT_SECTION}, ops\n- b: 2\n"
    )
    replaced = commands.replace_fleet_section(text, section)
    assert "- old: 1" not in replaced
    assert replaced.startswith("# head\n- a: 1\n")
    assert replaced.endswith(f"{commands.NEXT_SECTION}, ops\n- b: 2\n")


def test_parse_revisions_keys_pages_by_revision() -> None:
    answer = {"query": {"pages": [{"title": "Liste", "revisions": [
        {"revid": 271400738, "slots": {"main": {"content": "text"}}}]}]}}  # fmt: skip
    found = parse_revisions(answer)
    assert found[271400738].title == "Liste"
    assert found[271400738].permalink.endswith("oldid=271400738")
