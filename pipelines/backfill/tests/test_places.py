import uuid
from pathlib import Path

import polars as pl
import psycopg
import pytest

from gerlines_backfill.load import (
    SOURCES,
    OverrideError,
    Places,
    read_overrides,
    resolve_places,
    stop_place_id,
)

FRANKFURT_REGIONAL = uuid.UUID("a0000000-0000-5000-8000-000000000001")
FRANKFURT_FERN = uuid.UUID("a0000000-0000-5000-8000-000000000002")
STUTTGART_TIEF = uuid.UUID("a0000000-0000-5000-8000-000000000003")
STUTTGART_HBF = uuid.UUID("a0000000-0000-5000-8000-000000000004")
NIEDERSACHSWERFEN = uuid.UUID("a0000000-0000-5000-8000-000000000005")
NIEDERSACHSWERFEN_OST = uuid.UUID("a0000000-0000-5000-8000-000000000006")
BERLIN_HBF_FAR = uuid.UUID("a0000000-0000-5000-8000-000000000007")
BERLIN_HBF = uuid.UUID("a0000000-0000-5000-8000-000000000008")
KOELN_DEUTZ = uuid.UUID("a0000000-0000-5000-8000-000000000009")
MUENCHEN_HBF = uuid.UUID("a0000000-0000-5000-8000-00000000000a")
MUENCHEN_U = uuid.UUID("a0000000-0000-5000-8000-00000000000b")

STATIC = (
    (
        FRANKFURT_REGIONAL,
        "Frankfurt (Main) Flughafen Regionalbahnhof",
        None,
        "de:06412:2930",
        50.051219,
        8.571251,
    ),
    (
        FRANKFURT_FERN,
        "Frankfurt (Main) Flughafen Fernbahnhof",
        8070003,
        "de:06412:11511",
        50.053167,
        8.570185,
    ),
    (STUTTGART_TIEF, "Hauptbahnhof (tief)", None, "de:08111:6118", 48.783385, 9.180225),
    (STUTTGART_HBF, "Hauptbahnhof", 8000096, "de:08111:6115", 48.784729, 9.183172),
    (NIEDERSACHSWERFEN, "Niedersachswerfen", None, "de:16062:8012494", 51.545067, 10.763890),
    (
        NIEDERSACHSWERFEN_OST,
        "Niedersachswerfen Ost",
        8017017,
        "de:16062:8017017",
        51.549439,
        10.768731,
    ),
    (
        BERLIN_HBF_FAR,
        "S+U Berlin Hauptbahnhof",
        8011160,
        "de:11000:900003200",
        52.526875,
        13.368549,
    ),
    (BERLIN_HBF, "S+U Berlin Hauptbahnhof", 8011160, "de:11000:900003201", 52.525605, 13.369075),
    (KOELN_DEUTZ, "Köln Messe/Deutz Bf", 8003368, "de:05315:11901", 50.941721, 6.974067),
    (MUENCHEN_HBF, "München Hbf", 8000261, "de:09162:100", 48.140291, 11.559602),
    (MUENCHEN_U, "Hauptbahnhof (U, Tram)", None, "de:09162:6", 48.140027, 11.561066),
)

STATIONS = (
    (8070004, "Frankfurt(M) Flughafen Regionalbf", 50.051219, 8.571251, [8070003, 8089361]),
    (8098096, "Stuttgart Hbf (tief)", 48.782999, 9.179808, [561587, 8000096]),
    (8012494, "Niedersachswerfen", 51.545067, 10.76389, [8017017]),
    (8098160, "Berlin Hbf (tief)", 52.525592, 13.369545, [8011160, 8070952, 8089021]),
    (8073368, "Köln Messe/Deutz Gl.11-12", 50.941721, 6.974067, [8003368]),
    (
        8098263,
        "München Hbf (tief)",
        48.141172,
        11.560493,
        [270002, 470007, 8000261, 8098261, 8098262],
    ),
    (
        8098262,
        "München Hbf Gl.5-10",
        48.140094,
        11.555371,
        [270002, 470007, 8000261, 8098261, 8098263],
    ),
)
NAMES = {eva: name for eva, name, *_ in STATIONS}


@pytest.fixture
def stations(tmp_path: Path) -> Path:
    path = tmp_path / "stations.parquet"
    pl.DataFrame(
        {
            "eva": [row[0] for row in STATIONS],
            "name": [row[1] for row in STATIONS],
            "lat": [row[2] for row in STATIONS],
            "lon": [row[3] for row in STATIONS],
            "meta_evas": [row[4] for row in STATIONS],
        }
    ).write_parquet(path)
    return path


@pytest.fixture
def delfi(database_url: str) -> str:
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('delfi-gtfs', 'DELFI', 'CC-BY-4.0', 'DELFI e.V.')"
        )
        for row in SOURCES:
            conn.execute(
                "INSERT INTO source (source_id, name, homepage_url, licence, licence_url,"
                " attribution) VALUES (%s, %s, %s, %s, %s, %s)",
                row,
            )
        for place, name, eva, dhid, lat, lon in STATIC:
            conn.execute(
                "INSERT INTO stop_place"
                " (stop_place_id, name, name_source_id, eva, dhid, geom, geom_source_id)"
                " VALUES (%s, %s, 'delfi-gtfs', %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326),"
                " 'delfi-gtfs')",
                (place, name, eva, dhid, lon, lat),
            )
    return database_url


def resolve(url: str, stations: Path, overrides: dict[int, str] | None = None) -> Places:
    with psycopg.connect(url) as conn:
        return resolve_places(conn, NAMES, stations, overrides=overrides or {})


def decisions(places: Places) -> dict[int, list[str]]:
    found: dict[int, list[str]] = {}
    for row in places.review:
        found.setdefault(int(row[0]), []).append(str(row[6]))
    return found


def test_the_regional_station_takes_its_own_place_and_not_the_long_distance_one(
    delfi: str, stations: Path
) -> None:
    places = resolve(delfi, stations)
    assert places.mapping[8070004] == FRANKFURT_REGIONAL
    assert decisions(places)[8070004] == ["near_static"]


def test_the_deep_platforms_take_the_deep_place_and_not_the_main_hall(
    delfi: str, stations: Path
) -> None:
    places = resolve(delfi, stations)
    assert places.mapping[8098096] == STUTTGART_TIEF
    assert decisions(places)[8098096] == ["near_static"]


def test_a_static_place_whose_dhid_carries_the_eva_is_its_place(delfi: str, stations: Path) -> None:
    places = resolve(delfi, stations)
    assert places.mapping[8012494] == NIEDERSACHSWERFEN
    assert places.methods["dhid_eva"] == 1
    assert 8012494 not in decisions(places)


def test_a_meta_eva_place_within_150_m_is_taken_and_listed(delfi: str, stations: Path) -> None:
    places = resolve(delfi, stations)
    assert places.mapping[8098160] == BERLIN_HBF
    assert places.mapping[8073368] == KOELN_DEUTZ
    assert places.mapping[8098263] == MUENCHEN_HBF
    listed = decisions(places)
    assert listed[8098160] == ["meta_eva"]
    assert listed[8073368] == ["meta_eva"]
    assert listed[8098263] == ["meta_eva"]
    assert places.methods["meta_eva"] == 3


def test_a_meta_eva_place_further_than_150_m_is_not_taken_and_listed(
    delfi: str, stations: Path
) -> None:
    places = resolve(delfi, stations)
    assert places.mapping[8098262] == stop_place_id(8098262)
    assert "meta_too_far" in decisions(places)[8098262]


def test_every_step_is_counted(delfi: str, stations: Path) -> None:
    places = resolve(delfi, stations)
    assert places.methods == {
        "override": 0,
        "eva_mirror": 0,
        "stop_place_eva": 0,
        "dhid_eva": 1,
        "near_static": 2,
        "meta_eva": 3,
        "near_static_weak": 0,
        "same_point": 0,
        "created": 1,
    }


def test_a_dry_run_writes_nothing(delfi: str, stations: Path) -> None:
    with psycopg.connect(delfi) as conn:
        conn.execute("SET default_transaction_read_only = on")
        places = resolve_places(conn, NAMES, stations, write=False)
        conn.rollback()
        count = conn.execute(
            "SELECT count(*) FROM stop_place WHERE name_source_id <> 'delfi-gtfs'"
        ).fetchone()[0]
    assert places.methods["created"] == 1
    assert count == 0


def test_an_override_points_a_station_at_a_place_by_id_or_dhid(delfi: str, stations: Path) -> None:
    places = resolve(delfi, stations, {8098262: "de:09162:100", 8070004: str(FRANKFURT_FERN)})
    assert places.mapping[8098262] == MUENCHEN_HBF
    assert places.mapping[8070004] == FRANKFURT_FERN
    assert decisions(places)[8098262] == ["override"]
    assert places.methods["override"] == 2


def test_an_override_keeps_a_station_separate(delfi: str, stations: Path) -> None:
    places = resolve(delfi, stations, {8073368: "separate"})
    assert places.mapping[8073368] == stop_place_id(8073368)
    assert decisions(places)[8073368] == ["override_separate"]
    with psycopg.connect(delfi) as conn:
        made = conn.execute("SELECT name FROM stop_place WHERE eva = 8073368").fetchone()
    assert made == ("Köln Messe/Deutz Gl.11-12",)


def test_an_override_to_an_unknown_place_stops_the_resolution(delfi: str, stations: Path) -> None:
    with pytest.raises(OverrideError, match="8098262"):
        resolve(delfi, stations, {8098262: "de:09162:999999"})


def test_the_overrides_file_reads_eva_and_place(tmp_path: Path) -> None:
    path = tmp_path / "overrides.csv"
    path.write_text(
        "eva,place,note\n8098262,de:09162:100,Starnberger platforms of the main station\n"
        "8073368,separate,\n"
    )
    assert read_overrides(path) == {8098262: "de:09162:100", 8073368: "separate"}
    assert read_overrides(None) == {}
    assert read_overrides(tmp_path / "missing.csv") == {}


def test_an_overrides_file_with_a_bad_row_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "overrides.csv"
    path.write_text("eva,place,note\nabc,separate,\n")
    with pytest.raises(OverrideError, match="abc"):
        read_overrides(path)
