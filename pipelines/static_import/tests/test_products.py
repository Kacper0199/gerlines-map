import zipfile
from pathlib import Path

import pytest

from gerlines_static_import.products import (
    GtfsdeIndex,
    TimetableTrip,
    TripProduct,
    coverage,
    normalize_number,
    read_gtfsde,
    resolve_products,
    route_product,
)

ALTONA = (53.5527, 9.9352)
MUNICH = (48.1403, 11.5600)
BASEL = (47.5476, 7.5897)

GTFSDE = {
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon\n"
        "a,Hamburg-Altona,53.5528,9.9353\n"
        "h,Hamburg Hbf,53.5530,10.0060\n"
        "m,München Hbf,48.1402,11.5601\n"
        "b,Basel Bad Bf,47.5677,7.6075\n"
    ),
    "routes.txt": (
        "route_long_name,route_short_name,agency_id,route_type,route_id\n"
        ",ICE 42,12,2,1\n"
        ",IC 55,12,2,2\n"
        ",EC 85,12,2,3\n"
        ",ECE 85,12,2,4\n"
    ),
    "trips.txt": "route_id,service_id,trip_id\n1,1,t619\n2,1,t2010\n3,1,t-ec\n4,1,t-ece\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "t619,19:25:00,19:25:00,a,1\n"
        "t619,19:37:00,19:44:00,h,2\n"
        "t619,06:03:00,06:03:00,m,3\n"
        "t619,30:03:00,30:03:00,m,4\n"
        "t2010,08:00:00,08:00:00,a,1\n"
        "t2010,15:00:00,15:00:00,m,2\n"
        "t-ec,10:00:00,10:00:00,a,1\n"
        "t-ec,18:00:00,18:00:00,b,2\n"
        "t-ece,10:00:00,10:00:00,a,1\n"
        "t-ece,18:00:00,18:00:00,b,2\n"
    ),
}


def trip(key: str, **overrides: object) -> TimetableTrip:
    values: dict[str, object] = {
        "trip_key": key,
        "train_number": "000619",
        "line": "42",
        "operator_id": "db-fernverkehr-ag",
        "route_type": 101,
        "category": "hsr",
        "first_departure_s": 19 * 3600 + 25 * 60,
        "last_arrival_s": 30 * 3600 + 3 * 60,
        "origin": ALTONA,
        "destination": MUNICH,
    }
    values.update(overrides)
    return TimetableTrip(**values)  # type: ignore[arg-type]


@pytest.fixture
def gtfsde(tmp_path: Path) -> GtfsdeIndex:
    path = tmp_path / "fv.zip"
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in GTFSDE.items():
            archive.writestr(name, text)
    with zipfile.ZipFile(path) as archive:
        return read_gtfsde(archive)


@pytest.mark.parametrize(
    ("line", "product"),
    [
        ("ICE", "ICE"),
        ("ICE 42", "ICE"),
        ("IC17", "IC"),
        ("EC", "EC"),
        ("RE10a", "RE"),
        ("RB46", "RB"),
        ("S1", "S"),
        ("FLX20", "FLX"),
        ("NJ", "NJ"),
        ("Os", "Os"),
        ("OS 5", "Os"),
        ("Re 1", "RE"),
        ("ice", "ICE"),
        ("sp 1234", "Sp"),
        ("42", None),
        ("43N", None),
        ("Chiemseebahn", None),
        ("A1", None),
        ("", None),
        (None, None),
    ],
)
def test_route_product_reads_known_product_codes_only(
    line: str | None, product: str | None
) -> None:
    assert route_product(line) == product


def test_normalize_number_drops_leading_zeros() -> None:
    assert normalize_number("000619") == "619"
    assert normalize_number("0") == "0"
    assert normalize_number(" ") is None
    assert normalize_number("SEV") == "SEV"


def test_named_routes_decide_first() -> None:
    result = resolve_products([trip("t1", line="RE10", category="rfast")], None)
    assert result == [TripProduct("t1", "RE", "delfi-gtfs", "delfi:name")]


def test_codeshare_copy_takes_the_product_of_the_named_copy() -> None:
    trips = [
        trip("named", line="NJ", category="night", train_number="000403"),
        trip("copy", line="43N", category="night", train_number="403"),
        trip("clash-a", line="EC", category="ld", train_number="000458"),
        trip("clash-b", line="EN", category="night", train_number="458"),
        trip("open", line="12N", category="night", train_number="458"),
    ]
    by_key = {p.trip_key: p for p in resolve_products(trips, None)}
    assert by_key["copy"] == TripProduct("copy", "NJ", "delfi-gtfs", "delfi:number")
    assert "open" not in by_key


def test_gtfsde_match_names_db_long_distance_lines(gtfsde: GtfsdeIndex) -> None:
    trips = [
        trip("ice619"),
        trip("ice-unmatched", train_number="000621", first_departure_s=1),
        trip("ec-or-ece", line="85", route_type=102, category="ld", train_number="000100",
             first_departure_s=10 * 3600, last_arrival_s=18 * 3600, destination=BASEL),
        trip("late", first_departure_s=19 * 3600 + 26 * 60),
        trip("regional", line="13", category="reg", route_type=106, train_number="1"),
    ]  # fmt: skip
    by_key = {p.trip_key: p for p in resolve_products(trips, gtfsde)}
    assert by_key["ice619"] == TripProduct("ice619", "ICE", "gtfsde-static-fv", "gtfsde:trip")
    assert by_key["ice-unmatched"] == TripProduct(
        "ice-unmatched", "ICE", "gtfsde-static-fv", "gtfsde:line"
    )
    assert by_key["late"].rule == "gtfsde:line"
    assert "ec-or-ece" not in by_key
    assert "regional" not in by_key


def test_a_gtfsde_trip_must_reach_the_destination_after_the_origin(gtfsde: GtfsdeIndex) -> None:
    reversed_trip = trip("reversed", origin=MUNICH, destination=ALTONA)
    assert resolve_products([reversed_trip], gtfsde) == []


def test_coverage_counts_trips_with_a_product_per_rule() -> None:
    trips = [trip("a"), trip("b"), trip("c", category="reg", line="RB1")]
    products = [
        TripProduct("a", "ICE", "gtfsde-static-fv", "gtfsde:trip"),
        TripProduct("c", "RB", "delfi-gtfs", "delfi:name"),
    ]
    assert coverage(trips, products) == {
        "hsr": {"trips": 2, "with_product": 1, "gtfsde:trip": 1},
        "reg": {"trips": 1, "with_product": 1, "delfi:name": 1},
    }
