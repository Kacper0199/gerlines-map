from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from gerlines_catalog.seeds import SeedError, read_catalog
from gerlines_catalog.vehicles import CarType, Front, VehicleModel

from .conftest import CATALOG

SOURCE = "wikipedia-de-series"
END_MISSING = {
    "bogie_offset_m": "not measured",
    "bogie_wheelbase_m": "not given",
    "door_positions_m": "not measured",
    "door_width_m": "not given",
    "window_sill_m": "not measured",
    "window_top_m": "not measured",
    "nose_length_m": "not measured",
    "front": "not measured",
}


def car(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "car_type": "end",
        "name": "End car",
        "role": "cab",
        "length_m": 25.0,
        "width_m": 2.9,
        "height_m": 3.9,
        "floor_height_m": 1.2,
        "double_deck": False,
        "bogies": ["own", "own"],
        "bogie_pitch_m": 17.0,
        "wheel_diameter_m": 0.92,
        "nose_shape": "streamlined",
        "doors_per_side": 1,
        "pantograph_count": 0,
        "source": SOURCE,
        "missing": dict(END_MISSING),
    }
    row.update(overrides)
    return row


def middle(**overrides: Any) -> dict[str, Any]:
    nose_fields = {"bogie_offset_m", "nose_length_m", "front"}
    missing = {k: v for k, v in END_MISSING.items() if k not in nose_fields}
    row = car(car_type="middle", name="Middle car", role="middle", nose_shape=None, missing=missing)
    row.update(overrides)
    return row


def model(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "model_id": "example-3",
        "name": "Example, three cars",
        "series_id": "db-403",
        "generic": False,
        "category": "hsr",
        "livery_id": "db-long-distance-1996",
        "unit_length_m": 75.0,
        "formation": [
            {"car_type": "end"},
            {"car_type": "middle"},
            {"car_type": "end", "reversed": True},
        ],
        "car_types": [car(), middle()],
        "source": SOURCE,
    }
    row.update(overrides)
    return row


def test_a_complete_model_is_accepted() -> None:
    row = VehicleModel.model_validate(model())
    assert [c.car_type for c in row.car_types] == ["end", "middle"]
    assert row.formation[2].reversed is True
    assert row.referenced_sources() == {SOURCE}


def test_a_car_value_stays_empty_only_with_a_reason() -> None:
    with pytest.raises(ValidationError, match="width_m is empty without a reason"):
        CarType.model_validate(car(width_m=None))
    with pytest.raises(ValidationError, match="has a value and a reason"):
        CarType.model_validate(car(missing={**END_MISSING, "width_m": "unknown"}))


def test_nose_fields_belong_to_cars_with_a_cab() -> None:
    with pytest.raises(ValidationError, match="nose_shape is empty without a reason"):
        CarType.model_validate(car(nose_shape=None))
    with pytest.raises(ValidationError, match="middle car has nose"):
        CarType.model_validate(middle(nose_shape="streamlined"))


def test_door_positions_match_the_count_and_lie_inside_the_car() -> None:
    missing = {k: v for k, v in END_MISSING.items() if k != "door_positions_m"}
    ok = CarType.model_validate(car(door_positions_m=[-10.5], missing=missing))
    assert ok.door_positions_m == [-10.5]
    with pytest.raises(ValidationError, match="door positions"):
        CarType.model_validate(car(door_positions_m=[-10.5, 10.5], missing=missing))
    with pytest.raises(ValidationError, match="outside the car"):
        CarType.model_validate(car(door_positions_m=[-13.0], missing=missing))


def test_pantograph_positions_follow_the_count() -> None:
    with pytest.raises(ValidationError, match="pantograph_positions_m is empty without a reason"):
        CarType.model_validate(car(pantograph_count=1))
    assert CarType.model_validate(car(pantograph_count=1, pantograph_positions_m=[5.0]))
    with pytest.raises(ValidationError, match="2 pantograph positions for 1"):
        CarType.model_validate(car(pantograph_count=1, pantograph_positions_m=[5.0, -5.0]))


def test_heights_must_be_in_order() -> None:
    missing = {k: v for k, v in END_MISSING.items() if k not in {"window_sill_m", "window_top_m"}}
    with pytest.raises(ValidationError, match="window band"):
        CarType.model_validate(car(window_sill_m=2.6, window_top_m=2.0, missing=missing))
    with pytest.raises(ValidationError, match="floor above the roof"):
        CarType.model_validate(car(floor_height_m=4.0))


def jacobs_middle(**overrides: Any) -> dict[str, Any]:
    missing = {k: v for k, v in middle()["missing"].items() if k != "bogie_wheelbase_m"}
    row = middle(
        bogies=["jacobs", "jacobs"],
        bogie_pitch_m=None,
        missing={**missing, "jacobs_wheelbase_m": "not given"},
    )
    row.update(overrides)
    return row


def jacobs_end(**overrides: Any) -> dict[str, Any]:
    row = car(bogies=["own", "jacobs"], missing={**END_MISSING, "jacobs_wheelbase_m": "not given"})
    row.update(overrides)
    return row


def test_jacobs_cars_take_their_pitch_from_the_length() -> None:
    articulated = jacobs_middle()
    assert CarType.model_validate(articulated).bogie_pitch_m is None
    with pytest.raises(ValidationError, match="pitch of a car on two Jacobs bogies"):
        CarType.model_validate(jacobs_middle(bogie_pitch_m=17.0))
    with pytest.raises(ValidationError, match="bogie_pitch_m is empty without a reason"):
        CarType.model_validate(jacobs_end(bogie_pitch_m=None))
    with pytest.raises(ValidationError, match="pitch longer than the car"):
        CarType.model_validate(car(bogie_pitch_m=26.0))


def test_the_formation_names_known_car_types_and_uses_every_type() -> None:
    with pytest.raises(ValidationError, match="unknown car type 'loco'"):
        VehicleModel.model_validate(model(formation=[{"car_type": "loco"}]))
    with pytest.raises(ValidationError, match="never used"):
        VehicleModel.model_validate(
            model(formation=[{"car_type": "end"}, {"car_type": "end", "reversed": True}])
        )


def test_the_unit_length_matches_the_sum_of_the_cars() -> None:
    with pytest.raises(ValidationError, match=r"cars add up to 75\.00 m"):
        VehicleModel.model_validate(model(unit_length_m=80.0))
    with pytest.raises(ValidationError, match=r"cars add up to 75\.00 m"):
        VehicleModel.model_validate(model(unit_length_m=75.3))
    assert VehicleModel.model_validate(model(unit_length_m=75.2))
    gap = "the article rounds the unit length to whole metres"
    assert VehicleModel.model_validate(model(unit_length_m=75.3, length_gap_reason=gap))
    with pytest.raises(ValidationError, match="no gap to explain"):
        VehicleModel.model_validate(model(length_gap_reason=gap))


def test_jacobs_bogies_are_shared_by_neighbours() -> None:
    front = jacobs_end()
    inner = jacobs_middle()
    ok = model(car_types=[front, inner])
    assert VehicleModel.model_validate(ok)
    lonely = model(car_types=[front, middle()])
    with pytest.raises(ValidationError, match="Jacobs bogie between cars 1 and 2"):
        VehicleModel.model_validate(lonely)
    with pytest.raises(ValidationError, match="unit ends on a Jacobs bogie"):
        VehicleModel.model_validate(
            model(
                formation=[{"car_type": "end"}, {"car_type": "middle"}],
                car_types=[front, inner],
                unit_length_m=50.0,
            )
        )


def test_a_generic_model_has_no_series_and_a_series_model_has_one() -> None:
    with pytest.raises(ValidationError, match="generic model names a series"):
        VehicleModel.model_validate(model(generic=True))
    with pytest.raises(ValidationError, match="needs a series_id"):
        VehicleModel.model_validate(model(series_id=None))
    assert VehicleModel.model_validate(model(generic=True, series_id=None)).generic


def _edit(folder: Path, change) -> None:
    path = folder / "vehicles.yaml"
    rows = yaml.safe_load(path.read_text())
    change(rows)
    path.write_text(yaml.safe_dump(rows, allow_unicode=True, sort_keys=False))


def test_the_committed_vehicles_are_valid() -> None:
    catalog = read_catalog(CATALOG)
    assert catalog.counts()["vehicles"] >= 1
    assert all(v.formation for v in catalog.vehicles)


def test_vehicle_references_must_exist(catalog_copy: Path) -> None:
    def break_refs(rows: list[dict[str, Any]]) -> None:
        rows[0]["category"] = "zeppelin"
        rows[0]["livery_id"] = "no-such-livery"
        rows[0].get("missing", {}).pop("livery_id", None)
        rows[0]["car_types"][0]["source"] = "nobody"
        if not rows[0]["generic"]:
            rows[0]["series_id"] = "no-such-series"

    _edit(catalog_copy, break_refs)
    with pytest.raises(SeedError) as caught:
        read_catalog(catalog_copy)
    problems = "\n".join(caught.value.problems)
    assert "unknown category 'zeppelin'" in problems
    assert "unknown livery 'no-such-livery'" in problems
    assert "unknown source 'nobody'" in problems


def test_duplicate_model_ids_are_reported(catalog_copy: Path) -> None:
    _edit(catalog_copy, lambda rows: rows.append(dict(rows[0])))
    with pytest.raises(SeedError, match="appears 2 times"):
        read_catalog(catalog_copy)


def test_wheelbases_and_door_widths_stay_empty_only_with_a_reason() -> None:
    plain = {k: v for k, v in END_MISSING.items() if k != "bogie_wheelbase_m"}
    with pytest.raises(ValidationError, match="bogie_wheelbase_m is empty without a reason"):
        CarType.model_validate(car(missing=plain))
    with pytest.raises(ValidationError, match="jacobs_wheelbase_m is empty without a reason"):
        CarType.model_validate(car(bogies=["own", "jacobs"]))
    no_width = {k: v for k, v in END_MISSING.items() if k != "door_width_m"}
    with pytest.raises(ValidationError, match="door_width_m is empty without a reason"):
        CarType.model_validate(car(missing=no_width))
    assert CarType.model_validate(car(doors_per_side=0, missing=no_width))


def test_neighbours_on_a_jacobs_bogie_agree_on_its_wheelbase() -> None:
    def ends(wheelbase: float) -> dict[str, Any]:
        missing = dict(END_MISSING.items())
        return jacobs_end(jacobs_wheelbase_m=wheelbase, missing=missing)

    def inner(wheelbase: float) -> dict[str, Any]:
        return jacobs_middle(jacobs_wheelbase_m=wheelbase, missing=middle()["missing"])

    assert VehicleModel.model_validate(model(car_types=[ends(2.8), inner(2.8)]))
    with pytest.raises(
        ValidationError, match=r"Jacobs bogie between cars 1 and 2: 2\.8 m and 2\.7 m"
    ):
        VehicleModel.model_validate(model(car_types=[ends(2.8), inner(2.7)]))


FRONT = {
    "source": "commons-front-photo",
    "length_m": 4.0,
    "tip_height_m": 1.2,
    "bottom_setback_m": 0.6,
    "screen_bottom_m": 2.3,
    "screen_top_m": 3.3,
    "screen_bottom_setback_m": 1.4,
    "screen_top_setback_m": 2.8,
    "screen_width": 0.8,
    "plan": "round",
    "estimated": ["plan"],
}


def test_a_measured_front_replaces_the_nose_length() -> None:
    missing = {k: v for k, v in END_MISSING.items() if k not in {"front", "nose_length_m"}}
    row = CarType.model_validate(car(front=FRONT, missing=missing))
    assert row.front is not None
    assert row.front.length_m == 4.0
    assert "commons-front-photo" in row.referenced_sources()
    with pytest.raises(ValidationError, match="nose_length_m and front"):
        CarType.model_validate(car(front=FRONT, nose_length_m=4.0, missing=missing))
    with pytest.raises(ValidationError, match="middle car has nose"):
        CarType.model_validate(middle(front=FRONT))


def test_a_front_keeps_its_levels_in_order() -> None:
    missing = {k: v for k, v in END_MISSING.items() if k not in {"front", "nose_length_m"}}
    with pytest.raises(ValidationError, match="windscreen"):
        CarType.model_validate(car(front={**FRONT, "screen_top_m": 2.0}, missing=missing))
    with pytest.raises(ValidationError, match="roof"):
        CarType.model_validate(car(front={**FRONT, "screen_top_m": 4.2}, missing=missing))
    with pytest.raises(ValidationError, match="set back"):
        CarType.model_validate(car(front={**FRONT, "screen_top_setback_m": 4.5}, missing=missing))
    with pytest.raises(ValidationError, match="estimated names unknown"):
        CarType.model_validate(car(front={**FRONT, "estimated": ["nothing"]}, missing=missing))


def test_a_front_names_its_second_view_and_bounds_its_side_window() -> None:
    missing = {k: v for k, v in END_MISSING.items() if k not in {"front", "nose_length_m"}}
    front = {**FRONT, "view_source": "commons-other-view", "cab_window": True}
    row = CarType.model_validate(
        car(front={**front, "side_window_from_m": 1.6, "side_window_to_m": 2.6}, missing=missing)
    )
    assert {"commons-front-photo", "commons-other-view"} <= row.referenced_sources()
    with pytest.raises(ValidationError, match="side window"):
        CarType.model_validate(car(front={**front, "side_window_from_m": 1.6}, missing=missing))
    backwards = {**front, "side_window_from_m": 2.6, "side_window_to_m": 1.6}
    with pytest.raises(ValidationError, match="side window"):
        CarType.model_validate(car(front=backwards, missing=missing))
    with pytest.raises(ValidationError, match="side window"):
        CarType.model_validate(
            car(
                front={**FRONT, "side_window_from_m": 1.6, "side_window_to_m": 2.6},
                missing=missing,
            )
        )


def test_a_front_reaches_down_below_its_tip_and_names_both_edges_of_its_front_stripe() -> None:
    missing = {k: v for k, v in END_MISSING.items() if k not in {"front", "nose_length_m"}}
    row = CarType.model_validate(
        car(
            front={
                **FRONT,
                "bottom_m": 0.3,
                "front_stripe_bottom_m": 1.0,
                "front_stripe_top_m": 1.2,
            },
            missing=missing,
        )
    )
    assert row.front is not None
    assert row.front.bottom_m == 0.3
    with pytest.raises(ValidationError, match="below the tip"):
        CarType.model_validate(car(front={**FRONT, "bottom_m": 1.5}, missing=missing))
    with pytest.raises(ValidationError, match="front stripe"):
        CarType.model_validate(car(front={**FRONT, "front_stripe_top_m": 1.2}, missing=missing))


def test_window_panes_name_their_width_pillar_and_pillar_colour() -> None:
    row = CarType.model_validate(
        car(window_width_m=1.9, window_pillar_m=0.16, window_pillars="body")
    )
    assert (row.window_width_m, row.window_pillar_m, row.window_pillars) == (1.9, 0.16, "body")
    assert CarType.model_validate(car(window_pillars="mask")).window_pillars == "mask"
    with pytest.raises(ValidationError):
        CarType.model_validate(car(window_pillars="grey"))
    with pytest.raises(ValidationError):
        CarType.model_validate(car(window_pillar_m=0.0))


def test_a_diving_stripe_names_the_band_it_reaches_across_the_front() -> None:
    missing = {k: v for k, v in END_MISSING.items() if k not in {"front", "nose_length_m"}}
    band = {"front_stripe_bottom_m": 0.6, "front_stripe_top_m": 0.76}
    row = CarType.model_validate(car(front={**FRONT, "stripe": "dive", **band}, missing=missing))
    assert row.front is not None
    assert row.front.stripe == "dive"
    with pytest.raises(ValidationError, match="dives to the front"):
        CarType.model_validate(car(front={**FRONT, "stripe": "dive"}, missing=missing))


def test_a_front_skirt_line_comes_with_or_without_the_body_skirt_line() -> None:
    row = Front.model_validate({**FRONT, "skirt_top_m": 1.0, "front_skirt_top_m": 0.45})
    assert (row.skirt_top_m, row.front_skirt_top_m) == (1.0, 0.45)
    nose_only = Front.model_validate({**FRONT, "front_skirt_top_m": 0.45})
    assert (nose_only.skirt_top_m, nose_only.front_skirt_top_m) == (None, 0.45)


def test_nose_cheeks_need_ordered_heights_and_edges() -> None:
    cheeks = {"bottom_m": 0.3, "top_m": 1.6, "inner": 0.42, "outer": 0.98}
    cheeks |= {"reach_m": 0.3, "recess_m": 0.45}
    assert Front.model_validate({**FRONT, "cheeks": cheeks}).cheeks is not None
    with pytest.raises(ValidationError, match="nose cheeks"):
        Front.model_validate({**FRONT, "cheeks": {**cheeks, "inner": 0.99}})


def test_a_profile_by_height_needs_rising_heights_within_the_front() -> None:
    profile = [[0.4, 0.6], [0.9, 0.0], [2.0, 1.1], [3.5, 3.2]]
    row = Front.model_validate({**FRONT, "profile_by_height": profile})
    assert row.profile_by_height == [(0.4, 0.6), (0.9, 0.0), (2.0, 1.1), (3.5, 3.2)]
    with pytest.raises(ValidationError, match="rising heights"):
        Front.model_validate({**FRONT, "profile_by_height": [[0.4, 0.6], [0.3, 0.0], [2.0, 1.1]]})
    with pytest.raises(ValidationError, match="rising heights"):
        Front.model_validate({**FRONT, "profile_by_height": [[0.4, 0.6], [0.9, 0.0]]})
    with pytest.raises(ValidationError, match="further than the front is long"):
        Front.model_validate({**FRONT, "profile_by_height": [*profile, [3.8, 4.5]]})


def test_a_front_takes_one_measured_profile() -> None:
    by_height = [[0.4, 0.6], [0.9, 0.0], [2.0, 1.1]]
    side = [[0.6, 0.4], [0.0, 0.9], [1.1, 2.0]]
    assert Front.model_validate({**FRONT, "side_profile": side}).side_profile is not None
    with pytest.raises(ValidationError, match="not both"):
        Front.model_validate({**FRONT, "side_profile": side, "profile_by_height": by_height})


def test_front_loft_needs_ordered_heights() -> None:
    loft = {"waist_m": 1.3, "top_m": 3.9, "bottom_m": 0.3, "exponent": 2.4, "taper": 1.5}
    assert Front.model_validate({**FRONT, "loft": loft}).loft is not None
    with pytest.raises(ValidationError):
        Front.model_validate({**FRONT, "loft": {**loft, "top_m": 1.0}})


def test_front_panes_name_their_outline_and_the_cab_window_band() -> None:
    lamp = {"slot": "light", "bottom_m": 1.0, "top_m": 1.25, "inner": 0.45, "outer": 0.62}
    window = {"cab_window": True, "side_window_from_m": 0.3, "side_window_to_m": 1.0}
    row = Front.model_validate(
        {
            **FRONT,
            **window,
            "screen_round": 4,
            "decals": [
                lamp,
                {**lamp, "slot": "stripe", "inner": 0, "outer": 0.1, "round": 10, "under": True},
            ],
            "side_window_bottom_m": 2.0,
            "side_window_top_m": 3.1,
            "side_window_round_m": 0.35,
        }
    )
    assert row.screen_round == 4
    assert row.mask_slot == "mask"
    with pytest.raises(ValidationError):
        Front.model_validate({**FRONT, "mask_slot": "window"})
    assert Front.model_validate({**FRONT, "plan_exponents": [3.2, 2.0]}).plan_exponents == (
        3.2,
        2.0,
    )
    with pytest.raises(ValidationError):
        Front.model_validate({**FRONT, "plan_exponents": [0.5, 2.0]})
    assert row.decals is not None
    assert [d.slot for d in row.decals] == ["light", "stripe"]
    with pytest.raises(ValidationError, match="decal"):
        Front.model_validate({**FRONT, "decals": [{**lamp, "inner": 0.7}]})
    with pytest.raises(ValidationError):
        Front.model_validate({**FRONT, "decals": [{**lamp, "slot": "roof"}]})
    with pytest.raises(ValidationError, match="side window band"):
        Front.model_validate({**FRONT, **window, "side_window_bottom_m": 2.0})


def test_lamp_decals_name_their_tail_lens_tilt_and_cluster() -> None:
    lamp = {"slot": "light", "bottom_m": 1.8, "top_m": 2.0, "inner": 0.45, "outer": 0.85}
    cluster = {**lamp, "fill": True, "tilt_deg": 20, "tail": 0.33, "tail_side": "inner"}
    row = Front.model_validate({**FRONT, "decals": [cluster, {**lamp, "slot": "housing"}]})
    assert row.decals is not None
    first, second = row.decals
    assert (first.fill, first.tilt_deg, first.tail, first.tail_side) == (True, 20, 0.33, "inner")
    assert (second.slot, second.tail, second.tail_side, second.fill) == (
        "housing",
        None,
        "outer",
        False,
    )
    for bad in ({"tail": 1.5}, {"tilt_deg": 60}, {"tail_side": "left"}):
        with pytest.raises(ValidationError):
            Front.model_validate({**FRONT, "decals": [{**lamp, **bad}]})


def test_side_panels_run_forwards_inside_the_car_below_the_roof() -> None:
    row = CarType.model_validate(car(side_panels_m=[[4.0, 5.0, 2.6, 3.3]]))
    assert row.side_panels_m == [(4.0, 5.0, 2.6, 3.3)]
    for bad in (
        [5.0, 4.0, 2.6, 3.3],
        [4.0, 40.0, 2.6, 3.3],
        [4.0, 5.0, 3.3, 2.6],
        [4.0, 5.0, 2.6, 9.0],
    ):
        with pytest.raises(ValidationError, match="side panel"):
            CarType.model_validate(car(side_panels_m=[bad]))


def test_decals_take_a_stacked_tail_lens_and_a_logo_plate() -> None:
    lamp = {"slot": "light", "bottom_m": 1.8, "top_m": 2.3, "inner": 0.45, "outer": 0.7}
    plate = {"slot": "doors", "bottom_m": 1.5, "top_m": 1.8, "inner": 0, "outer": 0.15}
    row = Front.model_validate(
        {
            **FRONT,
            "decals": [{**lamp, "tail": 0.5, "tail_side": "below"}, {**plate, "logo": True}, plate],
        }
    )
    assert row.decals is not None
    lamp_row, logo_row, plain_row = row.decals
    assert (lamp_row.tail_side, logo_row.logo, plain_row.logo) == ("below", True, False)


def test_red_logo_letters_belong_to_a_logo_plate() -> None:
    plate = {"slot": "lower_body", "bottom_m": 1.2, "top_m": 1.5, "inner": 0, "outer": 0.12}
    row = Front.model_validate(
        {**FRONT, "decals": [{**plate, "logo": True, "logo_red_letters": True}]}
    )
    assert row.decals is not None
    assert row.decals[0].logo_red_letters
    with pytest.raises(ValidationError, match="red letters"):
        Front.model_validate({**FRONT, "decals": [{**plate, "logo_red_letters": True}]})


def test_a_front_takes_a_light_or_dark_windscreen_tone() -> None:
    assert Front.model_validate(FRONT).screen_tone == "dark"
    assert Front.model_validate({**FRONT, "screen_tone": "light"}).screen_tone == "light"
    with pytest.raises(ValidationError):
        Front.model_validate({**FRONT, "screen_tone": "black"})


def test_roof_equipment_runs_forwards_inside_the_car() -> None:
    row = CarType.model_validate(car(roof_equipment_m=[[-2.0, 1.0], [1.0, 3.5]]))
    assert row.roof_equipment_m == [(-2.0, 1.0), (1.0, 3.5)]
    with pytest.raises(ValidationError, match="roof equipment"):
        CarType.model_validate(car(roof_equipment_m=[[3.0, 1.0]]))
    with pytest.raises(ValidationError, match="roof equipment"):
        CarType.model_validate(car(roof_equipment_m=[[-40.0, 1.0]]))


def test_front_lettering_takes_known_letters_and_a_stripe_gap_on_the_stripe_curve() -> None:
    curve = [[0.0, 0.8, 1.0], [4.0, 1.5, 1.7]]
    word = {"text": "ICE", "from_m": 1.0, "to_m": 2.5, "bottom_m": 1.2, "top_m": 1.8}
    row = Front.model_validate(
        {**FRONT, "stripe_curve": curve, "lettering": {**word, "stripe_gap_m": [0.9, 2.6]}}
    )
    assert row.lettering is not None
    assert (row.lettering.italic, row.lettering.stripe_gap_m) == (0.0, (0.9, 2.6))
    for bad in ({"text": "IC2"}, {"from_m": 3.0}, {"top_m": 1.0}, {"stripe_gap_m": [2.6, 0.9]}):
        with pytest.raises(ValidationError):
            Front.model_validate({**FRONT, "stripe_curve": curve, "lettering": {**word, **bad}})
    behind = Front.model_validate({**FRONT, "lettering": {**word, "from_m": 9.0, "to_m": 11.0}})
    assert behind.lettering is not None
    with pytest.raises(ValidationError, match="measured stripe curve"):
        Front.model_validate({**FRONT, "lettering": {**word, "stripe_gap_m": [0.9, 2.6]}})
    with pytest.raises(ValidationError, match="measured stripe curve"):
        Front.model_validate(
            {**FRONT, "stripe_curve": curve, "lettering": {**word, "stripe_gap_m": [0.9, 4.6]}}
        )


def test_a_front_keeps_a_plain_cab_side_only_when_asked() -> None:
    assert Front.model_validate(FRONT).plain_cab_side is False
    assert Front.model_validate({**FRONT, "plain_cab_side": True}).plain_cab_side is True
    with pytest.raises(ValidationError):
        Front.model_validate({**FRONT, "plain_cab_side": "plain"})


def test_a_bogie_skirt_clears_the_wheels() -> None:
    assert CarType.model_validate(car(bogie_skirt_m=1.0)).bogie_skirt_m == 1.0
    with pytest.raises(ValidationError, match="clear the wheels"):
        CarType.model_validate(car(bogie_skirt_m=0.95))


def test_a_combined_tail_lamp_is_a_light_without_a_red_share() -> None:
    lamp = {"slot": "light", "bottom_m": 1.4, "top_m": 1.6, "inner": 0.3, "outer": 0.45}
    row = Front.model_validate({**FRONT, "decals": [{**lamp, "tail": 0, "tail_mode": "combined"}]})
    assert row.decals[0].tail_mode == "combined"
    assert Front.model_validate({**FRONT, "decals": [lamp]}).decals[0].tail_mode == "separate"
    for bad in ({"tail": 0.4}, {"slot": "equipment"}, {"tail_mode": "shared"}):
        with pytest.raises(ValidationError):
            Front.model_validate({**FRONT, "decals": [{**lamp, "tail_mode": "combined", **bad}]})


def test_red_paint_is_not_a_tail_lens() -> None:
    paint = {"bottom_m": 0.52, "top_m": 0.9, "inner": 0, "outer": 0.3, "round": 8}
    with pytest.raises(ValidationError):
        Front.model_validate({**FRONT, "decals": [{**paint, "slot": "tail"}]})
    row = Front.model_validate({**FRONT, "decals": [{**paint, "slot": "lower_body"}]})
    assert row.decals[0].slot == "lower_body"


def test_a_stripe_gap_behind_the_nose_cuts_the_side_stripe() -> None:
    word = {"text": "ICE", "from_m": 5.0, "to_m": 6.0, "bottom_m": 1.2, "top_m": 1.8}
    gap = {**word, "stripe_gap_m": [4.5, 6.5]}
    row = Front.model_validate({**FRONT, "lettering": gap})
    assert row.lettering is not None
    assert row.lettering.stripe_gap_m == (4.5, 6.5)
    for bad in ({"stripe": "across"}, {"lettering": {**gap, "stripe_gap_m": [3.5, 6.5]}}):
        with pytest.raises(ValidationError, match="side stripe behind the nose"):
            Front.model_validate({**FRONT, "lettering": gap, **bad})
