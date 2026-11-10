import numpy as np
import pytest

from gerlines_rail_graph.osm import RailWays
from gerlines_rail_graph.stubs import MIN_STUB_M, SNAP_GAP_M, STUB_M, TrackWalker, end_stubs

ORIGIN = np.array([500_000.0, 5_550_000.0])


def ways(*lines, railway="rail") -> RailWays:
    """Ways from local metre polylines; each vertex is (x, y, node id)."""
    offsets, nodes, xy = [0], [], []
    for line in lines:
        for x, y, node in line:
            nodes.append(node)
            xy.append([x, y])
        offsets.append(len(nodes))
    n = len(lines)
    return RailWays(
        way_ids=np.arange(1, n + 1, dtype=np.int64),
        railway=np.array([railway] * n),
        service=np.array([""] * n),
        offsets=np.array(offsets, dtype=np.int64),
        node_ids=np.array(nodes, dtype=np.int64),
        xy=np.asarray(xy, dtype=float) + ORIGIN,
    )


SHAPE = np.array([[0.0, 0.0], [1_000.0, 0.0], [2_000.0, 0.0]]) + ORIGIN


def test_a_track_behind_the_first_stop_gives_a_stub_of_the_longest_consist():
    walker = TrackWalker(ways([(-2_000, 0, 1), (0, 0, 2), (2_000, 0, 3)]))

    before, after = end_stubs(walker, SHAPE)

    assert before.length_m == pytest.approx(STUB_M)
    assert before.xy[0] == pytest.approx(SHAPE[0])
    assert before.xy[-1] == pytest.approx(ORIGIN + np.array([-STUB_M, 0.0]))
    assert np.all(np.diff(before.xy[:, 0]) <= 0)
    assert before.dist[-1] == pytest.approx(STUB_M)
    assert after.length_m == pytest.approx(0.0)


def test_a_stub_ends_at_the_buffer_stop():
    walker = TrackWalker(ways([(-150, 0.5, 1), (2_000, 0.5, 2)]))

    before, _ = end_stubs(walker, SHAPE)

    assert before.length_m == pytest.approx(150.5, abs=0.1)
    assert before.end == "buffer"


@pytest.mark.parametrize("offset", [3.0, 12.9])
def test_a_track_beside_the_end_vertex_gives_no_stub_rather_than_a_sideways_jump(offset):
    walker = TrackWalker(ways([(-2_000, offset, 1), (2_000, offset, 2)]))

    before, after = end_stubs(walker, SHAPE)

    assert offset > SNAP_GAP_M
    assert (before.end, after.end) == ("no_track", "no_track")
    assert len(before.xy) == 1


@pytest.mark.parametrize("track_end", [0.0, -0.4, -(MIN_STUB_M - 1)])
def test_a_stub_shorter_than_the_minimum_is_no_track(track_end):
    walker = TrackWalker(ways([(track_end, 0.3, 1), (2_000, 0.3, 2)]))

    before, _ = end_stubs(walker, SHAPE)

    assert before.end == "no_track"
    assert before.length_m == 0.0


def test_a_stub_starts_on_the_end_vertex_when_it_lies_on_the_track():
    walker = TrackWalker(ways([(-2_000, 0, 1), (2_000, 0, 2)]))

    before, _ = end_stubs(walker, SHAPE)

    assert np.all(np.diff(before.dist) > 0)
    assert before.xy[1] == pytest.approx(ORIGIN + np.array([-STUB_M, 0.0]))


def test_at_a_switch_the_stub_takes_the_straight_track():
    straight = [(0, 0, 1), (-200, 0, 2), (-1_000, 0, 3)]
    diverging = [(-200, 0, 2), (-800, -200, 4)]
    walker = TrackWalker(ways(straight, diverging))

    before, _ = end_stubs(walker, SHAPE)

    assert before.length_m == pytest.approx(STUB_M)
    assert np.allclose(before.xy[:, 1], ORIGIN[1], atol=1e-6)


def test_a_stub_never_turns_onto_a_crossing_track():
    track = [(0, 0, 1), (-100, 0, 2)]
    crossing = [(-100, -500, 3), (-100, 0, 2), (-100, 500, 4)]
    walker = TrackWalker(ways(track, crossing))

    before, _ = end_stubs(walker, SHAPE)

    assert before.length_m == pytest.approx(100.0)
    assert before.end == "no_continuation"


@pytest.mark.parametrize(
    "track",
    [
        [(-2_000, 40, 1), (2_000, 40, 2)],
        [(0, -2_000, 1), (0, 2_000, 2)],
    ],
)
def test_no_stub_without_an_aligned_track_near_the_end(track):
    walker = TrackWalker(ways(track))

    before, _ = end_stubs(walker, SHAPE)

    assert before.length_m == 0.0
    assert before.end == "no_track"
    assert len(before.xy) == 1


def test_a_tram_track_gives_no_stub():
    walker = TrackWalker(ways([(-2_000, 0, 1), (2_000, 0, 2)], railway="tram"))

    before, _ = end_stubs(walker, SHAPE)

    assert before.end == "no_track"


def test_the_stub_after_the_last_stop_runs_on_in_the_direction_of_travel():
    walker = TrackWalker(ways([(0, 0, 1), (3_000, 0, 2)]))

    _, after = end_stubs(walker, SHAPE)

    assert after.length_m == pytest.approx(STUB_M)
    assert after.xy[-1] == pytest.approx(ORIGIN + np.array([2_000 + STUB_M, 0.0]))


def test_stub_rows_are_one_per_track_shape_hash_with_the_end_height():
    from gerlines_rail_graph.project import to_lonlat  # noqa: PLC0415
    from gerlines_rail_graph.stubs import stub_rows  # noqa: PLC0415

    walker = TrackWalker(ways([(-2_000, 0, 1), (3_000, 0, 2)]))
    lonlat = to_lonlat(SHAPE)
    coords = np.column_stack([lonlat, [12.5, 13.0, 14.0], [0.0, 1_000.0, 2_000.0]])
    metas = [
        {"pattern_id": "a", "shape_hash": "h1", "method": "motis"},
        {"pattern_id": "b", "shape_hash": "h1", "method": "motis"},
        {"pattern_id": "c", "shape_hash": "h2", "method": "straight"},
    ]

    rows, summary = stub_rows(metas, lambda _: coords, walker)

    assert [r["shape_hash"] for r in rows] == ["h1"]
    before, after = rows[0]["before"], rows[0]["after"]
    assert before["length_m"] == pytest.approx(STUB_M, abs=0.5)
    assert after["length_m"] == pytest.approx(STUB_M, abs=0.5)
    assert {p[2] for p in before["lonlatz"]} == {12.5}
    assert {p[2] for p in after["lonlatz"]} == {14.0}
    assert before["lonlatz"][0][:2] == pytest.approx(list(lonlat[0]), abs=1e-7)
    assert summary["shapes"] == 1
    assert summary["before"]["limit"] == 1


def test_stub_distances_are_geodesic_on_the_scale_of_m():
    from gerlines_rail_graph.project import geodesic_arc, to_lonlat  # noqa: PLC0415
    from gerlines_rail_graph.stubs import stub_rows  # noqa: PLC0415

    walker = TrackWalker(ways([(-2_000, 0, 1), (3_000, 0, 2)]))
    lonlat = to_lonlat(SHAPE)
    coords = np.column_stack([lonlat, [0.0, 0.0, 0.0], [0.0, 1_000.0, 2_000.0]])

    rows, _ = stub_rows(
        [{"pattern_id": "a", "shape_hash": "h", "method": "motis"}], lambda _: coords, walker
    )

    before = rows[0]["before"]
    ground = geodesic_arc(np.asarray(before["lonlatz"])[:, :2])
    assert before["dist"] == pytest.approx(list(ground), abs=0.01)
    assert before["length_m"] == pytest.approx(STUB_M / 0.9996, abs=0.02)


def test_stub_rows_keep_distances_strictly_growing_after_rounding():
    from gerlines_rail_graph.project import to_lonlat  # noqa: PLC0415
    from gerlines_rail_graph.stubs import stub_rows  # noqa: PLC0415

    near = [(0, 0, 1), (-100, 0, 2), (-100.003, 0, 3), (-2_000, 0, 4)]
    walker = TrackWalker(ways(near))
    coords = np.column_stack([to_lonlat(SHAPE), [0.0] * 3, [0.0, 1_000.0, 2_000.0]])

    rows, _ = stub_rows(
        [{"pattern_id": "a", "shape_hash": "h", "method": "motis"}], lambda _: coords, walker
    )

    before = rows[0]["before"]
    assert np.all(np.diff(before["dist"]) > 0)
    assert len(before["lonlatz"]) == len(before["dist"])


def test_a_walk_names_its_first_way_end_node_and_snap_gap():
    walker = TrackWalker(
        ways([(-500, 0, 7), (-150, 0.4, 8)], [(-150, 0.4, 8), (0, 0.4, 9), (2_000, 0.4, 10)])
    )

    stub = walker.walk(SHAPE[0], np.array([-1.0, 0.0]), 1_000.0, max_gap_m=2.0, min_m=0.0)

    assert (stub.end, stub.way_id, stub.end_node) == ("buffer", 2, 7)
    assert stub.gap_m == pytest.approx(0.4)


def test_a_walk_with_a_wider_gap_and_no_minimum_finds_a_buffer_just_ahead():
    walker = TrackWalker(ways([(-3, 1.5, 1), (2_000, 1.5, 2)]))

    near = walker.walk(
        SHAPE[0], np.array([-1.0, 0.0]), 150.0, max_gap_m=2.0, min_m=0.0, start_deg=None
    )
    default = walker.walk(SHAPE[0], np.array([-1.0, 0.0]), 150.0)

    assert (near.end, near.end_node) == ("buffer", 1)
    assert default.end == "no_track"


@pytest.mark.parametrize(("next_vertex", "end"), [(-0.6, "no_track"), (-2.5, "limit")])
def test_a_stub_leaves_the_end_vertex_along_the_heading_as_the_pack_check_requires(
    next_vertex, end
):
    walker = TrackWalker(ways([(10, 0.9, 1), (next_vertex, 0.9, 2), (-2_000, 0.9, 3)]))
    first_beyond = np.array([next_vertex, 0.9])
    off_heading = np.degrees(np.arctan2(0.9, -next_vertex))

    before, _ = end_stubs(walker, SHAPE)

    assert 0.9 < SNAP_GAP_M < np.hypot(*first_beyond)
    assert (off_heading > 30.0) == (end == "no_track")
    assert before.end == end
