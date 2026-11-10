import pytest

from gerlines_rail_graph.gate import (
    LOW_QUALITY,
    UNMEASURED,
    Verdict,
    choose_group,
    floor_by_lower_bound,
    needs_secondary,
    stop_misfits,
    trip_outcome,
    verdict,
    verdict_against,
)

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


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({}, Verdict.PASS),
        ({"has_shape": False}, Verdict.FAIL),
        ({"hairpins": 1}, Verdict.FAIL),
        ({"hairpins": 0, "reversals": 2, "spur_cuts": 3}, Verdict.PASS),
        ({"legs_backwards": 2, "detour": None, "legs_routed": 0}, Verdict.FAIL),
        ({"legs_routed": 0, "detour": None}, Verdict.FAIL),
        ({"detour": 0.9}, Verdict.FAIL),
        ({"detour": 0.9, "detour_low": 0.9}, Verdict.FAIL),
        ({"detour": 0.9, "detour_low": 1.0}, Verdict.PASS),
        ({"detour": 1.2}, Verdict.FAIL),
        ({"detour": 1.2, "detour_low": 1.0}, Verdict.FAIL),
        ({"legs_over_1_3": 1}, Verdict.FAIL),
        ({"legs_extra_over_300m": 1}, Verdict.FAIL),
        ({"on_rail": 0.9}, Verdict.FAIL),
        ({"beeline_m": 1500.0}, Verdict.FAIL),
        ({"on_rail": None, "legs": 0, "legs_routed": 0, "detour": None}, Verdict.UNMEASURED),
        ({"legs": 0, "legs_routed": 0, "detour": None}, Verdict.UNMEASURED),
        ({"off_relation_runs": [[0, 0, 900]]}, Verdict.PASS),
        ({"max_stop_m": 300.0}, Verdict.PASS),
    ],
)
def test_verdict_has_three_states_and_rejects_geometry_faults(change, expected):
    assert verdict({**GOOD, **change}) is expected


def test_secondary_is_needed_on_failure_or_an_off_relation_run():
    assert not needs_secondary({"motis": GOOD})
    assert needs_secondary({"motis": {**GOOD, "beeline_m": 2000.0}})
    assert needs_secondary({"motis": {**GOOD, "off_relation_runs": [[0, 0, 600]]}})
    assert not needs_secondary({"motis": {**GOOD, "on_rail": None, "legs": 0, "legs_routed": 0}})


def trip(motis: dict, pfaedle: dict) -> dict:
    return {"motis": {**GOOD, **motis}, "pfaedle": {**GOOD, **pfaedle}}


def test_a_group_stays_on_motis_when_every_trip_is_fine():
    assert choose_group([trip({}, {}), trip({}, {"beeline_m": 5000.0})]) == "motis"


def test_one_bad_motis_trip_moves_the_whole_group_to_pfaedle():
    rows = [trip({}, {}), trip({"off_relation_runs": [[0, 0, 800]]}, {})]

    assert choose_group(rows) == "pfaedle"


def test_the_group_stays_on_motis_when_pfaedle_cannot_replace_it():
    rows = [trip({"off_relation_runs": [[0, 0, 800]]}, {"legs_backwards": 1})]

    assert choose_group(rows) == "motis"


def test_a_trip_keeps_the_group_method_when_it_passes():
    row = trip({"beeline_m": 3000.0}, {})

    assert trip_outcome(row, "pfaedle") == "pfaedle"
    assert trip_outcome(trip({}, {}), "motis") == "motis"
    assert trip_outcome(trip({"on_rail": None, "legs": 0, "legs_routed": 0}, {}), "motis") == (
        "pfaedle"
    )


def test_a_far_stop_fails_a_shape_only_when_the_other_method_fits_it():
    far_in_both = trip({"stop_m": [5.0, 120.0, 4.0]}, {"stop_m": [6.0, 130.0, 5.0]})
    fitted_by_pfaedle = trip({"stop_m": [5.0, 120.0, 4.0]}, {"stop_m": [6.0, 20.0, 5.0]})

    assert stop_misfits(far_in_both["motis"], far_in_both["pfaedle"]) == []
    assert stop_misfits(fitted_by_pfaedle["motis"], fitted_by_pfaedle["pfaedle"]) == [1]
    assert verdict_against(far_in_both["motis"], far_in_both["pfaedle"]) is Verdict.PASS
    assert verdict_against(fitted_by_pfaedle["motis"], fitted_by_pfaedle["pfaedle"]) is (
        Verdict.FAIL
    )
    assert choose_group([fitted_by_pfaedle]) == "pfaedle"
    assert trip_outcome(fitted_by_pfaedle, "motis") == "pfaedle"


def test_stop_rule_ignores_a_missing_other_shape():
    row = {**GOOD, "stop_m": [200.0, 5.0]}

    assert verdict_against(row, {"has_shape": False}) is Verdict.PASS
    assert verdict_against(row, None) is Verdict.PASS


def test_a_pattern_without_a_motis_shape_falls_back_to_a_passing_pfaedle_shape():
    row = trip({"has_shape": False}, {})

    assert trip_outcome(row, "motis") == "pfaedle"
    assert trip_outcome(trip({"has_shape": False}, {"beeline_m": 4000.0}), "motis") == (
        "low_quality"
    )


def test_a_pattern_motis_was_not_asked_about_does_not_move_its_group():
    unasked = {**trip({"has_shape": False}, {}), "motis_unasked": True}
    failing = trip({"has_shape": False}, {})

    assert choose_group([trip({}, {}), unasked]) == "motis"
    assert choose_group([trip({}, {}), failing]) == "pfaedle"


UNMEASURED_ROW = {"on_rail": None, "legs": 0, "legs_routed": 0, "detour": None}


def test_a_pattern_whose_group_method_fails_takes_the_other_passing_method():
    assert trip_outcome(trip({"beeline_m": 3000.0}, {}), "motis") == "pfaedle"
    assert trip_outcome(trip({}, {"legs_backwards": 1}), "pfaedle") == "motis"


def test_a_pattern_is_low_quality_when_both_methods_fail():
    row = trip({"beeline_m": 3000.0}, {"legs_extra_over_300m": 2})

    assert trip_outcome(row, "motis") == LOW_QUALITY
    assert trip_outcome(row, "pfaedle") == LOW_QUALITY


def test_the_other_method_still_meets_the_stop_rule_of_the_group_method():
    row = trip({"stop_m": [5.0, 20.0], "beeline_m": 3000.0}, {"stop_m": [6.0, 120.0]})

    assert trip_outcome(row, "motis") == LOW_QUALITY


def test_a_pattern_motis_was_not_asked_about_takes_pfaedle_or_stays_low_quality():
    unasked = {**trip({"has_shape": False}, {}), "motis_unasked": True}
    unasked_bad = {**trip({"has_shape": False}, {"beeline_m": 4000.0}), "motis_unasked": True}

    assert trip_outcome(unasked, "motis") == "pfaedle"
    assert trip_outcome(unasked_bad, "motis") == LOW_QUALITY


def test_a_pattern_with_only_unmeasured_verdicts_is_unmeasured():
    assert trip_outcome(trip(UNMEASURED_ROW, UNMEASURED_ROW), "motis") == UNMEASURED
    assert trip_outcome(trip({"has_shape": False}, UNMEASURED_ROW), "motis") == UNMEASURED


def test_a_measured_failure_next_to_an_unmeasured_verdict_is_low_quality():
    assert trip_outcome(trip({"beeline_m": 3000.0}, UNMEASURED_ROW), "motis") == LOW_QUALITY


def test_a_pattern_without_any_shape_is_low_quality():
    assert trip_outcome(trip({"has_shape": False}, {"has_shape": False}), "motis") == LOW_QUALITY


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"detour": 0.95, "detour_low": 1.0}, True),
        ({"detour": 0.97, "detour_low": 1.0}, False),
        ({"detour": 0.95, "detour_low": 0.95}, False),
        ({"detour": 1.0}, False),
        ({"detour": None, "detour_low": None}, False),
    ],
)
def test_a_shape_passing_only_through_the_lower_bound_is_flagged(change, expected):
    assert floor_by_lower_bound({**GOOD, **change}) is expected


def test_a_shape_with_a_hairpin_is_no_evidence_for_the_stop_rule():
    far = {**GOOD, "stop_m": [10.0, 120.0, 5.0]}
    fits = {**GOOD, "stop_m": [10.0, 20.0, 5.0]}

    assert stop_misfits(far, fits) == [1]
    assert stop_misfits(far, {**fits, "hairpins": 1}) == []
    assert stop_misfits(far, {**fits, "turn_cuts": 1}) == []


def test_a_cut_single_turn_passes_with_a_flag_but_a_clean_shape_comes_first():
    turned = {"turn_cuts": 1}

    assert verdict({**GOOD, **turned}) == Verdict.PASS
    assert verdict({**GOOD, **turned}, strict=True) == Verdict.FAIL
    assert trip_outcome(trip(turned, {}), "motis") == "pfaedle"
    assert trip_outcome(trip(turned, {"legs_backwards": 1}), "motis") == "motis"
    assert trip_outcome(trip({"legs_backwards": 1}, turned), "motis") == "pfaedle"
    assert trip_outcome(trip(turned, turned), "pfaedle") == "pfaedle"
    assert trip_outcome(trip({**turned, "legs_backwards": 1}, {"has_shape": False}), "motis") == (
        LOW_QUALITY
    )


def test_a_cut_turn_on_motis_moves_the_group_only_to_a_clean_pfaedle():
    assert needs_secondary(trip({"turn_cuts": 1}, {}))
    assert choose_group([trip({"turn_cuts": 1}, {})]) == "pfaedle"
    assert choose_group([trip({"turn_cuts": 1}, {"turn_cuts": 1})]) == "motis"
