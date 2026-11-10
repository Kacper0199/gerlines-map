"""Fleet rules of scope ``line`` for IC, Railjet, RE and RB lines from German Wikipedia lists.

Each list is read at the revision its source row cites. A table row gives a line label, an
operator (Länder lists), a route and a vehicle cell (``fleet_cells``). A row naming a vehicle the
catalogue lacks gets no rule: a partial rule would answer for the line with too much confidence.
Rows are matched to the timetable pairs (operator, category, line) of one service
day; a pair keeps a rule only when at least ``MATCH_SHARE_FLOOR`` of its trips start or end at a
station the row's route names (a listed exception from its own lower bound), and the share is
stored with the rule.
"""

import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import PurePosixPath
from urllib.parse import urlsplit

import psycopg

from gerlines_catalog.fleet import line_key
from gerlines_catalog.fleet_cells import Catalogue, CellReading, read_cell
from gerlines_catalog.wikitables import plain, quote, table_rows

MATCH_SHARE_FLOOR = 0.95
_KONSTANZ = (
    "IC 87 trains that run on from Singen to Konstanz; the IC list's line 87 text names them"
    " (Zwei der Zugpaare verkehrten montags bis freitags über Singen hinaus nach Konstanz)"
)


@dataclass(frozen=True, slots=True)
class MatchException:
    """A line of one list whose pairs need only ``floor``, with the reason the trips its route
    does not name run the same line."""

    list: str
    line: str
    floor: float
    reason: str


MATCH_EXCEPTIONS: tuple[MatchException, ...] = (MatchException("ic", "IC87", 0.85, _KONSTANZ),)


def match_exception(short: str, line: str) -> MatchException | None:
    return next((e for e in MATCH_EXCEPTIONS if e.list == short and e.line == line), None)


ICE_TRAINSETS = frozenset(
    {"db-401", "db-402", "db-403", "db-406", "db-407", "db-408", "db-411", "db-412", "db-415"}
)

_GENERIC_WORDS = frozenset({
    "gmbh", "ag", "mbh", "kg", "co", "die", "der", "und", "verkehrs", "gesellschaft", "eisenbahn",
    "eisenbahngesellschaft", "bahn", "marke", "db", "regio", "region", "de", "the", "rail",
    "verkehrsgesellschaft", "landesverkehrs", "holding", "unternehmen", "deutschland", "in",
    "regionetz",
})  # fmt: skip
OPERATOR_ALIASES = {
    "hlb": "hessische landesbahn", "brb": "bayerische regiobahn", "odeg": "ostdeutsche eisenbahn",
    "neb": "niederbarnimer", "mrb": "mitteldeutsche regiobahn", "sweg": "suedwestdeutsche",
    "nwb": "nordwestbahn", "evb": "elbe weser", "go ahead": "arverio", "goahead": "arverio",
    "stb": "sued thueringen bahn", "eb": "erfurter", "rtb": "rurtalbahn", "dlb": "laenderbahn",
    "nx": "national express", "rrb": "rheinruhrbahn", "cb": "city bahn chemnitz",
    "hans": "hanseatische", "oberweissbacher": "oberweisbacher",
}  # fmt: skip
DB_REGIONS = frozenset({
    "nordost", "nord", "bayern", "baden", "wuerttemberg", "nrw", "suedost", "mitte", "hessen",
    "suedwest", "kurhessenbahn", "erzgebirgsbahn", "suedostbayernbahn", "westfrankenbahn",
    "oberweisbacher",
})  # fmt: skip
_ALIASES = [(re.compile(rf"\b{short}\b"), long) for short, long in OPERATOR_ALIASES.items()]


def fold(text: str) -> str:
    text = text.lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _tokens(text: str) -> set[str]:
    folded = fold(text)
    for pattern, long in _ALIASES:
        folded = pattern.sub(long, folded)
    return {t for t in folded.split() if t not in _GENERIC_WORDS and len(t) > 1}


def _is_db_regio(operator_id: str) -> bool:
    return operator_id.startswith(("db-regio", "db-regionetz"))


@dataclass(frozen=True, slots=True)
class OperatorIndex:
    """Name words of every catalogue operator, for matching the operator cell of a list row."""

    names: Mapping[str, frozenset[str]]

    @classmethod
    def of(cls, operators: Iterable[Mapping[str, object]]) -> "OperatorIndex":
        names = {}
        for row in operators:
            op = str(row["operator_id"])
            words = [op.replace("-", " "), str(row.get("feed_name") or ""),
                     str(row.get("brand_name") or "")]  # fmt: skip
            names[op] = frozenset(_tokens(" ".join(words)))
        return cls(names)

    def tokens(self, operator_id: str) -> frozenset[str]:
        return self.names.get(operator_id) or frozenset(_tokens(operator_id.replace("-", " ")))

    def match(self, text: str, candidates: Sequence[str], db_defaults: Sequence[str]) -> str | None:
        """The candidate the operator cell names; a DB Regio cell without a region word takes the
        list's DB Regio company. None when unclear."""
        folded = fold(text)
        db_row = (
            "db regio" in folded or "db regionetz" in folded or folded.startswith("db ")
            or folded in {"db", "deutsche bahn"}
        )  # fmt: skip
        if db_row:
            return self._match_db(text, candidates, db_defaults)
        return self._match_private(text, candidates)

    def _match_db(
        self, text: str, candidates: Sequence[str], defaults: Sequence[str]
    ) -> str | None:
        regions = _tokens(text) & DB_REGIONS
        dbs = [op for op in candidates if _is_db_regio(op)]
        if regions:
            scored = sorted(((len(regions & self.tokens(op)), op) for op in dbs), reverse=True)
            if scored and scored[0][0] > 0:
                top = [op for score, op in scored if score == scored[0][0]]
                if len(top) == 1:
                    return top[0]
                return next((d for d in defaults if d in top), None)
        return next((d for d in defaults if d in dbs), None)

    def _match_private(self, text: str, candidates: Sequence[str]) -> str | None:
        mine = _tokens(text)
        if not mine:
            return None
        scored = []
        for op in candidates:
            common = mine & self.tokens(op)
            if _is_db_regio(op) and not (common & DB_REGIONS):
                continue
            score = len(common) - 0.01 * len(self.tokens(op) - mine)
            if score >= 0.4:
                scored.append((score, op))
        if not scored:
            return None
        best = max(score for score, _ in scored)
        top = {op for score, op in scored if score == best}
        return top.pop() if len(top) == 1 else None


Pair = tuple[str, str, str]


@dataclass(frozen=True, slots=True)
class PairTrips:
    trips: int
    ends: Mapping[tuple[str, str], int]


PAIR_ENDS_SQL = """
WITH active AS (
  SELECT c.service_key
    FROM service_calendar c
   WHERE c.feed_version_id = %(v)s
     AND c.start_date <= %(d)s AND c.end_date >= %(d)s
     AND ((c.weekdays >> (extract(isodow FROM %(d)s::date)::int - 1)) & 1) = 1
     AND NOT EXISTS (
       SELECT 1 FROM service_calendar_date x
        WHERE x.feed_version_id = c.feed_version_id AND x.service_key = c.service_key
          AND x.service_date = %(d)s AND x.exception_type = 2)
  UNION
  SELECT service_key FROM service_calendar_date
   WHERE feed_version_id = %(v)s AND service_date = %(d)s AND exception_type = 1
),
trips AS (
  SELECT r.operator_id, t.category_code, r.short_name, t.trip_pattern_id
    FROM trip t
    JOIN active a USING (service_key)
    JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
   WHERE t.feed_version_id = %(v)s AND t.category_code = ANY(%(c)s)
     AND r.operator_id IS NOT NULL AND r.short_name IS NOT NULL
),
ends AS (
  SELECT ps.trip_pattern_id,
         (array_agg(sp.name ORDER BY ps.stop_index))[1] AS first_name,
         (array_agg(sp.name ORDER BY ps.stop_index DESC))[1] AS last_name
    FROM trip_pattern_stop ps
    JOIN stop_point q ON q.stop_point_id = ps.stop_point_id
    JOIN stop_place sp ON sp.stop_place_id = q.stop_place_id
   WHERE ps.feed_version_id = %(v)s
     AND ps.trip_pattern_id IN (SELECT DISTINCT trip_pattern_id FROM trips)
   GROUP BY 1
)
SELECT t.operator_id, t.category_code, t.short_name, e.first_name, e.last_name, count(*)
  FROM trips t JOIN ends e USING (trip_pattern_id)
 GROUP BY 1, 2, 3, 4, 5
"""

FLEET_LINE_CATEGORIES = ("ld", "reg", "rfast")

FEED_FILE_SQL = """
SELECT f.source_id, f.published_on, f.sha256, r.request_url, r.object_key, f.valid_from,
       f.valid_to
  FROM feed_version f JOIN raw_object r USING (raw_object_id)
 WHERE f.feed_version_id = %(v)s AND f.status = 'loaded'
"""

FeedRow = tuple[str, date, str, str | None, str, date | None, date | None]


@dataclass(frozen=True, slots=True)
class FeedFile:
    """The timetable file a loaded feed version came from, named as its publisher names it."""

    source_id: str
    published_on: date
    name: str
    sha256: str
    valid_from: date | None
    valid_to: date | None

    @classmethod
    def of_row(cls, row: FeedRow) -> "FeedFile":
        source_id, published_on, sha256, request_url, object_key, valid_from, valid_to = row
        path = urlsplit(request_url).path if request_url else object_key
        name = PurePosixPath(path).name
        return cls(source_id, published_on, name, sha256, valid_from, valid_to)

    def covers(self, day: date) -> bool:
        after_start = self.valid_from is None or self.valid_from <= day
        return after_start and (self.valid_to is None or day <= self.valid_to)


def feed_file(conn: psycopg.Connection, feed_version: int) -> FeedFile | None:
    row = conn.execute(FEED_FILE_SQL, {"v": feed_version}).fetchone()
    return FeedFile.of_row(row) if row else None


def pair_trips(rows: Iterable[Sequence[object]]) -> dict[Pair, PairTrips]:
    """Trips and (first, last) stations per (operator, category, line key)."""
    ends: dict[Pair, Counter[tuple[str, str]]] = defaultdict(Counter)
    for operator_id, category, short_name, first, last, trips in rows:
        pair = (str(operator_id), str(category), line_key(str(short_name)))
        ends[pair][(str(first), str(last))] += int(str(trips))
    return {pair: PairTrips(sum(c.values()), dict(c)) for pair, c in ends.items()}


def timetable_pairs(
    conn: psycopg.Connection, feed_version: int, day: date
) -> dict[Pair, PairTrips]:
    params = {"v": feed_version, "d": day, "c": list(FLEET_LINE_CATEGORIES)}
    return pair_trips(conn.execute(PAIR_ENDS_SQL, params).fetchall())


_ROUTE_NOISE = frozenset({"bahnhof", "bf", "bhf", "hbf", "hauptbahnhof", "s", "u", "st", "bad"})


def _route_words(text: str) -> list[str]:
    return [w for w in fold(text).split() if w not in _ROUTE_NOISE and len(w) > 1]


def match_share(trips: PairTrips, route: str) -> float:
    """Share of the pair's trips whose first or last station (its first name word) the route
    names."""
    if not trips.trips:
        return 0.0
    words = set(_route_words(route))
    hit = 0
    for (first, last), count in trips.ends.items():
        ends = [w[0] for w in (_route_words(first), _route_words(last)) if w]
        if any(word in words for word in ends):
            hit += count
    return hit / trips.trips


@dataclass(frozen=True, slots=True)
class LineList:
    """One cited list: which rows count and which timetable pairs its rows may describe.

    ``operators`` limits a long-distance list to the operators that run its lines (its rows
    have no operator column); ``implied_vehicle`` is the vehicle of an article about one
    vehicle, whose table lists lines and their ``status``.
    """

    short: str
    title: str
    source_id: str
    categories: tuple[str, ...]
    db_defaults: tuple[str, ...] = ()
    operators: tuple[str, ...] = ()
    skip_sections: str | None = None
    ends_at: str | None = None
    implied_vehicle: str | None = None
    status: str | None = None
    excluded_series: frozenset[str] = frozenset()


LAND_SKIP = (
    r"Änderung|Zukünft|Geplant|Ehemalig|Eingestellt|Durchgeführt|Vorübergehend|Historisch"
    r"|Bildergalerie|Weblinks|Einzelnachweise|Siehe auch|Literatur|Quellen|Fernverkehr|Nachtz"
    r"|S-Bahn"
)
REGIONAL = ("reg", "rfast")
LONG_DISTANCE_END = "== Eingestellte Linien =="
DB_FERNVERKEHR = ("db-fernverkehr-ag", "db-fernverkehr-codesharing")
MITTE_SUEDWEST = ("db-regio-ag-mitte-region-suedwest", "db-regio-ag-mitte")
MITTE_HESSEN = ("db-regio-ag-mitte-region-hessen", "db-regio-ag-mitte")


def _land(short: str, title: str, *db: str) -> LineList:
    return LineList(short, title, f"wikipedia-de-spnv-{short}", REGIONAL, db, (), LAND_SKIP)


LINE_LISTS: tuple[LineList, ...] = (
    LineList("ic", "Liste der Intercity-Linien (Deutschland)", "wikipedia-de-ic-linien", ("ld",),
             operators=(*DB_FERNVERKEHR, "sbb"), ends_at=LONG_DISTANCE_END),
    LineList("ic2", "Intercity 2 (Deutsche Bahn)", "wikipedia-de-intercity-2-lines", ("ld",),
             operators=DB_FERNVERKEHR, implied_vehicle="[[Intercity 2 (Deutsche Bahn)|IC2]]",
             status="unter Verkehr"),
    LineList("ice", "Liste der Intercity-Express-Linien", "wikipedia-de-ice-linien", ("ld",),
             operators=("db-fernverkehr-ag", "oesterreichische-bundesbahnen"),
             ends_at=LONG_DISTANCE_END, excluded_series=ICE_TRAINSETS),
    _land("nrw", "Liste der SPNV-Linien in Nordrhein-Westfalen", "db-regio-ag-nrw"),
    _land("nds", "Liste der SPNV-Linien in Niedersachsen", "db-regio-ag-nord"),
    _land("by", "Liste der SPNV-Linien in Bayern", "db-regio-ag-bayern"),
    _land("bw", "Liste der SPNV-Linien in Baden-Württemberg", "db-regio-ag-baden-wuerttemberg"),
    _land("rp", "Liste der SPNV-Linien in Rheinland-Pfalz", *MITTE_SUEDWEST),
    _land("sl", "Liste der SPNV-Linien im Saarland", *MITTE_SUEDWEST),
    _land("nvv", "Liste der SPNV-Linien im Nordhessischen Verkehrsverbund", *MITTE_HESSEN),
    _land("rmv", "Liste der Eisenbahnlinien im Rhein-Main-Verkehrsverbund", *MITTE_HESSEN),
    _land("bb", "Liste der Eisenbahnlinien in Brandenburg und Berlin", "db-regio-ag-nordost"),
    _land("sn", "Liste der Eisenbahnlinien in Sachsen", "db-regio-ag-suedost"),
    _land("st", "Liste der Eisenbahnlinien in Sachsen-Anhalt", "db-regio-ag-suedost"),
    _land("th", "Liste der Eisenbahnlinien in Thüringen", "db-regio-ag-suedost"),
    _land("sh", "Liste der Eisenbahnlinien in Schleswig-Holstein", "db-regio-ag-nord"),
    _land("mv", "Liste der Eisenbahnlinien in Mecklenburg-Vorpommern", "db-regio-ag-nordost"),
)  # fmt: skip
LISTS_BY_SHORT = {spec.short: spec for spec in LINE_LISTS}

IC2_IS_TWINDEXX = "die KISS von der DB an die ÖBB verkauft"
"""Words of the IC list (line 87): DB sold its KISS to ÖBB in June 2025, so an IC2 of the IC
lists is the Twindexx Intercity 2 (db-intercity-2). Rules from the IC lists are built only while
the cited IC list says so."""


class SourceChangedError(ValueError):
    """A cited revision no longer says what the reading of the lists relies on."""


def _header_key(name: str) -> str:
    return re.sub(r"[-\s­]", "", name.lower())


def _vehicle_column(name: str) -> bool:
    return "fahrzeug" in _header_key(name)


def _operator_column(name: str) -> bool:
    return bool(re.search(r"betreiber|evu|unternehmen", _header_key(name)))


def _route_column(name: str) -> bool:
    return bool(re.search(r"laufweg|verlauf|zuglauf|linienweg", _header_key(name)))


def _status_column(name: str) -> bool:
    return "einsatz" in _header_key(name)


_LABEL = re.compile(r"^\s*([A-ZÄÖÜ]{1,4})\s*(\d{1,3}(?:[xX](?![A-Za-z]))?)?(?![\d.])")
"""Letters and number of a line label; a letter x after the number belongs to the line (RE 6x,
RE 8X and S 5X are lines of their own in the timetable)."""


@dataclass(frozen=True, slots=True)
class ListLine:
    """One table row of a list, read."""

    list: LineList
    label: str
    letters: str
    number: str
    operator: str
    route: str
    cell: str
    quoted: str
    reading: CellReading

    @property
    def line(self) -> str:
        return self.letters + self.number

    @property
    def keys(self) -> tuple[str, ...]:
        """Timetable line keys the row may name: RE1 for RE 1; 17, IC17 and IC for IC 17."""
        if not self.number:
            return (self.letters,)
        if self.list.categories == ("ld",):
            return (self.number, self.line, self.letters)
        return (self.line,)

    @property
    def evidence(self) -> str:
        head = f"{self.label}, {self.operator}" if self.operator else self.label
        return f"{head}: {self.quoted}"


def list_lines(spec: LineList, wikitext: str, catalogue: Catalogue) -> list[ListLine]:
    """The rows of one list that describe a current line and name its vehicles."""
    text = wikitext.split(spec.ends_at, 1)[0] if spec.ends_at else wikitext
    found: list[ListLine] = []
    for row in table_rows(text):
        if spec.skip_sections and re.search(spec.skip_sections, row.section, re.IGNORECASE):
            continue
        routes = row.columns(_route_column)
        route = " ".join(plain(row.cells[i]) for i in routes)
        if spec.status:
            status = row.columns(_status_column)
            if not status or plain(row.cells[status[0]]) != spec.status:
                continue
            cell = spec.implied_vehicle or ""
            quoted = "; ".join(quote(c) for c in row.cells[1 : status[0] + 1] if quote(c))
        else:
            vehicles = row.columns(_vehicle_column)
            if not vehicles:
                continue
            cell = row.cells[vehicles[0]]
            quoted = quote(cell)
        label = plain(row.cells[0])
        match = _LABEL.match(label)
        if not match or not quoted:
            continue
        operators = row.columns(_operator_column)
        found.append(
            ListLine(
                list=spec,
                label=label,
                letters=match.group(1),
                number=(match.group(2) or "").upper(),
                operator=plain(row.cells[operators[0]]) if operators else "",
                route=route,
                cell=cell,
                quoted=quoted,
                reading=read_cell(cell, catalogue),
            )
        )
    return found


@dataclass(frozen=True, slots=True)
class Skipped:
    list: str
    label: str
    reason: str
    pair: Pair | None = None
    share: float | None = None


@dataclass(slots=True)
class Generated:
    rules: list[dict[str, object]] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)


@dataclass(slots=True)
class _Candidate:
    pair: Pair
    spec: LineList
    rows: list[ListLine]
    share: float = 0.0

    @property
    def line(self) -> str:
        return self.rows[0].line

    @property
    def number(self) -> str:
        return self.rows[0].number

    @property
    def series(self) -> list[str]:
        main: list[str] = []
        rare: list[str] = []
        for row in self.rows:
            for sid in row.reading.series:
                (rare if sid in row.reading.rare else main).append(sid)
        ordered = list(dict.fromkeys(main))
        return ordered + [s for s in dict.fromkeys(rare) if s not in ordered]

    @property
    def units(self) -> int | None:
        found = {row.reading.units for row in self.rows}
        return found.pop() if len(found) == 1 and len(self.series) == 1 else None


def _pairs_for(
    row: ListLine, timetable: Mapping[Pair, PairTrips], index: OperatorIndex
) -> list[Pair]:
    spec = row.list
    keyed = [p for p in timetable if p[1] in spec.categories and p[2] in row.keys]
    if spec.operators:
        return [p for p in keyed if p[0] in spec.operators]
    by_key: dict[str, list[Pair]] = defaultdict(list)
    for pair in keyed:
        by_key[pair[2]].append(pair)
    chosen: list[Pair] = []
    for pairs in by_key.values():
        names = sorted({p[0] for p in pairs})
        operator_id = index.match(row.operator, names, spec.db_defaults)
        chosen += [p for p in pairs if p[0] == operator_id]
    return chosen


def _families(series: Iterable[str], catalogue: Catalogue) -> set[str]:
    return {catalogue.family.get(s) or s for s in series}


def _check_sources(pages: Mapping[str, str]) -> None:
    if ("ic" in pages or "ic2" in pages) and IC2_IS_TWINDEXX not in plain(pages.get("ic", "")):
        msg = (
            "the cited IC list no longer says that DB sold its KISS to ÖBB; read which IC2 the "
            "IC lines use before building their rules"
        )
        raise SourceChangedError(msg)


def _read_lists(pages: Mapping[str, str], timetable: Mapping[Pair, PairTrips],
                catalogue: Catalogue, index: OperatorIndex, result: Generated
                ) -> dict[Pair, dict[str, dict[str, _Candidate]]]:  # fmt: skip
    by_pair: dict[Pair, dict[str, dict[str, _Candidate]]] = defaultdict(lambda: defaultdict(dict))
    for spec in LINE_LISTS:
        if spec.short not in pages:
            continue
        for row in list_lines(spec, pages[spec.short], catalogue):
            reading = row.reading
            if reading.unmapped:
                reason = "not in the catalogue: " + ", ".join(reading.unmapped)
                result.skipped.append(Skipped(spec.short, row.label, reason))
                continue
            if not reading.series:
                result.skipped.append(Skipped(spec.short, row.label, "no vehicle read"))
                continue
            if spec.excluded_series & set(reading.series):
                reason = "names ICE trainsets, whose trips are not of category ld"
                result.skipped.append(Skipped(spec.short, row.label, reason))
                continue
            pairs = _pairs_for(row, timetable, index)
            if not pairs:
                result.skipped.append(Skipped(spec.short, row.label, "no timetable pair"))
            for pair in pairs:
                lines = by_pair[pair][spec.short]
                candidate = lines.setdefault(row.line, _Candidate(pair, spec, []))
                if row not in candidate.rows:
                    candidate.rows.append(row)
    return by_pair


def _choose(
    pair: Pair,
    short: str,
    lines: Mapping[str, _Candidate],
    timetable: Mapping[Pair, PairTrips],
    result: Generated,
) -> _Candidate | None:
    passing = []
    for candidate in lines.values():
        route = " ".join(row.route for row in candidate.rows)
        candidate.share = match_share(timetable[pair], route)
        exception = match_exception(short, candidate.line)
        if candidate.share >= (exception.floor if exception else MATCH_SHARE_FLOOR):
            passing.append(candidate)
        elif pair[2] in {candidate.line, candidate.number}:
            label = candidate.rows[0].label
            share = round(candidate.share, 3)
            result.skipped.append(Skipped(short, label, "route match below the floor", pair, share))
    if len(passing) > 1:
        labels = ", ".join(c.rows[0].label for c in passing)
        result.skipped.append(Skipped(short, labels, "rows of several lines match", pair))
        return None
    return passing[0] if passing else None


def build_rules(
    pages: Mapping[str, str],
    timetable: Mapping[Pair, PairTrips],
    catalogue: Catalogue,
    index: OperatorIndex,
    valid: tuple[date, date],
) -> Generated:
    """Line rules from the lists in ``pages`` (wikitext keyed by list short name).

    When several lists describe one pair, the one naming the most series wins if the others
    name only families it names too (first in ``LINE_LISTS`` on a tie); otherwise the pair is
    skipped as a disagreement.
    """
    _check_sources(pages)
    result = Generated()
    by_pair = _read_lists(pages, timetable, catalogue, index, result)
    order = [spec.short for spec in LINE_LISTS]
    for pair, lists in sorted(by_pair.items()):
        accepted = {
            short: chosen
            for short, lines in lists.items()
            if (chosen := _choose(pair, short, lines, timetable, result)) is not None
        }
        if not accepted:
            continue
        families = sorted((_families(c.series, catalogue) for c in accepted.values()), key=len)
        if any(not f <= families[-1] for f in families):
            label = next(iter(accepted.values())).rows[0].label
            result.skipped.append(Skipped(",".join(accepted), label, "lists disagree", pair))
            continue
        most = max(len(c.series) for c in accepted.values())
        short = min((s for s, c in accepted.items() if len(c.series) == most), key=order.index)
        result.rules.append(_rule(accepted[short], valid, by_pair))
    counts = Counter(str(r["rule_id"]) for r in result.rules)
    repeated = sorted(rule_id for rule_id, n in counts.items() if n > 1)
    if repeated:
        msg = f"rule ids repeat: {repeated}"
        raise ValueError(msg)
    return result


def _rule(candidate: _Candidate, valid: tuple[date, date], by_pair: Mapping) -> dict[str, object]:
    operator_id, category, key = candidate.pair
    short = candidate.spec.short
    rule_id = f"{short}-{key.lower()}-{operator_id}"
    if category != "rfast" and (operator_id, "rfast", key) in by_pair:
        rule_id = f"{short}-{key.lower()}-{category}-{operator_id}"
    evidence = list(dict.fromkeys(row.evidence for row in candidate.rows))
    rule: dict[str, object] = {
        "rule_id": rule_id[:63].rstrip("-"),
        "scope": "line",
        "operator_id": operator_id,
        "category": category,
        "lines": [key],
        "series_ids": candidate.series,
    }
    if candidate.units:
        rule["units"] = candidate.units
    rule |= {
        "valid_from": valid[0],
        "valid_to": valid[1],
        "match_share": round(candidate.share, 3),
        "source": candidate.spec.source_id,
        "evidence": " | ".join(evidence),
    }
    return rule
