import numpy as np

from gerlines_rail_graph.reversal_groups import (
    Call,
    decide,
    disputed,
    neighbour_angle,
    report,
    stop_calls,
)

MOVE = ("de:1:S", "de:1:A", "de:1:B")


def call(pid: str, reverses: bool, angle: float) -> Call:
    apex = np.zeros(2) if reverses else None
    heading = np.array([1.0, 0.0]) if reverses else None
    return Call(pid, MOVE, reverses, angle, apex, heading)


def buffer(found: bool):
    return lambda _apex, _heading: {
        "at_buffer": found,
        "way_id": 11,
        "buffer_node": 22 if found else -1,
        "gap_m": 0.3,
    }


def test_neighbours_on_the_same_side_make_a_small_angle():
    assert neighbour_angle(np.array([-1000, 10]), np.zeros(2), np.array([-1000, -10])) < 2
    assert neighbour_angle(np.array([-1000, 0]), np.zeros(2), np.array([1000, 0])) == 180.0


def test_only_movements_with_both_reversing_and_through_calls_are_disputed():
    other = ("de:1:T", "de:1:A", "de:1:B")
    calls = [call("p1", True, 170), call("p2", False, 170), Call("p3", other, True, 10)]

    assert list(disputed(calls)) == [MOVE]


def test_rule_0_neighbours_on_one_side_make_the_through_shapes_the_faults():
    group = [call("p1", True, 20), call("p2", False, 20), call("p3", False, 20)]

    decision = decide(group, buffer(False))

    assert (decision["verdict"], decision["rule"]) == ("reverse", "0")
    assert decision["fault_patterns"] == ["p2", "p3"]
    assert decision["rules_agree"] is False


def test_rule_2_a_turn_at_a_buffer_stop_with_opposite_neighbours_is_a_terminus():
    group = [call("p1", True, 150), call("p2", True, 150), call("p3", False, 150)]

    decision = decide(group, buffer(True))

    assert (decision["verdict"], decision["rule"], decision["rule0"]) == ("reverse", "2", None)
    assert decision["fault_patterns"] == ["p3"]
    assert decision["turns"][0] == {
        "pattern_id": "p1",
        "at_buffer": True,
        "way_id": 11,
        "buffer_node": 22,
        "gap_m": 0.3,
    }


def test_rule_2_a_turn_away_from_any_track_end_is_the_fault_at_a_through_station():
    group = [call("p1", True, 170), call("p2", False, 170)]

    decision = decide(group, buffer(False))

    assert decision["verdict"] == "through"
    assert decision["fault_patterns"] == ["p1"]
    assert report([decision]) == {
        "disputed_movements": 1,
        "by_rule": {"0": 0, "2": 1},
        "rules_disagree": 0,
        "fault_patterns": 1,
    }


def test_a_shape_that_turns_back_at_its_middle_stop_reverses_there():
    stops = ["de:1:A:1", "de:1:S:1", "de:1:B:1"]
    stops_xy = np.array([[0.0, 0.0], [1000.0, 0.0], [0.0, 50.0]])
    out_and_back = np.array([[0.0, 0.0], [1000.0, 0.0], [1000.0, 5.0], [0.0, 5.0]])
    straight = np.array([[0.0, 0.0], [1000.0, 0.0], [2000.0, 0.0]])

    turned = stop_calls("p", stops, stops_xy, out_and_back, [0.0, 1002.5, 2005.0])
    through = stop_calls("q", stops, stops_xy, straight, [0.0, 1000.0, 2000.0])

    assert turned[0].reverses
    assert turned[0].movement == ("de:1:S", "de:1:A", "de:1:B")
    assert turned[0].heading[0] > 0
    assert not through[0].reverses
