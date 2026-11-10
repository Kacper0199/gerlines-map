import zipfile
from pathlib import Path
from uuid import UUID

import pytest

from gerlines_static_import.eva import (
    EvaIndex,
    EvaStation,
    differs_only_by_suffix,
    eva_in_stop_id,
    name_score,
    read_eva_stations,
)
from gerlines_static_import.ids import canonical_id
from gerlines_static_import.spatial import NationalOutline
from gerlines_static_import.stops import (
    KnownIds,
    StopModel,
    StopRow,
    assign_canonical_ids,
    build_model,
    dhid_base,
    fill_countries,
    merge_lone_places,
    read_stops,
)


@pytest.mark.parametrize(
    ("stop_id", "base"),
    [
        ("de:02000:10950_G_G", "de:02000:10950"),
        ("de:02000:10950_G", "de:02000:10950"),
        ("de:09362:14012:0:2_G", "de:09362:14012"),
        ("de:09574:7000_G", "de:09574:7000"),
        ("lu:25000:NVBW_226", "lu:25000:NVBW_226"),
        ("at:48:452:2", "at:48:452:2"),
        ("000000002085", "000000002085"),
    ],
)
def test_dhid_base_drops_generic_suffixes(stop_id: str, base: str) -> None:
    assert dhid_base(stop_id) == base


def test_generic_variants_share_one_place(tmp_path: Path) -> None:
    path = tmp_path / "feed.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "stops.txt",
            '"stop_id","stop_name","stop_lat","stop_lon","location_type","parent_station"\n'
            '"de:02000:10950","Hamburg Hbf","53.552736","10.006909","0",""\n'
            '"de:02000:10950_G","Hamburg Hbf","53.552809","10.007921","0",""\n'
            '"de:02000:10950_G_G","Hamburg Hbf","53.552993","10.006637","0",""\n',
        )
    with zipfile.ZipFile(path) as archive:
        rows = read_stops(archive, {"de:02000:10950_G", "de:02000:10950_G_G"})
    assert "de:02000:10950" in rows
    model = build_model(rows, ["de:02000:10950_G", "de:02000:10950_G_G"])
    assert set(model.places) == {"de:02000:10950"}
    place = model.places["de:02000:10950"]
    assert (place.lat, place.synthesised, place.dhid) == (53.552736, False, "de:02000:10950")
    assert {p.place_key for p in model.points.values()} == {"de:02000:10950"}


STOPS = (
    '"stop_id","stop_name","stop_lat","stop_lon","location_type","parent_station","platform_code"\n'
    '"de:11000:900003201","S+U Berlin Hauptbahnhof","52.525605","13.369075","1","",""\n'
    '"de:11000:900003201:1:50","S+U Berlin Hauptbahnhof","52.524789","13.369667","0",'
    '"de:11000:900003201","11"\n'
    '"de:05916:7501:89","Herne Bf","51.54","7.22","0","",""\n'
    '"de:05916:7501:90","Herne Bf","51.56","7.24","0","",""\n'
    '"de:06434:2304","Oberursel (Taunus) Stadtmitte","50.2","8.58","0","",""\n'
    '"ch:23005:862:1:1","Riehen Im Schlipf","47.58","7.65","0","",""\n'
    '"000000002085","Slubice, Intermarché","52.34","14.56","0","",""\n'
    '"de:06412:1502:32:3","Frankfurt Burgstraße","50.12","8.70","0","",""\n'
    '"8011160","Berlin Hbf","52.525592","13.369545","0","",""\n'
    '"8089021","Berlin Hbf (S-Bahn)","52.525592","13.369545","0","8011160",""\n'
)  # fmt: skip


@pytest.fixture
def feed(tmp_path: Path) -> Path:
    path = tmp_path / "feed.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("stops.txt", STOPS)
    return path


def served() -> list[str]:
    return [
        "de:11000:900003201:1:50",
        "de:05916:7501:89",
        "de:05916:7501:90",
        "de:06434:2304",
        "ch:23005:862:1:1",
        "000000002085",
    ]


def test_reads_only_wanted_stops_and_their_parents(feed: Path) -> None:
    with zipfile.ZipFile(feed) as archive:
        rows = read_stops(archive, {"de:11000:900003201:1:50", "missing"})
    assert set(rows) == {"de:11000:900003201:1:50", "de:11000:900003201"}
    assert rows["de:11000:900003201:1:50"].platform_code == "11"


def test_builds_places_from_parents_dhid_heads_and_lone_stops(feed: Path) -> None:
    with zipfile.ZipFile(feed) as archive:
        rows = read_stops(archive, set(served()))
    model = build_model(rows, served())
    assert set(model.places) == {
        "de:11000:900003201",
        "de:05916:7501",
        "de:06434:2304",
        "ch:23005:862",
        "000000002085",
    }
    herne = model.places["de:05916:7501"]
    assert herne.synthesised
    assert herne.dhid == "de:05916:7501"
    assert (herne.lat, herne.lon) == pytest.approx((51.55, 7.23))
    assert model.places["de:11000:900003201"].country_code == "DE"
    swiss = model.places["ch:23005:862"]
    assert (swiss.dhid, swiss.ifopt, swiss.country_code) == (None, "ch:23005:862", "CH")
    assert model.points["ch:23005:862:1:1"].ifopt == "ch:23005:862:1:1"
    lone = model.places["000000002085"]
    assert (lone.dhid, lone.ifopt, lone.country_code) == (None, None, None)
    platform = model.points["de:11000:900003201:1:50"]
    assert (platform.dhid, platform.platform_code) == ("de:11000:900003201:1:50", "11")
    assert model.points["de:06434:2304"].dhid is None
    assert model.place_of_point("de:05916:7501:90") is herne


def test_keeps_known_ids_and_derives_new_ones_from_the_dhid(feed: Path) -> None:
    with zipfile.ZipFile(feed) as archive:
        rows = read_stops(archive, set(served()))
    model = build_model(rows, served())
    known = UUID("00000000-0000-5000-8000-000000000001")
    by_dhid = UUID("00000000-0000-5000-8000-000000000002")
    assign_canonical_ids(
        model,
        "delfi-gtfs",
        KnownIds(
            places={"de:11000:900003201": known},
            places_by_dhid={"de:05916:7501": by_dhid},
        ),
    )
    assert model.places["de:11000:900003201"].canonical == known
    assert model.places["de:05916:7501"].canonical == by_dhid
    assert model.places["000000002085"].canonical == canonical_id(
        "stop_place", "delfi-gtfs:000000002085"
    )
    assert model.points["000000002085"].canonical == canonical_id(
        "stop_point", "delfi-gtfs:000000002085"
    )
    assert model.points["de:06434:2304"].canonical != model.places["de:06434:2304"].canonical


def test_canonical_ids_are_stable_uuidv5() -> None:
    value = canonical_id("stop_place", "dhid:de:11000:900003201")
    assert value.version == 5
    assert value == canonical_id("stop_place", "dhid:de:11000:900003201")


def test_reads_eva_roots_from_the_mirror(feed: Path) -> None:
    with zipfile.ZipFile(feed) as archive:
        stations = read_eva_stations(archive)
    assert [station.eva for station in stations] == [8011160]


@pytest.mark.parametrize(
    ("a", "b", "at_least"),
    [
        ("S+U Berlin Hauptbahnhof", "Berlin Hbf", 1.0),
        ("Frankfurt (Main) Hbf", "Frankfurt(Main)Hbf", 1.0),
        ("München Hauptbahnhof", "München Hbf", 1.0),
        ("Köln Messe/Deutz", "Köln Messe/Deutz Gl.11-12", 0.6),
    ],
)
def test_name_score_ignores_station_words(a: str, b: str, at_least: float) -> None:
    assert name_score(a, b) >= at_least


def test_matches_the_nearest_similar_station_and_refuses_strangers() -> None:
    index = EvaIndex(
        [
            EvaStation(8011160, "Berlin Hbf", 52.525592, 13.369545),
            EvaStation(8070952, "Berlin Hbf (Invalidenstraße)", 52.52663, 13.36882),
            EvaStation(8000001, "Ganz Anders", 52.5256, 13.3696),
        ]
    )
    match = index.match("S+U Berlin Hauptbahnhof", 52.525605, 13.369075)
    assert match is not None
    assert match.eva == 8011160
    assert match.distance_m == pytest.approx(31.8, abs=1.0)
    assert index.match("Völlig Fremd", 52.525605, 13.369075) is None
    assert index.match("Berlin Hbf", 48.0, 11.0) is None
    assert index.match("Berlin Hbf", None, None) is None


def test_far_candidates_need_a_strong_name_match() -> None:
    index = EvaIndex([EvaStation(8081065, "Fohrde Dorf", 52.4920, 12.4500)])
    assert index.match("Fohrde, Bahnhof", 52.4920, 12.4586) is None
    assert index.match("Fohrde, Bahnhof", 52.4920, 12.4510) is not None


def lone_model() -> StopModel:
    rows = {
        "000010975601": StopRow("000010975601", "Nordhausen Nord", 51.5050, 10.7930, 0, "", ""),
        "de:16062:8017020": StopRow(
            "de:16062:8017020", "Nordhausen Nord", 51.505005, 10.79301, 0, "", ""
        ),
        "000008010191": StopRow("000008010191", "Klostermansfeld", 51.5833, 11.4950, 0, "", ""),
        "de:15087:8010191": StopRow(
            "de:15087:8010191", "Klostermansfeld Bf", 51.5900, 11.5000, 0, "", ""
        ),
        "000099999901": StopRow("000099999901", "Nordhausen Süd", 51.50501, 10.79302, 0, "", ""),
        "000000002085": StopRow("000000002085", "Slubice, Intermarché", 52.3488, 14.564, 0, "", ""),
    }
    return build_model(rows, list(rows))


def test_german_stops_without_dhid_get_their_country_from_the_outline(
    outline_path: Path,
) -> None:
    model = lone_model()
    filled = fill_countries(model, NationalOutline.from_geojson(outline_path))
    assert model.points["000010975601"].country_code == "DE"
    assert model.places["000010975601"].country_code == "DE"
    assert model.points["000000002085"].country_code is None
    assert filled == 6


def test_lone_places_merge_into_the_dhid_place_of_the_same_station() -> None:
    model = lone_model()
    model.places["de:15087:8010191"].eva = 8010191
    result = merge_lone_places(model)
    assert (result.by_eva, result.by_distance) == (1, 1)
    assert model.merged == {
        "000008010191": "de:15087:8010191",
        "000010975601": "de:16062:8017020",
    }
    assert model.points["000010975601"].place_key == "de:16062:8017020"
    assert "000099999901" in model.places
    assert "000000002085" in model.places


@pytest.mark.parametrize(
    ("stop_id", "eva"),
    [
        ("de:15002:8010159", 8010159),
        ("000008010191", 8010191),
        ("de:11000:900003201", None),
        ("000010975601", None),
        ("de:15002:8010159:1:1", None),
    ],
)
def test_finds_eva_numbers_carried_in_stop_ids(stop_id: str, eva: int | None) -> None:
    assert eva_in_stop_id(stop_id) == eva


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        ("Nordhausen Nord", "Nordhausen", True),
        ("Markkleeberg Mitte", "Markkleeberg", True),
        ("Erfurt Hbf", "Erfurt", True),
        ("Halle (Saale) Süd", "Halle(Saale)Hbf", True),
        ("Nordhausen Nord", "Nordhausen Nord", False),
        ("S+U Berlin Hauptbahnhof", "Berlin Hbf", False),
        ("Hauptbahnhof", "Stuttgart Hbf", False),
    ],
)
def test_suffix_only_differences(a: str, b: str, expected: bool) -> None:
    assert differs_only_by_suffix(a, b) is expected


def test_exact_pass_uses_the_carried_eva_and_spatial_refuses_suffix_variants() -> None:
    index = EvaIndex(
        [
            EvaStation(8010256, "Nordhausen", 51.5063, 10.7939),
            EvaStation(8010159, "Halle(Saale)Hbf", 51.4775, 11.9870),
        ]
    )
    exact = index.exact("de:15002:8010159", 51.4780, 11.9860)
    assert exact is not None
    assert (exact.eva, exact.method) == (8010159, "exact")
    assert index.exact("de:15002:8010159", 48.0, 11.0) is None
    assert index.match("Nordhausen Nord", 51.5050, 10.7930) is None
    resolved = index.resolve("de:16062:8017020", "Nordhausen", 51.5050, 10.7930)
    assert resolved is not None
    assert resolved.method == "spatial"
