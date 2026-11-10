import numpy as np

from gerlines_rail_graph.pipeline_shapes import shape_violations
from gerlines_rail_graph.project import geodesic_arc


def track(z: np.ndarray) -> np.ndarray:
    lonlat = np.column_stack([np.linspace(9.0, 9.01, len(z)), np.full(len(z), 50.0)])
    return np.column_stack([lonlat, z, geodesic_arc(lonlat)])


def test_a_sound_shape_has_no_violation():
    coords = track(np.linspace(100.0, 110.0, 21))
    stops = coords[[0, -1], :2]

    found = shape_violations(coords, [0.0, float(coords[-1, 3])], stops)

    assert not any(v for k, v in found.items() if not k.startswith("max_"))
    assert found["max_grade"] < 0.02
    assert found["max_stop_gap_m"] < 0.01


def test_the_steepest_grade_is_reported_on_track_shapes_only():
    z = np.full(21, 100.0)
    z[10] = 90.0
    coords = track(z)
    stops = coords[[0, -1], :2]
    arcs = [0.0, float(coords[-1, 3])]

    on_track = shape_violations(coords, arcs, stops)
    straight = shape_violations(coords, arcs, stops, check_grade=False)

    assert on_track["max_grade"] > 0.06
    assert 0.0 < on_track["max_grade_at_m"] < coords[10, 3]
    assert straight["max_grade"] == 0.0
    assert straight["max_grade_at_m"] is None


def test_stops_out_of_order_and_m_faults_are_found():
    coords = track(np.full(5, 1.0))
    coords[2, 3] = coords[1, 3] - 1.0

    found = shape_violations(coords, [10.0, 5.0], coords[[0, -1], :2])

    assert found["m_backwards"]
    assert found["stops_out_of_order"]


def out_and_back() -> np.ndarray:
    out = np.column_stack([np.linspace(9.0, 9.007, 15), np.full(15, 50.0)])
    back = np.column_stack([np.linspace(9.007, 9.0, 15)[1:], np.full(14, 50.00002)])
    lonlat = np.vstack([out, back])
    return np.column_stack([lonlat, np.full(len(lonlat), 100.0), geodesic_arc(lonlat)])


def test_a_far_stop_on_a_reversal_is_told_apart_from_one_beside_the_line():
    coords = out_and_back()
    apex = float(coords[14, 3])
    station = np.array([9.007, 50.00085])
    stops = np.vstack([coords[0, :2], station, coords[-1, :2]])

    at_turn = shape_violations(coords, [0.0, apex, float(coords[-1, 3])], stops)
    line = track(np.full(21, 100.0))
    beside = np.vstack([line[0, :2], [9.005, 50.00085], line[-1, :2]])
    mid = float(np.interp(9.005, line[:, 0], line[:, 3]))
    off_line = shape_violations(line, [0.0, mid, float(line[-1, 3])], beside)

    assert at_turn["max_stop_gap_m"] > 80
    assert at_turn["max_stop_gap_at_turn"]
    assert off_line["max_stop_gap_m"] > 80
    assert not off_line["max_stop_gap_at_turn"]
