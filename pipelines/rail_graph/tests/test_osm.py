import pytest

from gerlines_rail_graph.metrics import WayClass
from gerlines_rail_graph.osm import classify_route, way_class


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ({"type": "route", "route": "light_rail", "ref": "S5"}, "sbahn"),
        ({"type": "route", "route": "train", "service": "commuter", "ref": "RB 33"}, "sbahn"),
        ({"type": "route", "route": "train", "ref": "S 8"}, "sbahn"),
        ({"type": "route", "route": "train", "ref": "S1"}, "sbahn"),
        ({"type": "route", "route": "train", "service": "long_distance", "ref": "ICE 29"}, "main"),
        ({"type": "route", "route": "train", "ref": "RE 1"}, "main"),
        ({"type": "route", "route": "train", "ref": "SE 10"}, "main"),
        ({"type": "route", "route": "railway", "ref": "4000"}, None),
        ({"type": "route", "route": "subway", "ref": "U2"}, None),
        ({"type": "route", "route": "tram", "ref": "S1"}, None),
    ],
)
def test_classifies_passenger_route_relations(tags, expected):
    assert classify_route(tags) == expected


@pytest.mark.parametrize(
    ("kinds", "railway", "expected"),
    [
        (set(), "rail", WayClass.UNTYPED),
        (set(), "light_rail", WayClass.SBAHN),
        ({"sbahn"}, "rail", WayClass.SBAHN),
        ({"main"}, "rail", WayClass.MAIN),
        ({"main"}, "light_rail", WayClass.MAIN),
        ({"main", "sbahn"}, "rail", WayClass.SHARED),
    ],
)
def test_way_class_comes_from_its_routes_then_from_the_railway_tag(kinds, railway, expected):
    assert way_class(kinds, railway) == expected
