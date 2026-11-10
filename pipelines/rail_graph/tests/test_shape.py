import numpy as np
import pytest
from pyproj import Geod
from shapely import LineString, Point

from gerlines_rail_graph.project import to_lonlat, to_xy
from gerlines_rail_graph.shape import (
    bake_ranges,
    bake_z,
    build_geometry,
    clean,
    content_hash,
    densify,
    insert_at,
    max_grade,
    outside_positions,
    projected_arc,
    rounded,
    runs_to_spans,
    simplify,
    thin_profile,
)

GEOD = Geod(ellps="WGS84")


def wiggly_track(rng: np.random.Generator, n: int = 400) -> np.ndarray:
    """A smooth random curve of several km in Germany, densely sampled, as (lon, lat)."""
    start = np.array([rng.uniform(6.5, 14.5), rng.uniform(47.8, 54.5)])
    xy0 = to_xy(np.array([start[0]]), np.array([start[1]]))[0]
    heading = np.cumsum(rng.normal(0, 0.02, n))
    steps = np.column_stack([np.cos(heading), np.sin(heading)]) * rng.uniform(20, 60)
    xy = xy0 + np.vstack([[0, 0], np.cumsum(steps, axis=0)])
    return to_lonlat(xy)


def stops_on(lonlat: np.ndarray, count: int, rng: np.random.Generator) -> np.ndarray:
    picks = np.sort(rng.choice(np.arange(1, len(lonlat) - 1), count - 2, replace=False))
    return lonlat[np.concatenate([[0], picks, [len(lonlat) - 1]])]


@pytest.mark.parametrize("seed", range(12))
def test_a_candidate_shape_keeps_its_properties(seed):
    rng = np.random.default_rng(seed)
    track = wiggly_track(rng)
    stops = stops_on(track, int(rng.integers(2, 9)), rng)

    built = build_geometry(track, stops, "motis", "pass")

    assert built.m[0] == 0
    assert np.all(np.diff(built.m) >= 0)
    geodesic = GEOD.line_length(built.lonlat[:, 0], built.lonlat[:, 1])
    assert built.length_m == pytest.approx(geodesic, rel=1e-3)
    assert built.stop_arc_m == sorted(built.stop_arc_m)
    assert built.stop_arc_m[0] >= 0
    assert built.stop_arc_m[-1] <= built.length_m
    line = LineString(to_xy(built.lonlat[:, 0], built.lonlat[:, 1]))
    stops_xy = to_xy(stops[:, 0], stops[:, 1])
    assert max(line.distance(Point(p)) for p in stops_xy) < 80
    original = GEOD.line_length(track[:, 0], track[:, 1])
    assert built.length_m == pytest.approx(original, rel=1e-3)


def test_a_straight_fallback_runs_stop_to_stop_with_stops_at_its_vertices():
    stops = np.array([[13.37, 52.52], [13.40, 52.52], [13.40, 52.52], [13.45, 52.50]])

    built = build_geometry(None, stops, "straight", "low_quality")

    assert len(built.lonlat) == 3
    assert built.stop_arc_m[0] == 0
    assert built.stop_arc_m[1] == built.stop_arc_m[2]
    assert built.stop_arc_m[-1] == pytest.approx(built.length_m)
    _, _, legs = GEOD.inv(stops[[0, 1, 2], 0], stops[[0, 1, 2], 1], stops[1:, 0], stops[1:, 1])
    assert built.length_m == pytest.approx(sum(legs), rel=1e-9)


def test_simplify_keeps_the_ends_and_stays_within_tolerance():
    rng = np.random.default_rng(3)
    lonlat = wiggly_track(rng)
    xy = to_xy(lonlat[:, 0], lonlat[:, 1])

    out = simplify(xy, 1.0)

    assert np.allclose(out[0], xy[0])
    assert np.allclose(out[-1], xy[-1])
    assert len(out) < len(xy)
    assert LineString(out).hausdorff_distance(LineString(xy)) <= 1.0 + 1e-6


def test_densify_bounds_every_edge():
    xy = np.array([[0.0, 0.0], [1000.0, 0.0], [1000.0, 50.0]])

    out = densify(xy, 200.0)

    assert np.hypot(*np.diff(out, axis=0).T).max() <= 200.0 + 1e-9
    assert projected_arc(out)[-1] == pytest.approx(1050.0)


def test_insert_at_adds_vertices_at_span_ends_without_moving_the_line():
    xy = np.array([[0.0, 0.0], [100.0, 0.0]])

    out = insert_at(xy, [25.0, 60.0, 0.0, 100.0])

    assert out[:, 0].tolist() == [0.0, 25.0, 60.0, 100.0]
    assert projected_arc(out)[-1] == 100.0


def test_runs_become_spans_and_close_runs_merge():
    mask = np.array([0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1], dtype=bool)

    assert runs_to_spans(mask, 10.0, gap_m=15.0) == [(10.0, 50.0), (90.0, 120.0)]


def test_bake_z_draws_a_straight_grade_across_a_range_and_keeps_the_rest():
    m = np.array([0.0, 100.0, 150.0, 200.0, 300.0])
    z = np.array([10.0, 20.0, 5.0, 40.0, 50.0])

    out = bake_z(m, z, [(100.0, 200.0, 110.0, 190.0)], [np.array([])], [np.array([])])

    assert out.tolist() == [10.0, 20.0, 30.0, 40.0, 50.0]
    assert np.isfinite(out).all()


def valley(m: np.ndarray) -> np.ndarray:
    """Terrain at 100 m with a valley 20 m deep under 480 to 520 m, its slopes 20 m wide."""
    return 100.0 - 20.0 * np.clip(np.minimum(m - 460.0, 540.0 - m) / 20.0, 0.0, 1.0)


def test_a_bridge_over_a_valley_wider_than_its_span_is_baked_from_the_terrain_beyond():
    spans = [(480.0, 520.0)]
    ranges = bake_ranges(spans, 1000.0)
    m = np.sort(np.concatenate([np.arange(0.0, 1001.0, 10.0), [455.0, 545.0]]))
    before, after = outside_positions(ranges, spans, 1000.0)

    out = bake_z(m, valley(m), ranges, [valley(p) for p in before], [valley(p) for p in after])

    assert ranges == [(455.0, 545.0, 480.0, 520.0)]
    assert out[(m >= 455.0) & (m <= 545.0)].tolist() == [100.0] * 11
    assert max_grade(m, out) <= 0.060
    assert max_grade(m, bake_z(m, valley(m), [(480.0, 520.0, 480.0, 520.0)], [], [])) > 0.060


def test_spans_overlapping_after_widening_merge_and_stay_on_the_shape():
    ranges = bake_ranges([(30.0, 100.0), (130.0, 200.0), (500.0, 990.0)], 1000.0)

    assert ranges == [(5.0, 225.0, 30.0, 200.0), (475.0, 1000.0, 500.0, 990.0)]


def test_outside_samples_avoid_other_structures_and_the_shape_ends():
    spans = [(100.0, 200.0), (260.0, 300.0)]
    ranges = bake_ranges(spans, 320.0)

    before, after = outside_positions(ranges, spans, 320.0)

    assert ranges == [(75.0, 225.0, 100.0, 200.0), (235.0, 320.0, 260.0, 300.0)]
    assert before[0].tolist() == [80.0, 70.0, 60.0, 50.0, 40.0]
    assert after[0].tolist() == [220.0, 230.0, 240.0, 250.0]
    assert before[1].tolist() == [240.0, 230.0, 220.0, 210.0]
    assert after[1].tolist() == [320.0]


def test_a_range_without_terrain_on_one_side_takes_the_other_side():
    m = np.array([0.0, 50.0, 100.0, 125.0, 200.0])
    z = np.array([5.0, 9.0, 9.0, 30.0, 31.0])

    out = bake_z(m, z, [(0.0, 125.0, 0.0, 100.0)], [np.array([])], [np.array([30.0, 31.0])])

    assert out.tolist() == [30.5, 30.5, 30.5, 30.5, 31.0]


def test_max_grade_measures_over_at_least_the_window():
    m = np.array([0.0, 10.0, 60.0, 200.0])
    z = np.array([0.0, 2.0, 3.0, 3.0])

    assert max_grade(m, z, 50.0) == pytest.approx(3.0 / 60.0)
    assert max_grade(np.array([0.0, 20.0]), np.array([0.0, 5.0]), 50.0) == 0.0


def test_thin_profile_keeps_plan_vertices_and_terrain_bends_only():
    m = np.arange(0.0, 1001.0, 100.0)
    z = np.where(m <= 500, m / 100, 5 + (m - 500) / 10)
    essential = np.zeros(len(m), dtype=bool)
    essential[3] = True

    keep = thin_profile(m, z, essential)

    assert np.flatnonzero(keep).tolist() == [0, 3, 5, 10]


def test_densified_vertices_are_marked_as_removable():
    rng = np.random.default_rng(9)
    track = wiggly_track(rng, 60)

    built = build_geometry(track, track[[0, -1]], "motis", "pass")

    assert built.essential is not None
    assert built.essential[0]
    assert built.essential[-1]
    assert not built.essential.all()


def test_clean_drops_repeats_and_non_finite_rows():
    rows = np.array([[1.0, 2.0], [1.0, 2.0], [np.nan, 1.0], [3.0, 4.0]])

    assert clean(rows).tolist() == [[1.0, 2.0], [3.0, 4.0]]


def test_the_content_hash_is_sha256_hex_and_follows_the_content():
    rng = np.random.default_rng(5)
    track = wiggly_track(rng, 50)
    built = build_geometry(track, track[[0, -1]], "pfaedle", "pass")
    coords = rounded(built.lonlat, np.zeros(len(built.m)), built.m)

    first = content_hash(coords, built)
    moved = coords.copy()
    moved[3, 2] += 1.0

    assert len(first) == 64
    assert int(first, 16) >= 0
    assert first == content_hash(coords.copy(), built)
    assert first != content_hash(moved, built)


def test_bake_range_ends_become_vertices_of_the_built_shape():
    track = wiggly_track(np.random.default_rng(4), 80)

    def structures(xy: np.ndarray) -> tuple[list, list]:
        return [(300.0, 500.0)], [(800.0, 820.0)]

    built = build_geometry(track, track[[0, -1]], "motis", "pass", structures)

    assert len(built.bake_ranges) == 2
    for start, end, first, last in built.bake_ranges:
        assert first - start == pytest.approx(25.0, abs=0.1)
        assert end - last == pytest.approx(25.0, abs=0.1)
        assert np.min(np.abs(built.m - start)) < 1e-6
        assert np.min(np.abs(built.m - end)) < 1e-6
        assert built.essential[np.argmin(np.abs(built.m - start))]


@pytest.mark.parametrize("seed", range(6))
def test_outside_positions_match_a_plain_check_on_many_structures(seed):
    rng = np.random.default_rng(seed)
    length = 50_000.0
    starts = np.sort(rng.uniform(0, length, 300))
    spans = [(float(a), float(min(a + rng.uniform(5, 400), length))) for a in starts]
    ranges = bake_ranges(spans, length)

    before, after = outside_positions(ranges, spans, length)

    def plain(positions: np.ndarray) -> list[float]:
        return [
            float(p)
            for p in positions
            if 0 <= p <= length and not any(a <= p <= b for a, b in spans)
        ]

    offsets = np.array([20.0, 30.0, 40.0, 50.0, 60.0])
    for k, (_, _, first, last) in enumerate(ranges):
        assert before[k].tolist() == plain(first - offsets)
        assert after[k].tolist() == plain(last + offsets)
