"""Stop places and stop points from ``stops.txt`` with DHID, IFOPT, country and canonical ids.

Every GTFS stop a train calls at becomes a stop point. Its place is the parent station; a stop
without a parent belongs to the place named by the first three parts of its DHID
(``de:05916:7501:89`` to ``de:05916:7501``). A stop without a DHID becomes its own place unless
``merge_lone_places`` finds the DHID place of the same station.

A stop's country comes from the two-letter prefix of its id (``de:``, ``at:``, ``ch:``); an id
without one (``000010975601``) is German when its point lies in the national outline.
"""

import re
import zipfile
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from uuid import UUID

from gerlines_static_import.eva import differs_only_by_suffix, eva_in_stop_id, name_score
from gerlines_static_import.gtfs import open_table, parse_int
from gerlines_static_import.ids import canonical_id
from gerlines_static_import.spatial import GridIndex, NationalOutline, distance_m

PLACE_DHID = re.compile(r"^[a-z]{2}:[0-9]{5}:[0-9A-Za-z_]+$")
POINT_DHID = re.compile(r"^[a-z]{2}:[0-9]{5}:[0-9A-Za-z_]+(:[0-9A-Za-z_]+){1,2}$")
IFOPT = re.compile(r"^[a-z]{2}:[0-9A-Za-z_]+(:[0-9A-Za-z_]+)*$")
_COUNTRY_PREFIX = re.compile(r"^([a-z]{2}):")
_DHID_BASE = re.compile(r"^([a-z]{2}:[0-9]{5}:[0-9A-Za-z_]+?)(?:_G)*(?::|$)")
_STATION = 1
_STOP = 0


@dataclass(frozen=True, slots=True)
class StopRow:
    stop_id: str
    name: str
    lat: float | None
    lon: float | None
    location_type: int
    parent_station: str
    platform_code: str


@dataclass(slots=True)
class Place:
    key: str
    name: str
    lat: float | None
    lon: float | None
    dhid: str | None
    ifopt: str | None
    country_code: str | None
    synthesised: bool
    canonical: UUID | None = None
    eva: int | None = None


@dataclass(slots=True)
class Point:
    key: str
    place_key: str
    name: str
    lat: float | None
    lon: float | None
    platform_code: str | None
    dhid: str | None
    ifopt: str | None
    country_code: str | None = None
    canonical: UUID | None = None


@dataclass(slots=True)
class StopModel:
    places: dict[str, Place] = field(default_factory=dict)
    points: dict[str, Point] = field(default_factory=dict)
    merged: dict[str, str] = field(default_factory=dict)

    def place_of_point(self, point_key: str) -> Place:
        return self.places[self.points[point_key].place_key]


def _coordinate(value: str) -> float | None:
    stripped = value.strip()
    if not stripped:
        return None
    number = float(stripped)
    return None if number == 0.0 else number


def read_stops(archive: zipfile.ZipFile, wanted: set[str] | None = None) -> dict[str, StopRow]:
    """Rows of ``stops.txt``; with ``wanted``, only those stops, their stations and DHID bases."""
    rows: dict[str, StopRow] = {}
    with open_table(archive, "stops.txt") as table:
        sid = table.index("stop_id")
        name = table.index("stop_name")
        lat = table.index("stop_lat")
        lon = table.index("stop_lon")
        kind = table.optional_index("location_type")
        parent = table.optional_index("parent_station")
        platform = table.optional_index("platform_code")
        for row in table.rows:
            rows[row[sid]] = StopRow(
                stop_id=row[sid],
                name=row[name].strip(),
                lat=_coordinate(row[lat]),
                lon=_coordinate(row[lon]),
                location_type=parse_int(row[kind]) if kind is not None else _STOP,
                parent_station=row[parent].strip() if parent is not None else "",
                platform_code=row[platform].strip() if platform is not None else "",
            )
    if wanted is None:
        return rows
    keep = {key for key in wanted if key in rows}
    keep |= {rows[key].parent_station for key in keep if rows[key].parent_station in rows}
    keep |= {dhid_base(key) for key in keep if dhid_base(key) in rows}
    return {key: rows[key] for key in keep}


def dhid_base(stop_id: str) -> str:
    """The stop place DHID of a stop id, without DELFI's generic ``_G`` suffixes.

    ``de:02000:10950_G_G`` and ``de:09362:14012:0:2_G`` give ``de:02000:10950`` and
    ``de:09362:14012``; an id outside the DHID scheme is returned unchanged.
    """
    match = _DHID_BASE.match(stop_id)
    return match.group(1) if match else stop_id


def _country(stop_id: str) -> str | None:
    match = _COUNTRY_PREFIX.match(stop_id)
    return match.group(1).upper() if match else None


def _place_ids(key: str) -> tuple[str | None, str | None]:
    if PLACE_DHID.match(key) and key.startswith("de:"):
        return key, None
    if IFOPT.match(key):
        return None, key
    return None, None


def _point_ids(key: str) -> tuple[str | None, str | None]:
    if POINT_DHID.match(key) and key.startswith("de:"):
        return key, None
    if IFOPT.match(key) and not key.startswith("de:"):
        return None, key
    return None, None


def _place_key(row: StopRow, rows: Mapping[str, StopRow]) -> str:
    parent = rows.get(row.parent_station)
    anchor = parent if parent is not None and parent.location_type == _STATION else row
    return dhid_base(anchor.stop_id)


def build_model(rows: Mapping[str, StopRow], served: Iterable[str]) -> StopModel:
    """Places and points for the ``served`` stop ids (stops that trips call at).

    A place takes its name and position from its own row when ``stops.txt`` has one, otherwise
    from the most common name and the mean position of the stops and stations that point to it.
    """
    model = StopModel()
    anchors: dict[str, list[StopRow]] = {}
    for key in served:
        row = rows[key]
        place_key = _place_key(row, rows)
        dhid, ifopt = _point_ids(key)
        model.points[key] = Point(
            key=key,
            place_key=place_key,
            name=row.name,
            lat=row.lat,
            lon=row.lon,
            platform_code=row.platform_code or None,
            dhid=dhid,
            ifopt=ifopt,
            country_code=_country(key),
        )
        parent = rows.get(row.parent_station)
        anchor = parent if parent is not None and parent.location_type == _STATION else row
        anchors.setdefault(place_key, []).append(anchor)
    for place_key, members in anchors.items():
        own = rows.get(place_key)
        if own is not None:
            model.places[place_key] = _place(place_key, own.name, own.lat, own.lon)
            continue
        lats = [m.lat for m in members if m.lat is not None]
        lons = [m.lon for m in members if m.lon is not None]
        name = Counter(m.name for m in members if m.name).most_common(1)
        model.places[place_key] = _place(
            place_key,
            name[0][0] if name else place_key,
            sum(lats) / len(lats) if lats else None,
            sum(lons) / len(lons) if lons else None,
            synthesised=True,
        )
    return model


def _place(
    key: str, name: str, lat: float | None, lon: float | None, *, synthesised: bool = False
) -> Place:
    dhid, ifopt = _place_ids(key)
    return Place(
        key=key,
        name=name or key,
        lat=lat,
        lon=lon,
        dhid=dhid,
        ifopt=ifopt,
        country_code=_country(key),
        synthesised=synthesised,
    )


def fill_countries(model: StopModel, outline: NationalOutline) -> int:
    """Set ``DE`` on places and points without a country prefix that lie in the outline."""
    filled = 0
    for item in (*model.places.values(), *model.points.values()):
        if item.country_code is None and outline.contains(item.lat, item.lon):
            item.country_code = "DE"
            filled += 1
    return filled


@dataclass(frozen=True, slots=True)
class MergeResult:
    by_eva: int
    by_distance: int


def merge_lone_places(
    model: StopModel,
    *,
    max_distance_m: float = 150.0,
    min_score: float = 0.6,
) -> MergeResult:
    """Fold places without DHID or IFOPT into the DHID place of the same station.

    First by the EVA number a DELFI id carries (``000008010191`` and the DHID place with EVA
    8010191), then by the nearest DHID place within ``max_distance_m`` whose name matches, never
    when the names differ only by a suffix such as Nord or Süd.
    """
    dhid_places = [p for p in model.places.values() if p.dhid is not None]
    grid = GridIndex(dhid_places)
    by_eva: dict[int, Place] = {}
    for place in dhid_places:
        if place.eva is not None:
            by_eva.setdefault(place.eva, place)
    eva_count = distance_count = 0
    lone = [
        p
        for p in model.places.values()
        if p.dhid is None and p.ifopt is None and p.country_code in {None, "DE"}
    ]
    for place in lone:
        eva = eva_in_stop_id(place.key)
        target = by_eva.get(eva) if eva is not None else None
        if target is not None:
            eva_count += 1
        else:
            target = _nearest_namesake(place, grid, max_distance_m, min_score)
            if target is None:
                continue
            distance_count += 1
        fold_place(model, place, target)
    return MergeResult(eva_count, distance_count)


def _nearest_namesake(
    place: Place, grid: GridIndex[Place], max_distance_m: float, min_score: float
) -> Place | None:
    if place.lat is None or place.lon is None:
        return None
    best: tuple[float, Place] | None = None
    for candidate in grid.near(place.lat, place.lon):
        if candidate.lat is None or candidate.lon is None:
            continue
        distance = distance_m(place.lat, place.lon, candidate.lat, candidate.lon)
        if distance > max_distance_m or differs_only_by_suffix(place.name, candidate.name):
            continue
        if name_score(place.name, candidate.name) < min_score:
            continue
        if best is None or distance < best[0]:
            best = (distance, candidate)
    return best[1] if best is not None else None


def fold_place(model: StopModel, place: Place, target: Place) -> None:
    """Move the points of ``place`` to ``target``; the key of ``place`` stays mapped to it."""
    for point in model.points.values():
        if point.place_key == place.key:
            point.place_key = target.key
    if target.eva is None:
        target.eva = place.eva
    for key, into in model.merged.items():
        if into == place.key:
            model.merged[key] = target.key
    model.merged[place.key] = target.key
    del model.places[place.key]


def natural_key(source_id: str, key: str, dhid: str | None, ifopt: str | None) -> str:
    if dhid:
        return f"dhid:{dhid}"
    if ifopt:
        return f"ifopt:{ifopt}"
    return f"{source_id}:{key}"


@dataclass(frozen=True, slots=True)
class KnownIds:
    """Canonical ids already stored: by the source's own keys and by DHID."""

    places: Mapping[str, UUID] = field(default_factory=dict)
    points: Mapping[str, UUID] = field(default_factory=dict)
    places_by_dhid: Mapping[str, UUID] = field(default_factory=dict)
    points_by_dhid: Mapping[str, UUID] = field(default_factory=dict)


def assign_canonical_ids(model: StopModel, source_id: str, known: KnownIds) -> None:
    """Keep ids already mapped in ``id_map`` or found by DHID; compute UUIDv5 for new stops."""
    for place in model.places.values():
        place.canonical = (
            known.places.get(place.key)
            or (known.places_by_dhid.get(place.dhid) if place.dhid else None)
            or canonical_id(
                "stop_place", natural_key(source_id, place.key, place.dhid, place.ifopt)
            )
        )
    for point in model.points.values():
        point.canonical = (
            known.points.get(point.key)
            or (known.points_by_dhid.get(point.dhid) if point.dhid else None)
            or canonical_id(
                "stop_point", natural_key(source_id, point.key, point.dhid, point.ifopt)
            )
        )
