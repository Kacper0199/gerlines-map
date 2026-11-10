"""Read the vehicle cell of a line list row into catalogue series.

A cell names vehicles by linked article, by type words (``Talent 2``, ``LINT 41``) and by class
numbers (``442``, ``648/1648``, ``3462.1``). The reading keeps the cell order and puts vehicles
the cell marks as rare (vereinzelt, selten, Tagesrandlagen, Ersatzgarnitur, Schülerverkehr) last.
A vehicle the catalogue has no series for is reported as unmapped, never dropped in silence.

Class numbers refine a type within its family: ``Talent 2 (442)`` is db-442 alone,
``LINT 41 (648/1648)`` db-648 then db-1648; a number of another family is ignored, so
``KISS (445)`` stays stadler-kiss. A four-digit variant of a class (2648 of 648, 3427 of 427) names
the family series only when no other class of the same mention refined the type: ``LINT 41 (648,
2648)`` is db-648 alone. A FLIRT without generation 3 in the cell is stadler-flirt: the
class series db-428 and db-429 have FLIRT 3 bodies and are named only for a FLIRT 3. A LINT with
its size names the class of that size in the variant table of the LINT article
(wikipedia-de-coradia-lint-r13): LINT 27 is 640, LINT 54 is 622 (and 1622), LINT 81 is 620; a
LINT 41 or a LINT without its size stays alstom-coradia-lint unless a class refines it.
"""

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum

from gerlines_catalog.fleet import ARTICLE_SERIES
from gerlines_catalog.wikitables import LINK, SPACES, plain, strip_markup, unwrap


class Kind(StrEnum):
    UNIT = "unit"
    LOCOMOTIVE = "locomotive"
    DOUBLE_DECK = "double_deck"
    COACH = "coach"


@dataclass(frozen=True, slots=True)
class VehicleType:
    """A vehicle a cell can name by words (``pattern``) or by a linked article.

    ``series`` is empty for a vehicle the catalogue does not have. ``classes`` lists the class
    numbers that may refine the type; ``None`` allows every class of the series' family.
    """

    name: str
    pattern: str | None
    articles: frozenset[str]
    series: tuple[str, ...]
    kind: Kind = Kind.UNIT
    classes: Mapping[str, str] | None = None


FLIRT_3_CLASSES = {
    "428": "db-428", "429": "db-429", "1428": "db-1428", "1429": "db-1429", "3429": "db-3429",
}  # fmt: skip
TRAXX_CLASSES = {"146": "db-146", "146.5": "db-146-5", "147": "db-147", "245": "db-245"}
SAME_BODY_CLASSES = {"0563": "563", "1622": "622"}
"""Class numbers read as another class of the same body: a leading zero (the Bavarian list's
Mireo Plus H) and the 1622, which the variant table of the LINT article puts beside the 622 as
LINT 54 of the same length (wikipedia-de-coradia-lint-r13), unlike the 1648 and 2648 beside the
648."""


def _type(  # noqa: PLR0913, PLR0917
    name: str,
    pattern: str | None,
    articles: Iterable[str],
    series: str | tuple[str, ...] | None,
    kind: Kind = Kind.UNIT,
    classes: Mapping[str, str] | None = None,
) -> VehicleType:
    chosen = (series,) if isinstance(series, str) else tuple(series or ())
    return VehicleType(name, pattern, frozenset(articles), chosen, kind, classes)


VEHICLE_TYPES: tuple[VehicleType, ...] = (
    _type("Talent 3", r"Talent\s*3", ["Bombardier Talent 3", "Talent 3"], None),
    _type("Pesa Link", r"Pesa\s*Link", ["Pesa Link", "Pesa Link II", "Pesa Link III", "PESA 218M"],
          None),
    _type("Itino", r"Itino", ["Bombardier Itino"], None),
    _type("GTW", r"\bGTW\b", ["Stadler GTW", "Stadler GTW 1. Generation"], None),
    _type("Desiro HC", r"Desiro\s*HC", ["Siemens Desiro HC"], "siemens-desiro-hc"),
    _type("Desiro ML", r"Desiro\s*ML", ["Siemens Desiro ML"], "siemens-desiro-ml"),
    _type("Desiro Classic", r"Desiro(?!\s*(?:HC|ML))", ["Siemens Desiro Classic"],
          "siemens-desiro-classic"),
    _type("KISS", r"\bKISS\b", ["Stadler KISS"], "stadler-kiss"),
    _type("Regio-Shuttle", r"Regio-?\s*Shuttle|\bRS\s*1\b",
          ["Stadler Regio-Shuttle RS 1", "Stadler Regio-Shuttle RS1"], "stadler-regio-shuttle-rs1"),
    _type("iLint", r"\bi\s*LINT", ["Alstom Coradia iLint"], "alstom-coradia-ilint"),
    _type("LINT 27", r"\bLINT\s*27\b", ["Alstom Coradia LINT 27", "LINT 27"], "db-640"),
    _type("LINT 54", r"\bLINT\s*54\b", ["Alstom Coradia LINT 54"], "db-622"),
    _type("LINT 81", r"\bLINT\s*81\b", ["Alstom Coradia LINT 81"], "db-620"),
    _type("LINT", r"\bLINT", ["Alstom Coradia LINT", "Alstom Coradia LINT 41", "Lint 41"],
          "alstom-coradia-lint"),
    _type("Coradia Continental", r"Coradia\s*Continental", ["Alstom Coradia Continental"],
          "alstom-coradia-continental"),
    _type("Coradia Stream", r"Coradia\s*Stream", ["Alstom Coradia Stream"],
          "alstom-coradia-stream"),
    _type("Mireo", r"Mireo", ["Siemens Mireo", "Siemens Mireo Plus H", "Siemens Mireo Plus B",
          "Siemens Mireo Smart", "Siemens Mireo Smart Plus B"], "siemens-mireo"),
    _type("Talent 2", r"Talent\s*2", ["Bombardier Talent 2", "ET 442"], "bombardier-talent-2"),
    _type("Talent", r"Talent(?!\s*[23])", ["Bombardier Talent"], "bombardier-talent"),
    _type("FLIRT 3 XL", r"FLIRT\s*3\s*XL", [], "stadler-flirt-3-xl", classes=FLIRT_3_CLASSES),
    _type("FLIRT 3", r"FLIRT\s*3(?!\d)", ["Stadler Flirt 3"], "stadler-flirt-3",
          classes=FLIRT_3_CLASSES),
    _type("FLIRT Akku", r"FLIRT\s*Akku", ["Flirt Akku", "Stadler Flirt Akku"], "stadler-flirt",
          classes={}),
    _type("FLIRT", r"FLIRT", ["Stadler Flirt", "Stadler FLIRT"], "stadler-flirt", classes={}),
    _type("Twindexx", r"Twindexx", ["Bombardier Twindexx Vario", "Twindexx Vario"],
          "bombardier-twindexx-vario"),
    _type("RegioSwinger", r"Regio-?Swinger", ["DB-Baureihe 612 (1998)"], "db-612"),
    _type("GT8-100D/2S-M", r"GT8-100D/2S-M", ["GT8-100D/2S-M"], "avg-gt8-100d-2s-m"),
    _type("Intercity 2", r"\bIC\s*-?\s*2\b", ["Intercity 2 (Deutsche Bahn)"], "db-intercity-2"),
    _type("Railjet 2", r"Railjet\s*2", ["Railjet 2. Generation"], "obb-railjet-2"),
    _type("Railjet", r"Railjet", ["Railjet 1. Generation"], "obb-railjet"),
    _type("Doppelstockwagen", r"Doppelstock|Dosto",
          ["Doppelstockwagen", "Liste von Doppelstockwagen der Deutschen Bahn",
           "Nahverkehrs-Doppelstockwagen der ÖBB"], "doppelstockwagen", Kind.DOUBLE_DECK),
    _type("Coaches", r"(?<!trieb)wagen\b|Married[- ]Pair|Wendezug",
          ["n-Wagen", "Reisezugwagen", "Abteilwagen", "Bombardier Married Pair",
           "Škoda Wendezug-Garnitur", "ÖBB Inlandsreisezugwagen"], None, Kind.COACH),
    _type("Traxx", r"Traxx", ["Bombardier Traxx", "Traxx P160 AC3", "Bombardier Traxx P160 AC2"],
          None, Kind.LOCOMOTIVE, TRAXX_CLASSES),
    _type("ES64U2", r"ES\s*64\s*U2|Taurus", ["Siemens ES64U2"], None, Kind.LOCOMOTIVE,
          {"182": "db-182"}),
    _type("Vectron", r"Vectron", ["Siemens Vectron"], "siemens-vectron", Kind.LOCOMOTIVE,
          {"193": "siemens-vectron"}),
    *(_type(article, None, [article], series, classes={})
      for article, series in ARTICLE_SERIES.items()),
)  # fmt: skip

NOT_VEHICLES = frozenset(
    {
        "Mehrfachtraktion",
        "Elektrotriebwagen",
        "Dieseltriebwagen",
        "SNCF",
        "Société Nationale des Chemins de Fer Luxembourgeois",
    }
)
CLASS_ARTICLE = re.compile(r"^(?:DB-|DR-)?(?:Baureihe|BR)\s+(\d{3,4})\b")
DR_TO_DB = {"243": "143"}
RARE = re.compile(
    r"vereinzelt|selten|gelegentlich|ausnahmsweise|Tagesrand|Ersatz|Sch(?:ü|ue)lerverkehr"
    r"|Schulverkehr|einzelnen?\b",
    re.IGNORECASE,
)
VARIES = re.compile(
    r"\bauch\b|\bohne\b|\boder\b|\bbzw\b|\bteils\b|teilweise|Flügel|Verstärk|HVZ|\bmeist|\bsowie\b",
    re.IGNORECASE,
)
CLASS_NUMBER = re.compile(
    r"(?<![\w.])(\d{3,4})(?:\.(\d)\d*)?(?!\d)(?!\s*(?:km|min|Min|Pl|Sitz|%|m\b|-?teil))"
)
_RARE_NUMBER = re.compile("(?:" + RARE.pattern + r")\s+$", re.IGNORECASE)
_RARE_BEFORE_NUMBER = re.compile("(?:" + RARE.pattern + r")\s+(?=\d{3,4})", re.IGNORECASE)
_COUNT = re.compile(r"(?<![\d\u2013-])(\d)\s*[\u00d7x](?![a-zA-Z])")
_COUNT_RANGE = re.compile(r"\d\s*[\u2013-]\s*\d\s*[\u00d7x]")
_SEPARATOR = re.compile(r"\s/\s|;|,|\ssowie\s")
_ONLY_NUMBERS = re.compile(r"\(?\s*\d[\d.\s/,]*\)?")
YEARS = range(1950, 2040)


@dataclass(frozen=True, slots=True)
class Catalogue:
    """What the reader needs from vehicle-series.yaml: classes (``br``), families, unit kinds."""

    by_class: Mapping[str, str]
    family: Mapping[str, str | None]
    family_series: Mapping[str, str]
    kinds: Mapping[str, str | None]

    @classmethod
    def of(cls, series: Iterable[Mapping[str, object]]) -> "Catalogue":
        rows = list(series)
        by_class: dict[str, str] = {}
        for single in (True, False):
            for row in rows:
                classes = [c.strip() for c in str(row.get("br") or "").split(",") if c.strip()]
                if len(classes) == 1 or not single:
                    for one in classes:
                        by_class.setdefault(one, str(row["series_id"]))
        return cls(
            by_class,
            {str(r["series_id"]): r.get("family") for r in rows},
            {
                str(r["family"]): str(r["series_id"])
                for r in rows
                if r.get("family") and r.get("family") == r.get("name")
            },
            {str(r["series_id"]): r.get("unit_kind") for r in rows},
        )

    def class_series(self, number: str, decimal: str | None) -> str | None:
        if decimal is not None and f"{number}.{decimal}" in self.by_class:
            return self.by_class[f"{number}.{decimal}"]
        return self.by_class.get(number)

    def variant_base(self, number: str) -> str | None:
        """For a four-digit variant number (3462, 9442, 2648) the series of the class it varies."""
        return self.by_class.get(number[1:]) if len(number) == 4 else None

    def bare_class(self, number: str, decimal: str | None) -> str | None:
        """The series a class number names: its own, else for a four-digit variant of a known
        class the family series of that class."""
        own = self.class_series(number, decimal)
        if own:
            return own
        base = self.variant_base(number)
        family = self.family.get(base) if base else None
        return self.family_series.get(family) if family else None


@dataclass(slots=True)
class _Number:
    number: str
    decimal: str | None
    rare: bool


@dataclass(slots=True)
class _Mention:
    position: int
    phrase: int
    type: VehicleType | None
    article_class: str | None = None
    name: str = ""
    numbers: list[_Number] = field(default_factory=list)
    rare: bool = False

    @property
    def typed(self) -> bool:
        return self.type is not None or self.article_class is not None


@dataclass(frozen=True, slots=True)
class CellReading:
    """What one vehicle cell says in catalogue terms."""

    series: tuple[str, ...]
    unmapped: tuple[str, ...]
    rare: frozenset[str]
    units: int | None


def _type_of_text(text: str) -> VehicleType | None:
    best: tuple[int, VehicleType] | None = None
    for vehicle in VEHICLE_TYPES:
        match = re.search(vehicle.pattern, text, re.IGNORECASE) if vehicle.pattern else None
        if match and (best is None or match.start() < best[0]):
            best = (match.start(), vehicle)
    return best[1] if best else None


def _type_of_article(target: str) -> VehicleType | None:
    return next((v for v in VEHICLE_TYPES if target in v.articles), None)


@dataclass(frozen=True, slots=True)
class _Piece:
    text: str
    target: str | None


def _pieces(line: str) -> list[_Piece]:
    pieces: list[_Piece] = []
    index = 0
    for match in LINK.finditer(line):
        if match.start() > index:
            pieces.append(_Piece(line[index : match.start()], None))
        target = SPACES.sub(" ", match.group(1).split("#", 1)[0]).strip()
        label = match.group(2) if match.group(2) is not None else match.group(1)
        pieces.append(_Piece(label, target))
        index = match.end()
    if index < len(line):
        pieces.append(_Piece(line[index:], None))
    return [_Piece(SPACES.sub(" ", strip_markup(p.text)), p.target) for p in pieces]


def _phrases(pieces: list[_Piece]) -> list[list[_Piece]]:
    """The alternatives of one line: split at ``/``, commas and semicolons outside brackets."""
    phrases: list[list[_Piece]] = [[]]
    depth = 0
    for piece in pieces:
        if piece.target is not None:
            phrases[-1].append(piece)
            continue
        start = 0
        index = 0
        while index < len(piece.text):
            char = piece.text[index]
            if char in "([":
                depth += 1
            elif char in ")]":
                depth = max(0, depth - 1)
            elif depth == 0:
                match = _SEPARATOR.match(piece.text, index)
                if match:
                    phrases[-1].append(_Piece(piece.text[start:index], None))
                    phrases.append([])
                    index = start = match.end()
                    continue
            index += 1
        phrases[-1].append(_Piece(piece.text[start:], None))
    return [p for p in phrases if any(x.target or x.text.strip() for x in p)]


def _numbers(text: str) -> list[tuple[int, _Number]]:
    found = []
    for match in CLASS_NUMBER.finditer(text):
        rare = bool(_RARE_NUMBER.search(text[: match.start()][-16:]))
        number = SAME_BODY_CLASSES.get(match.group(1), match.group(1))
        found.append((match.start(), _Number(number, match.group(2), rare)))
    return found


def _link_mention(piece: _Piece, position: int, phrase: int) -> _Mention | None:
    target = piece.target or ""
    if target in NOT_VEHICLES:
        return None
    vehicle = _type_of_text(piece.text) or _type_of_article(target)
    article_class = None
    if vehicle is None:
        match = CLASS_ARTICLE.match(target) or CLASS_ARTICLE.match(piece.text)
        if match:
            article_class = DR_TO_DB.get(match.group(1), match.group(1))
    mention = _Mention(position, phrase, vehicle, article_class, target)
    mention.numbers = [n for _, n in _numbers(piece.text)]
    return mention


def _text_mentions(text: str, position: int, phrase: int) -> tuple[list[_Mention], list]:
    mentions: list[_Mention] = []
    covered: list[tuple[int, int]] = []
    for vehicle in VEHICLE_TYPES:
        if not vehicle.pattern:
            continue
        for match in re.finditer(vehicle.pattern, text, re.IGNORECASE):
            if any(a <= match.start() < b for a, b in covered):
                continue
            covered.append((match.start(), match.end()))
            mentions.append(
                _Mention(position + match.start(), phrase, vehicle, name=match.group(0))
            )
    loose = []
    for at, number in _numbers(text):
        if any(a <= at < b for a, b in covered):
            continue
        if len(number.number) == 4 and int(number.number) in YEARS:
            continue
        loose.append((position + at, number))
    return mentions, loose


def _read_phrase(phrase: list[_Piece], position: int, index: int) -> list[_Mention]:
    mentions: list[_Mention] = []
    loose: list[tuple[int, _Number]] = []
    text = ""
    for piece in phrase:
        at = position + len(text)
        text += piece.text
        if piece.target is not None:
            mention = _link_mention(piece, at, index)
            if mention:
                mentions.append(mention)
        else:
            found, numbers = _text_mentions(piece.text, at, index)
            mentions += found
            loose += numbers
    mentions.sort(key=lambda m: m.position)
    for at, number in loose:
        typed = [m for m in mentions if m.typed]
        before = [m for m in typed if m.position <= at]
        after = [m for m in typed if m.position > at]
        owner = before[-1] if before else (after[0] if after else None)
        if owner is None:
            mention = _Mention(at, index, None, number.number, number.number, [number])
            mentions.append(mention)
        else:
            owner.numbers.append(number)
    merged: list[_Mention] = []
    for mention in sorted(mentions, key=lambda m: m.position):
        same = next((m for m in merged if m.type is not None and m.type is mention.type), None)
        if same is None:
            merged.append(mention)
        else:
            same.numbers += mention.numbers
    rare = bool(RARE.search(_RARE_BEFORE_NUMBER.sub("", text)))
    for mention in merged:
        mention.rare = rare
    return merged


def _refine(vehicle: VehicleType, number: _Number, catalogue: Catalogue) -> str | None:
    if vehicle.classes is not None:
        if number.decimal is not None and f"{number.number}.{number.decimal}" in vehicle.classes:
            return vehicle.classes[f"{number.number}.{number.decimal}"]
        return vehicle.classes.get(number.number)
    candidate = catalogue.class_series(number.number, number.decimal)
    if candidate is None or not vehicle.series:
        return None
    home = catalogue.family.get(vehicle.series[0])
    return candidate if home and catalogue.family.get(candidate) == home else None


def _variant(vehicle: VehicleType, number: _Number, catalogue: Catalogue) -> bool:
    """A four-digit number varying a class of the type's own family (2648 for a LINT, not 1430
    for a FLIRT 3, since class 430 is no FLIRT)."""
    base = catalogue.variant_base(number.number)
    home = catalogue.family.get(vehicle.series[0]) if vehicle.series else None
    return bool(base and home and catalogue.family.get(base) == home)


def _resolve(mention: _Mention, catalogue: Catalogue) -> tuple[list[tuple[str, bool]], str | None]:
    """Series of one mention in cell order with their rarity, or the vehicle the catalogue lacks."""
    vehicle = mention.type
    if vehicle is None:
        found = [(catalogue.bare_class(n.number, n.decimal), n.rare) for n in mention.numbers]
        article = (
            catalogue.bare_class(mention.article_class, None) if mention.article_class else None
        )
        if article:
            found = [(s, r) for s, r in found if s] or [(article, False)]
        if not found or any(s is None for s, _ in found):
            return [], mention.name or mention.article_class or "?"
        return [(s, r) for s, r in found if s], None
    if vehicle.kind is Kind.COACH:
        return [], None
    refined = [_refine(vehicle, number, catalogue) for number in mention.numbers]
    series: list[tuple[str, bool]] = []
    for number, sid in zip(mention.numbers, refined, strict=True):
        if sid:
            series.append((sid, number.rare))
        elif not (any(refined) and _variant(vehicle, number, catalogue)):
            series += [(s, number.rare) for s in vehicle.series]
    if not mention.numbers:
        series = [(s, False) for s in vehicle.series]
    if not series:
        return [], vehicle.name
    return series, None


def _kind(mention: _Mention, series: list[tuple[str, bool]], catalogue: Catalogue) -> Kind:
    if mention.type is not None:
        return mention.type.kind
    if series and catalogue.kinds.get(series[0][0]) == "locomotive":
        return Kind.LOCOMOTIVE
    number = (mention.numbers[0].number if mention.numbers else mention.article_class) or ""
    return Kind.LOCOMOTIVE if len(number) == 3 and number[0] in "12" else Kind.UNIT


def _cell_lines(raw: str) -> list[str]:
    """Lines of the cell, a line starting with + or after a line ending in + joined to it."""
    lines: list[str] = []
    for line in unwrap(raw).split("\n"):
        text = strip_markup(line).strip()
        if not text:
            continue
        if lines and (text.startswith("+") or strip_markup(lines[-1]).rstrip().endswith("+")):
            lines[-1] += " " + line
        else:
            lines.append(line)
    return lines


def read_cell(raw: str, catalogue: Catalogue) -> CellReading:
    """Series a vehicle cell names, in cell order, with vehicles marked as rare placed last.

    A locomotive with double-deck coaches is the series doppelstockwagen (also the other
    locomotives of that line, which are alternatives for the same coaches); double-deck middle
    cars of a multiple unit belong to that unit; single-deck coaches go with their locomotive. A
    line holding only class numbers belongs to the line above it; a line holding only a rarity
    note ending in a colon applies to the line below it. A class the catalogue lacks, written
    next to a type it has (``BR 4746 Siemens Desiro HC``), is that type.
    """
    ordered: list[tuple[bool, int, str]] = []
    unmapped: list[str] = []
    for mentions in _line_mentions(raw):
        series, missing = _line_series(mentions, catalogue)
        ordered += series
        unmapped += missing
    series_ids: list[str] = []
    rare_ids: set[str] = set()
    for is_rare, _, sid in sorted(ordered, key=lambda item: (item[0], item[1])):
        if sid not in series_ids:
            series_ids.append(sid)
            if is_rare:
                rare_ids.add(sid)
    units = _units(raw, series_ids, rare_ids)
    return CellReading(
        tuple(series_ids), tuple(dict.fromkeys(unmapped)), frozenset(rare_ids), units
    )


def _line_mentions(raw: str) -> list[list[_Mention]]:
    groups: list[list[_Mention]] = []
    carry_rare = False
    for offset, line in enumerate(_cell_lines(raw)):
        pieces = _pieces(line)
        text = "".join(p.text for p in pieces).strip()
        if groups and _ONLY_NUMBERS.fullmatch(text):
            owner = next((m for m in reversed(groups[-1]) if m.typed), None)
            if owner is not None:
                owner.numbers += [n for _, n in _numbers(text)]
                continue
        mentions: list[_Mention] = []
        base = offset * 10_000
        for i, phrase in enumerate(_phrases(pieces)):
            mentions += _read_phrase(phrase, base, i)
            base += sum(len(piece.text) for piece in phrase) + 1
        if not mentions:
            carry_rare = bool(RARE.search(text)) and text.endswith(":")
            continue
        if carry_rare:
            for mention in mentions:
                mention.rare = True
            carry_rare = False
        groups.append(mentions)
    return groups


def _line_series(
    mentions: list[_Mention], catalogue: Catalogue
) -> tuple[list[tuple[bool, int, str]], list[str]]:
    resolved = [(m, *_resolve(m, catalogue)) for m in mentions]
    kinds = [_kind(m, s, catalogue) for m, s, _ in resolved]
    named = {m.phrase for m in mentions if m.type is not None and m.type.kind is Kind.UNIT}
    pairs = list(zip(resolved, kinds, strict=True))
    unit_phrases = {m.phrase for (m, _, _), k in pairs if k is Kind.UNIT}
    coaches = any(k is Kind.DOUBLE_DECK and m.phrase not in unit_phrases for (m, _, _), k in pairs)
    ordered: list[tuple[bool, int, str]] = []
    unmapped: list[str] = []
    for (mention, series, missing), kind in pairs:
        absorbed = (
            kind is Kind.COACH
            or (kind is Kind.DOUBLE_DECK and mention.phrase in unit_phrases)
            or (kind is Kind.LOCOMOTIVE and coaches)
            or (bool(missing) and mention.article_class is not None and mention.phrase in named)
        )
        if absorbed:
            continue
        if missing:
            unmapped.append(missing)
            continue
        ordered += [(mention.rare or rare, mention.position, sid) for sid, rare in series]
    return ordered, unmapped


def _units(raw: str, series: list[str], rare: set[str]) -> int | None:
    """Units in one consist, only when the cell names one series with one fixed count."""
    text = plain(raw)
    if len(series) != 1 or rare or RARE.search(text) or VARIES.search(text):
        return None
    if _COUNT_RANGE.search(text):
        return None
    counts = {int(m.group(1)) for m in _COUNT.finditer(text)}
    if len(counts) != 1:
        return None
    units = counts.pop()
    return units if 1 <= units <= 4 else None
