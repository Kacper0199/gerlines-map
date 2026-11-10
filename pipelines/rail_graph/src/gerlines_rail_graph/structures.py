"""Bridge and tunnel spans along a shape, from the OSM tags of the track it runs on.

A sample every 10 m takes the flags of its nearest track piece within 10 m; only samples within
10 m of some bridge or tunnel piece are looked up, so most of a shape costs one cheap query.
"""

from pathlib import Path

import numpy as np
import shapely
from shapely import LineString, STRtree

from gerlines_rail_graph.evaluate import ON_RAIL_M, SAMPLE_STEP_M, RailIndex
from gerlines_rail_graph.metrics import sample_points
from gerlines_rail_graph.shape import runs_to_spans

STRUCTURES_FILE = "way_structures.npz"


class StructureIndex:
    """Bridge and tunnel flags per track piece of a ``RailIndex``."""

    def __init__(
        self, index: RailIndex, way_ids: np.ndarray, bridge: np.ndarray, tunnel: np.ndarray
    ) -> None:
        if index.piece_way is None:
            msg = "the rail index has no way id per piece"
            raise ValueError(msg)
        order = np.argsort(way_ids)
        sorted_ids = way_ids[order]
        pos = np.clip(np.searchsorted(sorted_ids, index.piece_way), 0, max(len(sorted_ids) - 1, 0))
        known = sorted_ids[pos] == index.piece_way if len(sorted_ids) else np.zeros(0, dtype=bool)
        self.bridge = np.zeros(len(index.piece_way), dtype=bool)
        self.tunnel = np.zeros(len(index.piece_way), dtype=bool)
        self.bridge[known] = bridge[order][pos[known]]
        self.tunnel[known] = tunnel[order][pos[known]]
        self.index = index
        flagged = np.flatnonzero(self.bridge | self.tunnel)
        geometries = np.asarray(index.tree.geometries)
        self._flagged_tree = STRtree(geometries[flagged]) if len(flagged) else None

    @classmethod
    def load(cls, index: RailIndex, osm_dir: Path) -> "StructureIndex":
        with np.load(osm_dir / STRUCTURES_FILE) as data:
            return cls(index, data["way_ids"], data["bridge"], data["tunnel"])

    def spans(self, xy: np.ndarray) -> tuple[list[tuple], list[tuple]]:
        """(tunnels, bridges) as projected arc ranges along the line ``xy``."""
        line = LineString(xy)
        if self._flagged_tree is None or line.length == 0:
            return [], []
        points = sample_points(line, SAMPLE_STEP_M)
        piece = line.length / len(points)
        near, _ = self._flagged_tree.query(
            shapely.points(points), predicate="dwithin", distance=ON_RAIL_M
        )
        candidates = np.unique(near)
        tunnel = np.zeros(len(points), dtype=bool)
        bridge = np.zeros(len(points), dtype=bool)
        if len(candidates):
            (src, dst) = self.index.tree.query_nearest(
                shapely.points(points[candidates]), max_distance=ON_RAIL_M, all_matches=False
            )
            hit = candidates[src]
            tunnel[hit] = self.tunnel[dst]
            bridge[hit] = self.bridge[dst]
        return runs_to_spans(tunnel, piece), runs_to_spans(bridge, piece)
