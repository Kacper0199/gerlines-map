from gerlines_catalog.wikipedia import (
    infobox_fields,
    parse_query,
    single_length_m,
    single_speed_kmh,
)

ARTICLE = """Intro text.
{{Infobox Schienenfahrzeug
| Baureihe = Example 100
| Höchstgeschwindigkeit = 160&#8239;km/h
| LängeÜberKupplung = 67&#8239;500&#8239;mm<ref>{{Internetquelle |url=https://e.org}}</ref>
| Dienstmasse = 114&#8239;t (dreiteilig)<br />173&#8239;t
  (fünfteilig)
| Antrieb = {{nowrap|elektrisch}}
}}
Body text {{Other template}}.
"""


def test_infobox_fields_read_top_level_values_without_refs() -> None:
    fields = infobox_fields(ARTICLE)
    assert fields["Höchstgeschwindigkeit"] == "160&#8239;km/h"
    assert fields["LängeÜberKupplung"] == "67&#8239;500&#8239;mm"
    assert "fünfteilig" in fields["Dienstmasse"]
    assert fields["Antrieb"] == "{{nowrap|elektrisch}}"
    assert infobox_fields("no infobox here") == {}


def test_only_single_plain_values_are_taken() -> None:
    assert single_speed_kmh("160&#8239;km/h") == 160
    assert single_speed_kmh("265&#8239;km/h (Siebenteiler: 250&#8239;km/h)") is None
    assert single_speed_kmh(None) is None
    assert single_length_m("67&#8239;500&#8239;mm") == 67.5
    assert single_length_m("41,7 m") == 41.7
    assert single_length_m("{{0}}40&#8239;100&#8239;mm (Zweiteiler)") is None
    assert single_length_m("20 560 mm (Triebkopf)<br />26 400 mm (Mittelwagen)") is None


def test_parse_query_follows_normalisation_and_redirects() -> None:
    answer = {
        "query": {
            "normalized": [{"from": "dB-Baureihe 481", "to": "DB-Baureihe 481"}],
            "redirects": [{"from": "DB-Baureihe 481", "to": "DB-Baureihe 481/482"}],
            "pages": [
                {
                    "title": "DB-Baureihe 481/482",
                    "revisions": [{"revid": 7, "slots": {"main": {"content": "text"}}}],
                },
                {"title": "Gone", "missing": True},
            ],
        }
    }
    pages = parse_query(answer, ["dB-Baureihe 481", "Gone"])
    assert list(pages) == ["dB-Baureihe 481"]
    assert pages["dB-Baureihe 481"].revid == 7
    assert pages["dB-Baureihe 481"].permalink.endswith("oldid=7")
