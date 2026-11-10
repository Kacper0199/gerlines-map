import csv
import json
import shutil
import uuid
from dataclasses import replace
from datetime import date
from pathlib import Path

import polars as pl
import psycopg
import pytest

from gerlines_backfill.cli import main
from gerlines_backfill.load import (
    GERLINES_NAMESPACE,
    LIVE_EVENTS_SQL,
    SOURCE_ID,
    CutOverError,
    MonthInput,
    live_from,
    load_month,
    stop_place_id,
    trip_instance_id,
)
from gerlines_backfill.month import convert_month

FIXTURES = Path(__file__).parent / "fixtures"
BERLIN_HBF = uuid.UUID("11111111-1111-5111-8111-111111111111")
BERZHAHN = uuid.UUID("22222222-2222-5222-8222-222222222222")
WESTERBURG_PARK = uuid.UUID("33333333-3333-5333-8333-333333333333")
HILDESHEIM_OST = uuid.UUID("44444444-4444-5444-8444-444444444444")
HILDESHEIM = uuid.UUID("55555555-5555-5555-8555-555555555555")
HAMELN_MAIN = uuid.UUID("66666666-6666-5666-8666-666666666666")


@pytest.fixture
def converted(tmp_path: Path) -> Path:
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    for month in ("2025-11", "2025-12"):
        shutil.copy(FIXTURES / f"piebro-{month}.parquet", inputs / f"data-{month}.parquet")
    out = tmp_path / "out"
    convert_month(inputs, "2025-11", out)
    return out / "2025-11"


@pytest.fixture
def stations(tmp_path: Path) -> Path:
    path = tmp_path / "stations.parquet"
    pl.DataFrame(
        {
            "eva": [8000152, 8000921, 8000245, 8000169, 8000148],
            "lat": [52.3768, 50.5520, 50.5590, 52.1606, 52.0975],
            "lon": [9.7411, 7.8910, 7.9690, 9.9533, 9.3720],
            "name": ["Hannover Hbf", "Berzhahn", "Westerburg", "Hildesheim Hbf", "Hameln"],
            "meta_evas": [[], [], [], [], [8000999]],
        }
    ).write_parquet(path)
    return path


def seed_static_place(  # noqa: PLR0913, PLR0917
    url: str, place: uuid.UUID, name: str, lat: float, lon: float, eva: int | None = None
) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('delfi-gtfs', 'DELFI', 'CC-BY-4.0', 'DELFI e.V.') ON CONFLICT DO NOTHING"
        )
        conn.execute(
            "INSERT INTO stop_place"
            " (stop_place_id, name, name_source_id, eva, geom, geom_source_id)"
            " VALUES (%s, %s, 'delfi-gtfs', %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326),"
            " 'delfi-gtfs')",
            (place, name, eva, lon, lat),
        )


def seed_live_stop(url: str, day: date) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('gtfsde-rt', 'gtfs.de realtime', 'CC-BY-4.0', 'gtfs.de')"
            " ON CONFLICT DO NOTHING"
        )
        run = conn.execute(
            "INSERT INTO ingest_run (source_id, job, app_version, started_at)"
            " VALUES ('gtfsde-rt', 'record', '1', %s::date) RETURNING ingest_run_id",
            (day,),
        ).fetchone()[0]
        raw = conn.execute(
            "INSERT INTO raw_object (source_id, ingest_run_id, object_key, sha256, bytes,"
            " content_type, fetched_at) VALUES ('gtfsde-rt', %s, %s, %s, 1,"
            " 'application/x-protobuf', now()) RETURNING raw_object_id",
            (run, f"live/{day}.pb", "0" * 64),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO trip_instance (trip_instance_id, service_date, train_number,"
            " origin_stop_place_id, origin_departure, is_added, first_source_id,"
            " first_observed_at, first_raw_object_id)"
            " VALUES (%s, %s, '1', %s, now(), true, 'gtfsde-rt', now(), %s)",
            (uuid.UUID(int=day.toordinal()), day, BERLIN_HBF, raw),
        )
        conn.execute(
            "INSERT INTO stop_event (service_date, trip_instance_id, stop_index, source_id,"
            " stop_place_id, cancelled, additional, observed_at, raw_object_id)"
            " VALUES (%s, %s, 0, 'gtfsde-rt', %s, false, false, now(), %s)",
            (day, uuid.UUID(int=day.toordinal()), BERLIN_HBF, raw),
        )


def place_of(url: str, eva: int) -> uuid.UUID:
    with psycopg.connect(url) as conn:
        return conn.execute(
            "SELECT DISTINCT e.stop_place_id FROM stop_event e JOIN id_map m"
            " ON m.canonical_id = e.stop_place_id AND m.source_id = %s AND m.entity = 'stop_place'"
            " WHERE m.source_key = %s",
            (SOURCE_ID, str(eva)),
        ).fetchone()[0]


def seed_known_place(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('traines-delfi-eva', 'EVA mirror', 'CC-BY-4.0', 'DELFI e.V.')"
        )
        conn.execute(
            "INSERT INTO stop_place (stop_place_id, name, name_source_id, eva)"
            " VALUES (%s, 'Berlin Hauptbahnhof', 'traines-delfi-eva', 8098160)",
            (BERLIN_HBF,),
        )
        conn.execute(
            "INSERT INTO id_map (source_id, entity, source_key, canonical_id)"
            " VALUES ('traines-delfi-eva', 'stop_place', '8098160', %s)",
            (BERLIN_HBF,),
        )


def month_input(
    folder: Path, stations: Path, until: date | None = None, overrides: Path | None = None
) -> MonthInput:
    return MonthInput(
        month="2025-11",
        folder=folder,
        source_file=FIXTURES / "piebro-2025-11.parquet",
        object_key="piebro/test/data-2025-11.parquet",
        request_url="https://huggingface.co/datasets/piebro/deutsche-bahn-data/resolve/x/y",
        stations=stations,
        until=until,
        overrides=overrides,
    )


def counts(url: str) -> dict[str, int]:
    with psycopg.connect(url) as conn:
        return {
            table: conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608
            for table in ("trip_instance", "stop_event", "segment_obs")
        }


def test_trip_instance_ids_cannot_meet_live_ids() -> None:
    expected = uuid.uuid5(GERLINES_NAMESPACE, "trip_instance:piebro\x1fA-2511120612")
    assert trip_instance_id("A-2511120612") == expected


def test_a_month_loads_runs_stops_and_legs_marked_as_backfill(
    database_url: str, converted: Path, stations: Path
) -> None:
    seed_known_place(database_url)
    report = load_month(database_url, month_input(converted, stations))
    stops = pl.read_parquet(converted / "stops" / "*.parquet")
    legs = pl.read_parquet(converted / "segments" / "*.parquet")
    assert counts(database_url) == {
        "trip_instance": 8,
        "stop_event": stops.height,
        "segment_obs": legs.height,
    }
    assert report["stop_places_created"] == report["stations"] - 1
    with psycopg.connect(database_url) as conn:
        flags = conn.execute(
            "SELECT bool_and(backfill), bool_and(feed_version_id IS NULL AND trip_key IS NULL),"
            " count(DISTINCT first_raw_object_id) FROM trip_instance"
        ).fetchone()
        assert flags == (True, True, 1)
        qualities = conn.execute(
            "SELECT final_quality, count(*) FROM stop_event GROUP BY 1 ORDER BY 1 NULLS LAST"
        ).fetchall()
        assert {quality for quality, _ in qualities} <= {"final_only", None}
        assert conn.execute("SELECT DISTINCT source_id FROM stop_event").fetchall() == [
            (SOURCE_ID,)
        ]
        origin = conn.execute(
            "SELECT origin_stop_place_id, category_code, train_number FROM trip_instance"
            " WHERE trip_instance_id = %s",
            (trip_instance_id("-7256490561424230809-2511302138"),),
        ).fetchone()
        assert origin == (BERLIN_HBF, "hsr", "1720")
        hannover = conn.execute(
            "SELECT name, ST_Y(geom), geom_source_id FROM stop_place WHERE eva = 8000152"
        ).fetchone()
        assert hannover == ("Hannover Hbf", pytest.approx(52.3768), "bahn-vorhersage")
        raw = conn.execute(
            "SELECT object_key, bytes, sha256 FROM raw_object WHERE source_id = %s", (SOURCE_ID,)
        ).fetchone()
        assert raw[0] == "piebro/test/data-2025-11.parquet"
        assert raw[1] == (FIXTURES / "piebro-2025-11.parquet").stat().st_size


def test_loading_again_replaces_the_rows_and_until_keeps_later_days_out(
    database_url: str, converted: Path, stations: Path
) -> None:
    load_month(database_url, month_input(converted, stations), compress=True)
    first = counts(database_url)
    with psycopg.connect(database_url) as conn:
        compressed = conn.execute(
            "SELECT count(*) FROM timescaledb_information.chunks"
            " WHERE hypertable_name = 'stop_event' AND is_compressed"
        ).fetchone()[0]
    assert compressed == 2
    load_month(database_url, month_input(converted, stations), compress=True)
    assert counts(database_url) == first
    load_month(database_url, month_input(converted, stations, until=date(2025, 11, 13)))
    with psycopg.connect(database_url) as conn:
        days = conn.execute("SELECT DISTINCT service_date FROM trip_instance").fetchall()
    assert days == [(date(2025, 11, 12),)]


def test_rollups_count_the_backfilled_arrivals(
    database_url: str, converted: Path, stations: Path
) -> None:
    load_month(database_url, month_input(converted, stations))
    with psycopg.connect(database_url, autocommit=True) as conn:
        for view in ("stat_stop", "station_day"):
            conn.execute(
                "CALL refresh_continuous_aggregate(%s, '2025-11-01', '2025-12-01')", (view,)
            )
        totals = conn.execute(
            "SELECT category_code, sum(n_observed_arr), sum(n_lt_6min_arr) FROM station_day"
            " GROUP BY 1 ORDER BY 1"
        ).fetchall()
    summary = json.loads((converted / "summary.json").read_text())
    expected = [
        (category, counts["arrivals"], counts["lt_6min"])
        for category, counts in sorted(summary["punctuality_by_category"].items())
    ]
    assert totals == expected


def test_a_static_place_without_eva_close_by_and_of_the_same_name_takes_the_station(
    database_url: str, converted: Path, stations: Path
) -> None:
    seed_known_place(database_url)
    seed_static_place(database_url, BERZHAHN, "Berzhahn Bahnhof", 50.5521, 7.8911)
    report = load_month(database_url, month_input(converted, stations))
    assert report["stop_place_methods"]["near_static"] == 1
    assert report["stop_places_created"] == report["stations"] - 2
    assert place_of(database_url, 8000921) == BERZHAHN
    with psycopg.connect(database_url) as conn:
        made = conn.execute("SELECT count(*) FROM stop_place WHERE eva = 8000921").fetchone()[0]
    assert made == 0


def test_a_close_place_of_another_name_is_listed_for_review_and_not_taken(
    database_url: str, converted: Path, stations: Path
) -> None:
    seed_static_place(database_url, WESTERBURG_PARK, "Industriepark Nord", 50.5591, 7.9691)
    seed_static_place(database_url, HILDESHEIM_OST, "Hildesheim Ost", 52.1615, 9.9545)
    report = load_month(database_url, month_input(converted, stations))
    assert report["stop_place_methods"]["near_static"] == 0
    assert place_of(database_url, 8000245) == stop_place_id(8000245)
    assert place_of(database_url, 8000169) == stop_place_id(8000169)
    with (converted / "place-review.csv").open() as handle:
        rows = {row["eva"]: row for row in csv.DictReader(handle)}
    assert rows["8000245"]["place_name"] == "Industriepark Nord"
    assert rows["8000245"]["decision"] == "created"
    assert rows["8000169"]["place_name"] == "Hildesheim Ost"
    assert float(rows["8000169"]["distance_m"]) < 150
    assert report["places_for_review"] == len(rows)


def test_a_place_made_by_an_earlier_load_moves_to_the_static_place_found_later(
    database_url: str, converted: Path, stations: Path
) -> None:
    load_month(database_url, month_input(converted, stations))
    assert place_of(database_url, 8000921) == stop_place_id(8000921)
    seed_static_place(database_url, BERZHAHN, "Berzhahn Bahnhof", 50.5521, 7.8911)
    report = load_month(database_url, month_input(converted, stations))
    assert report["stop_place_methods"]["near_static"] == 1
    assert place_of(database_url, 8000921) == BERZHAHN
    with psycopg.connect(database_url) as conn:
        left = conn.execute(
            "SELECT count(*) FROM stop_event WHERE stop_place_id = %s", (stop_place_id(8000921),)
        ).fetchone()[0]
    assert left == 0


def test_days_on_or_after_the_first_live_day_are_refused(
    database_url: str, converted: Path, stations: Path
) -> None:
    seed_known_place(database_url)
    seed_live_stop(database_url, date(2025, 11, 13))
    with pytest.raises(CutOverError, match="2025-11-13"):
        load_month(database_url, month_input(converted, stations))
    with pytest.raises(CutOverError, match="2025-11-13"):
        load_month(database_url, month_input(converted, stations, until=date(2025, 11, 14)))
    assert counts(database_url)["stop_event"] == 1
    report = load_month(database_url, month_input(converted, stations, until=date(2025, 11, 13)))
    assert report["days_loaded"] == 1
    assert report["live_from"] == "2025-11-13"


def test_reloading_a_day_updates_its_runs_in_place(
    database_url: str, converted: Path, stations: Path
) -> None:
    load_month(database_url, month_input(converted, stations), compress=True)
    first = counts(database_url)
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(
            "CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS"
            " $$ BEGIN RAISE EXCEPTION 'trip_instance delete'; END $$"
        )
        conn.execute(
            "CREATE TRIGGER refuse_delete BEFORE DELETE ON trip_instance"
            " FOR EACH ROW EXECUTE FUNCTION refuse_delete()"
        )
    load_month(database_url, month_input(converted, stations), compress=True)
    assert counts(database_url) == first


def test_reloading_removes_runs_that_left_the_day(
    database_url: str, converted: Path, stations: Path
) -> None:
    load_month(database_url, month_input(converted, stations))
    day = converted / "trips" / "2025-11-30.parquet"
    trips = pl.read_parquet(day)
    gone = trips["trip_key"][0]
    trips.filter(pl.col("trip_key") != gone).write_parquet(day)
    for kind in ("stops", "segments"):
        path = converted / kind / "2025-11-30.parquet"
        pl.read_parquet(path).filter(pl.col("trip_key") != gone).write_parquet(path)
    load_month(database_url, month_input(converted, stations))
    with psycopg.connect(database_url) as conn:
        left = conn.execute(
            "SELECT count(*) FROM trip_instance WHERE trip_instance_id = %s",
            (trip_instance_id(gone),),
        ).fetchone()[0]
    assert left == 0


def test_a_new_file_under_the_same_key_updates_its_raw_object(
    database_url: str, converted: Path, stations: Path, tmp_path: Path
) -> None:
    load_month(database_url, month_input(converted, stations))
    revised = tmp_path / "revised.parquet"
    revised.write_bytes((FIXTURES / "piebro-2025-11.parquet").read_bytes() + b"\0")
    month = month_input(converted, stations)
    newer = replace(month, source_file=revised, request_url="https://x/z")
    load_month(database_url, newer)
    with psycopg.connect(database_url) as conn:
        raw = conn.execute(
            "SELECT count(*), max(bytes), max(request_url) FROM raw_object WHERE source_id = %s",
            (SOURCE_ID,),
        ).fetchone()
    assert raw == (1, revised.stat().st_size, "https://x/z")


def test_a_failed_load_marks_its_run_failed(
    database_url: str, converted: Path, stations: Path
) -> None:
    (converted / "segments" / "2025-11-30.parquet").unlink()
    with pytest.raises(FileNotFoundError):
        load_month(database_url, month_input(converted, stations))
    with psycopg.connect(database_url) as conn:
        run = conn.execute(
            "SELECT status, finished_at IS NOT NULL, error_message FROM ingest_run"
            " WHERE source_id = %s",
            (SOURCE_ID,),
        ).fetchone()
    assert run[:2] == ("failed", True)
    assert "2025-11-30" in run[2]


def test_a_place_at_the_same_point_named_without_the_hbf_suffix_is_taken_and_listed(
    database_url: str, converted: Path, stations: Path
) -> None:
    seed_static_place(database_url, HILDESHEIM, "Hildesheim", 52.16061, 9.95331)
    report = load_month(database_url, month_input(converted, stations))
    assert place_of(database_url, 8000169) == HILDESHEIM
    assert report["stop_place_methods"]["same_point"] == 1
    with (converted / "place-review.csv").open() as handle:
        rows = {row["eva"]: row for row in csv.DictReader(handle)}
    assert rows["8000169"]["decision"] == "same_point"


def test_a_meta_eva_takes_the_place_of_its_main_station(
    database_url: str, converted: Path, stations: Path
) -> None:
    seed_static_place(database_url, HAMELN_MAIN, "Hameln Bahnhof", 52.0980, 9.3712, eva=8000999)
    report = load_month(database_url, month_input(converted, stations))
    assert report["stop_place_methods"]["meta_eva"] == 1
    assert place_of(database_url, 8000148) == HAMELN_MAIN
    with (converted / "place-review.csv").open() as handle:
        rows = {row["eva"]: row for row in csv.DictReader(handle)}
    assert rows["8000148"]["decision"] == "meta_eva"
    assert float(rows["8000148"]["distance_m"]) < 150


def test_every_load_resolves_again_instead_of_keeping_an_earlier_mapping(
    database_url: str, converted: Path, stations: Path
) -> None:
    seed_static_place(database_url, WESTERBURG_PARK, "Industriepark Nord", 50.5591, 7.9691)
    seed_static_place(database_url, HAMELN_MAIN, "Hameln Bahnhof", 52.0980, 9.3712, eva=8000999)
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES (%s, 'piebro', 'CC-BY-4.0', 'piebro')",
            (SOURCE_ID,),
        )
        conn.execute(
            "INSERT INTO id_map (source_id, entity, source_key, canonical_id)"
            " VALUES (%s, 'stop_place', '8000148', %s)",
            (SOURCE_ID, WESTERBURG_PARK),
        )
    load_month(database_url, month_input(converted, stations))
    assert place_of(database_url, 8000148) == HAMELN_MAIN


def test_a_reviewed_decision_in_the_overrides_file_is_applied_on_each_load(
    database_url: str, converted: Path, stations: Path, tmp_path: Path
) -> None:
    seed_static_place(database_url, BERZHAHN, "Berzhahn Bahnhof", 50.5521, 7.8911)
    seed_static_place(database_url, HILDESHEIM_OST, "Hildesheim Ost", 52.1615, 9.9545)
    overrides = tmp_path / "place-overrides.csv"
    overrides.write_text(
        f"eva,place,note\n8000921,separate,two halts\n8000169,{HILDESHEIM_OST},one station\n"
    )
    report = load_month(database_url, month_input(converted, stations, overrides=overrides))
    assert report["stop_place_methods"]["override"] == 2
    assert place_of(database_url, 8000921) == stop_place_id(8000921)
    assert place_of(database_url, 8000169) == HILDESHEIM_OST
    overrides.write_text("eva,place,note\n")
    load_month(database_url, month_input(converted, stations, overrides=overrides))
    assert place_of(database_url, 8000921) == BERZHAHN


def test_the_places_command_resolves_without_writing(  # noqa: PLR0913, PLR0917
    database_url: str,
    converted: Path,
    stations: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    seed_static_place(database_url, BERZHAHN, "Berzhahn Bahnhof", 50.5521, 7.8911)
    overrides = tmp_path / "place-overrides.csv"
    overrides.write_text("eva,place,note\n8000169,separate,\n")
    monkeypatch.setenv("DATABASE_URL", database_url)
    argv = ["places", "--converted", str(converted.parent), "--stations", str(stations)]
    argv += ["--overrides", str(overrides), "--last", "2025-11", "--review", str(tmp_path)]
    assert main(argv) == 0
    report = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert report["stop_place_methods"]["near_static"] == 1
    assert report["stop_place_methods"]["override"] == 1
    with (tmp_path / "2025-11-place-review.csv").open() as handle:
        rows = {row["eva"]: row["decision"] for row in csv.DictReader(handle)}
    assert rows["8000921"] == "near_static"
    assert rows["8000169"] == "override_separate"
    with psycopg.connect(database_url) as conn:
        written = conn.execute(
            "SELECT (SELECT count(*) FROM stop_place WHERE name_source_id = %s),"
            " (SELECT count(*) FROM id_map WHERE source_id = %s)",
            (SOURCE_ID, SOURCE_ID),
        ).fetchone()
    assert written == (0, 0)


def test_the_first_live_day_is_searched_only_from_the_first_recorder_run(
    database_url: str, converted: Path, stations: Path
) -> None:
    seed_known_place(database_url)
    load_month(database_url, month_input(converted, stations), compress=True)
    seed_live_stop(database_url, date(2026, 11, 3))
    with psycopg.connect(database_url) as conn:
        assert live_from(conn) == date(2026, 11, 3)
        backfilled = {
            name.split(".")[-1]
            for (name,) in conn.execute(
                "SELECT show_chunks('stop_event', older_than => '2025-12-01'::date)::text"
            ).fetchall()
        }
        plan = json.dumps(
            conn.execute(
                f"EXPLAIN (ANALYZE, FORMAT JSON) {LIVE_EVENTS_SQL}",
                (SOURCE_ID, date(2026, 11, 1)),
            ).fetchone()[0]
        )
    assert backfilled
    assert not any(chunk in plan for chunk in backfilled)
