"""Operators from ``agency.txt``: stable slugs, aliases and the country where it is known.

DELFI repeats one operator under several agency ids and appends a counter to some names
(``vlexx1``, ``vlexx2``, ``DB Regio AG1``). The counter is dropped, the rest of the name gives
the slug, and every raw name is kept as an alias.
"""

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field

_COUNTER = re.compile(r"(?<=[^\d\s])\d{1,2}$")
_SPACES = re.compile(r"\s+")
_NOT_SLUG = re.compile(r"[^a-z0-9]+")
_GERMAN = str.maketrans(
    {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"}
)
_MAX_SLUG = 63

_COUNTRY_RULES: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), country)
    for pattern, country in (
        (r"^(SBB|THURBO|BLS|SOB|Schweizerische Bundesbahnen)\b", "CH"),
        (r"^(Österreichische Bundesbahnen|ÖBB|WESTbahn|Montafoner Bahn)\b", "AT"),
        (r"^(Ceske Drahy|České dráhy|CD|ČD|LEO Express|Arriva vlaky)$", "CZ"),
        (r"^(PKP|Koleje Dolnośląskie|Polregio)\b", "PL"),
        (r"^ZSSK\b", "SK"),
        (r"^MAV\b", "HU"),
        (r"^HZPP\b", "HR"),
        (r"^SNCF\b", "FR"),
        (r"^(SNCB|EUROSTAR)\b", "BE"),
        (r"^(Nederlandse Spoorwegen|European Sleeper)\b", "NL"),
        (r"^(Dänische Staatsbahnen|DSB)\b", "DK"),
        (r"^Trenitalia\b", "IT"),
        (r"^CFL\b", "LU"),
        (r"^(DB |Deutsche Bahn|S-Bahn (Berlin|Hamburg|München|Stuttgart|Hannover))", "DE"),
    )
)


def normalise_name(raw: str) -> str:
    collapsed = _SPACES.sub(" ", raw).strip()
    return _COUNTER.sub("", collapsed).strip() or collapsed


def slugify(name: str) -> str:
    ascii_name = (
        unicodedata.normalize("NFKD", name.translate(_GERMAN))
        .encode("ascii", "ignore")
        .decode("ascii")
        .lower()
    )
    slug = _NOT_SLUG.sub("-", ascii_name).strip("-")[:_MAX_SLUG].strip("-")
    if len(slug) < 2 or not slug[0].isalpha():
        slug = f"op-{slug}".strip("-")
    return slug


def country_of(name: str) -> str | None:
    for pattern, country in _COUNTRY_RULES:
        if pattern.search(name):
            return country
    return None


@dataclass(slots=True)
class Operator:
    operator_id: str
    name: str
    country_code: str | None
    aliases: set[str] = field(default_factory=set)

    @property
    def foreign(self) -> bool:
        return self.country_code is not None and self.country_code != "DE"


@dataclass(frozen=True, slots=True)
class OperatorCatalog:
    operators: dict[str, Operator]
    by_agency: dict[str, str]

    def for_agency(self, agency_id: str) -> Operator | None:
        operator_id = self.by_agency.get(agency_id)
        return self.operators.get(operator_id) if operator_id is not None else None


def build_catalog(agency_names: Mapping[str, str]) -> OperatorCatalog:
    """Group agencies into operators; the first normalised name seen for a slug names it."""
    operators: dict[str, Operator] = {}
    by_agency: dict[str, str] = {}
    for agency_id in sorted(agency_names, key=lambda key: (len(key), key)):
        raw = agency_names[agency_id]
        name = normalise_name(raw)
        slug = slugify(name)
        operator = operators.get(slug)
        if operator is None:
            operator = Operator(slug, name, country_of(name))
            operators[slug] = operator
        operator.aliases.add(raw)
        operator.aliases.add(name)
        by_agency[agency_id] = slug
    return OperatorCatalog(operators, by_agency)
