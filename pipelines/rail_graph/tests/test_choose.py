from gerlines_rail_graph.choose import choose_all, qa_report
from gerlines_rail_graph.patterns import Pattern

GOOD = {
    "has_shape": True,
    "detour": 1.0,
    "detour_low": 1.0,
    "legs": 2,
    "legs_routed": 2,
    "legs_backwards": 0,
    "legs_over_1_3": 0,
    "legs_extra_over_300m": 0,
    "on_rail": 1.0,
    "beeline_m": 0.0,
    "off_relation_runs": [],
    "stop_m": [5.0, 5.0, 5.0],
}
FAIL = {**GOOD, "beeline_m": 3000.0}
UNMEASURED = {**GOOD, "on_rail": None, "legs": 0, "legs_routed": 0, "detour": None}
LOW_BOUND = {**GOOD, "detour": 0.95, "detour_low": 1.0}


def pattern(pid: str, route: str, *, scope: str = "domestic", days: int = 7) -> Pattern:
    return Pattern(
        pattern_id=pid,
        route_key=route,
        route_short_name=route,
        category="reg",
        direction_id=0,
        stops=[("a", "A", 9.0, 50.0), ("b", "B", 9.1, 50.0), ("c", "C", 9.2, 50.0)],
        rep_trip=f"trip-{pid}",
        rep_date="2026-10-26",
        rep_departure_s=3600,
        trips=1,
        trip_days_week=days,
        length_km=10.0,
        scope=scope,
    )


def test_choose_all_keeps_the_group_method_and_falls_back_per_pattern():
    patterns = [pattern("p1", "r1"), pattern("p2", "r1"), pattern("p3", "r1")]
    rows = {
        "p1": {"motis": GOOD, "pfaedle": GOOD},
        "p2": {"motis": FAIL, "pfaedle": LOW_BOUND},
        "p3": {"motis": FAIL, "pfaedle": FAIL},
    }

    choice = choose_all(patterns, rows)

    assert {p: c["group_method"] for p, c in choice.items()} == dict.fromkeys(rows, "motis")
    assert choice["p1"]["outcome"] == "motis"
    assert choice["p2"]["outcome"] == "pfaedle"
    assert choice["p3"]["outcome"] == "low_quality"
    assert choice["p2"]["flags"] == ["other_method_than_group", "floor_by_lower_bound"]
    assert choice["p2"]["verdicts"] == {"motis": "fail", "pfaedle": "pass"}
    assert choice["p3"]["flags"] == ["low_quality"]


def test_choose_all_flags_a_cut_turn_and_a_stop_standing_on_a_far_reversal():
    patterns = [pattern("p1", "r1"), pattern("p2", "r2")]
    rows = {
        "p1": {"motis": {**GOOD, "turn_cuts": 1}, "pfaedle": FAIL},
        "p2": {"motis": {**GOOD, "reversal_stop_m": 120.0}, "pfaedle": GOOD},
    }

    choice = choose_all(patterns, rows)

    assert choice["p1"]["outcome"] == "motis"
    assert choice["p1"]["flags"] == ["turn_cut"]
    assert choice["p2"]["outcome"] == "motis"
    assert choice["p2"]["flags"] == ["stop_on_reversal"]


def test_choose_all_flags_a_chosen_pfaedle_shape_with_spliced_legs():
    patterns = [pattern("p1", "r1"), pattern("p2", "r2"), pattern("p3", "r3")]
    rows = {
        "p1": {"motis": FAIL, "pfaedle": GOOD},
        "p2": {"motis": GOOD, "pfaedle": GOOD},
        "p3": {"motis": FAIL, "pfaedle": GOOD},
    }

    choice = choose_all(patterns, rows, spliced=frozenset({"p1", "p2"}))

    assert choice["p1"]["outcome"] == "pfaedle"
    assert "pfaedle_spliced" in choice["p1"]["flags"]
    assert choice["p2"]["outcome"] == "motis"
    assert "pfaedle_spliced" not in choice["p2"]["flags"]
    assert "pfaedle_spliced" not in choice["p3"]["flags"]


def test_a_spliced_pfaedle_shape_does_not_move_its_route_group():
    patterns = [pattern("p1", "r1"), pattern("p2", "r1")]
    rows = {
        "p1": {"motis": FAIL, "pfaedle": GOOD},
        "p2": {"motis": GOOD, "pfaedle": GOOD},
    }

    unspliced = choose_all(patterns, rows)
    spliced = choose_all(patterns, rows, spliced=frozenset({"p1"}))

    assert {p: c["outcome"] for p, c in unspliced.items()} == {"p1": "pfaedle", "p2": "pfaedle"}
    assert {p: c["outcome"] for p, c in spliced.items()} == {"p1": "pfaedle", "p2": "motis"}
    assert spliced["p1"]["group_method"] == "motis"
    assert "pfaedle_spliced" in spliced["p1"]["flags"]


def test_choose_all_stores_unmeasured_patterns_as_unmeasured():
    patterns = [pattern("x1", "r9", scope="cross_border")]
    rows = {"x1": {"motis": UNMEASURED, "pfaedle": UNMEASURED}}

    choice = choose_all(patterns, rows)

    assert choice["x1"]["outcome"] == "unmeasured"
    assert choice["x1"]["flags"] == ["unmeasured"]


def test_qa_report_counts_the_three_states_on_all_and_on_running_patterns():
    patterns = [
        pattern("p1", "r1"),
        pattern("p2", "r2", days=0),
        pattern("p3", "r3"),
        pattern("x1", "r4", scope="cross_border"),
    ]
    choice = {
        "p1": {"outcome": "motis", "group_method": "motis", "flags": []},
        "p2": {"outcome": "low_quality", "group_method": "motis", "flags": ["low_quality"]},
        "p3": {"outcome": "pfaedle", "group_method": "motis", "flags": []},
        "x1": {"outcome": "unmeasured", "group_method": "motis", "flags": ["unmeasured"]},
    }

    report = qa_report(patterns, choice)

    domestic = report["all:domestic"]
    assert domestic["patterns"] == 3
    assert domestic["pass"] == 2
    assert domestic["pass_rate_patterns"] == 0.6667
    assert domestic["states"] == {"pass": 2, "low_quality": 1, "unmeasured": 0}
    assert domestic["states_running"] == {"pass": 2, "low_quality": 0, "unmeasured": 0}
    assert domestic["pass_rate_running_patterns"] == 1.0
    assert domestic["train_km_week"] == 140
    assert domestic["pass_rate_train_km"] == 1.0
    border = report["all:cross_border"]
    assert border["states"] == {"pass": 0, "low_quality": 0, "unmeasured": 1}
    assert border["pass_rate_patterns"] == 0.0
    assert report["groups"] == {"route_direction_groups": 4, "on_pfaedle": 0}


def test_the_abroad_flag_needs_stops_or_track_outside_the_measured_area():
    inside = {**GOOD, "length_m": 20_000.0, "covered_m": 20_000.0, "stops_outside": 0}
    stop_out = {**inside, "stops_outside": 1}
    track_out = {**inside, "covered_m": 15_000.0}
    patterns = [pattern(p, p, scope="cross_border") for p in ("in", "stop", "track", "old")]
    rows = {
        "in": {"motis": inside, "pfaedle": inside},
        "stop": {"motis": stop_out, "pfaedle": stop_out},
        "track": {"motis": track_out, "pfaedle": track_out},
        "old": {"motis": GOOD, "pfaedle": GOOD},
    }

    choice = choose_all(patterns, rows)

    abroad = {p: "cross_border_unmeasured_abroad" in c["flags"] for p, c in choice.items()}
    assert abroad == {"in": False, "stop": True, "track": True, "old": True}
