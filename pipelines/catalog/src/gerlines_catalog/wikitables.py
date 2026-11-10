"""Plain text and table rows from MediaWiki wikitext (German Wikipedia line lists)."""

import html
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass

_REF = re.compile(r"<ref[^>/]*/>|<ref[^>]*>.*?</ref>", re.DOTALL)
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_BR = re.compile(r"<br\s*/?>", re.IGNORECASE)
_TAG = re.compile(r"</?[a-zA-Z][^>]*>")
_TEMPLATE = re.compile(r"\{\{([^{}]*)\}\}")
LINK = re.compile(r"\[\[([^\]|]*)(?:\|([^\]]*))?\]\]")
_EXTERNAL = re.compile(r"\[https?://[^\s\]]+(?: ([^\]]*))?\]")
SPACES = re.compile(r"[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000]+")
_LINE_TEMPLATE = re.compile(r"bahnlinie|spnv|linie", re.IGNORECASE)
_HEADING = re.compile(r"^(=+)\s*([^\n]*?)\s*\1\s*$")


def _template_parts(body: str) -> list[str]:
    parts, depth, start = [], 0, 0
    for index, char in enumerate(body):
        if body.startswith("[[", index):
            depth += 1
        elif body.startswith("]]", index):
            depth = max(0, depth - 1)
        elif char == "|" and depth == 0:
            parts.append(body[start:index].strip())
            start = index + 1
    return [*parts, body[start:].strip()]


def _template_text(body: str) -> str:
    parts = _template_parts(body)
    name = parts[0].lower()
    params = [part for part in parts[1:] if part and "=" not in part]
    if name in {"anker", "0", "nnbsp"}:
        return ""
    if _LINE_TEMPLATE.search(name):
        if len(params) > 1 and re.fullmatch(r"[A-Za-zÄÖÜ]+", params[0]):
            return f"{params[0]} {params[1]}"
        return " ".join(params[:1])
    return " ".join(params)


def unwrap(text: str) -> str:
    """Wikitext without references, comments and templates, entities decoded; links stay and
    ``<br>`` becomes a line break."""
    text = _COMMENT.sub("", _REF.sub("", text))
    for _ in range(4):
        text = _TEMPLATE.sub(lambda match: _template_text(match.group(1)), text)
    text = _BR.sub("\n", text).replace("&shy;", "")
    return html.unescape(text).replace("­", "")


def strip_markup(text: str) -> str:
    """Link labels instead of links, no bold, italics or HTML tags."""
    text = _EXTERNAL.sub(lambda match: match.group(1) or "", text)
    text = LINK.sub(lambda match: match.group(2) or match.group(1), text)
    text = text.replace("'''", "").replace("''", "")
    return _TAG.sub("", text)


def text_lines(raw: str) -> list[str]:
    """The wikitext as plain lines: markup removed, entities decoded, spaces normalised."""
    lines = []
    for line in strip_markup(unwrap(raw)).split("\n"):
        clean = SPACES.sub(" ", line).strip()
        if clean:
            lines.append(clean)
    return lines


def plain(raw: str) -> str:
    return " ".join(text_lines(raw))


def quote(raw: str) -> str:
    """A cell as evidence: plain text with its lines joined by semicolons."""
    return "; ".join(text_lines(raw))


@dataclass(frozen=True, slots=True)
class TableRow:
    section: str
    header: tuple[str, ...]
    cells: tuple[str, ...]

    def columns(self, test: Callable[[str], bool]) -> list[int]:
        return [i for i, name in enumerate(self.header) if test(name) and i < len(self.cells)]


def _split_cells(body: str) -> list[str]:
    parts, depth, start, index = [], 0, 0, 0
    while index < len(body):
        pair = body[index : index + 2]
        if pair in {"{{", "[["}:
            depth += 1
            index += 2
            continue
        if pair in {"}}", "]]"}:
            depth = max(0, depth - 1)
            index += 2
            continue
        if depth == 0 and pair in {"||", "!!"}:
            parts.append(body[start:index])
            index += 2
            start = index
            continue
        index += 1
    parts.append(body[start:])
    return parts


_ATTRIBUTES = re.compile(r'\s*(?:[a-z-]+\s*=\s*(?:"[^"]*"|\S+)\s*)+')


def _attributes(part: str) -> tuple[str, str]:
    """The attribute head of a cell (``rowspan="2" style=…``) and its content."""
    depth = 0
    for index, char in enumerate(part):
        pair = part[index : index + 2]
        if pair in {"{{", "[["}:
            depth += 1
        elif pair in {"}}", "]]"}:
            depth -= 1
        elif char == "|" and depth == 0 and pair != "||":
            head = part[:index]
            return (head, part[index + 1 :]) if _ATTRIBUTES.fullmatch(head) else ("", part)
    return "", part


def _span(head: str, name: str) -> int:
    match = re.search(name + r'\s*=\s*"?(\d+)', head)
    return int(match.group(1)) if match else 1


def _cells(row: str) -> list[tuple[str, int, int]]:
    cells: list[tuple[str, int, int]] = []
    for raw in re.split(r"\n(?=[|!])", "\n" + row):
        line = raw.strip("\n")
        if not line or line.startswith(("|-", "|}", "|+", "{|")):
            continue
        marker, body = line[0], line[1:]
        if marker not in "|!":
            if cells:
                text, rows, cols = cells[-1]
                cells[-1] = (text + "\n" + line, rows, cols)
            continue
        for part in _split_cells(body):
            head, text = _attributes(part)
            cells.append((text, _span(head, "rowspan"), _span(head, "colspan")))
    return cells


def _blocks(wikitext: str) -> Iterator[tuple[bool, str]]:
    pattern = re.compile(r"^(=+)[^\n]*?\1[ \t]*$|^\{\|.*?^\|\}", re.MULTILINE | re.DOTALL)
    for match in pattern.finditer(wikitext):
        yield bool(match.group(1)), match.group(0)


class _Sections:
    def __init__(self) -> None:
        self._levels: dict[int, str] = {}

    def enter(self, line: str) -> bool:
        match = _HEADING.match(line.strip())
        if not match:
            return False
        level = len(match.group(1))
        self._levels = {k: v for k, v in self._levels.items() if k < level}
        self._levels[level] = plain(match.group(2))
        return True

    @property
    def path(self) -> str:
        return " / ".join(self._levels[k] for k in sorted(self._levels))


def _spread(cells: list[tuple[str, int, int]], carry: dict[int, list]) -> list[str]:
    out: list[str] = []
    column = 0
    pending = list(cells)
    while pending or column in carry:
        if column in carry:
            text, left = carry[column]
            out.append(text)
            if left <= 1:
                del carry[column]
            else:
                carry[column] = [text, left - 1]
            column += 1
            continue
        text, rows, cols = pending.pop(0)
        for _ in range(cols):
            out.append(text)
            if rows > 1:
                carry[column] = [text, rows - 1]
            column += 1
    return out


def table_rows(wikitext: str) -> list[TableRow]:
    """Every data row of every table with a header row, rowspans and colspans spread out.

    Headings between the rows of a table (some lists put them there) set the section of the
    rows after them.
    """
    found: list[TableRow] = []
    sections = _Sections()
    for is_heading, text in _blocks(wikitext):
        if is_heading:
            sections.enter(text)
            continue
        header: list[str] | None = None
        carry: dict[int, list] = {}
        body = text.split("\n", 1)[1] if "\n" in text else ""
        for raw in re.split(r"\n\|-[^\n]*", "\n" + body):
            kept = []
            for line in raw.split("\n"):
                if sections.enter(line):
                    carry = {}
                else:
                    kept.append(line)
            row = "\n".join(kept)
            cells = _cells(row)
            if not cells:
                continue
            if header is None:
                if row.lstrip("\n").startswith("!"):
                    header = [plain(text) for text, _, cols in cells for _ in range(cols)]
                continue
            found.append(TableRow(sections.path, tuple(header), tuple(_spread(cells, carry))))
    return found
