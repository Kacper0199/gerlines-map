import os
import secrets
import zipfile
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from gerlines_common import migration_statements

MIGRATIONS = Path(__file__).resolve().parents[3] / "packages" / "db" / "migrations"

FEED = {
    "feed_info.txt": (
        "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,"
        "feed_version\n"
        "DELFI e.V.,https://www.delfi.de,de,20261003,20261212,2026-10-17T14:46:34\n"
    ),
    "agency.txt": (
        "agency_id,agency_name,agency_url,agency_timezone\n"
        "1,DB Fernverkehr AG,https://www.delfi.de,Europe/Berlin\n"
        "2,DB Regio AG1,https://www.delfi.de,Europe/Berlin\n"
        "3,Österreichische Bundesbahnen,https://www.delfi.de,Europe/Berlin\n"
        "4,Busbetrieb,https://www.delfi.de,Europe/Berlin\n"
        "5,DB Regio AG2,https://www.delfi.de,Europe/Berlin\n"
    ),
    "routes.txt": (
        "route_id,agency_id,route_short_name,route_long_name,route_type\n"
        '"r-ice",1,"1","",101\n'
        '"r-re",2,"RE1","",106\n'
        '"r-nj",3,"27N","",102\n'
        '"r-bus",4,"RE1","",3\n'
        '"r-sev",5,"SEV3","",109\n'
    ),
    "trips.txt": (
        "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,"
        "shape_id\n"
        '"r-ice",1,t1,"Hamburg Hbf","571",0,,10\n'
        '"r-ice",1,t2,"Hamburg Hbf","573",0,,10\n'
        '"r-re",2,t3,"Herne","",1,b7,11\n'
        '"r-nj",1,t4,"Kufstein","40466",0,,12\n'
        '"r-bus",3,t5,"Irgendwo","",0,,\n'
        '"r-re",2,t6,"Kurz","",0,,11\n'
        '"r-sev",3,t7,"Ersatz","",0,,\n'
    ),
    "stop_times.txt": (
        "trip_id,stop_id,stop_sequence,pickup_type,drop_off_type,arrival_time,departure_time\n"
        't1,"de:11000:900003201:1:50",0,0,0,08:00:00,08:00:00\n'
        't1,"de:02000:10950:3:5",2,0,0,09:42:00,09:42:00\n'
        't2,"de:11000:900003201:1:50",0,0,0,10:00:00,10:00:00\n'
        't2,"de:02000:10950:3:5",1,0,0,11:42:00,11:44:00\n'
        't3,"de:05916:7501:89",5,0,0,23:50:00,23:51:00\n'
        't3,"de:02000:10950:3:5",7,1,0,24:30:00,24:30:00\n'
        't4,"at:48:452:2",0,0,0,21:00:00,21:00:00\n'
        't4,"at:47:2184",1,0,1,23:10:00,23:10:00\n'
        't5,"de:09999:1:1:1",0,0,0,07:00:00,07:00:00\n'
        't5,"de:09999:2:1:1",1,0,0,07:10:00,07:10:00\n'
        't6,"de:05916:7501:89",0,0,0,12:00:00,12:00:00\n'
    ),
    "stops.txt": (
        '"stop_id","stop_name","stop_lat","stop_lon","location_type","parent_station",'
        '"platform_code"\n'
        '"de:11000:900003201","S+U Berlin Hauptbahnhof","52.525605","13.369075","1","",""\n'
        '"de:11000:900003201:1:50","S+U Berlin Hauptbahnhof","52.524789","13.369667","0",'
        '"de:11000:900003201","11"\n'
        '"de:02000:10950","Hamburg Hauptbahnhof","53.5529","10.0067","1","",""\n'
        '"de:02000:10950:3:5","Hamburg Hauptbahnhof","53.5531","10.0071","0",'
        '"de:02000:10950","5"\n'
        '"de:05916:7501:89","Herne Bf","51.5446","7.2196","0","",""\n'
        '"at:48:452:2","Bregenz","47.5031","9.7471","0","",""\n'
        '"at:47:2184","Kufstein","47.5833","12.1656","0","",""\n'
        '"de:09999:1:1:1","Bushalt A","49.0","11.0","0","",""\n'
        '"de:09999:2:1:1","Bushalt B","49.1","11.1","0","",""\n'
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "1,1,1,1,1,1,0,0,20261003,20261212\n"
        "2,0,0,0,0,0,1,1,20261003,20261212\n"
    ),
    "calendar_dates.txt": (
        "service_id,date,exception_type\n1,20261003,2\n2,20261003,1\n3,20261005,1\n"
    ),
}

MIRROR_STOPS = (
    '"stop_id","stop_name","stop_lat","stop_lon","location_type","parent_station"\n'
    '"8011160","Berlin Hbf","52.525592","13.369545","0",""\n'
    '"8098160","Berlin Hbf","52.525592","13.369545","0","8011160"\n'
    '"8002549","Hamburg Hbf","53.552736","10.006909","0",""\n'
    '"8000142","Herne","51.544467","7.219582","0",""\n'
)


BORDER_FEED = FEED | {
    "agency.txt": FEED["agency.txt"]
    + "6,Harzer Schmalspurbahnen,https://www.delfi.de,Europe/Berlin\n",
    "routes.txt": FEED["routes.txt"] + '"r-hsb",6,"HSB","",2\n',
    "trips.txt": FEED["trips.txt"]
    + '"r-hsb",1,t8,"Klostermansfeld","",0,,\n'
    + '"r-re",2,t9,"Slubice","",0,,\n'
    + '"r-hsb",1,t10,"Kufstein","",0,,\n',
    "stop_times.txt": FEED["stop_times.txt"]
    + 't8,"000010975601",0,0,0,09:00:00,09:00:00\n'
    + 't8,"000008010191",1,0,0,10:00:00,10:00:00\n'
    + 't9,"de:16062:8017020",0,0,0,11:00:00,11:00:00\n'
    + 't9,"000000002085",1,0,0,12:00:00,12:00:00\n'
    + 't10,"000000002085",0,0,0,13:00:00,13:00:00\n'
    + 't10,"at:47:2184",1,0,0,19:00:00,19:00:00\n',
    "stops.txt": FEED["stops.txt"]
    + '"000010975601","Nordhausen Nord","51.505000","10.793000","0","",""\n'
    + '"de:16062:8017020","Nordhausen Nord","51.505005","10.793010","0","",""\n'
    + '"000008010191","Klostermansfeld","51.583300","11.495000","0","",""\n'
    + '"000000002085","Slubice, Intermarché","52.348837","14.564000","0","",""\n',
}

BORDER_MIRROR_STOPS = (
    MIRROR_STOPS
    + '"8010191","Klostermansfeld","51.583400","11.495100","0",""\n'
    + '"8010256","Nordhausen","51.506300","10.793900","0",""\n'
)

OUTLINE = (
    '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"code":"DE"},'
    '"geometry":{"type":"Polygon","coordinates":'
    "[[[5.8,47.6],[14.5,47.6],[14.5,55.1],[5.8,55.1],[5.8,47.6]]]}}]}"
)


def write_zip(path: Path, members: dict[str, str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in members.items():
            archive.writestr(name, text)
    return path


@pytest.fixture
def data_root(tmp_path: Path) -> Path:
    return tmp_path / "data"


@pytest.fixture
def mini_feed(data_root: Path) -> Path:
    return write_zip(data_root / "inputs" / "delfi" / "2026-10-19" / "delfi-gtfs.zip", FEED)


@pytest.fixture
def mini_mirror(data_root: Path) -> Path:
    return write_zip(
        data_root / "inputs" / "delfi" / "2026-10-19" / "delfi-gtfs-extended-zhv-evaNr.zip",
        {"stops.txt": MIRROR_STOPS},
    )


SECOND_VERSION_TRIPS = 3000


def second_version(trips: int) -> dict[str, str]:
    """The mini feed as the next weekly version: a new version string and many more ICE trips."""
    numbers = range(trips)
    return FEED | {
        "feed_info.txt": FEED["feed_info.txt"].replace(
            "2026-10-17T14:46:34", "2026-10-24T14:58:08"
        ),
        "trips.txt": FEED["trips.txt"]
        + "".join(f'"r-ice",1,x{n},"Hamburg Hbf","{1000 + n}",0,,10\n' for n in numbers),
        "stop_times.txt": FEED["stop_times.txt"]
        + "".join(
            f'x{n},"de:11000:900003201:1:50",0,0,0,06:{n % 60:02d}:00,06:{n % 60:02d}:00\n'
            f'x{n},"de:02000:10950:3:5",1,0,0,08:{n % 60:02d}:00,08:{n % 60:02d}:00\n'
            for n in numbers
        ),
    }


@pytest.fixture
def second_version_feed(data_root: Path) -> Path:
    return write_zip(
        data_root / "inputs" / "delfi" / "2026-10-26" / "delfi-gtfs.zip",
        second_version(SECOND_VERSION_TRIPS),
    )


@pytest.fixture
def border_feed(data_root: Path) -> Path:
    return write_zip(data_root / "inputs" / "delfi" / "2026-10-19" / "delfi-gtfs.zip", BORDER_FEED)


@pytest.fixture
def border_mirror(data_root: Path) -> Path:
    return write_zip(
        data_root / "inputs" / "delfi" / "2026-10-19" / "delfi-gtfs-extended-zhv-evaNr.zip",
        {"stops.txt": BORDER_MIRROR_STOPS},
    )


@pytest.fixture
def outline_path(tmp_path: Path) -> Path:
    path = tmp_path / "germany-outline.geojson"
    path.write_text(OUTLINE)
    return path


def _server_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    return make_conninfo(
        host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        port=os.environ.get("POSTGRES_PORT", "5433"),
        user=os.environ.get("POSTGRES_USER", "gerlines"),
        password=os.environ.get("POSTGRES_PASSWORD", "change-me-locally"),
        dbname=os.environ.get("POSTGRES_DB", "gerlines"),
    )


def _with_database(url: str, name: str) -> str:
    return make_conninfo(url, dbname=name)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if "database_url" in getattr(item, "fixturenames", ()):
            item.add_marker(pytest.mark.db)


@pytest.fixture
def database_url() -> Iterator[str]:
    """A throwaway database with every migration applied; skipped when no server answers."""
    server = _server_url()
    required = os.environ.get("GERLINES_DB_TESTS") == "required" or os.environ.get("CI") in {
        "1",
        "true",
    }
    try:
        admin = psycopg.connect(server, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as error:
        if required:
            raise
        pytest.skip(f"no database server answers ({error.__class__.__name__}); run pnpm infra:up")
    name = f"gerlines_test_py_{secrets.token_hex(5)}"
    with admin:
        admin.execute(f'CREATE DATABASE "{name}" TEMPLATE template0')
        url = _with_database(server, name)
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                for path in sorted(MIGRATIONS.glob("*.up.sql")):
                    for statement in migration_statements(path.read_text()):
                        conn.execute(statement)
            yield url
        finally:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
