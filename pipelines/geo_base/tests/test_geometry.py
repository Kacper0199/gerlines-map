import numpy as np
import pytest
import shapely
from shapely import MultiPolygon, Point, Polygon, box

from gerlines_geo_base.geometry import (
    WORLD,
    core_parts,
    drop_small_parts,
    is_rfc7946_oriented,
    label_point,
    outward_bbox,
    round_coordinates,
    simplify_coverage,
    world_minus,
)


def jagged_pair() -> tuple[Polygon, Polygon]:
    """Two squares sharing a zig-zag edge at x = 10 with identical vertices."""
    zigzag = [(10 + (0.3 if i % 2 else 0.0), float(i)) for i in range(11)]
    left = Polygon([(0, 0), *zigzag, (0, 10)])
    right = Polygon([(20, 0), (20, 10), *reversed(zigzag)])
    return left, right


def test_drop_small_parts_removes_islands_below_the_threshold() -> None:
    mainland = box(0, 0, 10, 10)
    island = box(20, 20, 20.5, 20.5)

    result = drop_small_parts(MultiPolygon([mainland, island]), min_area=1.0)

    assert result.equals(MultiPolygon([mainland]))


def test_drop_small_parts_keeps_the_largest_part_when_all_are_small() -> None:
    tiny = box(0, 0, 0.5, 0.5)
    tinier = box(5, 5, 5.2, 5.2)

    result = drop_small_parts(MultiPolygon([tiny, tinier]), min_area=1.0)

    assert result.equals(MultiPolygon([tiny]))


def test_simplify_coverage_keeps_shared_edges_identical() -> None:
    left, right = jagged_pair()
    assert shapely.coverage_is_valid([left, right])

    simplified = simplify_coverage([left, right], tolerance=2.0, min_part_area=0.0)

    assert shapely.coverage_is_valid(simplified)
    assert all(shapely.is_valid(simplified))
    assert (
        shapely.get_num_coordinates(simplified).sum()
        < shapely.get_num_coordinates([left, right]).sum()
    )
    assert shapely.area(shapely.coverage_union_all(simplified)) == pytest.approx(200, rel=0.02)


def test_simplify_coverage_keeps_small_enclaves_so_no_gap_opens() -> None:
    enclave = box(4, 4, 5, 5)
    host = box(0, 0, 10, 10).difference(enclave)
    owner = MultiPolygon([box(10, 0, 20, 10), enclave])
    islet = box(30, 30, 30.5, 30.5)

    simplified = simplify_coverage(
        [host, MultiPolygon([*owner.geoms, islet])], tolerance=0.1, min_part_area=2.0
    )

    union = shapely.coverage_union_all(simplified)
    assert union.equals(box(0, 0, 20, 10))
    assert shapely.get_num_interior_rings(shapely.get_parts(union)).sum() == 0
    assert simplified[0].contains(Point(4.5, 4.5))
    assert shapely.coverage_is_valid(simplified)


def test_simplify_coverage_keeps_small_parts_that_hold_a_named_point() -> None:
    mainland = box(0, 0, 10, 10)
    named_islet = box(30, 30, 30.5, 30.5)
    other_islet = box(40, 40, 40.5, 40.5)

    simplified = simplify_coverage(
        [MultiPolygon([mainland, named_islet, other_islet])],
        tolerance=0.01,
        min_part_area=2.0,
        keep=[Point(30.25, 30.25)],
    )

    assert simplified[0].contains(Point(30.25, 30.25))
    assert not simplified[0].intersects(other_islet)


def test_round_coordinates_keeps_shared_vertices_shared() -> None:
    left, right = jagged_pair()
    shifted = [shapely.affinity.translate(g, 0.123456, 0.987654) for g in (left, right)]

    rounded = [round_coordinates(g, 2) for g in shifted]

    assert shapely.coverage_is_valid(rounded)
    coords = np.concatenate([shapely.get_coordinates(g) for g in rounded])
    assert np.array_equal(coords, np.round(coords, 2))


def test_world_minus_cuts_holes_for_every_part_and_fills_enclaves() -> None:
    donut = box(0, 40, 10, 50).difference(box(4, 44, 6, 46))
    exclave = box(20, 40, 21, 41)
    country = MultiPolygon([donut, exclave])

    mask = world_minus(country)

    assert mask.is_valid
    assert is_rfc7946_oriented(mask)
    assert not mask.intersects(Point(2, 42))
    assert not mask.intersects(Point(20.5, 40.5))
    assert mask.contains(Point(5, 45))
    assert mask.contains(Point(-100, 0))
    assert mask.area == pytest.approx(WORLD.area - country.area)


def test_world_minus_stays_inside_the_web_mercator_world() -> None:
    mask = world_minus(box(0, 0, 1, 1))

    minx, miny, maxx, maxy = mask.bounds

    assert (minx, maxx) == (-180.0, 180.0)
    assert maxy < 85.06
    assert miny > -85.06


def test_is_rfc7946_oriented_detects_a_clockwise_exterior() -> None:
    clockwise = Polygon([(0, 0), (0, 1), (1, 1), (1, 0)])

    assert not is_rfc7946_oriented(clockwise)
    assert is_rfc7946_oriented(shapely.orient_polygons(clockwise, exterior_cw=False))


def test_label_point_lies_inside_a_concave_polygon() -> None:
    horseshoe = box(0, 0, 10, 10).difference(box(3, 0, 7, 8))

    point = label_point(horseshoe, precision=0.01)

    assert horseshoe.contains(point)


def test_label_point_uses_the_largest_part() -> None:
    big = box(0, 0, 10, 10)
    small = box(100, 100, 101, 101)

    point = label_point(MultiPolygon([small, big]), precision=0.01)

    assert big.contains(point)


def test_label_point_avoids_holes() -> None:
    ring = box(0, 0, 10, 10).difference(box(2, 2, 8, 8))

    point = label_point(ring, precision=0.01)

    assert ring.contains(point)


def test_core_parts_keep_large_and_nearby_parts_and_drop_far_islets() -> None:
    mainland = box(0, 0, 100, 100)
    nearby_island = box(120, 0, 125, 5)
    far_large_exclave = box(500, 500, 540, 540)
    far_islet = box(1000, 0, 1005, 5)

    core = core_parts(
        MultiPolygon([mainland, nearby_island, far_large_exclave, far_islet]),
        max_gap=40,
        min_share=0.1,
    )

    assert core.equals(MultiPolygon([mainland, nearby_island, far_large_exclave]))


def test_outward_bbox_contains_the_geometry_after_rounding() -> None:
    geometry = box(5.86642, 47.27012, 15.04181, 55.05866)

    west, south, east, north = outward_bbox(geometry, decimals=2)

    assert (west, south, east, north) == (5.86, 47.27, 15.05, 55.06)
