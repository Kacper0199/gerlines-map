import pytest

from gerlines_rail_graph.motis import fetch_trip, leg_lonlat, slice_to_trip, trip_id
from gerlines_rail_graph.polyline import encode


def test_trip_id_uses_service_day_and_gtfs_start_time():
    assert trip_id("2026-10-27", 6 * 3600 + 37 * 60 + 30, "3434489119", "de") == (
        "20261027_06:37_de_3434489119"
    )


def test_trip_id_keeps_hours_past_midnight_of_the_service_day():
    assert trip_id("2026-10-27", 25 * 3600 + 5 * 60, "x_1", "de") == "20261027_25:05_de_x_1"


def test_leg_geometries_are_joined_as_lon_lat_without_duplicate_joints():
    first = encode([(50.0, 8.0), (50.1, 8.1)], 6)
    second = encode([(50.1, 8.1), (50.2, 8.2)], 7)
    itinerary = {
        "legs": [
            {"legGeometry": {"points": first, "precision": 6}},
            {"legGeometry": {"points": second, "precision": 7}},
            {"mode": "WALK"},
        ]
    }

    assert leg_lonlat(itinerary) == [(8.0, 50.0), (8.1, 50.1), (8.2, 50.2)]


def _place(stop: str, lon: float) -> dict:
    return {"stopId": f"de_{stop}", "lon": lon, "lat": 50.0}


def _run(stops: list[tuple[str, float]]) -> dict:
    geometry = encode([(50.0, lon) for _, lon in stops], 6)
    return {
        "legs": [
            {
                "from": _place(*stops[0]),
                "intermediateStops": [_place(*s) for s in stops[1:-1]],
                "to": _place(*stops[-1]),
                "legGeometry": {"points": geometry, "precision": 6},
            }
        ]
    }


def test_a_run_equal_to_the_trip_is_kept_whole():
    run = _run([("a", 8.0), ("b", 8.1), ("c", 8.2)])

    coords, how = slice_to_trip(run, ["a", "b", "c"], "de")

    assert how == "whole_run"
    assert coords == [(8.0, 50.0), (8.1, 50.0), (8.2, 50.0)]


def test_a_stay_seated_run_is_cut_to_the_trip_stops():
    run = _run([("x", 7.8), ("a", 8.0), ("b", 8.1), ("c", 8.2), ("y", 8.4)])

    coords, how = slice_to_trip(run, ["a", "b", "c"], "de")

    assert how == "cut_from_run"
    assert coords[0] == pytest.approx((8.0, 50.0))
    assert coords[-1] == pytest.approx((8.2, 50.0))


def test_a_loop_through_the_same_stop_is_cut_at_the_right_visit():
    run = _run([("a", 8.0), ("b", 8.1), ("a2", 8.0), ("b", 8.1), ("c", 8.2)])

    coords, _ = slice_to_trip(run, ["b", "c"], "de")

    assert coords[0] == pytest.approx((8.1, 50.0))
    assert coords[-1] == pytest.approx((8.2, 50.0))
    assert len(coords) == 2


def test_stops_that_motis_leaves_out_of_the_run_are_skipped():
    run = _run([("a", 8.0), ("c", 8.2), ("d", 8.3)])

    coords, how = slice_to_trip(run, ["a", "b", "c"], "de")

    assert how == "cut_from_run"
    assert coords[-1] == pytest.approx((8.2, 50.0))


def test_a_missing_end_stop_gives_no_shape_without_stop_positions():
    run = _run([("a", 8.0), ("b", 8.1)])

    assert slice_to_trip(run, ["a", "b", "z"], "de") == (None, "end_stop_not_in_run")


def test_a_passed_end_stop_is_cut_where_it_projects_onto_the_run():
    run = _run([("a", 8.0), ("b", 8.1), ("y", 8.3)])

    coords, how = slice_to_trip(
        run, ["a", "b", "z"], "de", [(8.0, 50.0), (8.1, 50.0), (8.2, 50.001)]
    )

    assert how == "cut_at_projected_end"
    assert coords[-1] == pytest.approx((8.2, 50.0))


def test_a_passed_end_stop_far_from_the_run_gives_no_shape():
    run = _run([("a", 8.0), ("b", 8.1), ("y", 8.3)])

    coords, how = slice_to_trip(
        run, ["a", "b", "z"], "de", [(8.0, 50.0), (8.1, 50.0), (8.2, 50.05)]
    )

    assert coords is None
    assert how.startswith("last_stop_not_in_run_")


def test_stops_missing_from_the_run_give_no_shape():
    run = _run([("a", 8.0), ("b", 8.1)])

    assert slice_to_trip(run, ["y", "z"], "de") == (None, "stops_not_in_run")


def test_refuses_a_server_that_is_not_local():
    with pytest.raises(ValueError, match="non-local"):
        fetch_trip("https://example.org", "20261027_06:37_de_1")
