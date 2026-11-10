"""Verkehrsverbünde from the German Wikipedia list ``Liste deutscher Tarif- und Verkehrsverbünde``.

Each table row gives an abbreviation and the linked article of the Verbund. The Land is the
``==`` section the row stands in; a Verbund listed under several Länder covers all of them. The
SPNV flag comes from a ``===`` subsection titled with or without SPNV integration, from the
Baden-Württemberg intro (all integrated) or from the row's own remark; otherwise it stays
unknown. Former and merged Verbünde (the last sections) are skipped.
"""

import re
from dataclasses import dataclass, field

LAND_CODES = {
    "Baden-Württemberg": ("DE-BW",),
    "Bayern": ("DE-BY",),
    "Berlin und Brandenburg": ("DE-BE", "DE-BB"),
    "Bremen": ("DE-HB",),
    "Hamburg": ("DE-HH",),
    "Hessen": ("DE-HE",),
    "Mecklenburg-Vorpommern": ("DE-MV",),
    "Niedersachsen": ("DE-NI",),
    "Nordrhein-Westfalen": ("DE-NW",),
    "Rheinland-Pfalz": ("DE-RP",),
    "Saarland": ("DE-SL",),
    "Sachsen": ("DE-SN",),
    "Sachsen-Anhalt": ("DE-ST",),
    "Schleswig-Holstein": ("DE-SH",),
    "Thüringen": ("DE-TH",),
}
ALL_INTEGRATED = frozenset({"Baden-Württemberg"})
STOP_SECTIONS = ("Ehemalige", "Siehe auch", "Weblinks", "Einzelnachweise")

_H2 = re.compile(r"^==\s*([^=].*?)\s*==\s*$")
_H3 = re.compile(r"^===\s*(.*?)\s*===\s*$")
_LINK = re.compile(r"\[\[([^|\]]+)(?:\|([^\]]+))?\]\]")
_ROW_START = re.compile(r"^\|\s*(?!-|\})")


@dataclass(slots=True)
class ListedVerbund:
    abbr: str
    article: str
    name: str
    laender: set[str] = field(default_factory=set)
    spnv: set[bool | None] = field(default_factory=set)
    remarks: list[str] = field(default_factory=list)


def _spnv_from_heading(heading: str) -> bool | None:
    lowered = heading.lower()
    if "ohne" in lowered and "spnv" in lowered:
        return False
    if "mit" in lowered and "spnv" in lowered:
        return True
    return None


def _cells(row_lines: list[str]) -> list[str]:
    text = " ".join(line.strip() for line in row_lines)
    text = text.removeprefix("|").strip()
    return [cell.strip() for cell in text.split("||")] if "||" in text else [text]


def _split_rows(lines: list[str]) -> list[list[str]]:
    rows: list[list[str]] = []
    current: list[str] | None = None
    for line in lines:
        if line.startswith("|-") or line.startswith("|}") or line.startswith("{|"):
            if current:
                rows.append(current)
            current = [] if line.startswith("|-") else None
            continue
        if line.startswith("!"):
            continue
        if current is not None and (line.startswith("|") or current):
            current.append(line)
    if current:
        rows.append(current)
    return rows


def _row_cells(row: list[str]) -> list[str]:
    cells: list[str] = []
    for line in row:
        if _ROW_START.match(line):
            cells.extend(_cells([line]))
        elif cells:
            cells[-1] += " " + line.strip()
    return cells


def parse(wikitext: str) -> dict[str, ListedVerbund]:
    """Verbünde keyed by their linked article title."""
    found: dict[str, ListedVerbund] = {}
    land: str | None = None
    sub_spnv: bool | None = None
    table: list[str] | None = None
    for line in wikitext.splitlines():
        h2 = _H2.match(line)
        h3 = None if h2 else _H3.match(line)
        if h2:
            title = h2.group(1)
            land = None if title.startswith(STOP_SECTIONS) else title
            sub_spnv = None
            table = None
        elif h3:
            sub_spnv = _spnv_from_heading(h3.group(1))
            table = None
        elif land in LAND_CODES and line.startswith("{|"):
            table = []
        elif table is not None and line.startswith("|}"):
            _collect(found, table, land or "", sub_spnv)
            table = None
        elif table is not None:
            table.append(line)
    return found


def _collect(
    found: dict[str, ListedVerbund], table: list[str], land: str, sub_spnv: bool | None
) -> None:
    for row in _split_rows(["|-", *table, "|}"]):
        cells = _row_cells(row)
        if len(cells) < 2:
            continue
        link = _LINK.search(cells[1])
        if link is None:
            continue
        article = link.group(1).strip()
        name = (link.group(2) or link.group(1)).strip()
        abbr = re.sub(r"<[^>]+>|'''?|\[\[|\]\]", "", cells[0]).strip()
        remark = cells[-1] if len(cells) >= 5 else ""
        spnv = sub_spnv
        if spnv is None and land in ALL_INTEGRATED:
            spnv = True
        if spnv is None:
            spnv = _spnv_from_heading(remark) if "spnv" in remark.lower() else None
        entry = found.setdefault(article, ListedVerbund(abbr or name, article, name))
        entry.laender.update(LAND_CODES[land])
        entry.spnv.add(spnv)
        if remark:
            entry.remarks.append(remark)
