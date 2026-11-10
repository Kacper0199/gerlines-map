from gerlines_catalog.build import (
    line_colour_rows,
    merge_spnv,
    operator_slug,
    verbund_rows,
    write_line_colours,
)
from gerlines_catalog.verbuende import parse
from gerlines_catalog.wikipedia import Page

LIST = """Intro.

== Baden-Württemberg ==
In allen Verkehrsverbünden ist der SPNV integriert.
{| class="wikitable sortable"
|- class="hintergrundfarbe5"
! Verbund !! Name !! Trägerschaft !! Tarifmodell !! Anmerkungen
|-
| VRN || [[Verkehrsverbund Rhein-Neckar]] || Mischverbund || Zonentarif || übergreifend
|-
| AVV || [[Beispielverbund Nord|Beispielverbund]] || Mischverbund || Zonentarif ||
|}

== Bayern ==
=== Bayerische Verbünde ohne [[Schienenpersonennahverkehr|SPNV]]-Integration ===
{| class="wikitable sortable"
|-
| AVV || [[Augsburger Beispielverbund]] || || Zonentarif ||
|}

== Hessen ==
{| class="wikitable sortable"
|-
| VRN || [[Verkehrsverbund Rhein-Neckar]] || Mischverbund || Zonentarif ||
|-
| NVV || [[Nordhessischer Verkehrsverbund]] ||Unternehmensverbund
| Zonentarif || mit [[Schienenpersonennahverkehr|SPNV]]-Integration
|}

== Ehemalige und integrierte Verkehrsverbünde ==
{| class="wikitable"
|-
| OLD || [[Alter Verbund]] || || ||
|}
"""


def test_the_list_parser_merges_laender_and_reads_spnv() -> None:
    listed = parse(LIST)
    assert set(listed) == {
        "Verkehrsverbund Rhein-Neckar",
        "Beispielverbund Nord",
        "Augsburger Beispielverbund",
        "Nordhessischer Verkehrsverbund",
    }
    vrn = listed["Verkehrsverbund Rhein-Neckar"]
    assert vrn.laender == {"DE-BW", "DE-HE"}
    assert vrn.spnv == {True, None}
    assert listed["Augsburger Beispielverbund"].spnv == {False}
    assert listed["Nordhessischer Verkehrsverbund"].spnv == {True}
    assert listed["Beispielverbund Nord"].name == "Beispielverbund"


def test_merge_spnv_keeps_conflicts_unknown() -> None:
    assert merge_spnv({True, None}) is True
    assert merge_spnv({False}) is False
    assert merge_spnv({True, False}) is None
    assert merge_spnv({None}) is None


def test_verbund_rows_disambiguate_ids_and_explain_gaps() -> None:
    page = Page("Liste", 42, LIST)
    rows = verbund_rows(
        page,
        {"Verkehrsverbund Rhein-Neckar": "Q1", "Augsburger Beispielverbund": "Q2"},
        {"Q1": ["https://www.vrn.de"], "Q2": ["https://a.example", "https://b.example"]},
    )
    by_id = {row["verbund_id"]: row for row in rows}
    assert set(by_id) == {"avv-bw", "avv-by", "nvv", "vrn"}
    assert by_id["vrn"]["laender"] == ["DE-BW", "DE-HE"]
    assert by_id["vrn"]["website"] == "https://www.vrn.de"
    assert "website" not in by_id["avv-by"]
    assert by_id["avv-by"]["spnv_integrated"] is False
    assert "wikidata_qid" in by_id["nvv"]["missing"]


def test_verbund_rows_name_a_missing_article_as_missing() -> None:
    page = Page("Liste", 42, LIST)
    rows = verbund_rows(page, {}, {}, absent={"Nordhessischer Verkehrsverbund"})
    nvv = next(row for row in rows if row["verbund_id"] == "nvv")
    assert nvv["missing"]["wikidata_qid"] == (
        "the list links 'Nordhessischer Verkehrsverbund', which has no article on German Wikipedia"
    )
    vrn = next(row for row in rows if row["verbund_id"] == "vrn")
    assert "has no Wikidata sitelink" in vrn["missing"]["wikidata_qid"]


UPSTREAM = (
    "shortOperatorName,lineName,hafasOperatorCode,hafasLineId,backgroundColor,textColor,"
    "borderColor,shape,wikidataQid,delfiAgencyID,delfiAgencyName\n"
    "agilis,RB 15,agilis,ag-rb15,#24B27D,#ffffff,,rectangle,Q1,10838,agilis\n"
    "agilis,RB 15,agilis,ag-rb15,#24b27d,#ffffff,,rectangle,,10838,agilis\n"
    "vbx,12,,,#000000,#ffffff,,circle,,999,Busbetrieb X\n"
    "liege-s,S41,sncb,4-88-41,#0f6030,#ffffff,#ffffff,circle,,,\n"
    "alex-dlb,RE 2,alex,re2,#ffffff,#006666,#006666,rectangle,,10837,"
    "alex - Die Länderbahn GmbH DLB\n"
)


def test_line_colours_keep_catalogue_operators_with_stable_keys() -> None:
    known = {"agilis", "alex-die-laenderbahn-gmbh-dlb"}
    rows, skipped = line_colour_rows(UPSTREAM, known, "traewelling-line-colors")
    assert [r.line_colour_id for r in rows] == [
        "agilis-rb-15-ag-rb15",
        "agilis-rb-15-ag-rb15-2",
        "alex-dlb-re-2-re2",
    ]
    assert rows[0].background_hex == "#24b27d"
    assert rows[0].line_wikidata_qid == "Q1"
    assert rows[2].operator_id == "alex-die-laenderbahn-gmbh-dlb"
    assert skipped == {"operator not in the catalogue": 1, "no DELFI agency": 1}
    text = write_line_colours(rows)
    assert text.splitlines()[0].startswith("line_colour_id,upstream_operator,line_name")
    assert len(text.splitlines()) == 4


def test_operator_slug_follows_the_static_import() -> None:
    assert operator_slug("DB Regio AG1") == "db-regio-ag"
    assert operator_slug("trilex - Die Länderbahn GmbH DLB") == "trilex-die-laenderbahn-gmbh-dlb"
