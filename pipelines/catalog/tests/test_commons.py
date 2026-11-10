import pytest

from gerlines_catalog.cache import ResearchCache
from gerlines_catalog.commons import (
    PUBLIC_DOMAIN,
    Candidate,
    Credit,
    Licence,
    author_link,
    candidate_of,
    collect,
    credit_of,
    file_title,
    https_link,
    licence_of,
    page_url,
    plain_text,
)


def meta(**values: str) -> dict[str, dict[str, str]]:
    return {key: {"value": value} for key, value in values.items()}


BY_SA = meta(
    License="cc-by-sa-4.0",
    LicenseShortName="CC BY-SA 4.0",
    LicenseUrl="https://creativecommons.org/licenses/by-sa/4.0",
    AttributionRequired="true",
    Artist='<a href="//commons.wikimedia.org/wiki/User:Rail_Fan" title="Rail Fan">Rail Fan</a>',
)


@pytest.mark.parametrize(
    ("extmetadata", "expected"),
    [
        (BY_SA, Licence("CC-BY-SA-4.0", "CC BY-SA 4.0",
                        "https://creativecommons.org/licenses/by-sa/4.0", True)),
        (meta(License="cc-by-sa-3.0-de", LicenseShortName="CC BY-SA 3.0 de",
              LicenseUrl="http://creativecommons.org/licenses/by-sa/3.0/de/deed.en"),
         Licence("CC-BY-SA-3.0-DE", "CC BY-SA 3.0 de",
                 "https://creativecommons.org/licenses/by-sa/3.0/de/deed.en", True)),
        (meta(License="cc-by-2.0", LicenseShortName="CC BY 2.0",
              LicenseUrl="https://creativecommons.org/licenses/by/2.0", AttributionRequired="true"),
         Licence("CC-BY-2.0", "CC BY 2.0", "https://creativecommons.org/licenses/by/2.0", True)),
        (meta(License="cc0", LicenseShortName="CC0",
              LicenseUrl="http://creativecommons.org/publicdomain/zero/1.0/deed.en",
              AttributionRequired="false"),
         Licence("CC0-1.0", "CC0", "https://creativecommons.org/publicdomain/zero/1.0/deed.en",
                 False)),
        (meta(License="pd", LicenseShortName="Public domain", AttributionRequired="false"),
         Licence(PUBLIC_DOMAIN, "Public domain", None, False)),
    ],
)  # fmt: skip
def test_allowed_licences_are_normalised(extmetadata: dict, expected: Licence) -> None:
    assert licence_of(extmetadata) == expected


@pytest.mark.parametrize(
    ("extmetadata", "reason"),
    [
        (meta(License="cc-by-nd-4.0", LicenseShortName="CC BY-ND 4.0"),
         "licence not allowed: cc-by-nd-4.0"),
        (meta(License="cc-by-nc-sa-4.0"), "licence not allowed: cc-by-nc-sa-4.0"),
        (meta(License="gfdl", LicenseShortName="GFDL"), "licence not allowed: gfdl"),
        (meta(License="fal"), "licence not allowed: fal"),
        (meta(LicenseShortName="Unknown"), "licence not allowed: none given"),
        ({**BY_SA, **meta(NonFree="true")}, "non-free file"),
        ({**BY_SA, **meta(Restrictions="personality")}, "restrictions: personality"),
        (meta(License="cc-by-sa-4.0"), "licence link missing: cc-by-sa-4.0"),
    ],
)  # fmt: skip
def test_other_licences_are_left_out_with_a_reason(extmetadata: dict, reason: str) -> None:
    assert licence_of(extmetadata) == reason


def test_credit_takes_the_attribution_text_before_the_author() -> None:
    assert credit_of(BY_SA) == Credit(
        "Rail Fan", "https://commons.wikimedia.org/wiki/User:Rail_Fan"
    )
    with_text = {**BY_SA, **meta(Attribution="Photo: Rail Fan, CC BY-SA 4.0")}
    assert credit_of(with_text).author == "Photo: Rail Fan, CC BY-SA 4.0"
    assert credit_of(meta(Artist="<span>  </span>")) == "no author named"
    assert credit_of(meta(Artist="x" * 201)) == "author text longer than 200 characters"


def test_markup_becomes_plain_text_and_links_https() -> None:
    assert plain_text("Foo&nbsp;<b>Bar</b><br>Baz") == ("Foo\xa0Bar Baz".replace("\xa0", " "), [])
    assert https_link("//commons.wikimedia.org/wiki/User:A") == (
        "https://commons.wikimedia.org/wiki/User:A"
    )
    assert https_link("/wiki/User:A") == "https://commons.wikimedia.org/wiki/User:A"
    assert https_link("http://example.org/a") == "https://example.org/a"
    assert https_link("javascript:alert(1)") is None


def test_markup_is_unescaped_exactly_once() -> None:
    assert plain_text("Tom &amp;amp; Jerry &lt;3")[0] == "Tom &amp; Jerry <3"
    assert credit_of(meta(Artist="A &amp;amp; B")) == Credit("A &amp; B", None)


@pytest.mark.parametrize(
    ("href", "link"),
    [
        ("https://commons.wikimedia.org/w/index.php?title=User:Clic17&action=edit&redlink=1",
         "https://commons.wikimedia.org/wiki/User:Clic17"),
        ("//commons.wikimedia.org/w/index.php?title=User:Henry_Thiel&action=edit&redlink=1",
         "https://commons.wikimedia.org/wiki/User:Henry_Thiel"),
        ("https://de.wikipedia.org/w/index.php?title=Benutzer:J%C3%BCrgen&action=edit&redlink=1",
         "https://de.wikipedia.org/wiki/Benutzer:J%C3%BCrgen"),
        ("https://commons.wikimedia.org/w/index.php?title=DanielK.&action=edit&redlink=1", None),
        ("https://example.org/w/index.php?title=User:A&action=edit&redlink=1", None),
        ("https://commons.wikimedia.org/w/index.php?title=Special:Upload", None),
        ("https://commons.wikimedia.org/wiki/User:Rail_Fan",
         "https://commons.wikimedia.org/wiki/User:Rail_Fan"),
        ("https://www.flickr.com/people/robdammers/", "https://www.flickr.com/people/robdammers/"),
        ("javascript:alert(1)", None),
    ],
)  # fmt: skip
def test_author_links_name_a_page_never_an_edit_form(href: str, link: str | None) -> None:
    assert author_link(href) == link


def test_credit_takes_the_first_author_link_that_names_a_page() -> None:
    artist = (
        '<a href="https://commons.wikimedia.org/w/index.php?title=DanielK.&action=edit&redlink=1">'
        'DanielK.</a> <a href="https://www.flickr.com/people/d/">flickr</a>'
    )
    assert credit_of(meta(Artist=artist)) == Credit(
        "DanielK. flickr", "https://www.flickr.com/people/d/"
    )


def test_titles_and_page_links() -> None:
    assert file_title("ICE_3 in Köln.jpg") == "File:ICE 3 in Köln.jpg"
    assert file_title("File:dB 403.jpg") == "File:DB 403.jpg"
    assert page_url("File:ICE 3 in Köln (2).jpg") == (
        "https://commons.wikimedia.org/wiki/File:ICE_3_in_K%C3%B6ln_(2).jpg"
    )


def page(title: str = "File:ICE 3.jpg", **info: object) -> dict:
    base = {
        "url": "https://upload.wikimedia.org/wikipedia/commons/a/ab/ICE_3.jpg?utm_source=x",
        "thumburl": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/ICE_3.jpg/330px-ICE_3.jpg",
        "width": 3000,
        "height": 2000,
        "mime": "image/jpeg",
        "sha1": "0" * 40,
        "extmetadata": BY_SA,
    }
    return {"title": title, "imageinfo": [{**base, **info}]}


def test_candidate_of_keeps_the_metadata() -> None:
    candidate = candidate_of("db-403", page(), "wikidata-p18")
    assert isinstance(candidate, Candidate)
    assert candidate.page_url == "https://commons.wikimedia.org/wiki/File:ICE_3.jpg"
    assert candidate.licence.licence_id == "CC-BY-SA-4.0"
    assert candidate.credit.author == "Rail Fan"
    assert candidate.thumb_url.endswith("330px-ICE_3.jpg")
    assert candidate.original_url == "https://upload.wikimedia.org/wikipedia/commons/a/ab/ICE_3.jpg"


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"mime": "image/tiff"}, "file type image/tiff"),
        ({"mime": "image/svg+xml"}, "file type image/svg+xml"),
        ({"width": 800}, "narrower than 960 px"),
        ({"extmetadata": meta(License="cc-by-nd-4.0")}, "licence not allowed: cc-by-nd-4.0"),
    ],
)
def test_candidate_of_leaves_files_out(changes: dict, reason: str) -> None:
    assert candidate_of("db-403", page(**changes), "commons-category") == reason
    assert candidate_of("db-403", {"title": "File:x.jpg", "missing": True}, "x") == "file missing"


def test_score_prefers_p18_assessed_landscape_photos() -> None:
    assessed = {**BY_SA, **meta(Assessments="quality")}
    p18 = candidate_of("s", page(), "wikidata-p18")
    quality = candidate_of("s", page(extmetadata=assessed), "commons-category")
    portrait = candidate_of("s", page(width=2000, height=3000), "commons-category")
    plain = candidate_of("s", page(), "commons-category")
    assert p18.score > quality.score > plain.score > portrait.score


class FakeTransport:
    def __init__(self, answers: list[dict]) -> None:
        self.answers = answers
        self.forms: list[str] = []

    def __call__(self, request, timeout_s: float) -> bytes:
        import json  # noqa: PLC0415

        self.forms.append(request.data.decode())
        return json.dumps(self.answers.pop(0)).encode()


def test_collect_joins_p18_and_category_files_without_duplicates(tmp_path) -> None:
    entity = {
        "claims": {
            "P18": [
                {"rank": "deprecated", "mainsnak": {"datavalue": {"value": "Old.jpg"}}},
                {"rank": "normal", "mainsnak": {"datavalue": {"value": "ICE_3.jpg"}}},
            ],
            "P373": [{"rank": "normal", "mainsnak": {"datavalue": {"value": "DBAG Class 403"}}}],
        }
    }
    transport = FakeTransport([
        {"entities": {"Q1": entity}},
        {"query": {"normalized": [{"from": "File:ICE 3.jpg", "to": "File:ICE 3.jpg"}],
                   "pages": [page()]}},
        {"query": {"pages": [page(), page("File:Other.jpg", mime="image/gif"),
                             page("File:Second.jpg")]}},
    ])  # fmt: skip
    cache = ResearchCache(tmp_path, "test/0 (+test)", transport=transport, min_interval_s=0)
    [found] = collect(cache, [("db-403", "Q1", "Seed category")])
    assert found.category == "DBAG Class 403"
    assert found.p18 == "File:ICE 3.jpg"
    assert [c.file_title for c in found.candidates] == ["File:ICE 3.jpg", "File:Second.jpg"]
    assert found.candidates[0].found_by == "wikidata-p18"
    assert found.left_out == {"file type image/gif": 1}
    assert found.candidates[0].retrieved_at
    assert "gcmtitle=Category%3ADBAG+Class+403" in transport.forms[2]
    assert all("format=json" in form for form in transport.forms)


def test_a_cached_error_answer_is_fetched_again(tmp_path) -> None:
    from gerlines_catalog.commons import series_items  # noqa: PLC0415

    entity = {
        "claims": {"P18": [{"rank": "normal", "mainsnak": {"datavalue": {"value": "A.jpg"}}}]}
    }
    transport = FakeTransport([{"error": {"code": "maxlag", "info": "lagged"}}])
    cache = ResearchCache(tmp_path, "test/0 (+test)", transport=transport, min_interval_s=0)
    with pytest.raises(Exception, match="maxlag"):
        series_items(cache, ["Q1"])
    transport.answers.append({"entities": {"Q1": entity}})
    assert series_items(cache, ["Q1"]) == {"Q1": {"p18": "A.jpg", "p373": None}}
