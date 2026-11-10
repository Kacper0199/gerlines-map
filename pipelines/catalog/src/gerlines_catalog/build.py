"""Seed files that are generated from pinned or cached sources: Verbünde and line colours."""

import csv
import io
import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Collection, Iterable, Mapping

from gerlines_catalog import verbuende, wikidata
from gerlines_catalog.cache import ResearchCache
from gerlines_catalog.models import LineColour
from gerlines_catalog.wikipedia import Page, resolve_titles
from gerlines_static_import.operators import normalise_name, slugify

VERBUND_LIST_TITLE = "Liste deutscher Tarif- und Verkehrsverbünde"
_NOT_SLUG = re.compile(r"[^a-z0-9]+")
_GERMAN = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def slug(text: str) -> str:
    ascii_text = (
        unicodedata.normalize("NFKD", text.lower().translate(_GERMAN))
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    return _NOT_SLUG.sub("-", ascii_text).strip("-")


def merge_spnv(flags: set[bool | None]) -> bool | None:
    if True in flags and False in flags:
        return None
    if True in flags:
        return True
    if flags == {False}:
        return False
    return None


def verbund_rows(
    page: Page,
    qids: Mapping[str, str],
    websites: Mapping[str, list[str]],
    absent: Collection[str] = (),
) -> list[dict]:
    """Seed rows for every Verbund of the list page; ``qids`` maps article titles to items and
    ``absent`` holds the linked titles that have no article."""
    listed = verbuende.parse(page.wikitext)
    abbr_slugs = Counter(slug(v.abbr) for v in listed.values())
    rows: list[dict] = []
    for article, entry in sorted(listed.items(), key=lambda kv: (slug(kv[1].abbr), kv[0])):
        laender = sorted(entry.laender)
        base = slug(entry.abbr)
        verbund_id = base if abbr_slugs[base] == 1 else f"{base}-{laender[0][3:].lower()}"
        row: dict = {
            "verbund_id": verbund_id,
            "abbr": entry.abbr,
            "name": entry.name,
            "laender": laender,
        }
        missing: dict[str, str] = {}
        spnv = merge_spnv(entry.spnv)
        if spnv is None:
            missing["spnv_integrated"] = (
                "the list states it for no section this Verbund is listed in"
                if entry.spnv <= {None}
                else "the list states it differently in different Länder sections"
            )
        else:
            row["spnv_integrated"] = spnv
        qid = qids.get(article)
        field_sources: dict[str, str] = {}
        if qid:
            row["wikidata_qid"] = qid
            field_sources["wikidata_qid"] = "wikidata"
            sites = websites.get(qid, [])
            if len(sites) == 1:
                row["website"] = sites[0]
                field_sources["website"] = "wikidata"
        elif article in absent:
            missing["wikidata_qid"] = (
                f"the list links {article!r}, which has no article on German Wikipedia"
            )
        else:
            missing["wikidata_qid"] = f"the linked article {article!r} has no Wikidata sitelink"
        row["source"] = "wikipedia-de-verbuende"
        if field_sources:
            row["field_sources"] = field_sources
        if missing:
            row["missing"] = missing
        rows.append(row)
    return rows


def verbund_article_titles(page: Page) -> list[str]:
    return sorted(verbuende.parse(page.wikitext))


def absent_articles(cache: ResearchCache, titles: Iterable[str]) -> set[str]:
    """Titles that have no article on German Wikipedia."""
    return {t for t, target in resolve_titles(cache, list(titles)).items() if target is None}


def resolve_articles(cache: ResearchCache, titles: Iterable[str]) -> dict[str, str]:
    """Article titles (redirects followed) mapped to the Wikidata item of their target."""
    targets = {t: target for t, target in resolve_titles(cache, list(titles)).items() if target}
    ordered = sorted(set(targets.values()))
    by_target: dict[str, str] = {}
    for start in range(0, len(ordered), 40):
        query = wikidata.sitelink_query(ordered[start : start + 40])
        for row in wikidata.run(cache, "verbund-sitelinks", query):
            by_target[row["title"]["value"]] = wikidata.qid_of(row["item"]["value"])
    return {t: by_target[target] for t, target in targets.items() if target in by_target}


def item_websites(cache: ResearchCache, qids: Iterable[str]) -> dict[str, list[str]]:
    ordered = sorted(set(qids))
    sites: dict[str, set[str]] = defaultdict(set)
    for start in range(0, len(ordered), 40):
        values = " ".join(f"wd:{q}" for q in wikidata.checked_qids(ordered[start : start + 40]))
        query = (
            f"SELECT ?item ?website WHERE {{ VALUES ?item {{ {values} }} ?item wdt:P856 ?website }}"
        )
        for row in wikidata.run(cache, "verbund-websites", query):
            sites[wikidata.qid_of(row["item"]["value"])].add(row["website"]["value"])
    return {q: sorted(s) for q, s in sites.items()}


LINE_COLOUR_COLUMNS = (
    "line_colour_id",
    "upstream_operator",
    "line_name",
    "delfi_agency_key",
    "delfi_agency_name",
    "operator_id",
    "background_hex",
    "text_hex",
    "border_hex",
    "shape",
    "line_wikidata_qid",
    "source",
)


def operator_slug(agency_name: str) -> str:
    """The static import's operator slug for a DELFI agency name."""
    return slugify(normalise_name(agency_name))


def line_colour_rows(
    upstream_csv: str, known_operators: Collection[str], source_id: str
) -> tuple[list[LineColour], Counter[str]]:
    """Rows of Träwelling ``line-colors.csv`` for catalogue operators, normalised and keyed.

    The operator comes from the DELFI agency name through the static import's slug rule. Rows
    without a DELFI agency or for operators outside the catalogue are counted, not kept.
    """
    reader = csv.DictReader(io.StringIO(upstream_csv))
    rows: list[LineColour] = []
    seen: Counter[str] = Counter()
    skipped: Counter[str] = Counter()
    for record in reader:
        agency = (record.get("delfiAgencyID") or "").strip()
        agency_name = (record.get("delfiAgencyName") or "").strip()
        if not agency or not agency_name:
            skipped["no DELFI agency"] += 1
            continue
        operator_id = operator_slug(agency_name)
        if operator_id not in known_operators:
            skipped["operator not in the catalogue"] += 1
            continue
        base = slug(f"{record['shortOperatorName']}-{record['lineName']}")
        if record.get("hafasLineId"):
            base = slug(f"{base}-{record['hafasLineId']}")
        seen[base] += 1
        key = base if seen[base] == 1 else f"{base}-{seen[base]}"
        rows.append(
            LineColour(
                line_colour_id=key,
                upstream_operator=record["shortOperatorName"].strip(),
                line_name=record["lineName"].strip(),
                delfi_agency_key=agency,
                delfi_agency_name=agency_name,
                operator_id=operator_id,
                background_hex=record["backgroundColor"].strip().lower(),
                text_hex=record["textColor"].strip().lower(),
                border_hex=(record.get("borderColor") or "").strip().lower() or None,
                shape=record["shape"].strip(),
                line_wikidata_qid=(record.get("wikidataQid") or "").strip() or None,
                source=source_id,
            )
        )
    return rows, skipped


def write_line_colours(rows: Iterable[LineColour]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=LINE_COLOUR_COLUMNS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        data = row.model_dump(mode="json")
        writer.writerow({k: "" if data[k] is None else data[k] for k in LINE_COLOUR_COLUMNS})
    return buffer.getvalue()
