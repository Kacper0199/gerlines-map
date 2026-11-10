import itertools
import json

import numpy as np
import pytest

from gerlines_rail_graph.patterns import Pattern
from gerlines_rail_graph.project import to_lonlat, to_xy
from gerlines_rail_graph.splice import (
    SPLICE_JOIN_M,
    TripShape,
    read_trip_shapes,
    splice_legs,
    splice_turn_legs,
    turn_legs,
)
from gerlines_rail_graph.spurs import arc, sharp_pair_near, u_turns

ORIGIN = np.array([500_000.0, 5_550_000.0])


def trip(local_points, stop_local) -> TripShape:
    """A pfaedle trip shape from local metres: lon and lat, distance along it, stop distances."""
    xy = np.asarray(local_points, dtype=float) + ORIGIN
    dist = arc(xy)
    stops = [
        float(dist[int(np.argmin(np.hypot(*(xy - point).T)))])
        for point in np.asarray(stop_local, dtype=float) + ORIGIN
    ]
    return TripShape(to_lonlat(xy), dist, np.array(stops))


def densify(points, step: float = 50.0) -> np.ndarray:
    corners = np.asarray(points, dtype=float)
    out = [corners[0]]
    for a, b in itertools.pairwise(corners):
        n = max(1, int(np.ceil(np.hypot(*(b - a)) / step)))
        out.extend(a + (b - a) * t for t in np.linspace(0, 1, n + 1)[1:])
    return np.array(out)


STOPS = [[0, 0], [10_000, 0], [20_000, 0], [30_000, 0]]
STRAIGHT = densify([[0, 0], [30_000, 0]])
TURN_IN_LEG_1 = densify(
    [
        [0, 0],
        [10_000, 0],
        [12_000, 2_000],
        [17_000, 2_000],
        [12_000, 2_005],
        [14_000, 0],
        [20_000, 0],
        [30_000, 0],
    ]
)


def xy_of(lonlat: np.ndarray) -> np.ndarray:
    return to_xy(lonlat[:, 0], lonlat[:, 1]) - ORIGIN


def test_a_u_turn_between_two_stops_marks_its_leg():
    shape = trip(TURN_IN_LEG_1, STOPS)

    assert len(u_turns(to_xy(shape.lonlat[:, 0], shape.lonlat[:, 1]))) == 1
    assert turn_legs(shape) == [1]


def test_a_reversal_at_a_stop_marks_no_leg():
    back = densify([[0, 0], [10_000, 0], [20_000, 0], [10_000, 5], [0, 5]])
    shape = trip(back, [[0, 0], [10_000, 0], [20_000, 0], [10_000, 5], [0, 5]])

    assert turn_legs(shape) == []


def test_a_u_turn_near_a_curated_station_marks_no_leg():
    shape = trip(TURN_IN_LEG_1, STOPS)
    station = np.array([[17_000.0, 2_000.0]]) + ORIGIN

    assert turn_legs(shape, station) == []


def test_the_turning_leg_is_taken_from_the_alternate_and_the_rest_kept():
    default = trip(TURN_IN_LEG_1, STOPS)
    alternate = trip(densify([[0, 3], [10_000, 3], [20_000, 3], [30_000, 3]]), STOPS)

    spliced = splice_legs(default, alternate, [1])

    xy = xy_of(spliced)
    assert len(u_turns(xy + ORIGIN)) == 0
    assert np.max(xy[:, 1]) < 10
    first = xy[xy[:, 0] < 9_000]
    last = xy[xy[:, 0] > 21_000]
    assert np.allclose(first[:, 1], 0.0, atol=0.01)
    assert np.allclose(last[:, 1], 0.0, atol=0.01)
    middle = xy[(xy[:, 0] > 11_000) & (xy[:, 0] < 19_000)]
    assert np.allclose(middle[:, 1], 3.0, atol=0.01)
    assert xy[0] == pytest.approx([0, 0], abs=0.01)
    assert xy[-1] == pytest.approx([30_000, 0], abs=0.01)


def test_a_joint_farther_than_the_limit_refuses_the_splice():
    default = trip(TURN_IN_LEG_1, STOPS)
    far = SPLICE_JOIN_M + 5
    alternate = trip(densify([[0, far], [30_000, far]]), STOPS)

    assert splice_legs(default, alternate, [1]) is None


def test_an_end_leg_runs_to_the_alternate_end_without_a_joint_there():
    turn_last = densify(
        [
            [0, 0],
            [20_000, 0],
            [22_000, 2_000],
            [27_000, 2_000],
            [22_000, 2_005],
            [24_000, 0],
            [30_000, 0],
        ]
    )
    default = trip(turn_last, STOPS)
    alternate = trip(densify([[0, 0], [20_000, 0], [25_000, 2], [30_000, 42]]), STOPS)

    assert turn_legs(default) == [2]
    spliced = splice_legs(default, alternate, [2])

    assert spliced is not None
    assert xy_of(spliced)[-1] == pytest.approx([30_000, 42], abs=0.01)


def trip_with_stop_dist(local_points, stop_dist) -> TripShape:
    xy = np.asarray(local_points, dtype=float) + ORIGIN
    return TripShape(to_lonlat(xy), arc(xy), np.asarray(stop_dist, dtype=float))


@pytest.mark.parametrize("offset", [-20.0, 20.0])
def test_a_joint_whose_stop_points_are_offset_along_the_track_never_steps_back(offset):
    default = trip(TURN_IN_LEG_1, STOPS)
    line = densify([[0, 8], [30_000, 8]], step=10.0)
    alternate = trip_with_stop_dist(line, [0.0, 10_000.0 - offset, 20_000.0 + offset, 30_000.0])

    spliced = splice_legs(default, alternate, [1])

    assert spliced is not None
    xy = xy_of(spliced)
    assert np.all(np.diff(xy[:, 0]) >= -0.01)
    assert not sharp_pair_near(xy + ORIGIN, 10_000.0, 200.0)
    assert not sharp_pair_near(xy + ORIGIN, 20_000.0, 200.0)


@pytest.mark.parametrize("short", [20.0, 60.0, 99.0])
def test_a_short_leg_between_two_spliced_legs_never_steps_back(short):
    stops = [0.0, 10_000.0, 10_000.0 + short, 20_000.0]
    default = trip_with_stop_dist(densify([[0, 0], [20_000, 0]], step=2.0), stops)
    line = densify([[0, 3], [20_000, 3]], step=2.0)
    alternate = trip_with_stop_dist(line, [0.0, 9_990.0, 9_996.0, 20_000.0])

    spliced = splice_legs(default, alternate, [0, 2])

    assert spliced is not None
    assert np.all(np.diff(xy_of(spliced)[:, 0]) >= -0.01)


def test_two_neighbouring_legs_are_taken_in_one_piece():
    default = trip(STRAIGHT, STOPS)
    alternate = trip(densify([[0, 0], [10_000, 0], [20_000, 10], [30_000, 0]]), STOPS)

    spliced = splice_legs(default, alternate, [1, 2])

    xy = xy_of(spliced)
    assert np.max(xy[:, 1]) == pytest.approx(10.0, abs=0.01)
    assert np.all(np.diff(xy[:, 0]) > 0)


def test_a_different_stop_count_refuses_the_splice():
    default = trip(TURN_IN_LEG_1, STOPS)
    alternate = trip(STRAIGHT, STOPS[:3])

    assert splice_legs(default, alternate, [1]) is None


def pattern_of(stops_local) -> Pattern:
    lonlat = to_lonlat(np.asarray(stops_local, dtype=float) + ORIGIN)
    return Pattern(
        pattern_id="p",
        route_key="r",
        route_short_name="50",
        category="hsr",
        direction_id=0,
        stops=[(f"s{i}", f"S{i}", float(lo), float(la)) for i, (lo, la) in enumerate(lonlat)],
        rep_trip="t",
        rep_date="2026-10-26",
        rep_departure_s=3600,
        trips=1,
        trip_days_week=7,
        length_km=30.0,
    )


def test_only_a_shape_with_a_turn_fault_is_spliced():
    pattern = pattern_of(STOPS)
    default = trip(TURN_IN_LEG_1, STOPS)
    alternate = trip(densify([[0, 3], [30_000, 3]]), STOPS)

    shapes, spliced, summary = splice_turn_legs(
        [pattern], {"p": default.lonlat}, {"t": default}, {"t": alternate}
    )

    assert spliced == {"p": [1]}
    assert len(u_turns(to_xy(shapes["p"][:, 0], shapes["p"][:, 1]))) == 0
    assert summary["spliced_patterns"] == 1
    assert summary["spliced_legs"] == 1


def test_a_clean_shape_is_left_as_it_is():
    pattern = pattern_of(STOPS)
    default = trip(STRAIGHT, STOPS)
    alternate = trip(densify([[0, 3], [30_000, 3]]), STOPS)

    shapes, spliced, _ = splice_turn_legs(
        [pattern], {"p": default.lonlat}, {"t": default}, {"t": alternate}
    )

    assert spliced == {}
    assert shapes["p"] is default.lonlat


def test_a_splice_that_keeps_a_turn_fault_is_dropped():
    pattern = pattern_of(STOPS)
    default = trip(TURN_IN_LEG_1, STOPS)

    shapes, spliced, summary = splice_turn_legs(
        [pattern], {"p": default.lonlat}, {"t": default}, {"t": default}
    )

    assert spliced == {}
    assert shapes["p"] is default.lonlat
    assert summary["refused"] == 1


def test_a_missing_alternate_trip_keeps_the_default():
    pattern = pattern_of(STOPS)
    default = trip(TURN_IN_LEG_1, STOPS)

    shapes, spliced, summary = splice_turn_legs(
        [pattern], {"p": default.lonlat}, {"t": default}, {}
    )

    assert spliced == {}
    assert shapes["p"] is default.lonlat
    assert summary["with_turn_fault"] == 1


def write_feed(folder, trip_id: str, shape: TripShape, shape_id: str = "shp_1") -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "trips.txt").write_text(
        f"route_id,service_id,trip_id,shape_id\nr,s,{trip_id},{shape_id}\nr,s,other,shp_2\n"
    )
    rows = ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled"]
    rows.extend(
        f"{shape_id},{shape.lonlat[i, 1]:.7f},{shape.lonlat[i, 0]:.7f},{i + 1},{shape.dist[i]:.2f}"
        for i in reversed(range(len(shape.dist)))
    )
    rows.append("shp_2,50.0,8.0,1,0.0")
    (folder / "shapes.txt").write_text("\n".join(rows) + "\n")
    stops = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled"]
    stops.extend(
        f"{trip_id},00:00:00,00:00:00,s{k},{k},{shape.stop_dist[k]:.2f}"
        for k in reversed(range(len(shape.stop_dist)))
    )
    stops.append("other,00:00:00,00:00:00,x,0,0.0")
    (folder / "stop_times.txt").write_text("\n".join(stops) + "\n")


def test_trip_shapes_are_read_with_distances_in_sequence_order(tmp_path):
    shape = trip(TURN_IN_LEG_1, STOPS)
    write_feed(tmp_path, "t", shape)

    found = read_trip_shapes(tmp_path, ["t"])

    assert set(found) == {"t"}
    assert np.allclose(found["t"].lonlat, shape.lonlat, atol=1e-6)
    assert np.allclose(found["t"].dist, shape.dist, atol=0.01)
    assert np.allclose(found["t"].stop_dist, shape.stop_dist, atol=0.01)


def test_a_trip_without_stop_distances_is_left_out(tmp_path):
    shape = trip(STRAIGHT, STOPS)
    write_feed(tmp_path, "t", shape)
    text = (tmp_path / "stop_times.txt").read_text().replace(f"{shape.stop_dist[1]:.2f}", "")
    (tmp_path / "stop_times.txt").write_text(text)

    assert read_trip_shapes(tmp_path, ["t"]) == {}


def test_the_spliced_file_lists_legs_per_pattern(tmp_path):
    pattern = pattern_of(STOPS)
    default = trip(TURN_IN_LEG_1, STOPS)
    alternate = trip(densify([[0, 3], [30_000, 3]]), STOPS)
    write_feed(tmp_path / "default", "t", default)
    write_feed(tmp_path / "alternate", "t", alternate)

    from gerlines_rail_graph.candidates import extract_pfaedle  # noqa: PLC0415

    shapes, summary = extract_pfaedle([pattern], tmp_path / "default", tmp_path / "alternate")

    assert summary["splice"]["spliced"] == {"p": [1]}
    assert json.loads(json.dumps(summary))["splice"]["spliced_legs"] == 1
    assert len(u_turns(to_xy(shapes["p"][:, 0], shapes["p"][:, 1]))) == 0


def sidecar(osm="o1", gtfs="g1", image="img", params=None) -> dict:
    return {"image": image, "osm": {"sha256": osm}, "gtfs": {"sha256": gtfs}, "params": params}


def test_an_alternate_run_must_read_the_same_inputs_with_parameters():
    from gerlines_rail_graph.pipeline import check_alternate  # noqa: PLC0415

    strict = {"path": "config/pfaedle-strict-turns.cfg", "text": "[rail]\n"}
    check_alternate(sidecar(), sidecar(params=strict))
    for bad in (
        sidecar(osm="o2", params=strict),
        sidecar(gtfs="g2", params=strict),
        sidecar(image="other", params=strict),
        sidecar(),
    ):
        with pytest.raises(SystemExit):
            check_alternate(sidecar(), bad)


def test_a_shape_with_a_point_without_distance_is_left_out(tmp_path):
    shape = trip(STRAIGHT, STOPS)
    write_feed(tmp_path, "t", shape)
    lines = (tmp_path / "shapes.txt").read_text().splitlines()
    lines[5] = lines[5].rsplit(",", 1)[0] + ","
    (tmp_path / "shapes.txt").write_text("\n".join(lines) + "\n")

    assert read_trip_shapes(tmp_path, ["t"]) == {}


def test_loaded_provenance_names_the_strict_turn_run(tmp_path):
    from gerlines_rail_graph.pipeline_shapes import load_provenance  # noqa: PLC0415

    strict = {"params": {"path": "config/pfaedle-strict-turns.cfg"}}
    for name, body in (
        ("patterns", {"feed_sha256": "f"}),
        ("fetch-motis", {"router_run": "r"}),
        ("extract-pfaedle", {"pfaedle_inputs": {"image": "i"}, "alternate_inputs": strict}),
    ):
        (tmp_path / f"{name}.json").write_text(json.dumps(body))

    provenance = load_provenance(tmp_path)

    assert provenance["extract-pfaedle"] == {"image": "i"}
    assert provenance["extract-pfaedle-alternate"] == strict


def test_sidecar_params_are_what_the_run_wrote_and_must_match_the_named_file(tmp_path):
    from gerlines_rail_graph.pipeline import pfaedle_params  # noqa: PLC0415

    named = tmp_path / "strict.cfg"
    named.write_text("# comment\n[rail]\nrouting_full_turn_penalty: 1800\n")
    run = tmp_path / "run"
    run.mkdir()

    with pytest.raises(SystemExit):
        pfaedle_params(run, named)
    (run / "params.cfg").write_text("[rail]\nrouting_full_turn_penalty: 1800\n")
    assert pfaedle_params(run, named) == {
        "path": str(named),
        "text": "[rail]\nrouting_full_turn_penalty: 1800\n",
    }
    (run / "params.cfg").write_text("[rail]\nrouting_full_turn_penalty: 600\n")
    with pytest.raises(SystemExit):
        pfaedle_params(run, named)
    assert pfaedle_params(run, None) is None


TURN_IN_LEG_2_AND_ZIGZAG_IN_LEG_0 = densify(
    [
        [0, 0],
        [4_100, 0],
        [4_000, 5],
        [10_000, 5],
        [20_000, 5],
        [22_000, 2_000],
        [27_000, 2_000],
        [22_000, 2_005],
        [24_000, 5],
        [30_000, 5],
    ]
)


def test_only_legs_whose_turn_survives_the_spur_cut_are_replaced():
    pattern = pattern_of(STOPS)
    default = trip(TURN_IN_LEG_2_AND_ZIGZAG_IN_LEG_0, STOPS)
    alternate = trip(
        densify([[0, 5], [4_000, 5], [4_000, 1_500], [4_100, 1_500], [4_100, 5], [30_000, 5]]),
        STOPS,
    )
    shapes = {"p": default.lonlat}

    assert 0 in turn_legs(alternate)
    out, spliced, _ = splice_turn_legs([pattern], shapes, {"t": default}, {"t": alternate})

    assert spliced == {"p": [2]}
    assert np.max(xy_of(out["p"])[:, 1]) < 100


def test_a_splice_that_adds_a_reversal_at_a_stop_is_refused():
    from gerlines_rail_graph.splice import adds_reversal  # noqa: PLC0415

    stops = np.asarray(STOPS, dtype=float) + ORIGIN
    default = trip(TURN_IN_LEG_1, STOPS)
    back = to_lonlat(densify([[0, 0], [20_000, 0], [19_000, 5], [0, 5]]) + ORIGIN)

    assert adds_reversal(back, default.lonlat, stops)
    assert not adds_reversal(default.lonlat, default.lonlat, stops)
