import numpy as np
import pytest
from shapely import LineString, box

from gerlines_rail_graph.evaluate import RailIndex, TripMetrics, aggregate, as_row, evaluate_trip
from gerlines_rail_graph.gate import Verdict, verdict
from gerlines_rail_graph.graph import RailGraph
from gerlines_rail_graph.metrics import WayClass


@pytest.fixture
def index() -> RailIndex:
    """A main track at y=0 and an S-Bahn track at y=15 from x=0 to x=10 km."""
    main = LineString([(0, 0), (10_000, 0)])
    sbahn = LineString([(0, 15), (10_000, 15)])
    xs = np.arange(0, 10_001, 500.0)
    xy = np.vstack([np.column_stack([xs, np.zeros_like(xs)]), np.column_stack([xs, xs * 0 + 15])])
    n = len(xs)
    edges = np.array(
        [(i, i + 1) for i in range(n - 1)] + [(n + i, n + i + 1) for i in range(n - 1)]
    )
    graph = RailGraph.from_arrays(xy, edges)
    return RailIndex.build(
        [main, sbahn],
        np.array([WayClass.MAIN, WayClass.SBAHN]),
        graph,
        box(-1000, -1000, 11_000, 1000),
    )


STOPS = np.array([[0.0, 5.0], [5000.0, 5.0], [10_000.0, 5.0]])


def test_a_shape_on_its_own_track_is_on_rail_with_no_off_relation_run(index):
    result = evaluate_trip(STOPS, np.array([[0, 15], [10_000, 15]]), index, is_sbahn=True)

    assert result.on_rail_m == pytest.approx(10_000)
    assert result.off_relation_m == 0
    assert result.legs_extra_over_limit == 0
    assert result.stop_m == pytest.approx([10, 10, 10])
    assert result.detour == pytest.approx(1.0)
    assert result.beeline_m == 0


def test_an_s_bahn_on_the_main_track_counts_runs_away_from_stops_only(index):
    result = evaluate_trip(STOPS, np.array([[0, 0], [10_000, 0]]), index, is_sbahn=True)

    assert [round(run[2]) for run in result.off_relation_runs] == [4400, 4400]
    assert result.off_relation_m == pytest.approx(8800, abs=20)
    assert result.longest_off_relation_m == pytest.approx(4400, abs=10)


def test_a_short_off_relation_stretch_is_not_a_run(index):
    shape = np.array([[0, 15], [2000, 15], [2010, 0], [2300, 0], [2310, 15], [10_000, 15]])

    result = evaluate_trip(STOPS, shape, index, is_sbahn=True)

    assert result.off_relation_runs == []


def test_a_long_leg_tolerates_five_percent_extra(index):
    shape = np.array([[0, 15], [2500, 15], [2500, 120], [2600, 120], [2600, 15], [10_000, 15]])

    result = evaluate_trip(STOPS, shape, index, is_sbahn=True)

    assert result.worst_extra_m == pytest.approx(2 * 105, abs=5)
    assert result.legs_extra_over_limit == 0


def test_a_detour_leg_counts_its_extra_length(index):
    shape = np.array([[0, 15], [2500, 15], [2500, 400], [2600, 400], [2600, 15], [10_000, 15]])

    result = evaluate_trip(STOPS, shape, index, is_sbahn=True)

    assert result.legs_extra_over_limit == 1
    assert result.worst_extra_m == pytest.approx(2 * 385, abs=5)


def test_a_shape_off_the_rails_has_no_on_rail_length(index):
    shape = np.array([[0, 5], [5000, 400], [10_000, 5]])

    result = evaluate_trip(STOPS, shape, index, is_sbahn=False)

    assert result.on_rail_m == pytest.approx(2 * 253, abs=20)
    assert result.beeline_m == pytest.approx(LineString(shape).length)
    assert result.detour == pytest.approx(LineString(shape).length / 10_020, rel=3e-3)
    assert result.worst_leg >= result.detour
    assert result.legs_over_limit == 0


def test_missing_shape_is_reported_as_missing(index):
    assert evaluate_trip(STOPS, None, index, is_sbahn=False).has_shape is False


def test_a_shape_running_backwards_through_the_stops_counts_backward_legs(index):
    shape = np.array([[10_000, 0], [0, 0]])

    result = evaluate_trip(STOPS, shape, index, is_sbahn=False)

    assert result.legs_backwards == 2
    assert result.detour is None
    assert verdict(as_row(result)) is Verdict.FAIL


def test_a_shape_on_its_track_passes_the_gate(index):
    result = evaluate_trip(STOPS, np.array([[0, 15], [10_000, 15]]), index, is_sbahn=True)

    assert verdict(as_row(result)) is Verdict.PASS


def test_a_shape_wholly_outside_coverage_is_unmeasured(index):
    far = STOPS + np.array([0.0, 50_000.0])

    result = evaluate_trip(far, np.array([[0, 50_015], [10_000, 50_015]]), index, is_sbahn=True)

    assert verdict(as_row(result)) is Verdict.UNMEASURED


def test_a_stop_beyond_the_coverage_is_counted_outside(index):
    stops = np.vstack([STOPS, [[10_000.0, 5_000.0]]])
    shape = np.array([[0, 0], [10_000, 0], [10_000, 5_000]])

    result = evaluate_trip(stops, shape, index, is_sbahn=False)

    assert result.stops_outside == 1
    assert as_row(result)["stops_outside"] == 1
    assert as_row(evaluate_trip(STOPS, shape[:2], index, is_sbahn=False))["stops_outside"] == 0


def test_an_area_limits_stops_and_samples(index):
    result = evaluate_trip(
        STOPS,
        np.array([[0, 0], [10_000, 0]]),
        index,
        is_sbahn=False,
        area=box(4000, -100, 6000, 100),
    )

    assert result.stop_m == pytest.approx([5])
    assert result.covered_m == pytest.approx(2000, abs=20)


def test_aggregate_pools_stops_and_counts_failures():
    good = TripMetrics(has_shape=True, stop_m=[1, 2], covered_m=1000, on_rail_m=1000)
    good.length_m, good.shape_legs_m, good.rail_legs_m, good.legs, good.legs_routed = (
        1000,
        1000,
        1000,
        1,
        1,
    )
    bad = TripMetrics(has_shape=True, stop_m=[90], covered_m=1000, on_rail_m=0, beeline_m=1000)
    bad.length_m, bad.shape_legs_m, bad.rail_legs_m, bad.legs, bad.legs_routed = (
        1000,
        1300,
        1000,
        1,
        1,
    )

    result = aggregate([good, bad, TripMetrics(has_shape=False)])

    assert result["trips"] == 3
    assert result["missing_shape"] == 1
    assert result["stop_m"]["max"] == 90
    assert result["trips_stop_over_80m"] == 1
    assert result["on_rail_share"] == pytest.approx(0.5)
    assert result["beeline_share"] == pytest.approx(0.5)
    assert result["trips_beeline_over_1km"] == 0


def test_the_lower_bound_relaxes_only_the_detour_floor_of_a_leg_with_a_strict_path(index):
    stops = np.array([[0.0, 0.0], [5000.0, 0.0]])
    cache = {("a", "b"): (6000.0, 4900.0)}

    result = evaluate_trip(
        stops, np.array([[0, 0], [5000, 0]]), index, is_sbahn=False, legs=(cache, ["a", "b"])
    )

    assert result.rail_legs_m == pytest.approx(6000.0)
    assert result.detour == pytest.approx(5000 / 6000)
    assert result.detour_low == pytest.approx(5000 / 4900)
    assert verdict(as_row(result)) == Verdict.PASS


def test_a_leg_without_a_strict_path_is_not_measured_against_the_lower_bound(index):
    stops = np.array([[0.0, 0.0], [5000.0, 0.0]])
    cache = {("a", "b"): (None, 7000.0)}

    result = evaluate_trip(
        stops, np.array([[0, 0], [5000, 0]]), index, is_sbahn=False, legs=(cache, ["a", "b"])
    )

    assert result.legs == 1
    assert result.legs_routed == 0
