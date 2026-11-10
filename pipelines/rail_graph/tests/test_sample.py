import random

import pytest

from gerlines_rail_graph.sample import (
    Corridor,
    Pattern,
    TripStops,
    category,
    pick_corridor_trips,
    pps_sample,
    serves_corridor,
    stratified_patterns,
)


@pytest.mark.parametrize(
    ("route_type", "short_name", "expected"),
    [
        (101, "ICE 29", "hsr"),
        (102, "IC 56", "ld"),
        (102, "NJ 40", "night"),
        (102, "EN 50", "night"),
        (102, "27N", "night"),
        (109, "S1", "sbahn"),
        (106, "S5", "sbahn"),
        (106, "RS 1", "sbahn"),
        (106, "RE 1", "reg"),
        (2, "RB 33", "reg"),
        (106, "SE 10", "reg"),
    ],
)
def test_category_from_route_type_and_name(route_type, short_name, expected):
    assert category(route_type, short_name) == expected


KOELN = Corridor("koeln-hbf", (6.94, 50.93, 6.975, 50.95))
LEFT_RHINE = Corridor(
    "rhine-left",
    (7.55, 50.0, 7.75, 50.25),
    stop_pattern=r"Boppard|Oberwesel",
    pairs=((r"^Mainz Hbf", r"^Koblenz Hbf"),),
)


def trip(names_coords: list[tuple[str, float, float]]) -> TripStops:
    return TripStops(
        names=[n for n, _, _ in names_coords], lonlat=[(lon, lat) for _, lon, lat in names_coords]
    )


def test_a_trip_stopping_inside_the_box_serves_the_corridor():
    assert serves_corridor(
        trip([("Köln Hbf", 6.958, 50.943), ("Köln Messe/Deutz", 6.975, 50.94)]), KOELN
    )


def test_a_trip_passing_the_box_between_two_stops_serves_the_corridor():
    assert serves_corridor(trip([("Köln West", 6.92, 50.94), ("Köln-Mülheim", 7.0, 50.96)]), KOELN)


def test_a_trip_far_away_does_not_serve_the_corridor():
    assert not serves_corridor(
        trip([("Bonn Hbf", 7.097, 50.732), ("Bonn-Beuel", 7.12, 50.74)]), KOELN
    )


def test_a_stop_pattern_is_required_when_the_corridor_has_one():
    right_bank = trip([("Kaub", 7.765, 50.086), ("St. Goarshausen", 7.718, 50.155)])
    left_bank = trip([("Oberwesel", 7.73, 50.107), ("Boppard Hbf", 7.59, 50.23)])

    assert not serves_corridor(right_bank, LEFT_RHINE)
    assert serves_corridor(left_bank, LEFT_RHINE)


def test_a_non_stop_pair_counts_for_a_corridor_with_pairs():
    ic = trip(
        [("Mainz Hbf", 8.258, 49.999), ("Koblenz Hbf", 7.588, 50.351), ("Bonn Hbf", 7.097, 50.732)]
    )

    assert serves_corridor(ic, LEFT_RHINE)


def test_picks_flagged_trips_first_and_caps_each_category():
    candidates = {
        "a": ("sbahn", "p1", False),
        "b": ("sbahn", "p2", True),
        "c": ("sbahn", "p3", False),
        "d": ("hsr", "p4", False),
        "e": ("sbahn", "p1", True),
    }

    picked = pick_corridor_trips(candidates, per_category=2, rng=random.Random(1))  # noqa: S311

    assert set(picked) <= set(candidates)
    sbahn = [t for t in picked if candidates[t][0] == "sbahn"]
    assert len(sbahn) == 2
    assert {"b", "e"} == set(sbahn)
    assert "d" in picked


def test_pps_sample_takes_all_keys_when_there_are_few():
    assert pps_sample({"a": 1.0, "b": 2.0, "z": 0.0}, 5, random.Random(1)) == ["a", "b"]  # noqa: S311


def test_pps_sample_favours_heavy_keys():
    weights = {f"k{i}": (100.0 if i < 10 else 1.0) for i in range(100)}
    rng = random.Random(3)  # noqa: S311

    heavy = sum(sum(1 for k in pps_sample(weights, 10, rng) if int(k[1:]) < 10) for _ in range(200))

    assert heavy / 2000 > 0.7


def test_stratified_patterns_cap_each_category():
    patterns = [Pattern(f"p{i}", "reg", ("t",), 10.0) for i in range(30)] + [
        Pattern("n1", "night", ("t1", "t2"), 500.0)
    ]

    picked = stratified_patterns(patterns, 20, random.Random(5))  # noqa: S311

    assert len(picked["reg"]) == 20
    assert [p.key for p in picked["night"]] == ["n1"]
    assert picked["night"][0].train_km == 1000.0


def test_one_trip_per_stop_pattern():
    candidates = {
        "a": ("reg", "same", False),
        "b": ("reg", "same", False),
        "c": ("reg", "other", False),
    }

    picked = pick_corridor_trips(candidates, per_category=3, rng=random.Random(1))  # noqa: S311

    assert len(picked) == 2
