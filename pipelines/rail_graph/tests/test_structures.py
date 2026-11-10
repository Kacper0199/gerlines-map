import numpy as np
import pytest
from shapely import LineString, box

from gerlines_rail_graph.evaluate import RailIndex
from gerlines_rail_graph.graph import RailGraph
from gerlines_rail_graph.metrics import WayClass
from gerlines_rail_graph.osm import is_structure
from gerlines_rail_graph.structures import StructureIndex


def straight_index() -> RailIndex:
    """One straight track 0 to 3000 m in three pieces (ways 1, 2, 3) and a parallel way 4."""
    lines = [
        LineString([(0, 0), (1000, 0)]),
        LineString([(1000, 0), (1400, 0)]),
        LineString([(1400, 0), (3000, 0)]),
        LineString([(0, 40), (3000, 40)]),
    ]
    xy = np.array([[0.0, 0.0], [1000.0, 0.0], [1400.0, 0.0], [3000.0, 0.0]])
    graph = RailGraph.from_arrays(xy, np.array([[0, 1], [1, 2], [2, 3]]))
    return RailIndex.build(
        lines,
        np.full(4, WayClass.MAIN),
        graph,
        box(-10_000, -10_000, 10_000, 10_000),
        np.array([1, 2, 3, 4]),
    )


def test_a_shape_over_a_bridge_way_gets_one_bridge_span_at_its_arc_positions():
    structures = StructureIndex(
        straight_index(), np.array([2, 4]), np.array([True, False]), np.array([False, True])
    )

    tunnels, bridges = structures.spans(np.array([[0.0, 2.0], [3000.0, 2.0]]))

    assert tunnels == []
    assert len(bridges) == 1
    start, end = bridges[0]
    assert start == pytest.approx(1000, abs=10)
    assert end == pytest.approx(1400, abs=10)


def test_a_tunnel_on_a_parallel_track_beyond_10_m_does_not_count():
    structures = StructureIndex(
        straight_index(), np.array([4]), np.array([False]), np.array([True])
    )

    assert structures.spans(np.array([[0.0, 0.0], [3000.0, 0.0]])) == ([], [])


@pytest.mark.parametrize(
    ("value", "expected"),
    [("yes", True), ("viaduct", True), ("building_passage", True), ("no", False), (None, False)],
)
def test_structure_tag_values(value, expected):
    assert is_structure(value) is expected
