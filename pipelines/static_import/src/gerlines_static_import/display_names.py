"""Display names of stop places that name their town.

DELFI names some stations without their town ("Hauptbahnhof" for Stuttgart, "Pasing" for
München-Pasing), with a Kfz code for it ("KA Tullastraße", "D-Wehrhahn S"), or with the town in
parentheses after a mode marker ("S Ostkreuz Bhf (Berlin)"), and repeats districts ("Köln
Ehrenfeld Bf Ehrenfeld"). The town is the BKG VG250 municipality the stop lies in, or one within
``NEIGHBOUR_M`` of it (Eschborn Süd lies in Frankfurt). Each stop place takes the first of:

1. its DELFI name with the common forms normalised, when it names the town (the town moved first
   from VBB's parentheses, a Kfz code written out); DB's StaDa name instead when the town's short
   name is shared by another municipality and StaDa adds its qualifier ("Mülheim (Ruhr) Hbf");
2. DB's StaDa station name, found by IFOPT or EVA number, when it names the town;
3. the EVA mirror's station name, when it names the town ("Hamburg Reeperbahn", where StaDa
   says "Reeperbahn");
4. DB's StaDa name as DB writes it, never with a town put before it ("Flughafen BER", "Lohhof");
5. the town followed by the normalised DELFI name;
6. the normalised DELFI name (abroad, or without a position).

Only names that differ from the stop place's own name are written. The names a place is not shown
with (its timetable name, DB's and the EVA copy's names) go to ``stop_place_search_name`` so search
finds "Freiburg (Breisgau) Hbf" as well as "Freiburg Hbf".
"""

import json
import re
import unicodedata
import zipfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import numpy as np
import psycopg
import pyogrio
import shapely
from pyproj import Transformer

from gerlines_static_import import db
from gerlines_static_import.eva import read_eva_stations
from gerlines_static_import.load import DELFI, EVA_MIRROR
from gerlines_static_import.spatial import distance_m

RULE_NORMALISED = "delfi:normalised"
RULE_TOWN_FIRST = "delfi:town-first"
RULE_CODE = "vg250:town-code"
RULE_STADA = "stada:town-missing"
RULE_STADA_AS_NAMED = "stada:as-named"
RULE_STADA_QUALIFIED = "stada:town-qualified"
RULE_EVA = "eva:town-missing"
RULE_TOWN = "vg250:town-added"

STADA = db.SourceRow(
    source_id="db-stada-stations",
    name="DB StaDa station data, full list",
    homepage_url="https://developers.deutschebahn.com/db-api-marketplace/apis/product/stada",
    licence="CC-BY-4.0",
    licence_url="https://creativecommons.org/licenses/by/4.0/",
    attribution="Deutsche Bahn AG",
)
VG250 = db.SourceRow(
    source_id="bkg-vg250",
    name="BKG VG250 municipalities (Verwaltungsgebiete 1:250 000)",
    homepage_url="https://gdz.bkg.bund.de/index.php/default/verwaltungsgebiete-1-250-000-stand-01-01-vg250-01-01.html",
    licence="DL-DE-BY-2.0",
    licence_url="https://www.govdata.de/dl-de/by-2-0",
    attribution="© GeoBasis-DE / BKG (2026), changed",
)
SOURCE_OF_RULE = {
    RULE_NORMALISED: DELFI,
    RULE_TOWN_FIRST: DELFI,
    RULE_CODE: VG250,
    RULE_STADA: STADA,
    RULE_STADA_AS_NAMED: STADA,
    RULE_STADA_QUALIFIED: STADA,
    RULE_EVA: EVA_MIRROR,
    RULE_TOWN: VG250,
}
VG250_GPKG = "vg250_ebenen_0101/DE_VG250.gpkg"
VG250_CRS = 25832
VG250_WITHOUT_TOWN = 65
NEIGHBOUR_M = 2000.0
STADA_MAX_M = 2000.0

_DIGRAPHS = re.compile(r"([aou])e")
_WORD = re.compile(r"[a-z0-9]+")
_QUALIFIER = re.compile(
    r"\s*\(.*$|\s*,.*$|\s*/.*$|\s+(?:am|an|im|in|auf|ob|bei|vor|unter)\s.*$"
    r"|\s+[abiov]\.(?:[a-z]\.)?\s?\S.*$"
)
_MIN_PART_LETTERS = 4
_GLUED_OPEN = re.compile(r"(?<=\w)\(")
_GLUED_CLOSE = re.compile(r"\)(?=\w)")
_SLASH = re.compile(r"\s*/\s*")
_MAIN_STATION = frozenset({"Hauptbahnhof", "Hbf."})
_MODE_MARKERS = frozenset({"S", "U", "S+U", "U+S"})
_STATION_WORDS = frozenset(
    {
        "Bahnhof",
        "Bahnh.",
        "Bf",
        "Bf.",
        "Bhf",
        "Bhf.",
        "S-Bf",
        "S-Bf.",
        "S-Bahnhof",
        "DB-Bahnhof",
        "S-Bahn",
        "S-Bahnhalt",
        "(Bahnhof)",
        "Hp",
        "Hp.",
        "HP",
        "Haltepunkt",
        "(Hp)",
        "(Haltepunkt)",
        "S",
        "U",
    }
)
_LINKING_WORDS = frozenset(
    {
        "a",
        "am",
        "an",
        "auf",
        "b",
        "bei",
        "d",
        "dem",
        "den",
        "der",
        "i",
        "im",
        "in",
        "ob",
        "v",
        "vor",
    }
)
_KEEP_AFTER = frozenset({"Am", "Zum", "Vor", "Oberer", "Unterer", "Alter"})
_TRAILING_PARENS = re.compile(r"^(?P<rest>.+?)\s*\((?P<inner>[^()]+)\)$")
_CODE = re.compile(r"^(?P<code>[A-ZÄÖÜ]{1,3})(?P<sep>[- ])(?![A-ZÄÖÜ]{1,3}[- ])(?P<rest>\S.*)$")


@dataclass(frozen=True, slots=True)
class Town:
    name: str
    words: tuple[tuple[str, ...], ...]
    shared: bool = False


@dataclass(frozen=True, slots=True)
class PlaceInput:
    stop_place_id: UUID
    name: str
    dhid: str | None
    eva: int | None
    lon: float | None
    lat: float | None


@dataclass(frozen=True, slots=True)
class DisplayName:
    stop_place_id: UUID
    name: str
    rule: str
    source_id: str


@dataclass(frozen=True, slots=True)
class SearchName:
    stop_place_id: UUID
    name: str
    source_id: str


@dataclass(frozen=True, slots=True)
class StadaStation:
    name: str
    ifopt: str | None
    evas: tuple[int, ...]
    lon: float | None
    lat: float | None


def fold_words(text: str) -> list[str]:
    """Lower-case words without diacritics, ae, oe, ue read as the plain vowel, Sankt as St."""
    lowered = text.lower().replace("ß", "ss")
    plain = unicodedata.normalize("NFKD", lowered).encode("ascii", "ignore").decode("ascii")
    words = _WORD.findall(_DIGRAPHS.sub(r"\1", plain))
    return ["st" if word == "sankt" else word for word in words]


def _core(gen: str) -> str:
    return _QUALIFIER.sub("", gen).strip() or gen.strip()


def town_of(gen: str, shared_cores: Iterable[str] = ()) -> Town:
    """A VG250 municipality as written in names: its core ("Mühldorf" of "Mühldorf a.Inn"),
    or the full name when another municipality has the same core ("Halle (Saale)").

    A compound municipality is named by each of its parts too ("Echterdingen").
    """
    core = _core(gen)
    words = [tuple(fold_words(core))]
    parts = re.split(r"[-/]", gen) if "/" in gen else re.split(r"-", core)
    if len(parts) > 1:
        words += [
            tuple(fold_words(part)) for part in parts if len(part.strip()) >= _MIN_PART_LETTERS
        ]
    unique = list(dict.fromkeys(word for word in words if word))
    shared = " ".join(fold_words(core)) in set(shared_cores)
    return Town(gen.strip() if shared else core, tuple(unique), shared)


def _contains(words: Sequence[str], part: Sequence[str]) -> bool:
    size = len(part)
    return any(tuple(words[i : i + size]) == tuple(part) for i in range(len(words) - size + 1))


def names_town(name: str, towns: Iterable[Town]) -> bool:
    words = fold_words(name)
    return any(_contains(words, part) for town in towns for part in town.words)


def _without_commas(tokens: list[str]) -> list[str]:
    result, depth = [], 0
    for token in tokens:
        depth += token.count("(") - token.count(")")
        stripped = token.rstrip(",") if depth <= 0 else token
        if stripped.startswith(",") and depth <= 0:
            stripped = stripped.lstrip(",")
        if stripped:
            result.append(stripped)
    return result


def _keeps_station_word(kept: list[str], vbb_form: bool) -> bool:
    """Bahnhof stays in a proper name: after a preposition or adjective (Am Bahnhof, oberer
    Bahnhof) and after an -er word that is not the town (Mühlener Bf, Anhalter Bahnhof)."""
    previous = kept[-1]
    if previous[:1].islower() or previous in _KEEP_AFTER:
        return True
    return previous.endswith("er") and (vbb_form or len(kept) > 1)


def _without_repeats(tokens: list[str]) -> list[str]:
    seen: set[str] = set()
    result = []
    for token in tokens:
        key = " ".join(fold_words(token))
        if key and key in seen and not any(char.isdigit() for char in key):
            continue
        seen.add(key)
        result.append(token)
    return result


def normalise(name: str) -> str:
    """Hauptbahnhof as Hbf, station words and mode markers dropped, commas and repeats removed."""
    text = _SLASH.sub("/", _GLUED_CLOSE.sub(") ", _GLUED_OPEN.sub(" (", name)))
    tokens = _without_commas(text.split())
    tokens = ["Hbf" if token in _MAIN_STATION else token for token in tokens]
    vbb_form = False
    while len(tokens) > 1 and tokens[0] in _MODE_MARKERS:
        tokens.pop(0)
        vbb_form = True
    kept: list[str] = []
    for index, token in enumerate(tokens):
        if token in _STATION_WORDS and len(tokens) > 1:
            if not kept and index + 1 < len(tokens):
                continue
            if kept and not _keeps_station_word(kept, vbb_form):
                continue
        kept.append(token)
    result = " ".join(_without_repeats(kept))
    return result or name.strip()


def _is_code_of(code: str, town: Town) -> bool:
    letters = "".join(fold_words(code))
    target = "".join(town.words[0]) if town.words else ""
    if not letters or not target or letters[0] != target[0]:
        return False
    position = 0
    for letter in letters[1:]:
        position = target.find(letter, position + 1)
        if position < 0:
            return False
    return True


def _is_town_name(tokens: Sequence[str], towns: Sequence[Town]) -> bool:
    words = tuple(fold_words(" ".join(tokens)))
    return any(town.words[:1] == (words,) for town in towns)


def _ends_in_town_name(tokens: Sequence[str], towns: Sequence[Town]) -> bool:
    return any(_is_town_name(tokens[start:], towns) for start in range(len(tokens)))


def without_district_repeats(
    text: str, towns: Sequence[Town], known_names: Iterable[str] = ()
) -> str:
    """A district or town written twice side by side, once: the word beside a compound that holds
    it goes, with a station word kept only for it ("Offenbach (Main)-Bieber Bieber Bahnhof",
    "Witten Witten-Annen"). A town and district compound goes before the town's own stop name
    when a word follows the town ("Wiesbaden-Biebrich Wiesbaden Ost") or when ``known_names``
    (StaDa, the EVA copy) call the place by the town alone ("Mücke (Hess)"). A municipality's own
    compound name stays ("Brohl-Lützing Brohl", "Walldorf Mörfelden-Walldorf").
    """
    bare = {" ".join(fold_words(_core(name))) for name in known_names if name}
    tokens = text.split()
    index = 0
    while index + 1 < len(tokens):
        left, right = tokens[index], tokens[index + 1]
        if "-" in left and "-" not in right and not _ends_in_town_name(tokens[: index + 1], towns):
            parts = [tuple(fold_words(part)) for part in left.split("-")]
            word = tuple(fold_words(right))
            if word == parts[-1]:
                del tokens[index + 1]
                if index + 1 < len(tokens) and tokens[index + 1] in _STATION_WORDS:
                    del tokens[index + 1]
                continue
            named_alone = index + 2 < len(tokens) or " ".join(word) in bare
            if word == parts[0] and named_alone and _is_town_name([right], towns):
                del tokens[index]
                continue
        if (
            "-" in right
            and "-" not in left
            and not right.startswith("(")
            and not _is_town_name([right], towns)
        ):
            parts = [tuple(fold_words(part)) for part in right.split("-")]
            if tuple(fold_words(left)) in (parts[0], parts[-1]):
                del tokens[index]
                continue
        index += 1
    return " ".join(tokens)


def with_town(
    name: str,
    towns: Sequence[Town],
    known_names: Iterable[str] = (),
    *,
    repeats: bool = True,
) -> tuple[str, str] | None:
    """The normalised name and its rule when it names one of ``towns``, else None; with
    ``repeats`` a district or town written twice is shown once (``without_district_repeats``)."""
    text = normalise(name)
    if repeats:
        text = without_district_repeats(text, towns, known_names)
    parens = _TRAILING_PARENS.match(text)
    if parens is not None and not names_town(parens["rest"], towns):
        inner = tuple(fold_words(parens["inner"]))
        town = next((t for t in towns if t.words[:1] == (inner,)), None)
        if town is not None:
            return f"{town.name} {parens['rest']}", RULE_TOWN_FIRST
    if names_town(text, towns):
        return text, RULE_NORMALISED
    code = _CODE.match(text)
    if code is not None and code["code"] not in _MODE_MARKERS:
        candidates = towns if len(code["code"]) > 1 else towns[:1]
        town = next((t for t in candidates if _is_code_of(code["code"], t)), None)
        if town is not None:
            expanded = f"{town.name}{code['sep']}{code['rest']}"
            return " ".join(_without_repeats(expanded.split())), RULE_CODE
    return None


class StadaIndex:
    def __init__(self, stations: Iterable[StadaStation]) -> None:
        listed = list(stations)
        self._by_ifopt = {s.ifopt: s for s in listed if s.ifopt}
        self._by_eva = {eva: s for s in listed for eva in s.evas}
        self.size = len(listed)

    def name_for(self, place: PlaceInput) -> str | None:
        """StaDa's name of the place: by IFOPT, else by EVA number when the station lies near the
        place and keeps every word of its timetable name (a tram stop beside it does not)."""
        station = self._by_ifopt.get(place.dhid) if place.dhid else None
        if station is None and place.eva is not None:
            station = self._by_eva.get(place.eva)
            if station is not None and not (_near(station, place) and _keeps_words(place, station)):
                station = None
        return station.name if station is not None else None


def _keeps_words(place: PlaceInput, station: StadaStation) -> bool:
    theirs = fold_words(station.name)
    return all(
        any(word.startswith(mine) for word in theirs) for mine in fold_words(normalise(place.name))
    )


def _near(station: StadaStation, place: PlaceInput) -> bool:
    if station.lat is None or station.lon is None or place.lat is None or place.lon is None:
        return True
    return distance_m(place.lat, place.lon, station.lat, station.lon) <= STADA_MAX_M


def display_name(
    place: PlaceInput,
    towns: Sequence[Town],
    stada: StadaIndex,
    eva_name: str | None,
    *,
    repeats: bool = True,
) -> DisplayName | None:
    """The display name of one stop place; ``towns`` lists the containing municipality first."""
    chosen = _choose(place, towns, stada, eva_name, repeats)
    if chosen is None or chosen[0] == place.name.strip():
        return None
    name, rule = chosen
    return DisplayName(place.stop_place_id, name, rule, SOURCE_OF_RULE[rule].source_id)


def _choose(
    place: PlaceInput,
    towns: Sequence[Town],
    stada: StadaIndex,
    eva_name: str | None,
    repeats: bool,
) -> tuple[str, str] | None:
    if not towns:
        return normalise(place.name), RULE_NORMALISED
    stada_name = " ".join((stada.name_for(place) or "").split())
    known = (stada_name, eva_name or "")
    own = with_town(place.name, towns, known, repeats=repeats)
    if own is not None:
        return _qualified(own, stada_name, towns)
    if stada_name and names_town(stada_name, towns):
        return stada_name, RULE_STADA
    named = with_town(eva_name, towns, known, repeats=repeats) if eva_name else None
    if named is not None:
        return named[0], RULE_EVA
    if stada_name:
        return stada_name, RULE_STADA_AS_NAMED
    return normalise(f"{towns[0].name} {normalise(place.name)}"), RULE_TOWN


def _qualified(own: tuple[str, str], stada_name: str, towns: Sequence[Town]) -> tuple[str, str]:
    """StaDa's name when it keeps every word of ``own`` and adds the qualifier of a town whose
    short name another municipality shares ("Mülheim (Ruhr) Hbf" for "Mülheim Hbf"), not only a
    station or linking word ("Neustadt (Aisch) Bahnhof", "Frankfurt am Main Messe")."""
    shared = [town for town in towns if town.shared and names_town(own[0], [town])]
    if not shared or not stada_name or not names_town(stada_name, shared):
        return own
    mine, theirs = set(fold_words(own[0])), set(fold_words(normalise(stada_name)))
    if mine <= theirs and theirs - mine - _LINKING_WORDS:
        return stada_name, RULE_STADA_QUALIFIED
    return own


def search_names(
    place: PlaceInput,
    shown: DisplayName | None,
    stada: StadaIndex,
    eva_name: str | None,
    towns: Sequence[Town],
) -> list[SearchName]:
    """The names search also finds a stop place by: its timetable name when another is shown and it
    names a town (not "Hauptbahnhof" or "Ostbahnhof" alone), DB's StaDa name and the EVA copy's
    name, each once and never the shown name."""
    timetable = shown is not None and (not towns or names_town(place.name, towns))
    candidates = [
        (place.name if timetable else None, DELFI),
        (stada.name_for(place), STADA),
        (eva_name, EVA_MIRROR),
    ]
    seen = {" ".join(fold_words(shown.name if shown is not None else place.name))}
    result = []
    for name, source in candidates:
        text = " ".join((name or "").split())
        key = " ".join(fold_words(text))
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(SearchName(place.stop_place_id, text, source.source_id))
    return result


class MunicipalityIndex:
    """VG250 municipalities: the one a point lies in, then those within ``NEIGHBOUR_M``.

    Areas without a municipality (``without_town``, such as the Harz forest) place a stop in
    Germany but never name its town.
    """

    def __init__(
        self,
        rows: Iterable[tuple[str, shapely.Geometry]],
        crs: int = VG250_CRS,
        without_town: Iterable[tuple[str, shapely.Geometry]] = (),
    ) -> None:
        listed = list(rows)
        cores = [" ".join(fold_words(_core(gen))) for gen, _ in listed]
        counts: dict[str, int] = {}
        for core in cores:
            counts[core] = counts.get(core, 0) + 1
        shared = {core for core, count in counts.items() if count > 1}
        names = sorted({gen for gen, _ in listed})
        towns = {gen: town_of(gen, shared) for gen in names}
        areas = [geometry for _, geometry in without_town]
        self._towns: list[Town | None] = [towns[gen] for gen, _ in listed] + [None] * len(areas)
        self._geometries = np.array([geometry for _, geometry in listed] + areas, dtype=object)
        self._tree = shapely.STRtree(self._geometries)
        self._to_crs = Transformer.from_crs(4326, crs, always_xy=True)

    def towns_at(self, lon: float | None, lat: float | None) -> list[Town]:
        if lon is None or lat is None:
            return []
        x, y = self._to_crs.transform(lon, lat)
        return self.towns_at_xy(x, y)

    def towns_at_xy(self, x: float, y: float) -> list[Town]:
        point = shapely.Point(x, y)
        inside = [int(i) for i in self._tree.query(point, predicate="intersects")]
        if not inside:
            return []
        near = self._tree.query(point, predicate="dwithin", distance=NEIGHBOUR_M)
        ranked = sorted(
            (int(i) for i in near if int(i) not in inside),
            key=lambda i: shapely.distance(point, self._geometries[i]),
        )
        result: list[Town] = []
        for index in [*inside, *ranked]:
            town = self._towns[index]
            if town is not None and town not in result:
                result.append(town)
        return result


def read_municipalities(archive: Path) -> MunicipalityIndex:
    """VG250 municipalities (``vg250_gem``, land and water areas) from the BKG archive; areas
    without a municipality (``IBZ`` 65, gemeindefreies Gebiet) are kept apart."""
    meta, _, wkb, fields = pyogrio.raw.read(
        f"/vsizip/{archive}/{VG250_GPKG}", layer="vg250_gem", columns=["GEN", "GF", "IBZ"]
    )
    names = list(meta["fields"])
    gen = fields[names.index("GEN")]
    area_class = np.asarray(fields[names.index("GF")]).astype(int)
    kind = np.asarray(fields[names.index("IBZ")]).astype(int)
    order = np.argsort(-area_class, kind="stable")
    geometries = shapely.from_wkb(wkb)
    rows = [(str(gen[i]), geometries[i]) for i in order if kind[i] != VG250_WITHOUT_TOWN]
    areas = [(str(gen[i]), geometries[i]) for i in order if kind[i] == VG250_WITHOUT_TOWN]
    return MunicipalityIndex(rows, crs=VG250_CRS, without_town=areas)


def read_stada(path: Path) -> list[StadaStation]:
    """StaDa stations of a full list download (``GET /stations``): name, IFOPT and EVA numbers."""
    stations = []
    for record in json.loads(path.read_text())["result"]:
        name = (record.get("name") or "").strip()
        if not name:
            continue
        evas = [entry for entry in record.get("evaNumbers") or [] if isinstance(entry, dict)]
        main = next((e for e in evas if e.get("isMain")), evas[0] if evas else None)
        point = ((main or {}).get("geographicCoordinates") or {}).get("coordinates") or []
        lon, lat = (float(point[0]), float(point[1])) if len(point) >= 2 else (None, None)
        stations.append(
            StadaStation(
                name,
                record.get("ifopt") or None,
                tuple(int(e["number"]) for e in evas if isinstance(e.get("number"), int)),
                lon,
                lat,
            )
        )
    return stations


def read_eva_names(eva_path: Path) -> dict[int, str]:
    with zipfile.ZipFile(eva_path) as archive:
        return {station.eva: station.name for station in read_eva_stations(archive)}


def read_places(conn: psycopg.Connection) -> list[tuple[PlaceInput, str | None]]:
    """Every stop place with its position and country."""
    rows = conn.execute(
        """SELECT stop_place_id, name, dhid, eva, ST_X(geom), ST_Y(geom), country_code
             FROM stop_place ORDER BY 1"""
    ).fetchall()
    return [(PlaceInput(r[0], r[1], r[2], r[3], r[4], r[5]), r[6]) for r in rows]


def compute_names(
    places: Iterable[tuple[PlaceInput, str | None]],
    municipalities: MunicipalityIndex,
    stada: StadaIndex,
    eva_names: Mapping[int, str],
) -> tuple[list[DisplayName], list[SearchName]]:
    """The display and search names of every place. A name the repeat rule made that another place
    is shown with as well falls back to the name without that rule, so the rule never makes two
    stations read alike."""
    rows = []
    for place, country in places:
        towns = municipalities.towns_at(place.lon, place.lat) if country == "DE" else []
        eva_name = eva_names.get(place.eva) if place.eva is not None else None
        rows.append([place, towns, eva_name, display_name(place, towns, stada, eva_name)])
    shown_count = Counter(_shown_key(place, chosen) for place, _, _, chosen in rows)
    for row in rows:
        place, towns, eva_name, chosen = row
        if chosen is None or shown_count[_shown_key(place, chosen)] < 2:
            continue
        plain = display_name(place, towns, stada, eva_name, repeats=False)
        if plain != chosen:
            shown_count[_shown_key(place, chosen)] -= 1
            shown_count[_shown_key(place, plain)] += 1
            row[3] = plain
    shown_names = [chosen for _, _, _, chosen in rows if chosen is not None]
    other_names = [
        name
        for place, towns, eva_name, chosen in rows
        for name in search_names(place, chosen, stada, eva_name, towns)
    ]
    return shown_names, other_names


def _shown_key(place: PlaceInput, chosen: DisplayName | None) -> str:
    return " ".join(fold_words(chosen.name if chosen is not None else place.name))


def run_display_names(
    eva_path: Path,
    stada_path: Path,
    vg250_path: Path,
    database_url: str,
    *,
    dry_run: bool = False,
) -> dict:
    """Replace every display name in one transaction; ``dry_run`` reads only and writes nothing."""
    municipalities = read_municipalities(vg250_path)
    stada = StadaIndex(read_stada(stada_path))
    eva_names = read_eva_names(eva_path)
    with psycopg.connect(database_url) as conn:
        if dry_run:
            conn.read_only = True
        places = read_places(conn)
        names, others = compute_names(places, municipalities, stada, eva_names)
        written = 0 if dry_run else write_names(conn, names, others)
    by_rule: dict[str, int] = {}
    for name in names:
        by_rule[name.rule] = by_rule.get(name.rule, 0) + 1
    return {
        "places": len(places),
        "stada_stations": stada.size,
        "eva_stations": len(eva_names),
        "display_names": len(names),
        "by_rule": dict(sorted(by_rule.items())),
        "search_names": len(others),
        "written": written,
        "dry_run": dry_run,
    }


def write_names(
    conn: psycopg.Connection, names: Iterable[DisplayName], others: Iterable[SearchName]
) -> int:
    """Replace all display and search names in one statement set; the caller commits."""
    listed = list(names)
    db.upsert_sources(conn, [DELFI, EVA_MIRROR, STADA, VG250])
    with conn.cursor() as cur:
        cur.execute("DELETE FROM stop_place_display_name")
        cur.execute("DELETE FROM stop_place_search_name")
        cur.executemany(
            """
            INSERT INTO stop_place_display_name (stop_place_id, name, source_id, rule)
            VALUES (%s, %s, %s, %s)
            """,
            [(n.stop_place_id, n.name, n.source_id, n.rule) for n in listed],
        )
        cur.executemany(
            """
            INSERT INTO stop_place_search_name (stop_place_id, name, source_id)
            VALUES (%s, %s, %s)
            """,
            [(n.stop_place_id, n.name, n.source_id) for n in others],
        )
    return len(listed)
