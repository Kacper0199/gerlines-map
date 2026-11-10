import numpy as np
import pytest
import shapely
from shapely import LineString

from gerlines_rail_graph.metrics import (
    WayClass,
    detour_ratio,
    forward_positions,
    long_edges,
    long_runs,
    off_relation_mask,
    quantiles,
    sample_points,
    stop_arc_distances,
    stop_distances,
)


def test_quantiles_report_p50_p95_max_and_count():
    result = quantiles(np.arange(1, 101, dtype=float))

    assert result == {
        "n": 100,
        "p50": pytest.approx(50.5),
        "p95": pytest.approx(95.05),
        "max": 100.0,
    }


def test_quantiles_of_nothing_are_missing_not_zero():
    assert quantiles(np.array([])) == {"n": 0, "p50": None, "p95": None, "max": None}


def test_stop_distance_is_the_perpendicular_distance_to_the_shape():
    line = LineString([(0, 0), (1000, 0)])

    distances = stop_distances(line, np.array([[500.0, 30.0], [1000.0, -4.0], [1100.0, 0.0]]))

    assert distances == pytest.approx([30.0, 4.0, 100.0])


def test_samples_cover_the_line_at_a_fixed_step_from_the_middle_of_each_piece():
    line = LineString([(0, 0), (100, 0)])

    points = sample_points(line, step=20.0)

    assert points[:, 0] == pytest.approx([10, 30, 50, 70, 90])
    assert points[:, 1] == pytest.approx([0, 0, 0, 0, 0])


def test_samples_match_geos_interpolation_on_a_bent_line_with_repeated_points():
    line = LineString([(0, 0), (30, 0), (30, 0), (30, 47), (-12, 80), (-12, 80.5)])

    points = sample_points(line, step=7.0)

    count = int(line.length // 7.0)
    offsets = (np.arange(count) + 0.5) * line.length / count
    expected = shapely.get_coordinates(shapely.line_interpolate_point(line, offsets))
    assert points == pytest.approx(expected)


def test_a_line_shorter_than_one_step_still_gives_its_midpoint():
    points = sample_points(LineString([(0, 0), (6, 0)]), step=20.0)

    assert points.tolist() == [[3.0, 0.0]]


def test_long_edges_are_the_single_edges_of_at_least_the_limit_with_their_midpoints():
    line = LineString([(0, 0), (1500, 0), (1600, 0), (1700, 100), (1700, 2100)])

    midpoints, lengths = long_edges(line, min_edge_m=1000.0)

    assert lengths == pytest.approx([1500, 2000])
    assert midpoints.tolist() == [[750, 0], [1700, 1100]]


def test_a_densely_matched_line_has_no_long_edges():
    xs = np.linspace(0, 5000, 101)
    line = LineString(np.column_stack([xs, np.sin(xs / 300) * 50]))

    assert len(long_edges(line, min_edge_m=1000.0)[1]) == 0


def test_forward_positions_follow_a_ring_lap_by_lap():
    square = [(0, 0), (1000, 0), (1000, 1000), (0, 1000), (0, 0)]
    line = LineString(square + square[1:])
    stops = np.array([[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0], [1000, 0]], dtype=float)

    positions = forward_positions(line, stops, extra=100.0)

    assert positions == pytest.approx([0, 1000, 2000, 3000, 4000, 5000])


def test_the_first_point_is_taken_on_the_first_lap():
    square = [(0, 0), (1000, 0), (1000, 1000), (0, 1000), (0, 0)]
    line = LineString([(0, -50), *square, *square[1:]])

    positions = forward_positions(line, np.array([[1000.0, 0.0]]), extra=500.0)

    assert positions == pytest.approx([1050.0])


def test_forward_positions_never_go_back():
    line = LineString([(0, 0), (1000, 0)])
    stops = np.array([[600.0, 0.0], [200.0, 0.0], [900.0, 0.0]])

    assert forward_positions(line, stops).tolist() == [600.0, 600.0, 900.0]


def test_long_runs_keep_only_consecutive_samples_of_the_minimum_length():
    mask = np.array([1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1], dtype=bool)

    assert long_runs(mask, piece=100.0, min_m=500.0) == [(4, 9)]
    assert long_runs(mask, piece=100.0, min_m=100.0) == [(0, 3), (4, 9), (10, 11)]
    assert long_runs(np.zeros(4, dtype=bool), piece=10.0, min_m=1.0) == []


def test_stop_distance_is_taken_at_the_forward_arc_position_not_the_nearest_pass():
    square = [(0, 0), (1000, 0), (1000, 1000), (0, 1000), (0, 0)]
    line = LineString(square)
    stops = np.array([[0.0, 0.0], [0.0, 0.0]])

    distances = stop_arc_distances(line, stops, np.array([0.0, 2000.0]))

    assert distances == pytest.approx([0.0, np.hypot(1000, 1000)])


@pytest.mark.parametrize(
    ("shape_m", "rail_m", "expected"),
    [(1050.0, 1000.0, 1.05), (900.0, 1000.0, 0.9), (1000.0, 0.0, None), (1000.0, None, None)],
)
def test_detour_ratio_is_shape_length_over_rail_path(shape_m, rail_m, expected):
    result = detour_ratio(shape_m, rail_m)

    assert result == (pytest.approx(expected) if expected is not None else None)


def test_an_s_bahn_on_a_long_distance_track_next_to_its_own_track_is_wrong():
    nearest = np.array([WayClass.SBAHN, WayClass.MAIN, WayClass.MAIN, WayClass.SHARED])
    other = np.array([5.0, 12.0, 80.0, 3.0])

    mask = off_relation_mask(nearest, other, is_sbahn=True, parallel_m=30.0)

    assert mask.tolist() == [False, True, False, False]


def test_a_long_distance_train_on_an_s_bahn_only_track_next_to_a_main_track_is_wrong():
    nearest = np.array([WayClass.SBAHN, WayClass.SBAHN, WayClass.MAIN, WayClass.NONE])
    other = np.array([8.0, 200.0, 1.0, 1.0])

    mask = off_relation_mask(nearest, other, is_sbahn=False, parallel_m=30.0)

    assert mask.tolist() == [True, False, False, False]
