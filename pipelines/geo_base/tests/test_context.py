import pytest
import shapely
from shapely import LineString, Point, box

from gerlines_geo_base.context import (
    Country,
    RailLine,
    border_crossings,
    nearby_countries,
)

GERMANY = box(0, 0, 100_000, 100_000)


def country(code: str, geometry: shapely.Geometry) -> Country:
    return Country(code, f"{code} en", f"{code} de", f"{code} pl", geometry)


def test_nearby_countries_flags_land_borders_and_skips_distant_ones() -> None:
    east = country("PL", box(100_000, 0, 400_000, 100_000))
    across_the_sea = country("SE", box(0, 150_000, 100_000, 300_000))
    far = country("ES", box(-2_000_000, 0, -1_500_000, 100_000))

    found = nearby_countries(
        GERMANY, [east, across_the_sea, far], max_distance=60_000, label_band=50_000
    )

    assert [(n.country.code, n.shares_border) for n in found] == [("PL", True), ("SE", False)]


def test_nearby_country_label_sits_inside_the_country_close_to_germany() -> None:
    east = country("PL", box(100_000, 0, 1_000_000, 100_000))

    (neighbour,) = nearby_countries(GERMANY, [east], max_distance=1_000, label_band=60_000)

    assert east.geometry.contains(neighbour.label)
    assert neighbour.label.x < 100_000 + 60_000
    assert not GERMANY.contains(neighbour.label)


def test_border_crossings_name_the_country_on_the_other_side() -> None:
    east = country("PL", box(100_000, 0, 400_000, 100_000))
    west = country("NL", box(-300_000, 0, 0, 100_000))
    line = RailLine("4711", LineString([(50_000, 50_000), (150_000, 50_000)]))
    trans = RailLine("4712", LineString([(-50_000, 20_000), (150_000, 20_000)]))

    crossings = border_crossings(GERMANY, [line, trans], [east, west], max_gap=5_000, merge=2_000)

    found = sorted((c.country, round(c.point.x), round(c.point.y), c.source_id) for c in crossings)
    assert found == [
        ("NL", 0, 20_000, "4712"),
        ("PL", 100_000, 20_000, "4712"),
        ("PL", 100_000, 50_000, "4711"),
    ]


def test_border_crossings_skip_the_coast() -> None:
    coastal = RailLine("1", LineString([(50_000, 50_000), (50_000, 150_000)]))

    assert border_crossings(GERMANY, [coastal], [], max_gap=5_000, merge=2_000) == []


def test_border_crossings_merge_points_closer_than_the_merge_distance() -> None:
    east = country("CZ", box(100_000, 0, 400_000, 100_000))
    wiggle = RailLine(
        "9",
        LineString([(90_000, 50_000), (101_000, 50_000), (101_000, 50_500), (99_000, 50_500)]),
    )

    crossings = border_crossings(GERMANY, [wiggle], [east], max_gap=5_000, merge=2_000)

    assert len(crossings) == 1
    assert crossings[0].point.distance(Point(100_000, 50_000)) == pytest.approx(0)
