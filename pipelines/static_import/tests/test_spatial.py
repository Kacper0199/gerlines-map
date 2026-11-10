from dataclasses import dataclass
from pathlib import Path

import pytest

from gerlines_static_import.spatial import GridIndex, NationalOutline, distance_m

REAL_OUTLINE = Path(__file__).resolve().parents[3] / "apps/web/public/geo/germany-outline.geojson"


@dataclass(frozen=True)
class Spot:
    name: str
    lat: float | None
    lon: float | None


def test_outline_contains_inland_points_and_a_buffer_at_the_border(outline_path: Path) -> None:
    outline = NationalOutline.from_geojson(outline_path, buffer_m=500)
    assert outline.contains(51.505, 10.793)
    assert outline.contains(52.0, 14.503)
    assert not outline.contains(52.348837, 14.564)
    assert not outline.contains(None, 10.0)


@pytest.mark.parametrize(
    ("name", "lat", "lon", "inside"),
    [
        ("Nordhausen Nord", 51.5050, 10.7930, True),
        ("Görlitz", 51.1462, 14.9752, True),
        ("Westerland (Sylt)", 54.9071, 8.3105, True),
        ("Słubice", 52.3488, 14.5640, False),
        ("Kufstein", 47.5833, 12.1656, False),
        ("Basel SBB", 47.5476, 7.5897, False),
        ("Strasbourg", 48.5850, 7.7350, False),
    ],
)
def test_real_outline_places_border_stations(
    name: str, lat: float, lon: float, inside: bool
) -> None:
    outline = NationalOutline.from_geojson(REAL_OUTLINE)
    assert outline.contains(lat, lon) is inside, name


def test_grid_yields_neighbours_across_cell_edges() -> None:
    spots = [Spot("a", 50.0199, 8.0), Spot("b", 50.0201, 8.0), Spot("far", 51.0, 8.0)]
    grid = GridIndex([*spots, Spot("no position", None, None)])
    assert {s.name for s in grid.near(50.0199, 8.0)} == {"a", "b"}


def test_distance_is_haversine_metres() -> None:
    assert distance_m(52.0, 13.0, 52.0, 13.0) == 0
    assert distance_m(52.0, 13.0, 53.0, 13.0) == pytest.approx(111_195, rel=1e-3)
