"""EVA numbers for DELFI stop places, joined from the EVA-enriched mirror copy.

The mirror adds DB's stations (stop ids that are seven-digit EVA numbers) to ``stops.txt`` but
does not link them to DHIDs. Two passes:

1. exact: a stop id that carries an EVA number (a DHID whose station part is ``80xxxxx``, such as
   ``de:15002:8010159``, or a DELFI id of five zeros and the EVA number, ``000008010191``) takes
   that number when the mirror has the station within ``exact_max_m``;
2. spatial: the best EVA station within ``max_distance_m`` whose normalised name is similar
   enough, never one whose name differs only by a direction or station suffix (Nord, Süd, Ost,
   West, Mitte, Hbf).

Running the spatial pass also on the exactly matched places gives the agreement figure that
estimates the precision of the spatial pass.
"""

import re
import unicodedata
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from difflib import SequenceMatcher

from gerlines_static_import.gtfs import open_table
from gerlines_static_import.spatial import GridIndex, distance_m

_EVA = re.compile(r"^\d{7}$")
_EVA_IN_DHID = re.compile(r"^[a-z]{2}:\d{5}:(80\d{5})$")
_EVA_IN_DELFI_ID = re.compile(r"^00000(80\d{5})$")
_GERMAN = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
_WORD = re.compile(r"[a-z0-9]+")
_REPLACE = {"hauptbahnhof": "hbf", "bahnhof": "bf", "bhf": "bf", "sankt": "st", "sud": "sued"}
_DROP = frozenset({"s", "u", "bf", "db", "gleis", "bahnsteig", "zob", "rb", "re"})
SUFFIXES = frozenset(
    {"nord", "sued", "ost", "west", "mitte", "nordost", "nordwest", "suedost", "suedwest", "hbf"}
)


@dataclass(frozen=True, slots=True)
class EvaStation:
    eva: int
    name: str
    lat: float
    lon: float


@dataclass(frozen=True, slots=True)
class EvaMatch:
    eva: int
    eva_name: str
    distance_m: float
    score: float
    method: str


def read_eva_stations(archive: zipfile.ZipFile) -> list[EvaStation]:
    """EVA stations of the mirror: seven-digit stop ids without a parent station."""
    stations = []
    with open_table(archive, "stops.txt") as table:
        sid = table.index("stop_id")
        name = table.index("stop_name")
        lat = table.index("stop_lat")
        lon = table.index("stop_lon")
        parent = table.optional_index("parent_station")
        for row in table.rows:
            if not _EVA.match(row[sid]) or (parent is not None and row[parent].strip()):
                continue
            if not row[lat].strip() or not row[lon].strip():
                continue
            stations.append(EvaStation(int(row[sid]), row[name], float(row[lat]), float(row[lon])))
    return stations


def eva_in_stop_id(stop_id: str) -> int | None:
    """The EVA number a stop id carries, if any."""
    match = _EVA_IN_DHID.match(stop_id) or _EVA_IN_DELFI_ID.match(stop_id)
    return int(match.group(1)) if match else None


def name_tokens(name: str) -> tuple[str, ...]:
    folded = (
        unicodedata.normalize("NFKD", name.lower().translate(_GERMAN))
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    words = (_REPLACE.get(word, word) for word in _WORD.findall(folded))
    return tuple(word for word in words if word not in _DROP)


def differs_only_by_suffix(a: str, b: str) -> bool:
    """True when the names differ and every differing word is a direction or station suffix."""
    difference = set(name_tokens(a)) ^ set(name_tokens(b))
    return bool(difference) and difference <= SUFFIXES


def name_score(a: str, b: str) -> float:
    left, right = name_tokens(a), name_tokens(b)
    if not left or not right:
        return 0.0
    overlap = len(set(left) & set(right)) / len(set(left) | set(right))
    ratio = SequenceMatcher(None, " ".join(left), " ".join(right)).ratio()
    return max(overlap, ratio)


class EvaIndex:
    def __init__(  # noqa: PLR0913
        self,
        stations: Iterable[EvaStation],
        *,
        max_distance_m: float = 600.0,
        min_score: float = 0.8,
        near_distance_m: float = 150.0,
        near_min_score: float = 0.5,
        exact_max_m: float = 2000.0,
    ) -> None:
        listed = list(stations)
        self._grid = GridIndex(listed)
        self._by_eva = {station.eva: station for station in listed}
        self.max_distance_m = max_distance_m
        self.min_score = min_score
        self.near_distance_m = near_distance_m
        self.near_min_score = near_min_score
        self.exact_max_m = exact_max_m

    def exact(self, stop_id: str, lat: float | None, lon: float | None) -> EvaMatch | None:
        eva = eva_in_stop_id(stop_id)
        station = self._by_eva.get(eva) if eva is not None else None
        if station is None or lat is None or lon is None:
            return None
        distance = distance_m(lat, lon, station.lat, station.lon)
        if distance > self.exact_max_m:
            return None
        return EvaMatch(station.eva, station.name, distance, 1.0, "exact")

    def match(self, name: str, lat: float | None, lon: float | None) -> EvaMatch | None:
        if lat is None or lon is None:
            return None
        best: tuple[float, EvaMatch] | None = None
        for station in self._grid.near(lat, lon):
            distance = distance_m(lat, lon, station.lat, station.lon)
            if distance > self.max_distance_m:
                continue
            score = name_score(name, station.name)
            accepted = score >= self.min_score or (
                distance <= self.near_distance_m and score >= self.near_min_score
            )
            if not accepted or differs_only_by_suffix(name, station.name):
                continue
            rank = score - distance / self.max_distance_m
            if best is None or rank > best[0]:
                best = (rank, EvaMatch(station.eva, station.name, distance, score, "spatial"))
        return best[1] if best is not None else None

    def resolve(
        self, stop_id: str, name: str, lat: float | None, lon: float | None
    ) -> EvaMatch | None:
        return self.exact(stop_id, lat, lon) or self.match(name, lat, lon)
