"""Checks on the committed outputs in apps/web/public/geo, so CI verifies them without downloads."""

import json
from functools import cache
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import shapely
from shapely import Point, Polygon
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from gerlines_geo_base.geojson import sizes
from gerlines_geo_base.geometry import WORLD, is_rfc7946_oriented, polygon_parts

GEO = Path(__file__).parents[3] / "apps" / "web" / "public" / "geo"
REPORT = Path(__file__).parents[1] / "build-report.json"

CODES = {
    "DE-BB", "DE-BE", "DE-BW", "DE-BY", "DE-HB", "DE-HE", "DE-HH", "DE-MV",
    "DE-NI", "DE-NW", "DE-RP", "DE-SH", "DE-SL", "DE-SN", "DE-ST", "DE-TH",
}  # fmt: skip
BORDERING = {"AT", "BE", "CH", "CZ", "DK", "FR", "LU", "NL", "PL"}

AREA_EPSILON = 1e-9
FOCUS_TO_NATIONAL_MAX_DEGREES = 0.01
OVERLAP_MAX_SHARE = 1e-6
JUNGHOLZ = Point(10.4517, 47.574)
CAPITALS = {
    "DE-BB": ("Potsdam", 13.0645, 52.3906),
    "DE-BE": ("Berlin", 13.4050, 52.5200),
    "DE-BW": ("Stuttgart", 9.1829, 48.7758),
    "DE-BY": ("München", 11.5755, 48.1374),
    "DE-HB": ("Bremen", 8.8017, 53.0793),
    "DE-HE": ("Wiesbaden", 8.2398, 50.0782),
    "DE-HH": ("Hamburg", 9.9937, 53.5511),
    "DE-MV": ("Schwerin", 11.4148, 53.6355),
    "DE-NI": ("Hannover", 9.7320, 52.3759),
    "DE-NW": ("Düsseldorf", 6.7735, 51.2277),
    "DE-RP": ("Mainz", 8.2473, 49.9929),
    "DE-SH": ("Kiel", 10.1228, 54.3233),
    "DE-SL": ("Saarbrücken", 6.9969, 49.2402),
    "DE-SN": ("Dresden", 13.7373, 51.0504),
    "DE-ST": ("Magdeburg", 11.6276, 52.1205),
    "DE-TH": ("Erfurt", 11.0299, 50.9848),
}
GERMAN_ISLANDS = {
    "Helgoland": ("DE-SH", 7.8857, 54.1818),
    "Neuwerk": ("DE-HH", 8.4965, 53.9165),
}

GZIP_BUDGET = {
    "germany-outline.geojson": 32_000,
    "germany-mask.geojson": 32_000,
    "laender.geojson": 90_000,
    "neighbours.geojson": 2_000,
    "border-crossings.geojson": 4_000,
}
LAND_MASK_GZIP_BUDGET = 40_000


@cache
def load(name: str) -> dict[str, Any]:
    return json.loads((GEO / name).read_text(encoding="utf-8"))


def geometries(name: str) -> list[BaseGeometry]:
    return [shape(f["geometry"]) for f in load(name)["features"]]


@cache
def national_laender() -> dict[str, BaseGeometry]:
    return {
        f["properties"]["code"]: shape(f["geometry"]) for f in load("laender.geojson")["features"]
    }


@cache
def focus_laender() -> dict[str, BaseGeometry]:
    result = {}
    for code in CODES:
        mask = shape(load(f"laender-masks/{code}.geojson")["features"][0]["geometry"])
        result[code] = shapely.difference(WORLD, mask)
    return result


def max_decimals(geometry: BaseGeometry) -> int:
    coords = shapely.get_coordinates(geometry).ravel()
    for decimals in range(8):
        if np.array_equal(coords, np.round(coords, decimals)):
            return decimals
    return 8


def output_names() -> list[str]:
    return sorted(str(p.relative_to(GEO)) for p in GEO.rglob("*.geojson"))


@pytest.mark.parametrize("name", output_names())
def test_every_output_names_its_source_and_licence(name: str) -> None:
    collection = load(name)

    assert collection["type"] == "FeatureCollection"
    assert collection["attribution"]
    assert collection["licence"]
    assert collection["sources"]
    assert all(source.startswith("https://") for source in collection["sources"])


@pytest.mark.parametrize("name", output_names())
def test_every_geometry_is_valid_and_rfc7946_oriented(name: str) -> None:
    for geometry in geometries(name):
        assert geometry.is_valid, name
        assert is_rfc7946_oriented(geometry), name


def test_outline_is_germany_rounded_for_national_zoom() -> None:
    (outline,) = geometries("germany-outline.geojson")
    west, south, east, north = outline.bounds

    assert (5.8 < west < 5.9, 47.2 < south < 47.3, 15.0 < east < 15.1, 55.0 < north < 55.1) == (
        True,
        True,
        True,
        True,
    )
    assert max_decimals(outline) <= 3


def test_outline_holes_are_foreign_enclaves_only() -> None:
    (outline,) = geometries("germany-outline.geojson")

    holes = [Polygon(ring) for part in polygon_parts(outline) for ring in part.interiors]

    assert len(holes) == 1
    assert holes[0].contains(JUNGHOLZ)


def test_mask_is_the_world_minus_the_outline() -> None:
    (outline,) = geometries("germany-outline.geojson")
    (mask,) = geometries("germany-mask.geojson")

    assert mask.bounds == WORLD.bounds
    assert shapely.intersection(mask, outline).area < AREA_EPSILON
    assert mask.area + outline.area == pytest.approx(WORLD.area, abs=AREA_EPSILON)
    assert mask.contains(JUNGHOLZ)


def test_laender_union_equals_the_outline() -> None:
    (outline,) = geometries("germany-outline.geojson")
    laender = np.array(list(national_laender().values()), dtype=object)

    assert set(national_laender()) == CODES
    assert shapely.coverage_is_valid(laender)
    assert shapely.symmetric_difference(shapely.coverage_union_all(laender), outline).area < (
        AREA_EPSILON
    )


@pytest.mark.parametrize("level", ["national", "focus"])
def test_laender_do_not_overlap(level: str) -> None:
    laender = national_laender() if level == "national" else focus_laender()
    polygons = list(laender.values())

    union = shapely.union_all(polygons)
    overlap = sum(p.area for p in polygons) - union.area

    assert overlap <= OVERLAP_MAX_SHARE * union.area


def test_focus_laender_match_the_outline_within_the_simplification_tolerance() -> None:
    (outline,) = geometries("germany-outline.geojson")
    focus_union = shapely.union_all(list(focus_laender().values()))

    national_points = shapely.points(
        shapely.get_coordinates(shapely.segmentize(outline.boundary, 0.005))
    )
    distance = shapely.distance(national_points, focus_union.boundary).max()

    assert distance < FOCUS_TO_NATIONAL_MAX_DEGREES
    assert shapely.symmetric_difference(focus_union, outline).area < 0.002 * outline.area


@pytest.mark.parametrize("code", sorted(CAPITALS))
def test_each_land_holds_its_capital_at_both_levels(code: str) -> None:
    _, lon, lat = CAPITALS[code]
    capital = Point(lon, lat)

    assert national_laender()[code].contains(capital)
    assert focus_laender()[code].contains(capital)
    assert [c for c, land in national_laender().items() if land.contains(capital)] == [code]


@pytest.mark.parametrize("island", sorted(GERMAN_ISLANDS))
def test_named_islands_are_never_shown_as_abroad(island: str) -> None:
    code, lon, lat = GERMAN_ISLANDS[island]
    point = Point(lon, lat)
    (outline,) = geometries("germany-outline.geojson")
    (mask,) = geometries("germany-mask.geojson")

    assert outline.contains(point)
    assert not mask.intersects(point)
    assert national_laender()[code].contains(point)
    assert focus_laender()[code].contains(point)


def test_focus_laender_leave_only_the_jungholz_hole() -> None:
    union = shapely.union_all(list(focus_laender().values()))

    holes = [Polygon(ring) for part in polygon_parts(union) for ring in part.interiors]

    assert len(holes) == 1
    assert holes[0].contains(JUNGHOLZ)


@pytest.mark.parametrize("code", sorted(CODES))
def test_each_mask_file_names_its_own_land(code: str) -> None:
    (feature,) = load(f"laender-masks/{code}.geojson")["features"]

    assert feature["properties"]["code"] == code
    assert feature["properties"]["role"] == "outside-land"


def test_focus_masks_keep_four_decimals() -> None:
    assert all(max_decimals(g) <= 4 for g in focus_laender().values())


@pytest.mark.parametrize(
    "feature", load("laender.geojson")["features"], ids=lambda f: f["properties"]["code"]
)
def test_land_has_names_label_and_bounds(feature: dict[str, Any]) -> None:
    props = feature["properties"]
    code = props["code"]
    label = Point(props["label_lon"], props["label_lat"])
    west, south, east, north = feature["bbox"]
    fit = (props["fit_west"], props["fit_south"], props["fit_east"], props["fit_north"])

    assert all(props[key].strip() for key in ("name_en", "name_de", "name_pl"))
    assert national_laender()[code].contains(label)
    assert focus_laender()[code].contains(label)
    assert shapely.box(west, south, east, north).contains(focus_laender()[code])
    assert west - 1e-4 <= fit[0] < fit[2] <= east + 1e-4
    assert south - 1e-4 <= fit[1] < fit[3] <= north + 1e-4
    assert shapely.box(*fit).contains(label)


def test_neighbours_cover_every_bordering_country_with_three_names() -> None:
    (outline,) = geometries("germany-outline.geojson")
    features = load("neighbours.geojson")["features"]

    bordering = {f["properties"]["code"] for f in features if f["properties"]["shares_border"]}

    assert bordering == BORDERING
    for f in features:
        props = f["properties"]
        assert all(props[key].strip() for key in ("name_en", "name_de", "name_pl"))
        assert not outline.contains(shape(f["geometry"]))


def test_border_crossings_lie_on_the_border_and_name_a_bordering_country() -> None:
    (outline,) = geometries("germany-outline.geojson")
    features = load("border-crossings.geojson")["features"]

    assert len(features) >= 40
    for f in features:
        assert f["properties"]["country"] in BORDERING
        assert shape(f["geometry"]).distance(outline.boundary) < 0.001


def test_outputs_stay_within_their_gzip_budget() -> None:
    for name, budget in GZIP_BUDGET.items():
        assert sizes((GEO / name).read_bytes())["gzip_bytes"] <= budget, name
    for code in CODES:
        data = (GEO / "laender-masks" / f"{code}.geojson").read_bytes()
        assert sizes(data)["gzip_bytes"] <= LAND_MASK_GZIP_BUDGET, code


def test_build_report_matches_the_committed_files() -> None:
    report = json.loads(REPORT.read_text(encoding="utf-8"))

    assert set(report["outputs"]) == set(output_names())
    for name, measured in report["outputs"].items():
        assert sizes((GEO / name).read_bytes()) == measured, name
