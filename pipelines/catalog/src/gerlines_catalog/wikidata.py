"""Wikidata SPARQL queries used to research and check the catalogue (CC0 data).

Each query has a stable name so its cached result can be found again; the cache keeps the body
and a sidecar. The parsers turn SPARQL JSON bindings into plain dictionaries.
"""

import json
import re
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from gerlines_catalog.cache import ResearchCache, sha256_hex

SPARQL_URL = "https://query.wikidata.org/sparql"
WIKIDATA_LICENCE = "CC0-1.0"
_QID = re.compile(r"^Q[1-9]\d*$")
_ENTITY_PREFIX = "http://www.wikidata.org/entity/"
KMH_UNIT = "Q180154"
METRE_UNIT = "Q11573"


class QueryError(ValueError):
    """A query was built from invalid input."""


def qid_of(uri: str) -> str:
    return uri.removeprefix(_ENTITY_PREFIX)


def checked_qids(qids: Iterable[str]) -> list[str]:
    result = sorted(set(qids), key=lambda q: int(q[1:]) if _QID.match(q) else 0)
    for qid in result:
        if not _QID.match(qid):
            msg = f"not a Wikidata item id: {qid!r}"
            raise QueryError(msg)
    return result


def _literal(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def run(cache: ResearchCache, name: str, query: str, *, refresh: bool = False) -> list[dict]:
    """Run ``query`` through the cache and return its bindings."""
    file_name = f"{name}-{sha256_hex(query.encode())[:12]}.json"
    cached = cache.post_form(
        "wikidata",
        file_name,
        SPARQL_URL,
        {"query": query},
        licence=WIKIDATA_LICENCE,
        accept="application/sparql-results+json",
        refresh=refresh,
    )
    return json.loads(cached.body)["results"]["bindings"]


def value(binding: dict, key: str) -> str | None:
    entry = binding.get(key)
    return entry["value"] if entry else None


def operator_query(qids: Sequence[str]) -> str:
    values = " ".join(f"wd:{q}" for q in checked_qids(qids))
    return f"""SELECT ?item ?labelEn ?labelDe ?official ?officialStart ?officialStartPrecision
       ?officialEnd ?officialEndPrecision ?country ?website ?inception ?inceptionPrecision
       ?dissolved ?dissolvedPrecision ?parent ?parentLabel ?replacedBy ?class ?classLabel WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item rdfs:label ?labelEn FILTER(lang(?labelEn) = "en") }}
  OPTIONAL {{ ?item rdfs:label ?labelDe FILTER(lang(?labelDe) = "de") }}
  OPTIONAL {{ ?item p:P1448 ?officialStatement . ?officialStatement ps:P1448 ?official .
             FILTER(lang(?official) IN ("de", "de-ch", "de-at", "en", "mul"))
             OPTIONAL {{ ?officialStatement pqv:P580 ?startNode .
                        ?startNode wikibase:timeValue ?officialStart ;
                                   wikibase:timePrecision ?officialStartPrecision }}
             OPTIONAL {{ ?officialStatement pqv:P582 ?endNode .
                        ?endNode wikibase:timeValue ?officialEnd ;
                                 wikibase:timePrecision ?officialEndPrecision }} }}
  OPTIONAL {{ ?item wdt:P17/wdt:P297 ?country }}
  OPTIONAL {{ ?item wdt:P856 ?website }}
  OPTIONAL {{ ?item p:P571/psv:P571 ?inceptionNode .
             ?inceptionNode wikibase:timeValue ?inception ;
                            wikibase:timePrecision ?inceptionPrecision }}
  OPTIONAL {{ ?item p:P576/psv:P576 ?dissolvedNode .
             ?dissolvedNode wikibase:timeValue ?dissolved ;
                            wikibase:timePrecision ?dissolvedPrecision }}
  OPTIONAL {{ ?item wdt:P749 ?parent }}
  OPTIONAL {{ ?item wdt:P1366 ?replacedBy }}
  OPTIONAL {{ ?item wdt:P31 ?class }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "de,en,mul". }}
}}"""


def search_query(terms: Sequence[str], limit: int = 5) -> str:
    """Item candidates per search term through the MediaWiki API service of the endpoint."""
    values = " ".join(_literal(t) for t in terms)
    return f"""SELECT ?term ?item ?itemLabel ?itemDescription WHERE {{
  VALUES ?term {{ {values} }}
  SERVICE wikibase:mwapi {{
    bd:serviceParam wikibase:endpoint "www.wikidata.org";
                    wikibase:api "EntitySearch";
                    mwapi:search ?term;
                    mwapi:language "de";
                    mwapi:limit "{limit}".
    ?item wikibase:apiOutputItem mwapi:item.
  }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "de,en,mul". }}
}}"""


def sitelink_query(titles: Sequence[str], wiki: str = "https://de.wikipedia.org/") -> str:
    values = " ".join(f"{_literal(t)}@de" for t in sorted(set(titles)))
    return f"""SELECT ?title ?item WHERE {{
  VALUES ?title {{ {values} }}
  ?article schema:about ?item ; schema:isPartOf <{wiki}> ; schema:name ?title .
}}"""


def series_query(qids: Sequence[str]) -> str:
    values = " ".join(f"wd:{q}" for q in checked_qids(qids))
    return f"""SELECT ?item ?itemLabel ?labelDe ?commons ?speed ?speedUnit ?length ?lengthUnit
       ?maker ?makerLabel ?class ?classLabel ?operator ?dewiki WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item wdt:P137 ?operator }}
  OPTIONAL {{ ?item rdfs:label ?labelDe FILTER(lang(?labelDe) = "de") }}
  OPTIONAL {{ ?item wdt:P373 ?commons }}
  OPTIONAL {{ ?item p:P2052/psv:P2052 ?speedNode .
             ?speedNode wikibase:quantityAmount ?speed ; wikibase:quantityUnit ?speedUnit }}
  OPTIONAL {{ ?item p:P2043/psv:P2043 ?lengthNode .
             ?lengthNode wikibase:quantityAmount ?length ; wikibase:quantityUnit ?lengthUnit }}
  OPTIONAL {{ ?item wdt:P176 ?maker }}
  OPTIONAL {{ ?item wdt:P31 ?class }}
  OPTIONAL {{ ?dewikiArticle schema:about ?item ; schema:isPartOf <https://de.wikipedia.org/> ;
             schema:name ?dewiki }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,de,mul". }}
}}"""


def series_class_query(qids: Sequence[str]) -> str:
    """Direct classes and parts of series items: ``P31``, ``P279``, ``P516``, ``P930``, ``P361``,
    and parts of a class (``P2670``, ``P527``) with their ``P1114`` quantity."""
    values = " ".join(f"wd:{q}" for q in checked_qids(qids))
    return f"""SELECT ?item ?via ?class ?classLabel ?quantity WHERE {{
  VALUES ?item {{ {values} }}
  {{ ?item wdt:P31 ?class . BIND("P31" AS ?via) }}
  UNION {{ ?item wdt:P279 ?class . BIND("P279" AS ?via) }}
  UNION {{ ?item wdt:P516 ?class . BIND("P516" AS ?via) }}
  UNION {{ ?item wdt:P930 ?class . BIND("P930" AS ?via) }}
  UNION {{ ?item wdt:P361 ?class . BIND("P361" AS ?via) }}
  UNION {{ ?item p:P2670 ?part . ?part ps:P2670 ?class . BIND("P2670" AS ?via)
           OPTIONAL {{ ?part pq:P1114 ?quantity }} }}
  UNION {{ ?item p:P527 ?part . ?part ps:P527 ?class . BIND("P527" AS ?via)
           OPTIONAL {{ ?part pq:P1114 ?quantity }} }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,de,mul". }}
}}"""


def ancestor_query(qids: Sequence[str]) -> str:
    """``P279`` ancestors up to three levels above each class, with labels."""
    values = " ".join(f"wd:{q}" for q in checked_qids(qids))
    return f"""SELECT DISTINCT ?item ?class ?classLabel WHERE {{
  VALUES ?item {{ {values} }}
  ?item wdt:P279/wdt:P279?/wdt:P279? ?class .
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,de,mul". }}
}}"""


def colour_query(labels: Sequence[str]) -> str:
    """Items with an sRGB hex triplet (P465) whose English label is one of ``labels``."""
    values = " ".join(f"{_literal(t)}@en" for t in sorted(set(labels)))
    return f"""SELECT ?label ?item ?hex WHERE {{
  VALUES ?label {{ {values} }}
  ?item rdfs:label ?label ; wdt:P465 ?hex .
}}"""


def hex_query(qids: Sequence[str]) -> str:
    """The sRGB hex triplet (P465) of colour items."""
    values = " ".join(f"wd:{q}" for q in checked_qids(qids))
    return f"""SELECT ?item ?itemLabel ?hex WHERE {{
  VALUES ?item {{ {values} }}
  ?item wdt:P465 ?hex .
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "de,en,mul". }}
}}"""


def official_colour_query(qids: Sequence[str]) -> str:
    """Official colours (P6364) of operators with the hex triplet (P465) of each colour item."""
    values = " ".join(f"wd:{q}" for q in checked_qids(qids))
    return f"""SELECT ?item ?colour ?colourLabel ?hex WHERE {{
  VALUES ?item {{ {values} }}
  ?item wdt:P6364 ?colour .
  OPTIONAL {{ ?colour wdt:P465 ?hex }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,de,mul". }}
}}"""


@dataclass(slots=True)
class ItemFacts:
    qid: str
    values: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))

    def one(self, key: str) -> str | None:
        found = sorted(self.values.get(key, ()))
        return found[0] if len(found) == 1 else None

    def all(self, key: str) -> list[str]:
        return sorted(self.values.get(key, ()))


def group_by_item(bindings: Iterable[dict], keys: Sequence[str]) -> dict[str, ItemFacts]:
    items: dict[str, ItemFacts] = {}
    for binding in bindings:
        qid = qid_of(binding["item"]["value"])
        facts = items.setdefault(qid, ItemFacts(qid))
        for key in keys:
            found = value(binding, key)
            if found is not None:
                facts.values[key].add(qid_of(found) if found.startswith(_ENTITY_PREFIX) else found)
    return items
