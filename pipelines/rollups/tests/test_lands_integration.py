import json
import os
from pathlib import Path

import psycopg
import pytest
import shapely

from gerlines_common import project_paths
from gerlines_rollups.lands import (
    VG250_ARCHIVE,
    Area,
    AreaSource,
    load_areas,
    read_areas,
    read_sidecar,
)

SOURCE = AreaSource(
    url="https://daten.gdz.bkg.bund.de/example.zip",
    sha256="c" * 64,
    edition="VG250 test",
    licence="DL-DE-BY-2.0",
    attribution="© GeoBasis-DE / BKG (2026), DL-DE BY 2.0, changed",
)


def grid_areas() -> list[Area]:
    """Sixteen 10 km squares in EPSG:25832, ARS 01 to 16 from west to east."""
    return [
        Area(
            f"{n:02d}",
            shapely.to_wkb(shapely.box(400000 + n * 10000, 5500000, 410000 + n * 10000, 5510000)),
        )
        for n in range(1, 17)
    ]


def add_place(conn: psycopg.Connection, name: str, x: float, country: str | None) -> None:
    conn.execute(
        """INSERT INTO stop_place (stop_place_id, name, name_source_id, geom_source_id,
                                   country_code, geom)
           VALUES (gen_random_uuid(), %s, 'test', 'test', %s,
                   ST_Transform(ST_SetSRID(ST_MakePoint(%s, 5505000), 25832), 4326))""",
        (name, country, x),
    )


def test_sidecar_names_the_source(tmp_path: Path) -> None:
    archive = tmp_path / "vg250.zip"
    archive.with_name("vg250.zip.json").write_text(
        json.dumps(
            {
                "url": "https://daten.gdz.bkg.bund.de/x.zip",
                "sha256": "d" * 64,
                "edition": "VG250 Ebenen, Stand 2026-01-01",
                "licence": "DL-DE-BY-2.0",
                "attribution": "© GeoBasis-DE / BKG (2026)",
            }
        )
    )
    source = read_sidecar(archive)
    assert source.attribution == "© GeoBasis-DE / BKG (2026), DL-DE BY 2.0, changed"
    assert source.edition == "VG250 Ebenen, Stand 2026-01-01"


def test_load_assigns_places_already_stored_and_new_ones(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('test', 't', 'l', 'a')"
        )
        add_place(conn, "in-01", 415000, "DE")
        add_place(conn, "edge-16", 570080, "DE")
        add_place(conn, "abroad", 570300, "DE")
        add_place(conn, "neighbour", 575000, "CZ")
        assert conn.execute("SELECT count(*) FROM stop_place_land").fetchone() == (0,)

        report = load_areas(conn, grid_areas(), SOURCE)
        assert report.areas == 16
        assert report.changed_places == 4
        assert report.by_method == {"nearest": 1, "outside": 2, "within": 1}

        add_place(conn, "in-05", 455000, None)
        rows = conn.execute(
            """SELECT s.name, l.land_code, l.method, l.edition FROM stop_place s
                 JOIN stop_place_land l USING (stop_place_id) ORDER BY s.name"""
        ).fetchall()
    assert rows == [
        ("abroad", "foreign", "outside", "VG250 test"),
        ("edge-16", "DE-TH", "nearest", "VG250 test"),
        ("in-01", "DE-SH", "within", "VG250 test"),
        ("in-05", "DE-NW", "within", "VG250 test"),
        ("neighbour", "foreign", "outside", "VG250 test"),
    ]


def test_load_refuses_an_incomplete_set(database_url: str) -> None:
    with psycopg.connect(database_url) as conn, pytest.raises(ValueError, match="16 Länder"):
        load_areas(conn, grid_areas()[:15], SOURCE)


VG250 = Path(os.environ.get("GERLINES_VG250_ARCHIVE") or project_paths().data / VG250_ARCHIVE)
SHORE_STATIONS = [
    ("Norddeich(Norden) Mole", 7.15881, 53.62432, "DE-NI"),
    ("Dagebüll Mole", 8.69099, 54.72991, "DE-SH"),
    ("Lauterbach Mole", 13.50312, 54.34222, "DE-MV"),
    ("Lübeck-Travemünde Skandinavienkai", 10.85403, 53.95079, "DE-SH"),
    ("Lindau Inselbahnhof", 9.68047, 47.54434, "DE-BY"),
    ("Friedrichsh. Hafenbahnhof", 9.48282, 47.65121, "DE-BW"),
]


@pytest.mark.skipif(not VG250.exists(), reason="the VG250 archive is not on this machine")
def test_shore_and_pier_stations_lie_within_their_land(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('test', 't', 'l', 'a')"
        )
        for name, lon, lat, _ in SHORE_STATIONS:
            conn.execute(
                """INSERT INTO stop_place (stop_place_id, name, name_source_id, geom_source_id,
                                           country_code, geom)
                   VALUES (gen_random_uuid(), %s, 'test', 'test', 'DE',
                           ST_SetSRID(ST_MakePoint(%s, %s), 4326))""",
                (name, lon, lat),
            )
        load_areas(conn, read_areas(VG250), SOURCE)
        rows = dict(
            conn.execute(
                """SELECT s.name, (l.land_code, l.method) FROM stop_place s
                     JOIN stop_place_land l USING (stop_place_id)"""
            ).fetchall()
        )
    assert rows == {name: (land, "within") for name, _, _, land in SHORE_STATIONS}
