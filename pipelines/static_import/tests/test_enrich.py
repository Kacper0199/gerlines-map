import csv
import io
import zipfile
from pathlib import Path

from gerlines_static_import.categories import TRAIN_CATEGORIES, Category, classify
from gerlines_static_import.enrich import enriched_route_type, write_enriched, write_subset


def read_csv(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    with archive.open(name) as raw:
        return list(csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8")))


def test_route_types_follow_the_canonical_category() -> None:
    cases = {
        (102, "27N", "DB Fernverkehr AG"): 105,
        (102, "RJX", "MAV"): 101,
        (101, "RE25", "vogtlandbahn"): 106,
        (106, "IC17", "DB Fernverkehr (Codesharing)"): 102,
        (106, "S5", "DB Regio AG"): 109,
        (109, "SEV3", "S-Bahn Hannover"): 714,
        (2, "20", "Regionalbuslinien"): 700,
        (106, "RB27", "DB Regio AG"): 106,
        (3, "RE1", "DB Regio Mitte"): 3,
    }
    for (route_type, name, agency), expected in cases.items():
        assert enriched_route_type(route_type, classify(route_type, name, agency)) == expected


def test_enriched_feed_changes_only_route_types_and_adds_the_category(
    mini_feed: Path, tmp_path: Path
) -> None:
    output = tmp_path / "out" / "delfi-gtfs-enriched.zip"
    report = write_enriched(mini_feed, output)
    assert report.as_dict()["route_type_changes"] == {"102->105": 1, "109->714": 1}
    with zipfile.ZipFile(mini_feed) as source, zipfile.ZipFile(output) as enriched:
        assert enriched.namelist() == source.namelist()
        for name in source.namelist():
            if name != "routes.txt":
                assert enriched.read(name) == source.read(name)
        routes = {row["route_id"]: row for row in read_csv(enriched, "routes.txt")}
    assert routes["r-nj"]["route_type"] == "105"
    assert routes["r-nj"]["gerlines_category"] == "night"
    assert routes["r-bus"]["route_type"] == "3"
    assert routes["r-bus"]["gerlines_category"] == "bus"
    assert routes["r-ice"]["route_type"] == "101"


def test_subset_keeps_only_the_chosen_trips_and_what_they_need(
    mini_feed: Path, tmp_path: Path
) -> None:
    output = tmp_path / "rail.zip"
    report = write_subset(mini_feed, output, TRAIN_CATEGORIES)
    with zipfile.ZipFile(output) as subset:
        trips = {row["trip_id"] for row in read_csv(subset, "trips.txt")}
        stops = {row["stop_id"] for row in read_csv(subset, "stops.txt")}
        agencies = {row["agency_id"] for row in read_csv(subset, "agency.txt")}
        services = {row["service_id"] for row in read_csv(subset, "calendar_dates.txt")}
    assert trips == {"t1", "t2", "t3", "t4", "t6"}
    assert "de:11000:900003201" in stops
    assert "de:09999:1:1:1" not in stops
    assert agencies == {"1", "2", "3"}
    assert services == {"1", "2"}
    assert report.rows["stop_times.txt"] == 9


def test_subset_category_set_is_a_parameter(mini_feed: Path, tmp_path: Path) -> None:
    output = tmp_path / "night.zip"
    write_subset(mini_feed, output, frozenset({Category.NIGHT}))
    with zipfile.ZipFile(output) as subset:
        assert {row["trip_id"] for row in read_csv(subset, "trips.txt")} == {"t4"}


def test_subset_can_keep_only_listed_trips(mini_feed: Path, tmp_path: Path) -> None:
    output = tmp_path / "new-patterns.zip"
    report = write_subset(mini_feed, output, TRAIN_CATEGORIES, only_trips=frozenset({"t2", "t9"}))
    with zipfile.ZipFile(output) as subset:
        trips = {row["trip_id"] for row in read_csv(subset, "trips.txt")}
        stop_times = {row["trip_id"] for row in read_csv(subset, "stop_times.txt")}
    assert trips == {"t2"}
    assert stop_times == {"t2"}
    assert report.rows["trips.txt"] == 1
