"""Neighbouring countries' rail OSM for cross-border shapes.

``corridor`` draws the area beyond the border that the cross-border legs of a feed run through,
``filter_rail`` keeps what MOTIS, pfaedle and the rail graph read from a region's extract,
``clip_to_corridor`` cuts that to the corridor, ``held_area`` is the part of the corridor the
downloaded regions hold (the area that can be measured), and ``merge_osm`` lays the clipped
regions over a German extract, so one file holds Germany and the corridor.

The neighbours' filter is a superset of the German rail extract's (``extract_rail.py``): the same
track and platform ways, but every ``railway`` node (switches, signals, crossings) and the rail
route and stop area relations as well, since pfaedle reads them from the full German extract.
"""

import hashlib
import json
import tempfile
from collections.abc import Iterable, Sequence
from itertools import pairwise
from pathlib import Path

import numpy as np
import osmium
import shapely
from shapely.geometry import mapping, shape

from gerlines_rail_graph.patterns import Pattern
from gerlines_rail_graph.project import to_lonlat, to_xy

TRACK_VALUES = frozenset(
    {"rail", "light_rail", "subway", "tram", "narrow_gauge", "funicular", "monorail"}
)
PLATFORM_VALUES = frozenset({"platform", "platform_edge"})
STOP_NODE_PT = frozenset({"station", "stop_position", "platform"})
RAIL_ROUTES = frozenset({"train", "light_rail", "subway", "tram", "railway", "tracks"})
SIMPLIFY_M = 500.0
CHUNK = 1_000_000
FILTER_VERSION = 2


def _projected(geometry):
    coords = shapely.get_coordinates(geometry)
    return shapely.set_coordinates(geometry, to_xy(coords[:, 0], coords[:, 1]))


def _geographic(geometry):
    coords = shapely.get_coordinates(geometry)
    return shapely.set_coordinates(geometry, to_lonlat(coords))


def read_polygon(path: Path):
    """The union of every feature of a GeoJSON file, in WGS84."""
    features = json.loads(path.read_text())["features"]
    return shapely.union_all([shape(f["geometry"]) for f in features])


def write_polygon(path: Path, geometry, properties: dict | None = None) -> None:
    feature = {"type": "Feature", "properties": properties or {}, "geometry": mapping(geometry)}
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [feature]}))


def corridor(  # noqa: PLR0913
    patterns: Iterable[Pattern],
    outline: Path,
    *,
    cap_km: float,
    share: float,
    min_km: float,
    max_km: float,
):
    """The area beyond Germany that the legs leaving it run through, in WGS84.

    Each stop-to-stop leg not wholly inside ``outline`` is cut to ``cap_km`` beyond the border
    and buffered by ``share`` of its length, at least ``min_km`` and at most ``max_km``, since
    the track between two far stops strays further from their straight line.
    """
    germany = _projected(read_polygon(outline))
    zone = germany.buffer(cap_km * 1000.0)
    pieces = []
    for pattern in patterns:
        lonlat = pattern.stop_lonlat()
        xy = to_xy(lonlat[:, 0], lonlat[:, 1])
        for a, b in pairwise(xy):
            leg = shapely.LineString([a, b])
            if leg.length == 0 or leg.within(germany):
                continue
            part = leg.intersection(zone)
            if part.is_empty:
                continue
            width = min(max(share * leg.length, min_km * 1000.0), max_km * 1000.0)
            pieces.append(part.buffer(width))
    if not pieces:
        return shapely.Polygon()
    area = shapely.union_all(pieces).simplify(SIMPLIFY_M)
    return _geographic(area)


def keep_rail(obj) -> bool:
    """Tracks, platforms, railway and stop nodes, rail route and stop area relations."""
    tags = obj.tags
    railway = tags.get("railway")
    public_transport = tags.get("public_transport")
    if obj.is_way():
        return (
            railway in TRACK_VALUES or railway in PLATFORM_VALUES or public_transport == "platform"
        )
    if obj.is_node():
        return railway is not None or public_transport in STOP_NODE_PT
    if obj.is_relation():
        kind = tags.get("type")
        if kind == "route":
            return tags.get("route") in RAIL_ROUTES
        if kind == "multipolygon":
            return railway == "platform" or public_transport == "platform"
        return public_transport == "stop_area"
    return False


def filter_rail(source: Path, target: Path) -> Path:
    """``source`` reduced to ``keep_rail`` objects and the nodes and members they reference, each
    with its tags (a referenced node keeps ``railway=switch`` or ``highway=level_crossing``)."""
    processor = osmium.FileProcessor(str(source)).with_filter(
        osmium.filter.KeyFilter("railway", "public_transport", "type")
    )
    with osmium.BackReferenceWriter(
        str(target), ref_src=str(source), overwrite=True, remove_tags=False
    ) as writer:
        for obj in processor:
            if keep_rail(obj):
                writer.add(obj)
    return target


def clip_to_corridor(source: Path, target: Path, area) -> Path:
    """Ways with a node inside ``area`` (whole, with all their nodes), tagged nodes inside it,
    and every relation with a member kept, with its full member list (members outside stay as
    dangling references, as in any Geofabrik extract); ``area`` is in WGS84."""
    inside, nodes = _nodes_inside(source, area)
    ways = osmium.index.IdSet()
    for w in osmium.FileProcessor(str(source), osmium.osm.WAY):
        refs = [n.ref for n in w.nodes]
        if any(inside.get(r) for r in refs):
            ways.set(w.id)
            for r in refs:
                nodes.set(r)
    relations = osmium.index.IdSet()
    for r in osmium.FileProcessor(str(source), osmium.osm.RELATION):
        if any(
            (m.type == "n" and nodes.get(m.ref)) or (m.type == "w" and ways.get(m.ref))
            for m in r.members
        ):
            relations.set(r.id)
    kept = {"n": nodes, "w": ways, "r": relations}
    with osmium.SimpleWriter(str(target), overwrite=True) as writer:
        for obj in osmium.FileProcessor(str(source)):
            if kept[obj.type_str()].get(obj.id):
                writer.add(obj)
    return target


def _nodes_inside(source: Path, area) -> tuple[osmium.index.IdSet, osmium.index.IdSet]:
    """Ids of the nodes inside ``area``, and of the tagged ones among them, read in chunks."""
    shapely.prepare(area)
    inside = osmium.index.IdSet()
    tagged_inside = osmium.index.IdSet()

    def flush(ids, lon, lat, tagged) -> None:
        chunk_ids, chunk_inside, chunk_tagged = _inside_chunk(area, ids, lon, lat, tagged)
        for i in chunk_ids[chunk_inside].tolist():
            inside.set(i)
        for i in chunk_ids[chunk_inside & chunk_tagged].tolist():
            tagged_inside.set(i)

    ids, lon, lat, tagged = [], [], [], []
    for n in osmium.FileProcessor(str(source), osmium.osm.NODE):
        if not n.location.valid():
            continue
        ids.append(n.id)
        lon.append(n.location.lon)
        lat.append(n.location.lat)
        tagged.append(len(n.tags) > 0)
        if len(ids) >= CHUNK:
            flush(ids, lon, lat, tagged)
            ids, lon, lat, tagged = [], [], [], []
    flush(ids, lon, lat, tagged)
    return inside, tagged_inside


def _inside_chunk(area, ids, lon, lat, tagged):
    id_arr = np.array(ids, dtype=np.int64)
    inside = shapely.contains_xy(area, np.array(lon, dtype=float), np.array(lat, dtype=float))
    return id_arr, np.asarray(inside, dtype=bool), np.array(tagged, dtype=bool)


def region_polygons(regions: Iterable[str], index: Path) -> dict:
    """WGS84 polygon per Geofabrik region id of ``index-v1.json``; an unknown id is an error."""
    wanted = set(regions)
    polygons = {
        f["properties"]["id"]: shape(f["geometry"])
        for f in json.loads(index.read_text())["features"]
        if f["properties"]["id"] in wanted
    }
    missing = sorted(wanted - set(polygons))
    if missing:
        msg = f"regions not in {index}: {', '.join(missing)}"
        raise ValueError(msg)
    return polygons


def held_area(area, regions: Iterable[str], index: Path):
    """The part of ``area`` that the Geofabrik ``regions`` (ids of ``index-v1.json``) hold, in
    WGS84: beyond it the caches have no track, so nothing there can be measured."""
    return shapely.intersection(
        area, shapely.union_all(list(region_polygons(regions, index).values()))
    )


_KINDS = (("n", osmium.osm.NODE), ("w", osmium.osm.WAY), ("r", osmium.osm.RELATION))


def _versions(path: Path) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Per object type the ids, versions and member counts (relations) of one file."""
    out = {}
    for kind, entity in _KINDS:
        ids, versions, sizes = [], [], []
        for obj in osmium.FileProcessor(str(path), entity):
            ids.append(obj.id)
            versions.append(obj.version)
            sizes.append(len(obj.members) if kind == "r" else 0)
        out[kind] = (
            np.array(ids, dtype=np.int64),
            np.array(versions, dtype=np.int64),
            np.array(sizes, dtype=np.int64),
        )
    return out


def _base_versions(base: Path, ids: dict[str, np.ndarray]) -> dict[str, dict[int, int]]:
    """Versions in ``base`` of the objects whose ids are given, read through an id filter."""
    wanted = {kind: set(values.tolist()) for kind, values in ids.items()}
    every = set().union(*wanted.values())
    found: dict[str, dict[int, int]] = {kind: {} for kind, _ in _KINDS}
    if not every:
        return found
    for obj in osmium.FileProcessor(str(base)).with_filter(osmium.filter.IdFilter(every)):
        kind = obj.type_str()
        if obj.id in wanted[kind]:
            found[kind][obj.id] = obj.version
    return found


def winners(
    base: Path, additions: Sequence[Path]
) -> tuple[list[dict[str, osmium.index.IdSet]], dict[str, int]]:
    """Which copy of each object an addition contributes: an addition's object wins only with a
    higher version than the base's (the base wins a tie, so a complete German relation is never
    replaced by a copy of the same version); among additions the higher version wins, then the
    copy with more relation members, then the earlier file."""
    tables = [_versions(path) for path in additions]
    ids = {
        kind: np.unique(np.concatenate([t[kind][0] for t in tables]))
        if tables
        else np.zeros(0, np.int64)
        for kind, _ in _KINDS
    }
    in_base = _base_versions(base, ids)
    picks: list[dict[str, osmium.index.IdSet]] = [
        {kind: osmium.index.IdSet() for kind, _ in _KINDS} for _ in additions
    ]
    counts = {"added": 0, "replaced": 0, "base_kept": 0}
    for kind, _ in _KINDS:
        best: dict[int, tuple[int, int, int]] = {}
        for file_no, table in enumerate(tables):
            for i, version, size in zip(*(a.tolist() for a in table[kind]), strict=True):
                key = (version, size, -file_no)
                if i not in best or key > best[i]:
                    best[i] = key
        for i, (version, _, neg_file) in best.items():
            stored = in_base[kind].get(i)
            if stored is not None and version <= stored:
                counts["base_kept"] += 1
                continue
            counts["replaced" if stored is not None else "added"] += 1
            picks[-neg_file][kind].set(i)
    return picks, counts


def merge_osm(base: Path, additions: Sequence[Path], target: Path) -> dict[str, int]:
    """``base`` with ``additions`` laid over it, by ``winners``: an object of an addition enters
    only when the base lacks it or holds a lower version; equal versions keep the base's copy."""
    picks, counts = winners(base, additions)
    if target.exists():
        target.unlink()
    with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
        merger = osmium.MergeInputReader()
        for file_no, (path, pick) in enumerate(zip(additions, picks, strict=True)):
            piece = Path(tmp) / f"piece-{file_no}.osm.pbf"
            with osmium.SimpleWriter(str(piece), overwrite=True) as writer:
                for obj in osmium.FileProcessor(str(path)):
                    if pick[obj.type_str()].get(obj.id):
                        writer.add(obj)
            merger.add_file(str(piece))
        reader = osmium.io.Reader(str(base))
        writer = osmium.io.Writer(str(target))
        try:
            merger.apply_to_reader(reader, writer, with_history=False)
        finally:
            writer.close()
            reader.close()
    return counts


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def area_km2(geometry) -> float:
    """Area of a WGS84 geometry in square kilometres, measured in EPSG:25832."""
    return 0.0 if geometry.is_empty else _projected(geometry).area / 1e6
