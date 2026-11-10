"""Photo candidates for the vehicle series from Wikimedia Commons, found through Wikidata.

Each series item gives its image (P18) and its Commons category (P373, or the seed's
``commons_category``). Commons ``imageinfo`` with ``extmetadata`` names the author, the licence,
its link and whether attribution is required. Only CC0, public domain, CC BY and CC BY-SA files
become candidates; every other file is counted with the reason it was left out.
"""

import json
import re
import urllib.parse
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from html.parser import HTMLParser

from gerlines_catalog.cache import ResearchCache, sha256_hex

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
COMMONS_LICENCE = "CC-BY-SA-4.0"
WIKIDATA_LICENCE = "CC0-1.0"
PUBLIC_DOMAIN = "LicenseRef-Public-Domain"
STORED_WIDTHS = (330, 960)
MIN_ORIGINAL_WIDTH = 960
CATEGORY_FILES = 50
_ENTITY_BATCH = 50
_TITLE_BATCH = 25
ACCEPTED_MIMES = {"image/jpeg": "jpg", "image/png": "png"}
EXTMETADATA_FIELDS = (
    "Artist",
    "Attribution",
    "AttributionRequired",
    "Copyrighted",
    "Credit",
    "DateTimeOriginal",
    "ImageDescription",
    "License",
    "LicenseShortName",
    "LicenseUrl",
    "NonFree",
    "Restrictions",
    "UsageTerms",
    "Assessments",
)
_CC = re.compile(r"^cc-(by|by-sa)-(\d\.\d)(?:-([a-z]{2,3}))?$")
_PD = re.compile(r"^(pd|public[ -]domain)(-.*)?$")
_ASSESSMENT_WEIGHT = {"featured": 3, "quality": 2, "valued": 1}


class CommonsError(RuntimeError):
    """An API answer was not what the query asked for."""


@dataclass(frozen=True, slots=True)
class Licence:
    licence_id: str
    name: str
    url: str | None
    attribution_required: bool


@dataclass(frozen=True, slots=True)
class Credit:
    author: str
    author_url: str | None


@dataclass(frozen=True, slots=True)
class Candidate:
    series_id: str
    file_title: str
    page_url: str
    original_url: str
    width: int
    height: int
    mime: str
    commons_sha1: str
    licence: Licence
    credit: Credit
    found_by: str
    description: str
    assessments: tuple[str, ...]
    thumb_url: str | None
    retrieved_at: str

    @property
    def score(self) -> float:
        ratio = self.width / self.height
        landscape = 1.0 if 1.3 <= ratio <= 1.8 else 0.4 if ratio > 1 else 0.0
        size = min(self.width, 4000) / 4000
        assessed = sum(_ASSESSMENT_WEIGHT.get(name, 0) for name in self.assessments)
        p18 = 2.5 if self.found_by == "wikidata-p18" else 0.0
        return round(p18 + assessed + 2 * landscape + size, 3)


@dataclass(slots=True)
class SeriesCandidates:
    series_id: str
    qid: str | None
    category: str | None
    p18: str | None
    candidates: list[Candidate] = field(default_factory=list)
    left_out: dict[str, int] = field(default_factory=dict)

    def leave_out(self, reason: str) -> None:
        self.left_out[reason] = self.left_out.get(reason, 0) + 1


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)
        if tag in {"br", "p", "li"}:
            self.parts.append(" ")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain_text(markup: str) -> tuple[str, list[str]]:
    parser = _Text()
    parser.feed(markup)
    parser.close()
    text = re.sub(r"\s+", " ", "".join(parser.parts)).strip()
    return text, parser.links


def without_query(url: str) -> str:
    return urllib.parse.urlunsplit(urllib.parse.urlsplit(url)._replace(query="", fragment=""))


def https_link(href: str) -> str | None:
    if href.startswith("//"):
        href = "https:" + href
    elif href.startswith("/wiki/"):
        href = "https://commons.wikimedia.org" + href
    parsed = urllib.parse.urlsplit(href)
    if parsed.scheme == "http":
        parsed = parsed._replace(scheme="https")
    if parsed.scheme != "https" or not parsed.netloc:
        return None
    return urllib.parse.urlunsplit(parsed)


_USER_PAGES = ("User:", "Benutzer:", "Benutzerin:")
_WIKI_HOSTS = (".wikimedia.org", ".wikipedia.org")


def author_link(href: str) -> str | None:
    """An https link to the author's page; an edit form of a missing user page becomes the page.

    MediaWiki links a user page that does not exist as ``/w/index.php?title=User:…&redlink=1``,
    which opens the edit form. Such a link is rewritten to ``/wiki/User:…``; any other script or
    edit link is dropped.
    """
    url = https_link(href)
    if url is None:
        return None
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query)
    if parts.path != "/w/index.php" and not {"action", "redlink"} & query.keys():
        return url
    title = (query.get("title") or [""])[0]
    if not parts.netloc.endswith(_WIKI_HOSTS) or not title.startswith(_USER_PAGES):
        return None
    path = "/wiki/" + urllib.parse.quote(title.replace(" ", "_"), safe=":_(),'-.!@")
    return urllib.parse.urlunsplit(("https", parts.netloc, path, "", ""))


def _meta(extmetadata: Mapping[str, object], key: str) -> str:
    entry = extmetadata.get(key)
    if isinstance(entry, Mapping):
        raw = entry.get("value")
        return str(raw).strip() if raw is not None else ""
    return ""


def licence_of(extmetadata: Mapping[str, object]) -> Licence | str:  # noqa: PLR0911
    """The file's licence when it is one we may store, otherwise the reason it is left out."""
    if _meta(extmetadata, "NonFree").lower() == "true":
        return "non-free file"
    restrictions = _meta(extmetadata, "Restrictions")
    if restrictions:
        return f"restrictions: {restrictions}"
    code = _meta(extmetadata, "License").lower()
    short = plain_text(_meta(extmetadata, "LicenseShortName"))[0]
    url = https_link(_meta(extmetadata, "LicenseUrl")) if _meta(extmetadata, "LicenseUrl") else None
    required = _meta(extmetadata, "AttributionRequired").lower() != "false"
    if code == "cc0":
        return Licence("CC0-1.0", short or "CC0", url, attribution_required=False)
    if _PD.match(code) or short.lower() == "public domain":
        return Licence(PUBLIC_DOMAIN, short or "Public domain", url, attribution_required=False)
    match = _CC.match(code)
    if match is None:
        return f"licence not allowed: {code or 'none given'}"
    kind, version, port = match.groups()
    licence_id = f"CC-{kind.upper()}-{version}" + (f"-{port.upper()}" if port else "")
    if url is None:
        return f"licence link missing: {code}"
    return Licence(licence_id, short or licence_id.replace("-", " "), url, required)


def credit_of(extmetadata: Mapping[str, object]) -> Credit | str:
    """The credit line: the licensor's own attribution text when given, else the author."""
    attribution, _ = plain_text(_meta(extmetadata, "Attribution"))
    artist, links = plain_text(_meta(extmetadata, "Artist"))
    author_url = next((link for link in map(author_link, links) if link), None)
    text = attribution or artist
    if not text:
        return "no author named"
    if len(text) > 200:
        return "author text longer than 200 characters"
    return Credit(text, author_url)


def page_url(file_title: str) -> str:
    name = file_title.replace(" ", "_")
    return "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(name, safe=":_(),'-.!")


def file_title(name: str) -> str:
    bare = name.removeprefix("File:").removeprefix("Datei:").replace("_", " ").strip()
    return f"File:{bare[:1].upper()}{bare[1:]}"


def candidate_of(  # noqa: PLR0911
    series_id: str, page: Mapping[str, object], found_by: str
) -> Candidate | str:
    """A candidate from one ``imageinfo`` page, or the reason the file is left out."""
    if page.get("missing") or page.get("invalid"):
        return "file missing"
    infos = page.get("imageinfo")
    if not isinstance(infos, list) or not infos:
        return "no image info"
    info = infos[0]
    mime = str(info.get("mime", ""))
    if mime not in ACCEPTED_MIMES:
        return f"file type {mime or 'unknown'}"
    width, height = int(info.get("width", 0)), int(info.get("height", 0))
    if width < MIN_ORIGINAL_WIDTH or height <= 0:
        return f"narrower than {MIN_ORIGINAL_WIDTH} px"
    extmetadata = info.get("extmetadata") or {}
    licence = licence_of(extmetadata)
    if isinstance(licence, str):
        return licence
    credit = credit_of(extmetadata)
    if isinstance(credit, str):
        return credit
    title = str(page["title"])
    description = plain_text(_meta(extmetadata, "ImageDescription"))[0][:300]
    assessments = tuple(
        sorted(part for part in _meta(extmetadata, "Assessments").split("|") if part)
    )
    return Candidate(
        series_id=series_id,
        file_title=title,
        page_url=page_url(title),
        original_url=without_query(str(info["url"])),
        width=width,
        height=height,
        mime=mime,
        commons_sha1=str(info.get("sha1", "")),
        licence=licence,
        credit=credit,
        found_by=found_by,
        description=description,
        assessments=assessments,
        thumb_url=without_query(str(info["thumburl"])) if info.get("thumburl") else None,
        retrieved_at=str(page.get("retrieved_at", "")),
    )


def _api(  # noqa: PLR0913
    cache: ResearchCache,
    folder: str,
    url: str,
    form: Mapping[str, str],
    *,
    licence: str,
    refresh: bool,
) -> dict:
    body = {"format": "json", "formatversion": "2", **form}
    digest = sha256_hex(json.dumps(body, sort_keys=True).encode())[:16]
    name = f"{form['action']}-{digest}.json"
    cached = cache.post_form(
        folder, name, url, body, licence=licence, accept="application/json", refresh=refresh
    )
    answer = json.loads(cached.body)
    if "error" in answer and cached.reused:
        cached = cache.post_form(
            folder, name, url, body, licence=licence, accept="application/json", refresh=True
        )
        answer = json.loads(cached.body)
    if "error" in answer:
        msg = f"{url} answered {answer['error'].get('code')}: {answer['error'].get('info')}"
        raise CommonsError(msg)
    for page in answer.get("query", {}).get("pages", ()):
        page["retrieved_at"] = cached.sidecar["fetched_at"]
    return answer


def _claim_string(entity: Mapping[str, object], prop: str) -> str | None:
    claims = entity.get("claims")
    statements = claims.get(prop, []) if isinstance(claims, Mapping) else []
    ranked = sorted(statements, key=lambda s: {"preferred": 0, "normal": 1}.get(s["rank"], 2))
    for statement in ranked:
        if statement.get("rank") == "deprecated":
            continue
        value = statement.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def series_items(
    cache: ResearchCache, qids: Sequence[str], *, refresh: bool = False
) -> dict[str, dict[str, str | None]]:
    """P18 image and P373 Commons category of each item."""
    result: dict[str, dict[str, str | None]] = {}
    ordered = sorted(set(qids), key=lambda q: int(q[1:]))
    for start in range(0, len(ordered), _ENTITY_BATCH):
        batch = ordered[start : start + _ENTITY_BATCH]
        answer = _api(
            cache, "wikidata", WIKIDATA_API,
            {"action": "wbgetentities", "ids": "|".join(batch), "props": "claims"},
            licence=WIKIDATA_LICENCE, refresh=refresh,
        )  # fmt: skip
        for qid, entity in answer.get("entities", {}).items():
            result[qid] = {
                "p18": _claim_string(entity, "P18"),
                "p373": _claim_string(entity, "P373"),
            }
    return result


def _imageinfo_form(width: int = STORED_WIDTHS[0]) -> dict[str, str]:
    return {
        "prop": "imageinfo",
        "iiprop": "url|size|mime|sha1|extmetadata",
        "iiurlwidth": str(width),
        "iiextmetadatafilter": "|".join(EXTMETADATA_FIELDS),
        "iiextmetadatalanguage": "en",
    }


def file_pages(
    cache: ResearchCache,
    titles: Iterable[str],
    *,
    width: int = STORED_WIDTHS[0],
    refresh: bool = False,
) -> dict[str, dict]:
    """``imageinfo`` pages of ``titles`` with thumbnails ``width`` wide, keyed by title."""
    ordered = sorted(set(titles))
    pages: dict[str, dict] = {}
    for start in range(0, len(ordered), _TITLE_BATCH):
        batch = ordered[start : start + _TITLE_BATCH]
        answer = _api(
            cache, "commons", COMMONS_API,
            {"action": "query", "titles": "|".join(batch), **_imageinfo_form(width)},
            licence=COMMONS_LICENCE, refresh=refresh,
        )  # fmt: skip
        query = answer.get("query", {})
        renamed = {step["from"]: step["to"] for step in query.get("normalized", ())}
        by_title = {page["title"]: page for page in query.get("pages", ())}
        for title in batch:
            page = by_title.get(renamed.get(title, title))
            if page is not None:
                pages[title] = page
    return pages


def category_pages(cache: ResearchCache, category: str, *, refresh: bool = False) -> list[dict]:
    """The first files directly in a Commons category, with their ``imageinfo``."""
    answer = _api(
        cache, "commons", COMMONS_API,
        {
            "action": "query",
            "generator": "categorymembers",
            "gcmtitle": f"Category:{category.removeprefix('Category:')}",
            "gcmtype": "file",
            "gcmlimit": str(CATEGORY_FILES),
            **_imageinfo_form(),
        },
        licence=COMMONS_LICENCE, refresh=refresh,
    )  # fmt: skip
    return list(answer.get("query", {}).get("pages", ()))


def collect(
    cache: ResearchCache,
    series: Sequence[tuple[str, str | None, str | None]],
    *,
    refresh: bool = False,
) -> list[SeriesCandidates]:
    """Candidates of each ``(series_id, wikidata_qid, commons_category)``, best first."""
    items = series_items(cache, [qid for _, qid, _ in series if qid], refresh=refresh)
    found: list[SeriesCandidates] = []
    for series_id, qid, seed_category in series:
        item = items.get(qid or "", {})
        found.append(
            SeriesCandidates(
                series_id, qid, item.get("p373") or seed_category,
                file_title(item["p18"]) if item.get("p18") else None,
            )
        )  # fmt: skip
    p18_pages = file_pages(cache, [s.p18 for s in found if s.p18], refresh=refresh)
    for entry in found:
        seen: set[str] = set()
        pages: list[tuple[dict, str]] = []
        if entry.p18 and entry.p18 in p18_pages:
            pages.append((p18_pages[entry.p18], "wikidata-p18"))
        if entry.category:
            pages += [
                (page, "commons-category")
                for page in category_pages(cache, entry.category, refresh=refresh)
            ]
        for page, found_by in pages:
            title = str(page.get("title", ""))
            if title in seen:
                continue
            seen.add(title)
            candidate = candidate_of(entry.series_id, page, found_by)
            if isinstance(candidate, str):
                entry.leave_out(candidate)
            else:
                entry.candidates.append(candidate)
        entry.candidates.sort(key=lambda c: (-c.score, c.file_title))
    return found
