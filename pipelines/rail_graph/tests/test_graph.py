import heapq

import numpy as np
import pytest

from gerlines_rail_graph.graph import MAX_TURN_DEG, RailGraph


def ladder() -> RailGraph:
    """Two parallel tracks 10 m apart from x=0 to x=3000, a crossover from the lower track at
    x=900 to the upper track at x=1100 (both in the +x direction), and a spur leaving the upper
    track at x=1500 towards (2500, 300)."""
    node_xy = {
        1: (0.0, 0.0),
        2: (900.0, 0.0),
        3: (2000.0, 0.0),
        4: (3000.0, 0.0),
        11: (0.0, 10.0),
        12: (1100.0, 10.0),
        14: (1500.0, 10.0),
        13: (3000.0, 10.0),
        20: (2500.0, 300.0),
    }
    ways = [[1, 2, 3, 4], [11, 12, 14, 13], [2, 12], [14, 20]]
    return RailGraph.build(ways, node_xy)


def test_the_path_runs_along_the_track_between_the_projections_of_the_points():
    graph = ladder()

    assert graph.path_length((5.0, -3.0), (2995.0, 2.0)) == pytest.approx(2990.0)


def test_a_crossover_in_the_direction_of_travel_is_taken():
    graph = ladder()

    expected = 900 + np.hypot(200, 10) + (3000 - 1100)
    assert graph.path_length((0.0, 0.0), (3000.0, 10.0), max_snap_m=1.0) == pytest.approx(expected)


def test_a_path_never_reverses_at_a_switch():
    graph = ladder()

    assert graph.path_length((1500.0, 0.0), (1050.0, 10.0), max_snap_m=1.0) is None


def test_a_wye_lets_a_train_reach_the_other_branch_without_reversing():
    trunk = {1: (0.0, 0.0), 2: (1000.0, 0.0), 9: (1800.0, 0.0), 3: (2000.0, 0.0)}
    branch = {5: (1200.0, 100.0), 6: (1400.0, 400.0), 4: (1500.0, 1000.0)}
    chord = {7: (1650.0, 60.0), 8: (1500.0, 250.0)}
    xy = trunk | branch | chord
    no_wye = RailGraph.build([[1, 2, 9, 3], [2, 5, 6, 4]], xy)
    with_wye = RailGraph.build([[1, 2, 9, 3], [2, 5, 6, 4], [9, 7, 8, 6]], xy)

    assert no_wye.path_length((1900.0, 0.0), (1500.0, 1000.0), max_snap_m=1.0) is None
    expected = 100 + np.hypot(150, 60) + np.hypot(150, 190) + np.hypot(100, 150)
    assert with_wye.path_length((1900.0, 0.0), (1500.0, 1000.0), max_snap_m=1.0) == (
        pytest.approx(expected + np.hypot(100, 600))
    )


def test_a_level_crossing_of_two_lines_is_no_junction_to_turn_at():
    nodes = {
        1: (0.0, 0.0),
        2: (1000.0, 0.0),
        3: (2000.0, 0.0),
        4: (1000.0, -1000.0),
        5: (1000.0, 1000.0),
    }
    graph = RailGraph.build([[1, 2, 3], [4, 2, 5]], nodes)

    assert graph.path_length((0.0, 0.0), (2000.0, 0.0), max_snap_m=1.0) == pytest.approx(2000.0)
    assert graph.path_length((0.0, 0.0), (1000.0, 1000.0), max_snap_m=1.0) is None


def test_a_tunnel_with_few_nodes_is_found_under_dense_surface_tracks():
    xy = {1: (0.0, 0.0), 2: (4000.0, 0.0)}
    ways = [[1, 2]]
    for track in range(6):
        ids = [100 * (track + 1) + k for k in range(60)]
        for k, node in enumerate(ids):
            xy[node] = (1700.0 + 10.0 * k, 25.0 + 8.0 * track)
        ways.append(ids)
    graph = RailGraph.build(ways, xy)

    assert graph.path_length((2000.0, 3.0), (3000.0, -2.0)) == pytest.approx(1000.0)


def test_a_nearer_track_that_leads_nowhere_does_not_hide_the_through_track():
    nodes = {1: (0.0, 0.0), 4: (3000.0, 0.0), 11: (0.0, 8.0), 15: (400.0, 8.0)}
    graph = RailGraph.build([[1, 4], [11, 15]], nodes)

    assert graph.path_length((0.0, 7.0), (3000.0, 0.0)) == pytest.approx(3000.0)


def test_tracks_beyond_the_snap_slack_are_not_candidates():
    nodes = {1: (0.0, 0.0), 2: (3000.0, 0.0), 11: (0.0, 100.0), 12: (3000.0, 100.0)}
    graph = RailGraph.build([[1, 2], [11, 12]], nodes)

    assert len(graph.snaps((10.0, 2.0), 200.0)) == 1
    assert len(graph.snaps((10.0, 50.0), 200.0)) == 2


def y_junction() -> RailGraph:
    """A trunk along y=0 from x=0 to x=2000 and a branch leaving it at x=1000 towards the
    north-east, so going from the trunk's east end onto the branch needs a reversal at x=1000."""
    nodes = {
        1: (0.0, 0.0),
        2: (1000.0, 0.0),
        3: (2000.0, 0.0),
        5: (1200.0, 100.0),
        4: (1500.0, 1000.0),
    }
    return RailGraph.build([[1, 2, 3], [2, 5, 4]], nodes)


def test_a_path_may_reverse_at_a_station_junction_only_when_reversals_are_asked_for():
    near = y_junction().with_stations(np.array([[1100.0, 50.0]]))
    far = y_junction().with_stations(np.array([[5000.0, 5000.0]]))
    exact = {"max_snap_m": 1.0}

    expected = 1000 + np.hypot(200, 100) + np.hypot(300, 900)
    assert near.path_length((2000.0, 0.0), (1500.0, 1000.0), **exact) is None
    assert near.path_length(
        (2000.0, 0.0), (1500.0, 1000.0), reversals=True, **exact
    ) == pytest.approx(expected)
    assert far.path_length((2000.0, 0.0), (1500.0, 1000.0), reversals=True, **exact) is None


def test_only_junctions_within_the_station_radius_allow_a_reversal():
    nodes = {1: (0.0, 0.0), 2: (1000.0, 0.0), 3: (2000.0, 0.0), 9: (1300.0, 60.0)}
    graph = RailGraph.build([[1, 2, 3], [2, 9]], nodes)
    station = np.array([[1300.0, 60.0]])
    wide = graph.with_stations(station, radius_m=500.0)
    narrow = graph.with_stations(station, radius_m=100.0)
    exact = {"max_snap_m": 1.0, "reversals": True}

    assert wide.path_length((1650.0, 0.0), (1150.0, 30.0), **exact) == pytest.approx(
        650 + np.hypot(150, 30)
    )
    assert narrow.path_length((1650.0, 0.0), (1150.0, 30.0), **exact) is None


def test_a_wider_slack_lets_a_stop_start_from_a_farther_track():
    nodes = {1: (0.0, 0.0), 2: (3000.0, 0.0), 11: (0.0, 100.0), 12: (3000.0, 100.0)}
    graph = RailGraph.build([[1, 2], [11, 12]], nodes)

    assert graph.path_length((10.0, 10.0), (2990.0, 100.0)) is None
    assert graph.path_length((10.0, 10.0), (2990.0, 100.0), slack_m=200.0) == pytest.approx(2980.0)


def test_no_path_when_a_point_is_beyond_the_snap_distance():
    graph = ladder()

    assert graph.path_length((0.0, 0.0), (5000.0, 5000.0), max_snap_m=200.0) is None


def test_no_path_when_the_detour_exceeds_the_search_limit():
    nodes = {1: (0.0, 0.0), 2: (1000.0, 0.0), 3: (1300.0, 400.0)}
    graph = RailGraph.build([[1, 2, 3]], nodes)

    exact = {"max_snap_m": 1.0}
    assert (
        graph.path_length((0.0, 0.0), (1300.0, 400.0), limit_factor=1.0, limit_extra_m=0.0, **exact)
        is None
    )
    assert graph.path_length((0.0, 0.0), (1300.0, 400.0), **exact) == pytest.approx(1500.0)


def test_disconnected_components_give_no_path():
    graph = RailGraph.build([[1, 2], [3, 4]], {1: (0, 0), 2: (100, 0), 3: (200, 0), 4: (300, 0)})

    assert graph.path_length((0.0, 0.0), (300.0, 0.0), max_snap_m=10.0) is None


def test_a_ring_without_junctions_is_routable_both_ways_round():
    angles = np.linspace(0, 2 * np.pi, 73)[:-1]
    ring = {k: (1000 * np.cos(a), 1000 * np.sin(a)) for k, a in enumerate(angles)}
    graph = RailGraph.build([[*range(72), 0]], ring)

    quarter = graph.path_length(ring[0], ring[18], max_snap_m=1.0)
    assert quarter == pytest.approx(18 * np.hypot(*np.subtract(ring[0], ring[1])))
    assert graph.path_length(ring[18], ring[0], max_snap_m=1.0) == pytest.approx(quarter)


def test_node_count_and_edges_are_exposed_for_reporting():
    graph = ladder()

    assert graph.node_count == 9
    assert graph.edge_count == 8
    assert graph.total_length_m == pytest.approx(
        3000 + 3000 + np.hypot(200, 10) + np.hypot(1000, 290)
    )


def random_network(seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Nodes on a jittered 400 m grid, each joined to its two nearest neighbours."""
    rng = np.random.default_rng(seed)
    grid = np.stack(np.meshgrid(np.arange(12), np.arange(10)), axis=-1).reshape(-1, 2) * 400.0
    xy = grid + rng.uniform(-150, 150, size=grid.shape)
    tree = __import__("scipy.spatial", fromlist=["cKDTree"]).cKDTree(xy)
    _, near = tree.query(xy, k=3)
    edges = np.array([(i, j) for i, row in enumerate(near) for j in row[1:]])
    return xy, edges


def turn_restricted_dijkstra(xy: np.ndarray, edges: np.ndarray, a: int, b: int) -> float:
    """Plain search over directed node-to-node edges; at a node of degree other than two the
    next edge must leave within the turn limit of the arriving direction, at degree two any."""
    neighbours: dict[int, set[int]] = {}
    for u, v in edges:
        if u != v:
            neighbours.setdefault(int(u), set()).add(int(v))
            neighbours.setdefault(int(v), set()).add(int(u))
    if a == b:
        return 0.0
    cos_limit = np.cos(np.radians(MAX_TURN_DEG))

    def unit(u: int, v: int) -> np.ndarray:
        d = xy[v] - xy[u]
        return d / np.hypot(*d)

    def length(u: int, v: int) -> float:
        return float(np.hypot(*(xy[v] - xy[u])))

    heap = [(length(a, v), a, v) for v in neighbours.get(a, ())]
    heapq.heapify(heap)
    done: set[tuple[int, int]] = set()
    while heap:
        g, u, v = heapq.heappop(heap)
        if v == b:
            return g
        if (u, v) in done:
            continue
        done.add((u, v))
        for w in neighbours[v]:
            if w == u:
                continue
            if len(neighbours[v]) != 2 and unit(u, v) @ unit(v, w) < cos_limit:
                continue
            heapq.heappush(heap, (g + length(v, w), v, w))
    return np.inf


@pytest.mark.parametrize("seed", [3, 7, 11])
def test_contracted_search_matches_a_turn_restricted_search_on_random_networks(seed):
    xy, edges = random_network(seed)
    graph = RailGraph.from_arrays(xy, edges)
    lengths = np.hypot(*(xy[edges[:, 0]] - xy[edges[:, 1]]).T)
    assert lengths.min() > 20.0
    rng = np.random.default_rng(seed + 100)
    for a, b in rng.integers(0, len(xy), size=(40, 2)):
        if a == b:
            continue
        expected = turn_restricted_dijkstra(xy, edges, int(a), int(b))
        got = graph.path_length(tuple(xy[a]), tuple(xy[b]), limit_factor=100.0, max_snap_m=0.01)
        if np.isfinite(expected):
            assert got == pytest.approx(expected)
        else:
            assert got is None


@pytest.mark.parametrize("seed", [5, 9])
def test_paths_are_symmetric_and_never_shorter_than_the_straight_line(seed):
    xy, edges = random_network(seed)
    graph = RailGraph.from_arrays(xy, edges)
    rng = np.random.default_rng(seed)
    for a, b in rng.uniform(0, 5000, size=(30, 2, 2)):
        there = graph.path_length(tuple(a), tuple(b), max_snap_m=300.0, limit_factor=100.0)
        back = graph.path_length(tuple(b), tuple(a), max_snap_m=300.0, limit_factor=100.0)
        assert (there is None) == (back is None)
        if there is not None:
            assert there == pytest.approx(back)
            assert there >= np.hypot(*(a - b)) - 2 * 300.0
