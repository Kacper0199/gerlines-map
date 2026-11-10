import json
import zipfile
from pathlib import Path

import numpy as np
import psycopg
import pyogrio
import pytest
import shapely
from pyproj import Transformer

from gerlines_static_import.categories import TRAIN_CATEGORIES
from gerlines_static_import.cli import main
from gerlines_static_import.load import LoadOptions, run_load

GTFSDE_FV = {
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon\n"
        "be,Berlin Hbf,52.5251,13.3694\n"
        "hh,Hamburg Hbf,53.5530,10.0068\n"
    ),
    "routes.txt": "route_long_name,route_short_name,agency_id,route_type,route_id\n,ICE 1,12,2,1\n",
    "trips.txt": "route_id,service_id,trip_id\n1,1,x571\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "x571,08:00:00,08:00:00,be,1\n"
        "x571,09:42:00,09:42:00,hh,2\n"
    ),
}


def write_zip(path: Path, members: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in members.items():
            archive.writestr(name, text)
    return path


MUNICIPALITIES = {
    "Berlin": (13.369075, 52.525605),
    "Hamburg": (10.0067, 53.5529),
    "Herne": (7.2196, 51.5446),
}
STADA_STATIONS = {
    "result": [
        {
            "name": "Hamburg Hbf",
            "ifopt": "de:02000:10950",
            "evaNumbers": [
                {
                    "number": 8002549,
                    "isMain": True,
                    "geographicCoordinates": {"type": "Point", "coordinates": [10.0069, 53.5527]},
                }
            ],
        }
    ]
}


def write_vg250(path: Path) -> Path:
    """A VG250 archive whose municipalities are 10 km squares around the mini feed's stations."""
    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    squares = []
    for lon, lat in MUNICIPALITIES.values():
        x, y = to_utm.transform(lon, lat)
        squares.append(shapely.MultiPolygon([shapely.box(x - 5000, y - 5000, x + 5000, y + 5000)]))
    gpkg = path.parent / "DE_VG250.gpkg"
    pyogrio.raw.write(
        gpkg,
        shapely.to_wkb(np.array(squares, dtype=object)),
        [
            np.array(list(MUNICIPALITIES), dtype=object),
            np.array([4, 4, 4], dtype=np.int32),
            np.array([61, 61, 61], dtype=np.int16),
        ],
        ["GEN", "GF", "IBZ"],
        layer="vg250_gem",
        driver="GPKG",
        geometry_type="MultiPolygon",
        crs="EPSG:25832",
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.write(gpkg, "vg250_ebenen_0101/DE_VG250.gpkg")
    return path


def load(mini_feed: Path, data_root: Path, database_url: str, mini_mirror: Path) -> int:
    run_load(
        LoadOptions(
            feed_path=mini_feed,
            database_url=database_url,
            categories=TRAIN_CATEGORIES,
            data_root=data_root,
            eva_path=mini_mirror,
            report_dir=data_root / "static" / "2026-10-19",
        )
    )
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "UPDATE stop_place SET name = 'Hauptbahnhof' WHERE name = 'Hamburg Hauptbahnhof'"
        )
        row = conn.execute("SELECT max(feed_version_id) FROM feed_version").fetchone()
    assert row is not None
    return int(row[0])


def test_display_names_and_products_fill_their_tables(  # noqa: PLR0913, PLR0917
    mini_feed: Path,
    data_root: Path,
    database_url: str,
    mini_mirror: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    version = load(mini_feed, data_root, database_url, mini_mirror)
    gtfsde = write_zip(tmp_path / "fv.zip", GTFSDE_FV)
    monkeypatch.setenv("DATABASE_URL", database_url)

    stada = tmp_path / "stada.json"
    stada.write_text(json.dumps(STADA_STATIONS))
    vg250 = write_vg250(tmp_path / "vg250.zip")
    names_args = ["--eva", str(mini_mirror), "--stada", str(stada), "--vg250", str(vg250)]

    assert main(["display-names", *names_args, "--dry-run"]) == 0
    with psycopg.connect(database_url) as conn:
        assert conn.execute("SELECT count(*) FROM stop_place_display_name").fetchone() == (0,)
    assert main(["display-names", *names_args]) == 0
    assert main(["display-names", *names_args]) == 0
    assert main(["products", "--feed-version", str(version), "--gtfsde", str(gtfsde)]) == 0
    assert main(["products", "--feed-version", str(version), "--gtfsde", str(gtfsde)]) == 0

    with psycopg.connect(database_url) as conn:
        names = conn.execute(
            """SELECT p.name, d.name, d.source_id, d.rule FROM stop_place_display_name d
                 JOIN stop_place p USING (stop_place_id) ORDER BY 1"""
        ).fetchall()
        others = conn.execute(
            """SELECT p.name, s.name, s.source_id FROM stop_place_search_name s
                 JOIN stop_place p USING (stop_place_id) ORDER BY 1, 2"""
        ).fetchall()
        products = conn.execute(
            """SELECT trip_key, product, source_id, rule FROM trip_product
                WHERE feed_version_id = %s ORDER BY trip_key""",
            (version,),
        ).fetchall()
    assert names == [
        ("Hauptbahnhof", "Hamburg Hbf", "db-stada-stations", "stada:town-missing"),
        ("Herne Bf", "Herne", "delfi-gtfs", "delfi:normalised"),
        ("S+U Berlin Hauptbahnhof", "Berlin Hbf", "delfi-gtfs", "delfi:normalised"),
    ]
    assert others == [
        ("Herne Bf", "Herne Bf", "delfi-gtfs"),
        ("S+U Berlin Hauptbahnhof", "S+U Berlin Hauptbahnhof", "delfi-gtfs"),
    ]
    assert products == [
        ("t1", "ICE", "gtfsde-static-fv", "gtfsde:trip"),
        ("t2", "ICE", "gtfsde-static-fv", "gtfsde:line"),
        ("t3", "RE", "delfi-gtfs", "delfi:name"),
    ]
