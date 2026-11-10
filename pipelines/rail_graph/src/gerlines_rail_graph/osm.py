"""OSM rail ways and the passenger route classes of their route relations."""

import re
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import osmium

from gerlines_rail_graph.metrics import WayClass
from gerlines_rail_graph.project import to_xy

TRACK_VALUES = frozenset({"rail", "light_rail", "subway", "narrow_gauge", "tram"})
SBAHN_REF = re.compile(r"^S\s?\d")


def classify_route(tags: Mapping[str, str]) -> str | None:
    route = tags.get("route")
    if route == "light_rail":
        return "sbahn"
    if route != "train":
        return None
    if tags.get("service") == "commuter" or SBAHN_REF.match(tags.get("ref", "")):
        return "sbahn"
    return "main"


def way_class(kinds: set[str], railway: str) -> WayClass:
    if kinds == {"sbahn"}:
        return WayClass.SBAHN
    if kinds == {"main"}:
        return WayClass.MAIN
    if kinds:
        return WayClass.SHARED
    return WayClass.SBAHN if railway == "light_rail" else WayClass.UNTYPED


def route_kinds_by_way(pbf: Path) -> dict[int, set[str]]:
    """Per way id, the passenger route kinds of the route relations in ``pbf``."""
    kinds: dict[int, set[str]] = defaultdict(set)
    processor = osmium.FileProcessor(str(pbf), osmium.osm.RELATION).with_filter(
        osmium.filter.TagFilter(("type", "route"))
    )
    for relation in processor:
        kind = classify_route(relation.tags)
        if kind is None:
            continue
        for member in relation.members:
            if member.type == "w":
                kinds[member.ref].add(kind)
    return dict(kinds)


def route_kinds_by_way_in(pbfs: Iterable[Path]) -> dict[int, set[str]]:
    """``route_kinds_by_way`` over several extracts (Germany and its neighbours' corridor)."""
    kinds: dict[int, set[str]] = defaultdict(set)
    for pbf in pbfs:
        for way_id, found in route_kinds_by_way(pbf).items():
            kinds[way_id] |= found
    return dict(kinds)


def is_structure(value: str | None) -> bool:
    """A ``bridge`` or ``tunnel`` tag value that means the track is on or in one."""
    return value is not None and value not in {"", "no"}


def read_structures(pbf: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Way ids of track ways with their bridge and tunnel flags, from the rail extract."""
    ids: list[int] = []
    bridge: list[bool] = []
    tunnel: list[bool] = []
    processor = (
        osmium.FileProcessor(str(pbf))
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
        .with_filter(osmium.filter.KeyFilter("railway"))
    )
    for way in processor:
        if way.tags.get("railway") not in TRACK_VALUES:
            continue
        b, t = is_structure(way.tags.get("bridge")), is_structure(way.tags.get("tunnel"))
        if b or t:
            ids.append(way.id)
            bridge.append(b)
            tunnel.append(t)
    return (
        np.array(ids, dtype=np.int64),
        np.array(bridge, dtype=bool),
        np.array(tunnel, dtype=bool),
    )


@dataclass(frozen=True, slots=True)
class RailWays:
    way_ids: np.ndarray
    railway: np.ndarray
    service: np.ndarray
    offsets: np.ndarray
    node_ids: np.ndarray
    xy: np.ndarray

    def coords(self, i: int) -> np.ndarray:
        return self.xy[self.offsets[i] : self.offsets[i + 1]]

    def nodes(self, i: int) -> np.ndarray:
        return self.node_ids[self.offsets[i] : self.offsets[i + 1]]

    def __len__(self) -> int:
        return len(self.way_ids)

    def save(self, path: Path) -> None:
        np.savez_compressed(
            path,
            way_ids=self.way_ids,
            railway=self.railway,
            service=self.service,
            offsets=self.offsets,
            node_ids=self.node_ids,
            xy=self.xy,
        )

    @classmethod
    def load(cls, path: Path) -> "RailWays":
        with np.load(path, allow_pickle=False) as data:
            return cls(**{name: data[name] for name in data.files})


def read_rail_ways(pbf: Path) -> RailWays:
    way_ids: list[int] = []
    railway: list[str] = []
    service: list[str] = []
    offsets = [0]
    node_ids: list[int] = []
    lonlat: list[tuple[float, float]] = []
    processor = (
        osmium.FileProcessor(str(pbf))
        .with_locations()
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
        .with_filter(osmium.filter.KeyFilter("railway"))
    )
    for way in processor:
        value = way.tags.get("railway")
        if value not in TRACK_VALUES or len(way.nodes) < 2:
            continue
        refs = [(n.ref, n.lon, n.lat) for n in way.nodes if n.location.valid()]
        if len(refs) < 2:
            continue
        way_ids.append(way.id)
        railway.append(value)
        service.append(way.tags.get("service", ""))
        node_ids.extend(r[0] for r in refs)
        lonlat.extend((r[1], r[2]) for r in refs)
        offsets.append(len(node_ids))
    lonlat_arr = np.array(lonlat)
    return RailWays(
        way_ids=np.array(way_ids, dtype=np.int64),
        railway=np.array(railway),
        service=np.array(service),
        offsets=np.array(offsets, dtype=np.int64),
        node_ids=np.array(node_ids, dtype=np.int64),
        xy=to_xy(lonlat_arr[:, 0], lonlat_arr[:, 1]),
    )
