from gerlines_static_import.platform_codes import (
    OWL_DISTRICTS,
    VRS_DISTRICTS,
    stop_number_check,
)
from gerlines_static_import.stops import Point


def point(key: str, platform: str | None, dhid: str | None) -> Point:
    return Point(
        key=key,
        place_key=key,
        name=key,
        lat=None,
        lon=None,
        platform_code=platform,
        dhid=dhid,
        ifopt=None,
    )


def test_the_districts_mirror_the_schema_rule() -> None:
    assert VRS_DISTRICTS == {
        "05314": 70, "05315": 70, "05316": 70, "05362": 70, "05366": 70, "05374": 70,
        "05378": 70, "05382": 70,
    }  # fmt: skip
    assert set(OWL_DISTRICTS) == {"05711", "05754", "05758", "05762", "05766", "05770", "05774"}
    assert set(OWL_DISTRICTS.values()) == {90}


def test_counts_stop_numbers_and_warns_on_nothing_when_the_feed_keeps_its_schemes() -> None:
    points = [
        point("a", "87", "de:05315:11201:7:75"),
        point("b", "91", "de:05711:5500:91:91"),
        point("c", "5", "de:06412:10:13:6"),
        point("d", "Gl. 3", "de:05315:16601:7:73"),
    ]
    check = stop_number_check(points)
    assert check["districts"]["05315"] == {"floor": 70, "numeric": 1, "below_floor": 0}
    assert check["districts"]["05711"] == {"floor": 90, "numeric": 1, "below_floor": 0}
    assert check["warnings"] == []


def test_a_single_code_under_the_floor_among_many_stop_numbers_is_no_warning() -> None:
    points = [point(str(n), str(83 + n), f"de:05315:11201:7:{71 + n}") for n in range(4)]
    points.append(point("w", "11", "de:05315:16601:7:71"))
    check = stop_number_check(points)
    assert check["districts"]["05315"] == {"floor": 70, "numeric": 5, "below_floor": 1}
    assert check["warnings"] == []


def test_warns_when_a_listed_district_has_codes_under_its_floor() -> None:
    check = stop_number_check([point("a", "3", "de:05315:11201:7:75")])
    assert check["warnings"] == [
        "district 05315 has 1 numeric platform codes under its stop number floor 70: "
        "it may have changed its scheme, revisit STOP_NUMBER_FROM in @gerlines/schema/platform"
    ]


def test_warns_when_another_district_has_many_codes_of_70_and_above() -> None:
    points = [point(str(n), str(80 + n), f"de:09162:1:41:{80 + n}") for n in range(5)]
    points.append(point("x", "101", "de:06412:7010:1:4"))
    check = stop_number_check(points)
    assert check["unlisted_70_and_above"] == {"09162": 5, "06412": 1}
    assert check["warnings"] == [
        "district 09162 has 5 numeric platform codes of 70 and above: they may be stop numbers, "
        "check them against IRIS station plans and STOP_NUMBER_FROM in @gerlines/schema/platform"
    ]
