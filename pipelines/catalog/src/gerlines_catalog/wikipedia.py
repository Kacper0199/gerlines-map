"""German Wikipedia pages (CC BY-SA 4.0) through the MediaWiki API, with revision ids kept.

Only facts are taken from the pages (numbers in infoboxes, table cells of the Verbund list),
always together with the revision id they were read from.
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass

from gerlines_catalog.cache import ResearchCache, sha256_hex

API_URL = "https://de.wikipedia.org/w/api.php"
WIKIPEDIA_LICENCE = "CC-BY-SA-4.0"
_BATCH = 20


@dataclass(frozen=True, slots=True)
class Page:
    title: str
    revid: int
    wikitext: str

    @property
    def permalink(self) -> str:
        return f"https://de.wikipedia.org/w/index.php?oldid={self.revid}"


def fetch_pages(
    cache: ResearchCache,
    titles: Sequence[str],
    *,
    lead_only: bool = False,
    refresh: bool = False,
) -> dict[str, Page]:
    """Current revisions of ``titles``, following redirects; keys are the requested titles.

    ``lead_only`` asks for section 0 (where the infobox lives), one page per request, which
    keeps each answer under about 256 KB.
    """
    pages: dict[str, Page] = {}
    ordered = sorted(set(titles))
    batch_size = 1 if lead_only else _BATCH
    for start in range(0, len(ordered), batch_size):
        batch = ordered[start : start + batch_size]
        form = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "prop": "revisions",
            "rvprop": "ids|content",
            "rvslots": "main",
            "redirects": "1",
            "titles": "|".join(batch),
        }
        if lead_only:
            form["rvsection"] = "0"
        prefix = "lead" if lead_only else "pages"
        name = f"{prefix}-{sha256_hex('|'.join(batch).encode())[:12]}.json"
        cached = cache.post_form(
            "wikipedia-de",
            name,
            API_URL,
            form,
            licence=WIKIPEDIA_LICENCE,
            accept="application/json",
            refresh=refresh,
        )
        pages.update(parse_query(json.loads(cached.body), batch))
    return pages


def fetch_revisions(
    cache: ResearchCache, revids: Sequence[int], *, refresh: bool = False
) -> dict[int, Page]:
    """The cited revisions ``revids`` (oldids), one request each, cached by revision id."""
    pages: dict[int, Page] = {}
    for revid in sorted(set(revids)):
        form = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "prop": "revisions",
            "rvprop": "ids|content",
            "rvslots": "main",
            "revids": str(revid),
        }
        cached = cache.post_form(
            "wikipedia-de",
            f"revision-{revid}.json",
            API_URL,
            form,
            licence=WIKIPEDIA_LICENCE,
            accept="application/json",
            refresh=refresh,
        )
        pages.update(parse_revisions(json.loads(cached.body)))
    return pages


def parse_revisions(answer: dict) -> dict[int, Page]:
    found: dict[int, Page] = {}
    for page in answer.get("query", {}).get("pages", ()):
        for revision in page.get("revisions", ()):
            content = revision["slots"]["main"]["content"]
            found[int(revision["revid"])] = Page(page["title"], int(revision["revid"]), content)
    return found


def parse_query(answer: dict, requested: Sequence[str]) -> dict[str, Page]:
    query = answer.get("query", {})
    renamed: dict[str, str] = {}
    for step in (*query.get("normalized", ()), *query.get("redirects", ())):
        renamed[step["from"]] = step["to"]
    by_title: dict[str, Page] = {}
    for page in query.get("pages", ()):
        revisions = page.get("revisions")
        if page.get("missing") or not revisions:
            continue
        revision = revisions[0]
        content = revision["slots"]["main"]["content"]
        by_title[page["title"]] = Page(page["title"], int(revision["revid"]), content)
    result: dict[str, Page] = {}
    for title in requested:
        target = title
        while target in renamed:
            target = renamed[target]
        if target in by_title:
            result[title] = by_title[target]
    return result


_FIELD = re.compile(r"^\|\s*([^=|]+?)\s*=(.*)$")
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_REF = re.compile(r"<ref[^>/]*/>|<ref[^>]*>.*?</ref>", re.DOTALL)


def infobox_fields(wikitext: str, template: str = "Infobox Schienenfahrzeug") -> dict[str, str]:
    """Top-level fields of the first ``template``; values keep their raw wiki markup."""
    start = wikitext.find("{{" + template)
    if start < 0:
        return {}
    text = _REF.sub("", _COMMENT.sub("", wikitext[start:]))
    depth = 0
    end = len(text)
    index = 0
    while index < len(text) - 1:
        pair = text[index : index + 2]
        if pair == "{{":
            depth += 1
            index += 2
            continue
        if pair == "}}":
            depth -= 1
            index += 2
            if depth == 0:
                end = index
                break
            continue
        index += 1
    body = text[:end]
    fields: dict[str, str] = {}
    current: str | None = None
    for line in body.splitlines()[1:]:
        match = _FIELD.match(line)
        if match:
            current = match.group(1).strip()
            fields[current] = match.group(2).strip()
        elif current is not None:
            fields[current] += "\n" + line
    return {key: value.removesuffix("}}").strip() for key, value in fields.items()}


_NUMBER = re.compile(r"(\d{1,3}(?:[\u202f\u00a0 .]\d{3})+|\d+)(?:,(\d+))?")
_SPACES = re.compile(r"&#8239;|&nbsp;|\{\{0\}\}|\{\{nnbsp\}\}|&thinsp;")


def _clean(raw: str) -> str:
    text = _SPACES.sub(" ", raw)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
    return re.sub(r"<[^>]+>", " ", text)


def _plain_value(raw: str | None, units: tuple[str, ...]) -> tuple[float, str] | None:
    """The number and unit when the field holds one plain value and nothing else."""
    if not raw:
        return None
    text = " ".join(_clean(raw).split())
    pattern = re.compile(
        r"^" + _NUMBER.pattern + r"\s*(" + "|".join(re.escape(u) for u in units) + r")$"
    )
    match = pattern.match(text)
    if match is None:
        return None
    whole = re.sub(r"[\u202f\u00a0 .]", "", match.group(1))
    number = float(f"{whole}.{match.group(2)}" if match.group(2) else whole)
    return number, match.group(3)


def single_speed_kmh(raw: str | None) -> int | None:
    """The speed in km/h when the field is one plain value, else ``None``."""
    found = _plain_value(raw, ("km/h",))
    return int(found[0]) if found else None


def single_length_m(raw: str | None) -> float | None:
    """The length in metres when the field is one plain value in mm or m, else ``None``."""
    found = _plain_value(raw, ("mm", "m"))
    if found is None:
        return None
    number, unit = found
    return round(number / 1000 if unit == "mm" else number, 3)


def resolve_titles(
    cache: ResearchCache, titles: Sequence[str], *, refresh: bool = False
) -> dict[str, str | None]:
    """Each requested title mapped to the title it normalises or redirects to, or to ``None``
    when that page does not exist."""
    resolved: dict[str, str | None] = {}
    ordered = sorted(set(titles))
    for start in range(0, len(ordered), 50):
        batch = ordered[start : start + 50]
        form = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "redirects": "1",
            "titles": "|".join(batch),
        }
        name = f"titles-{sha256_hex('|'.join(batch).encode())[:12]}.json"
        cached = cache.post_form(
            "wikipedia-de",
            name,
            API_URL,
            form,
            licence=WIKIPEDIA_LICENCE,
            accept="application/json",
            refresh=refresh,
        )
        query = json.loads(cached.body).get("query", {})
        renamed = {
            step["from"]: step["to"]
            for step in (*query.get("normalized", ()), *query.get("redirects", ()))
        }
        absent = {page["title"] for page in query.get("pages", ()) if page.get("missing")}
        for title in batch:
            target = title
            while target in renamed:
                target = renamed[target]
            resolved[title] = None if target in absent else target
    return resolved
