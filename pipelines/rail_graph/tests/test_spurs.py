import json
from pathlib import Path

import numpy as np
import pytest
import shapely
from shapely import LineString

from gerlines_rail_graph.gate import Verdict, verdict
from gerlines_rail_graph.pipeline_shapes import shape_violations
from gerlines_rail_graph.project import geodesic_arc, to_lonlat, to_xy
from gerlines_rail_graph.shape import build_geometry
from gerlines_rail_graph.spurs import (
    STOP_KEEP_M,
    hairpin_vertices,
    pack_hairpins,
    pack_u_turns,
    remove_spurs,
    snap_stops,
    spur_row,
    turn_degrees,
    u_turns,
)

ORIGIN = np.array([500_000.0, 5_550_000.0])
GOOD = {
    "has_shape": True,
    "detour": 1.0,
    "legs": 3,
    "legs_routed": 3,
    "legs_backwards": 0,
    "legs_over_1_3": 0,
    "legs_extra_over_300m": 0,
    "on_rail": 1.0,
    "beeline_m": 0.0,
    "off_relation_runs": [],
    "max_stop_m": 10.0,
}


def place(points, angle: float = 0.0) -> np.ndarray:
    """Local metres rotated by ``angle`` and moved into EPSG:25832 near Frankfurt."""
    c, s = np.cos(angle), np.sin(angle)
    return np.asarray(points, dtype=float) @ np.array([[c, s], [-s, c]]) + ORIGIN


def zigzag(overshoot: float = 100.0, offset: float = 5.0, at: float = 2000.0) -> np.ndarray:
    """Track A along y = 0 past a crossover, back over it to track B and on along B."""
    return np.array(
        [[0, 0], [at + overshoot, 0], [at, offset], [at + 1500, offset], [5000, offset]]
    )


def hausdorff_to(line: np.ndarray, reference: np.ndarray) -> float:
    return float(shapely.hausdorff_distance(LineString(line), LineString(reference), densify=0.05))


def test_a_zigzag_between_parallel_tracks_is_cut_to_a_chord():
    path = place(zigzag())
    stops = place([[0, 0], [3500, 5], [5000, 5]])
    assert len(hairpin_vertices(path)) == 2

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["zigzag"]
    assert not len(hairpin_vertices(result.xy))
    assert result.hairpins == []
    length = LineString(result.xy).length
    assert LineString(path).length - length == pytest.approx(result.removed_m, abs=0.5)
    assert 150 < result.removed_m < 260
    assert np.max(turn_degrees(result.xy)) < 25
    assert shapely.distance(LineString(path), shapely.points(result.xy)).max() < 1e-6


def test_a_reversal_at_an_intermediate_stop_stays_and_its_stop_moves_onto_the_turn():
    path = place([[0, 0], [3000, 0], [2000, 3], [0, 400]])
    stops = place([[0, 0], [2940, 0], [0, 400]])

    result = remove_spurs(path, stops)

    assert result.cuts == []
    np.testing.assert_array_equal(result.xy, path)
    assert result.hairpins == []
    assert result.reversals == [pytest.approx(3000.0)]
    assert snap_stops([0.0, 2940.0, 5100.0], result.reversals) == [0.0, 3000.0, 5100.0]
    assert spur_row(result)["reversals"] == 1


def test_a_single_turn_off_stops_that_still_reverses_after_a_cut_stays_and_fails():
    path = place([[0, 0], [3000, 0], [2000, 3], [0, 400]])
    stops = place([[0, 0], [1000, 0], [0, 400]])

    result = remove_spurs(path, stops)

    assert result.cuts == []
    assert result.hairpins == [pytest.approx(3000.0)]
    row = {**GOOD, **spur_row(result)}
    assert row["u_turns_off_stop"] == 1
    assert verdict(row) == Verdict.FAIL


def test_a_u_of_two_right_angles_is_a_u_turn():
    u = place([[0, 0], [1888, 0], [1892.8, 24.3], [0, 400]])

    assert not len(hairpin_vertices(u))
    assert len(u_turns(u)) == 1
    assert u_turns(u)[0] == pytest.approx(1890, abs=15)
    row = {**GOOD, **spur_row(remove_spurs(u, place([[0, 0], [1000, 0], [0, 400]])))}
    assert row["hairpins"] == 0
    assert row["u_turns_off_stop"] == 1
    assert verdict(row) == Verdict.FAIL


def test_a_stub_past_a_junction_is_cut_back_to_the_junction_without_a_u():
    path = place([[0, 0], [3000, 0], [2000, 3], [1357, 769]])
    stops = place([[0, 0], [1000, 0], [1357, 769]])

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["turn"]
    assert result.hairpins == []
    assert not len(u_turns(result.xy))
    assert 900 < result.removed_m < 2100
    row = {**GOOD, **spur_row(result)}
    assert row["turn_cuts"] == 1
    assert row["u_turns_off_stop"] == 0
    assert verdict(row) == Verdict.PASS
    assert verdict(row, strict=True) == Verdict.FAIL


def test_a_single_turn_past_a_stop_moves_onto_the_stop_where_the_way_back_passes_it():
    path = place([[0, 0], [3700, 0], [2800, 20], [2800, -3000]])
    stops = place([[0, 0], [3000, 0], [2800, -3000]])

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["turn_at_stop"]
    assert result.hairpins == []
    assert result.cuts[0].start_m == pytest.approx(3000.0, abs=0.5)
    assert LineString(result.xy).length == pytest.approx(3000 + 15.6 + 200 + 3020, abs=2.0)
    assert shapely.distance(LineString(result.xy), shapely.points(stops[1])) < 0.5


def test_two_turns_far_from_every_stop_stay_and_fail_the_gate():
    path = place([[0, 0], [3000, 0], [1000, 3], [4000, 6], [12000, 6]])
    stops = place([[0, 0], [10000, 6], [12000, 6]])

    result = remove_spurs(path, stops)

    assert result.cuts == []
    assert result.hairpins == [pytest.approx(3000.0), pytest.approx(5000.0, abs=0.1)]
    assert verdict({**GOOD, **spur_row(result)}) == Verdict.FAIL
    assert verdict({**GOOD, **spur_row(remove_spurs(place(zigzag()), stops))}) == Verdict.PASS


def test_a_turn_spread_over_vertices_closer_than_a_metre_is_one_turn():
    path = place([[0, 0], [3000, 0], [3000, 0.6], [0, 1.2], [0, 400]])
    stops = place([[0, 0], [2950, 0], [0, 400]])

    assert not len(hairpin_vertices(path))
    assert list(hairpin_vertices(path, merge_m=1.0)) == [1]
    result = remove_spurs(path, stops)
    assert result.reversals == [pytest.approx(3000.0)]
    assert result.hairpins == []

    built = build_geometry(to_lonlat(path), to_lonlat(stops), "motis", "pass")
    xy = to_xy(built.lonlat[:, 0], built.lonlat[:, 1])
    apex = hairpin_vertices(xy)
    assert len(apex) == 1
    assert built.stop_arc_m[1] == pytest.approx(built.m[apex[0]])


def test_a_curated_reversal_station_explains_a_turn_without_a_stop():
    path = place([[0, 0], [3000, 0], [2000, 3], [0, 400]])
    stops = place([[0, 0], [1000, 0], [0, 400]])

    result = remove_spurs(path, stops, stations_xy=place([[3100, 50]]))

    assert result.hairpins == []
    assert result.reversals == [pytest.approx(3000.0)]


def test_a_start_that_leaves_the_first_stop_the_wrong_way_is_cut_at_the_turn():
    path = place([[0, 0], [-140, 0], [0, 4], [3000, 4]])
    stops = place([[0, 0], [1500, 4], [3000, 4]])

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["start"]
    np.testing.assert_allclose(result.xy[0], place([[-140, 0]])[0])
    assert not len(hairpin_vertices(result.xy))


def test_an_end_that_runs_past_the_last_stop_and_back_is_cut_at_the_turn():
    path = place([[0, 0], [3140, 0], [3000, 6]])
    stops = place([[0, 0], [1500, 0], [3000, 6]])

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["end"]
    assert len(result.xy) == 2
    assert not len(hairpin_vertices(result.xy))


def test_a_cut_that_would_lose_a_stop_is_not_made():
    path = place([[0, 0], [3000, 0], [2000, 5], [5000, 400]])
    stops = place([[0, 0], [3000, 0], [5000, 400]])

    result = remove_spurs(path, stops)

    assert "zigzag" not in [c.kind for c in result.cuts]
    assert result.reversals == [pytest.approx(3000.0)]
    assert result.hairpins == [pytest.approx(4000.0, abs=0.1)]
    assert shapely.distance(LineString(result.xy), shapely.points(stops[1])) < 1e-6


@pytest.mark.parametrize("seed", range(40))
def test_random_zigzags_are_cut_and_the_line_stays_on_the_tracks(seed):
    rng = np.random.default_rng(seed)
    overshoot = rng.uniform(30, 300)
    offset = rng.uniform(0.0, 8.0)
    at = rng.uniform(800, 3000)
    angle = rng.uniform(0, 2 * np.pi)
    local = zigzag(overshoot, offset, at)
    path = place(local, angle)
    tracks = np.array([[0, 0], [at + overshoot, 0], [at, offset], [5000, offset]])
    stops_local = np.array([[0, 0], [rng.uniform(at + 400, 4600), offset], [5000, offset]])
    stops = place(stops_local, angle)

    result = remove_spurs(path, stops)

    assert len(result.cuts) == 1
    assert not len(hairpin_vertices(result.xy))
    assert result.hairpins == []
    assert hausdorff_to(result.xy, place(tracks, angle)) <= max(offset, 1.0) + 1.0
    line = LineString(result.xy)
    gaps = shapely.distance(line, shapely.points(stops))
    assert np.all(gaps <= STOP_KEEP_M)
    assert np.all(np.hypot(*np.diff(result.xy, axis=0).T) > 0)


@pytest.mark.parametrize("seed", range(20))
def test_lines_without_hairpins_are_left_alone(seed):
    rng = np.random.default_rng(seed)
    heading = np.cumsum(rng.normal(0, 0.15, 300))
    steps = np.column_stack([np.cos(heading), np.sin(heading)]) * rng.uniform(5, 60, (300, 1))
    path = ORIGIN + np.vstack([[0, 0], np.cumsum(steps, axis=0)])
    if len(hairpin_vertices(path)):
        pytest.skip("random walk turned back")
    stops = path[[0, 150, -1]]

    result = remove_spurs(path, stops)

    np.testing.assert_array_equal(result.xy, path)
    assert result.cuts == []
    assert result.reversals == []
    assert result.hairpins == []


def test_build_cuts_the_zigzag_and_keeps_m_monotone():
    path = to_lonlat(place(zigzag(), 0.3))
    stops = to_lonlat(place([[0, 0], [3500, 5], [5000, 5]], 0.3))

    built = build_geometry(path, stops, "motis", "pass")

    assert built.spurs["spur_cuts"] == 1
    assert built.spurs["hairpins"] == 0
    assert not len(hairpin_vertices(to_xy(built.lonlat[:, 0], built.lonlat[:, 1])))
    assert np.all(np.diff(built.m) > 0)
    assert np.all(np.diff(built.stop_arc_m) >= 0)


def test_build_puts_a_reversing_stop_on_the_turn():
    path = to_lonlat(place([[0, 0], [3000, 0], [2000, 3], [0, 400]]))
    stops = to_lonlat(place([[0, 0], [2940, 0], [0, 400]]))

    built = build_geometry(path, stops, "pfaedle", "pass")

    xy = to_xy(built.lonlat[:, 0], built.lonlat[:, 1])
    apex = hairpin_vertices(xy)
    assert len(apex) == 1
    assert built.stop_arc_m[1] == pytest.approx(built.m[apex[0]])
    assert built.spurs["reversals"] == 1


@pytest.mark.parametrize("apex_x", [3000.0, 3002.3, 3007.9])
def test_build_puts_a_reversing_stop_exactly_on_the_hairpin_vertex(apex_x):
    path = to_lonlat(place([[0, 0], [apex_x, 0], [2000, 3], [0, 400]]))
    stops = to_lonlat(place([[0, 0], [2940, 0], [0, 400]]))

    built = build_geometry(path, stops, "pfaedle", "pass")

    xy = to_xy(built.lonlat[:, 0], built.lonlat[:, 1])
    apex = hairpin_vertices(xy)
    assert len(apex) == 1
    assert abs(built.stop_arc_m[1] - built.m[apex[0]]) <= 0.01


def test_verify_reports_a_hairpin_that_is_no_reversal_at_a_stop():
    lonlat = to_lonlat(place([[0, 0], [3000, 0], [2000, 3], [0, 400]]))
    coords = np.column_stack([lonlat, np.zeros(len(lonlat)), geodesic_arc(lonlat)])
    end = float(coords[-1, 3])
    apex = float(coords[1, 3])
    stops = to_lonlat(place([[0, 0], [1000, 0], [0, 400]]))

    far = shape_violations(coords, [0.0, 1000.0, end], stops)
    at_stop = shape_violations(coords, [0.0, apex, end], stops)

    assert far["hairpin_not_at_stop"]
    assert not at_stop["hairpin_not_at_stop"]


def test_a_reversal_far_past_its_stop_is_cut_back_to_the_stop():
    path = place([[0, 0], [3250, 0], [2000, 8], [0, 400]])
    stops = place([[0, 0], [3000, 0], [0, 400]])

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["overshoot"]
    assert result.cuts[0].start_m == pytest.approx(3000.0, abs=0.5)
    assert result.hairpins == []
    assert result.reversal_stop_m <= STOP_KEEP_M
    assert spur_row(result)["turn_cuts"] == 0
    assert shapely.distance(LineString(result.xy), shapely.points(stops[1])) < 1e-6


def test_a_reversal_past_its_stop_without_a_chord_reports_the_distance(monkeypatch):
    monkeypatch.setattr("gerlines_rail_graph.spurs.TURN_STOP_CHORD_M", 0.5)
    path = place([[0, 0], [3250, 0], [2000, 8], [0, 400]])
    stops = place([[0, 0], [3000, 0], [0, 400]])

    result = remove_spurs(path, stops)

    assert result.cuts == []
    assert result.reversals == [pytest.approx(3250.0)]
    assert spur_row(result)["reversal_stop_m"] == pytest.approx(250.0, abs=0.1)


def test_two_turns_that_loop_back_past_a_stop_are_cut_at_the_stop():
    path = place([[0, 3000], [0, -800], [40, 900], [80, -3000]])
    stops = place([[0, 3000], [0, 0], [80, -3000]])
    assert len(remove_spurs(path, place([[0, 3000], [2000, 0], [80, -3000]])).hairpins) == 2

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["turn_at_stop"]
    assert result.hairpins == []
    assert spur_row(result)["turn_cuts"] == 1
    assert LineString(result.xy).length == pytest.approx(3000 + 49.2 + 3000.2, abs=1.0)


def _random_case(seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(1000 + seed)
    angle = rng.uniform(0, 2 * np.pi)
    kind = seed % 3
    if kind == 0:
        at, over, off = rng.uniform(800, 3000), rng.uniform(30, 300), rng.uniform(0, 8)
        local = zigzag(over, off, at)
        stops = [[0, 0], [rng.uniform(at + 400, 4600), off], [5000, off]]
    elif kind == 1:
        stub, branch = rng.uniform(200, 1500), rng.uniform(30, 70)
        b = np.radians(branch)
        local = np.array(
            [[0, 0], [2000 + stub, 0], [2000, 3], [2000 - 1500 * np.cos(b), 3 + 1500 * np.sin(b)]]
        )
        stops = [[0, 0], [1000, 0], local[-1]]
    else:
        at = rng.uniform(1500, 4000)
        local = np.array([[0, 0], [at, 0], [at - 1000, rng.uniform(2, 20)], [0, 600]])
        stops = [[0, 0], [at - rng.uniform(0, 200), 0], [0, 600]]
    return place(local, angle), place(stops, angle)


@pytest.mark.parametrize("seed", range(45))
def test_remove_spurs_is_a_fixed_point(seed):
    path, stops = _random_case(seed)

    once = remove_spurs(path, stops)
    twice = remove_spurs(once.xy, stops)

    assert twice.cuts == []
    np.testing.assert_array_equal(twice.xy, once.xy)
    assert twice.hairpins == once.hairpins


@pytest.mark.parametrize("seed", range(15))
def test_random_stubs_past_a_junction_leave_no_turn_and_keep_the_stops(seed):
    path, stops = _random_case(3 * seed + 1)

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["turn"]
    assert result.hairpins == []
    assert not len(u_turns(result.xy))
    assert np.all(shapely.distance(LineString(result.xy), shapely.points(stops)) <= STOP_KEEP_M)
    built = build_geometry(to_lonlat(path), to_lonlat(stops), "motis", "pass")
    assert np.all(np.diff(built.m) > 0)
    assert np.all(np.diff(built.stop_arc_m) >= 0)


@pytest.mark.parametrize("second_last", [False, True])
def test_a_reversal_at_the_second_or_second_last_stop_survives(second_last):
    local = np.array([[0, 0], [3000, 0], [-2000, 5]], dtype=float)
    stops_local = np.array([[0, 0], [3000, 0], [-2000, 5]], dtype=float)
    if second_last:
        local, stops_local = local[::-1].copy(), stops_local[::-1].copy()
    path, stops = place(local), place(stops_local)

    result = remove_spurs(path, stops)

    assert result.cuts == []
    assert len(result.reversals) == 1
    assert result.hairpins == []
    built = build_geometry(to_lonlat(path), to_lonlat(stops), "pfaedle", "pass")
    xy = to_xy(built.lonlat[:, 0], built.lonlat[:, 1])
    assert built.stop_arc_m[1] == pytest.approx(built.m[hairpin_vertices(xy)[0]])


def test_verify_measures_u_turns_against_the_stops_not_their_snapped_arcs():
    lonlat = to_lonlat(place([[0, 0], [1888, 0], [1892.8, 24.3], [0, 400]]))
    coords = np.column_stack([lonlat, np.zeros(len(lonlat)), geodesic_arc(lonlat)])
    end = float(coords[-1, 3])
    far_stops = to_lonlat(place([[0, 0], [1000, 0], [0, 400]]))
    near_stops = to_lonlat(place([[0, 0], [1840, 0], [0, 400]]))

    far = shape_violations(coords, [0.0, 1900.0, end], far_stops)
    near = shape_violations(coords, [0.0, 1900.0, end], near_stops)

    assert far["u_turn_not_at_stop"]
    assert not far["hairpin_not_at_stop"]
    assert not near["u_turn_not_at_stop"]
    assert [round(d) for d, _, _ in near["u_turn_stops"]] == [pytest.approx(55, abs=5)]


def test_verify_tells_a_timetable_reversal_from_a_stop_passed_through():
    lonlat = to_lonlat(place([[0, 0], [1888, 0], [1892.8, 24.3], [0, 400]]))
    coords = np.column_stack([lonlat, np.zeros(len(lonlat)), geodesic_arc(lonlat)])
    end = float(coords[-1, 3])
    back = to_lonlat(place([[0, 0], [1840, 0], [0, 400]]))
    through = to_lonlat(place([[0, 0], [1840, 0], [4000, 30]]))

    assert shape_violations(coords, [0.0, 1900.0, end], back)["u_turn_stops"][0][1]
    assert not shape_violations(coords, [0.0, 1900.0, end], through)["u_turn_stops"][0][1]


def test_an_end_cut_keeps_a_back_leg_whose_last_stop_lies_beyond_the_search_window():
    path = place([[0, 0], [10_000, 0], [4_000, 5], [4_000, 1_733], [10_000, 1_733]])
    stops = place([[0, 0], [10_000, 0], [10_000, 1_733]])

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == []
    assert len(result.reversals) == 1
    assert len(result.hairpins) == 0
    assert np.allclose(result.xy[-1], place([[10_000, 1_733]])[0])


def test_a_turn_cut_keeps_a_loop_that_passes_the_stop_far_from_the_turn():
    path = place(
        [
            [0, 0],
            [15_000, 0],
            [15_000, 3_000],
            [6_000, 3_000],
            [6_000, 40],
            [4_000, 40],
            [4_000, 45],
            [20_000, 45],
        ]
    )
    stops = place([[0, 0], [5_000, 0], [20_000, 45]])

    result = remove_spurs(path, stops)

    assert len(result.cuts) == 1
    assert result.cuts[0].start_m > 20_000
    assert result.removed_m < 5_000
    assert np.min(np.hypot(*(result.xy - place([[15_000, 3_000]])[0]).T)) < 1.0


def test_end_and_zigzag_cuts_keep_a_turn_at_a_curated_station():
    path = place([[0, 0], [3_300, 0], [3_000, 5]])
    stops = place([[0, 0], [1_500, 0], [3_000, 5]])
    station = place([[3_300, 0]])

    assert [c.kind for c in remove_spurs(path, stops).cuts] == ["end"]
    result = remove_spurs(path, stops, station)

    assert result.cuts == []
    assert len(result.reversals) == 1
    assert len(result.hairpins) == 0

    zigzag_path = place([[0, 0], [2_100, 0], [2_000, 5], [3_500, 5], [5_000, 5]])
    zigzag_stops = place([[0, 0], [3_500, 5], [5_000, 5]])
    assert [c.kind for c in remove_spurs(zigzag_path, zigzag_stops).cuts] == ["zigzag"]
    kept = remove_spurs(zigzag_path, zigzag_stops, place([[2_100, 0]]))
    assert kept.cuts == []


@pytest.mark.parametrize(("past", "beside"), [(100, 0), (250, 0), (200, 90), (120, 85)])
def test_an_overshoot_past_a_stop_is_cut_once_and_the_result_is_a_fixed_point(past, beside):
    path = place([[0, 0], [10_000 + past, 0], [10_000 + past, 13], [2_000, 13]])
    stops = place([[0, 0], [10_000, beside], [2_000, 13]])

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["overshoot"]
    assert result.cuts[0].removed_m > past
    assert remove_spurs(result.xy, stops).cuts == []
    assert len(result.hairpins) == 0
    assert result.reversal_stop_m <= max(80.0, beside + 1.0)


def test_u_turn_bands_count_by_distance_reversal_and_flag():
    from gerlines_rail_graph.pipeline_shapes import add_u_turns, u_turn_bands  # noqa: PLC0415

    bands = u_turn_bands()
    add_u_turns(bands, [(10.0, True), (30.0, False), (55.0, True), (400.0, False)], flagged=True)
    add_u_turns(bands, [(float("inf"), False)], flagged=False)

    assert list(bands) == ["0-30 m", "30-80 m", "80-150 m", "150-300 m", "over 300 m"]
    assert bands["0-30 m"] == {"u_turns": 2, "timetable_reversal": 1, "flagged_stop_on_reversal": 2}
    assert bands["30-80 m"] == {
        "u_turns": 1,
        "timetable_reversal": 1,
        "flagged_stop_on_reversal": 1,
    }
    assert bands["over 300 m"]["u_turns"] == 2


def test_u_turn_bands_from_verify_rows_serialise_to_json():
    from gerlines_rail_graph.pipeline_shapes import add_u_turns, u_turn_bands  # noqa: PLC0415

    lonlat = to_lonlat(place([[0, 0], [1888, 0], [1892.8, 24.3], [0, 400]]))
    coords = np.column_stack([lonlat, np.zeros(len(lonlat)), geodesic_arc(lonlat)])
    stops = to_lonlat(place([[0, 0], [1840, 0], [0, 400]]))
    found = shape_violations(coords, [0.0, 1900.0, float(coords[-1, 3])], stops)
    bands = u_turn_bands()

    add_u_turns(bands, found["u_turn_stops"], flagged=np.bool_(True))

    assert json.loads(json.dumps(bands))["30-80 m"] == {
        "u_turns": 1,
        "timetable_reversal": 1,
        "flagged_stop_on_reversal": 1,
    }


@pytest.mark.parametrize(("slope", "kept"), [(0.4, False), (0.5, False), (1.0, True), (2.0, True)])
def test_a_stub_cut_is_kept_only_when_no_segment_pair_turns_over_150_degrees(slope, kept):
    end = [1_000, 5 + 3_000 * slope]
    path = place([[0, 0], [5_000, 0], [5_000, 5], [4_000, 5], end])
    stops = place([[0, 0], [1_500, 0], end])

    result = remove_spurs(path, stops)

    assert ([c.kind for c in result.cuts] == ["turn"]) is kept
    assert (spur_row(result)["u_turns_off_stop"] == 0) is kept


@pytest.mark.parametrize(("past", "beside"), [(100, 84), (250, 95)])
def test_an_overshoot_chord_at_a_platform_beside_the_track_is_a_reversal_at_it(past, beside):
    path = place([[0, 0], [10_000 + past, 0], [10_000 + past, 13], [2_000, 13]])
    stops = place([[0, 0], [10_000, beside], [2_000, 13]])

    result = remove_spurs(path, stops)

    assert [c.kind for c in result.cuts] == ["overshoot"]
    assert len(result.reversals) == 1
    assert result.reversal_stop_m <= STOP_KEEP_M


def verify_coords(points) -> np.ndarray:
    lonlat = to_lonlat(place(points))
    return np.column_stack([lonlat, np.zeros(len(lonlat)), geodesic_arc(lonlat)])


def test_verify_measures_a_u_turn_along_the_track_not_in_a_straight_line():
    coords = verify_coords(
        [[0, 0], [1_000, 0], [3_000, 0], [3_000, 150], [1_150, 150], [3_000, 155], [3_000, 600]]
    )
    stops = to_lonlat(place([[0, 0], [1_000, 0], [3_000, 600]]))
    end = float(coords[-1, 3])

    found = shape_violations(coords, [0.0, 1_000.0, end], stops)

    assert len(found["u_turn_stops"]) == 1
    straight, _, track = found["u_turn_stops"][0]
    assert straight < 300
    assert track > 3_000
    assert found["u_turn_not_at_stop"]


def test_verify_counts_a_u_of_two_corners_off_every_stop_arc_like_the_pack_gate():
    coords = verify_coords([[0, 0], [2_000, 0], [2_000, 20], [1_000, 20], [1_000, 40], [3_000, 40]])
    stops = to_lonlat(place([[0, 0], [2_000, 10], [3_000, 40]]))
    end = float(coords[-1, 3])
    turn = float(coords[1, 3]) + 10.0

    off = shape_violations(coords, [0.0, 500.0, end], stops)
    on = shape_violations(coords, [0.0, turn, end], stops)

    assert off["pack_u_turn_off_stop"]
    assert not on["pack_u_turn_off_stop"]


def test_verify_counts_u_turns_a_curated_station_exempts():
    coords = verify_coords([[0, 0], [2_000, 0], [2_000, 20], [1_400, 20], [1_400, 40], [3_000, 40]])
    stops = to_lonlat(place([[0, 0], [500, 0], [3_000, 40]]))
    station = to_lonlat(place([[1_700, 20]]))
    end = float(coords[-1, 3])

    found = shape_violations(coords, [0.0, 500.0, end], stops, stations=station)
    plain = shape_violations(coords, [0.0, 500.0, end], stops)

    assert found["u_turns_at_station"] == 2
    assert found["u_turn_stops"] == []
    assert plain["u_turns_at_station"] == 0


GATE_VECTORS = (
    Path(__file__).resolve().parents[3]
    / "services"
    / "live"
    / "src"
    / "shapes"
    / "gate-vectors.json"
)


@pytest.mark.parametrize(
    "case", json.loads(GATE_VECTORS.read_text())["cases"], ids=lambda case: case["name"]
)
def test_the_pack_gate_port_matches_the_live_gate_vectors(case):
    xy = np.column_stack([case["x"], case["y"]])
    s = np.asarray(case["s"], dtype=float)

    spans = pack_u_turns(xy, s, case["stop_arcs"])

    assert np.asarray(spans, dtype=float).reshape(-1, 2) == pytest.approx(
        np.asarray(case["u_turns"], dtype=float).reshape(-1, 2), abs=1e-6
    )
    assert pack_hairpins(xy, s, case["stop_arcs"]) == case["hairpins"]


def test_far_stops_at_a_reversal_stay_inside_the_unflagged_total():
    from gerlines_rail_graph.pipeline_shapes import far_stop_report  # noqa: PLC0415

    far = [("a", 94.9, True), ("b", 80.4, False), ("c", 88.4, True)]

    report = far_stop_report(far)

    assert report["stop_over_80m_unflagged"] == 3
    assert report["stop_over_80m_unflagged_at_reversal"] == 2
    assert report["examples"] == [["b", 80.4]]
    assert report["at_reversal_examples"] == [["a", 94.9], ["c", 88.4]]
