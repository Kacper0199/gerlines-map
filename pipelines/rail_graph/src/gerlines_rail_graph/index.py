"""Loading the rail index (tracks, classes, routing graph, coverage) from the OSM caches."""

from itertools import pairwise
from pathlib import Path

import numpy as np
import shapely

from gerlines_rail_graph.evaluate import RailIndex
from gerlines_rail_graph.graph import RailGraph
from gerlines_rail_graph.osm import RailWays, way_class
from gerlines_rail_graph.project import to_xy

ROUTABLE = ("rail", "light_rail", "narrow_gauge")
COVERAGE_INSET_M = 2000.0


def load_coverage(outline: Path, inset_m: float = COVERAGE_INSET_M, extra: Path | None = None):
    """Germany's outline in EPSG:25832, joined with the ``extra`` area (the part of the neighbours'
    corridor whose track the OSM caches hold, ``held.geojson`` of ``neighbours``), then
    shrunk by ``inset_m`` so places near the edge of the track data do not count. Every feature
    of both files counts."""
    from gerlines_rail_graph.neighbours import read_polygon  # noqa: PLC0415

    paths = [outline] if extra is None else [outline, extra]
    geo = shapely.union_all([read_polygon(p) for p in paths])
    coords = shapely.get_coordinates(geo)
    projected = shapely.set_coordinates(geo, to_xy(coords[:, 0], coords[:, 1]))
    return projected.buffer(-inset_m)


def way_classes(osm_dir: Path, ways: RailWays) -> np.ndarray:
    """``WayClass`` of every track way from the route-relation bits of ``way_kinds.npz``."""
    with np.load(osm_dir / "way_kinds.npz") as data:
        bits = dict(zip(data["way_ids"].tolist(), data["bits"].tolist(), strict=True))
    return np.array(
        [
            way_class(
                {k for k, b in (("sbahn", 1), ("main", 2)) if bits.get(int(w), 0) & b},
                str(r),
            )
            for w, r in zip(ways.way_ids, ways.railway, strict=True)
        ]
    )


PIECE_VERTICES = 8


def way_pieces(
    offsets: np.ndarray, size: int = PIECE_VERTICES
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Short overlapping pieces of every way: point indices, piece id per point, way per piece.

    Pieces of at most ``size`` points share their end points, so together they cover each way
    exactly; short pieces keep the bounding boxes of the search tree tight.
    """
    points: list[np.ndarray] = []
    owner: list[int] = []
    step = size - 1
    for way, (start, end) in enumerate(pairwise(offsets)):
        for first in range(int(start), int(end) - 1, step):
            points.append(np.arange(first, min(first + size, int(end))))
            owner.append(way)
    piece_of_point = np.repeat(np.arange(len(points)), [len(p) for p in points])
    return np.concatenate(points), piece_of_point, np.array(owner, dtype=np.int64)


def load_rail_index(
    osm_dir: Path, outline: Path, coverage: Path | None = None
) -> tuple[RailIndex, int]:
    """The rail index and the number of graph nodes before contraction."""
    ways = RailWays.load(osm_dir / "ways.npz")
    way_class_of = way_classes(osm_dir, ways)
    point_idx, piece_of_point, piece_way = way_pieces(ways.offsets)
    lines = shapely.linestrings(ways.xy[point_idx], indices=piece_of_point)
    classes = way_class_of[piece_way]
    routable = np.isin(ways.railway, ROUTABLE)
    starts = ways.offsets[:-1][routable]
    ends = ways.offsets[1:][routable]
    point_idx = np.concatenate([np.arange(s, e) for s, e in zip(starts, ends, strict=True)])
    unique_nodes, first, inverse = np.unique(
        ways.node_ids[point_idx], return_index=True, return_inverse=True
    )
    node_of_point = np.full(len(ways.node_ids), -1, dtype=np.int64)
    node_of_point[point_idx] = inverse
    edge_from = np.concatenate([np.arange(s, e - 1) for s, e in zip(starts, ends, strict=True)])
    edges = np.column_stack([node_of_point[edge_from], node_of_point[edge_from + 1]])
    graph = RailGraph.from_arrays(ways.xy[point_idx][first], edges)
    index = RailIndex.build(
        list(lines), classes, graph, load_coverage(outline, extra=coverage), ways.way_ids[piece_way]
    )
    return index, len(unique_nodes)
