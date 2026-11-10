from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path

import psycopg
import pytest

from gerlines_static_import import db
from gerlines_static_import.categories import TRAIN_CATEGORIES
from gerlines_static_import.db import LoadLockedError, lock_source, trip_integrity
from gerlines_static_import.ids import canonical_id
from gerlines_static_import.load import (
    InputFile,
    IntegrityError,
    LoadOptions,
    ReconciliationError,
    _reconcile,
    published_on,
    run_load,
)

TABLES = {
    "route": "route_key",
    "service_calendar": "service_key",
    "service_calendar_date": "service_key, service_date",
    "trip_pattern": "trip_pattern_id",
    "trip_pattern_stop": "trip_pattern_id, stop_index",
    "trip": "trip_key",
    "stop_time": "trip_key, stop_index",
    "stop_place": "stop_place_id",
    "stop_point": "stop_point_id",
    "operator": "operator_id",
    "operator_alias": "source_id, alias",
}
VOLATILE = {"created_at", "updated_at", "first_seen_at", "last_seen_at"}


def snapshot(url: str) -> dict[str, list[tuple[object, ...]]]:
    """Every row of the timetable and stop tables, without timestamps, in a stable order."""
    result = {}
    with psycopg.connect(url) as conn:
        for table, order in TABLES.items():
            columns = [
                row[0]
                for row in conn.execute(
                    "SELECT column_name FROM information_schema.columns"
                    " WHERE table_name = %s ORDER BY ordinal_position",
                    (table,),
                )
                if row[0] not in VOLATILE
            ]
            query = psycopg.sql.SQL("SELECT {} FROM {} ORDER BY {}").format(
                psycopg.sql.SQL(", ").join(psycopg.sql.Identifier(c) for c in columns),
                psycopg.sql.Identifier(table),
                psycopg.sql.SQL(order),
            )
            result[table] = conn.execute(query).fetchall()
        result["id_map"] = conn.execute(
            "SELECT source_id, entity, source_key, canonical_id FROM id_map ORDER BY 1, 2, 3"
        ).fetchall()
    return result


@pytest.fixture
def options(mini_feed: Path, mini_mirror: Path, data_root: Path, database_url: str) -> LoadOptions:
    return LoadOptions(
        feed_path=mini_feed,
        database_url=database_url,
        categories=TRAIN_CATEGORIES,
        data_root=data_root,
        eva_path=mini_mirror,
        report_dir=data_root / "static" / "2026-10-19",
    )


def test_loads_trains_with_reconciled_counts(options: LoadOptions) -> None:
    report = run_load(options)
    assert report["stored"]["trips"] == {"hsr": 2, "rfast": 1, "night": 1}
    assert report["stored"]["stop_times"] == {"hsr": 4, "rfast": 2, "night": 2}
    assert report["stored"]["foreign_trips"] == 1
    assert report["selected"]["trips_dropped_by_reason"] == {"fewer than two stops": 1}
    assert report["stops"]["stop_places"] == 5
    assert report["stops"]["places_with_eva"] == 3
    assert report["stops"]["eva_reference_check"]["8011160 Berlin Hbf"] == [
        "de:11000:900003201 S+U Berlin Hauptbahnhof"
    ]
    assert (options.report_dir / "load-report.json").is_file()
    with psycopg.connect(options.database_url) as conn:
        berlin = conn.execute(
            "SELECT stop_place_id, eva, country_code, ST_Y(geom) FROM stop_place WHERE dhid = %s",
            ("de:11000:900003201",),
        ).fetchone()
        assert berlin is not None
        assert berlin[0] == canonical_id("stop_place", "dhid:de:11000:900003201")
        assert berlin[1:3] == (8011160, "DE")
        assert berlin[3] == pytest.approx(52.525605)
        eva = conn.execute(
            "SELECT canonical_id FROM id_map"
            " WHERE source_id = 'traines-delfi-eva' AND source_key = '8011160'"
        ).fetchone()
        assert eva == (berlin[0],)
        status = conn.execute("SELECT status, row_counts->'trips' FROM feed_version").fetchone()
        assert status == ("loaded", {"hsr": 2, "rfast": 1, "night": 1})
        runs = conn.execute(
            "SELECT source_id, status FROM ingest_run ORDER BY source_id"
        ).fetchall()
        assert runs == [("delfi-gtfs", "succeeded"), ("traines-delfi-eva", "succeeded")]
        night = conn.execute(
            "SELECT category_code, is_foreign, short_name FROM trip WHERE trip_key = 't4'"
        ).fetchone()
        assert night == ("night", True, "40466")
        departures = conn.execute(
            """
            SELECT t.trip_key, s.departure_s FROM stop_time s
              JOIN trip t USING (feed_version_id, trip_key)
              JOIN trip_pattern_stop p ON p.feed_version_id = t.feed_version_id
               AND p.trip_pattern_id = t.trip_pattern_id AND p.stop_index = s.stop_index
              JOIN stop_point sp USING (stop_point_id)
             WHERE sp.dhid = 'de:11000:900003201:1:50' ORDER BY 2
            """
        ).fetchall()
        assert departures == [("t1", 28800), ("t2", 36000)]


def test_loading_twice_gives_the_same_rows(options: LoadOptions) -> None:
    first = run_load(options)
    before = snapshot(options.database_url)
    second = run_load(options)
    after = snapshot(options.database_url)
    assert second["reloaded_existing_version"]
    assert second["feed_version_id"] == first["feed_version_id"]
    assert before == after
    assert second["stops"]["id_map_conflicts"] == {"stop_place": 0, "stop_point": 0, "eva": 0}


def test_a_failed_load_leaves_no_version_and_records_the_failure(
    options: LoadOptions, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*_args: object, **_kwargs: object) -> None:
        msg = "boom"
        raise ReconciliationError(msg)

    monkeypatch.setattr("gerlines_static_import.load._reconcile", broken)
    with pytest.raises(ReconciliationError):
        run_load(options)
    with psycopg.connect(options.database_url) as conn:
        assert conn.execute("SELECT count(*) FROM feed_version").fetchone() == (0,)
        assert conn.execute("SELECT count(*) FROM stop_place").fetchone() == (0,)
        run = conn.execute("SELECT status, error_message FROM ingest_run").fetchone()
        assert run == ("failed", "ReconciliationError: boom")


def test_reconciliation_names_every_difference() -> None:
    with pytest.raises(ReconciliationError, match="trips"):
        _reconcile({"trips": {"hsr": 2}, "services": 1}, {"trips": {"hsr": 1}, "services": 1})


def test_border_feed_counts_german_stops_without_dhid_as_domestic(
    border_feed: Path, border_mirror: Path, outline_path: Path, database_url: str
) -> None:
    data_root = border_feed.parents[3]
    report = run_load(
        LoadOptions(
            feed_path=border_feed,
            database_url=database_url,
            categories=TRAIN_CATEGORIES,
            data_root=data_root,
            eva_path=border_mirror,
            outline_path=outline_path,
        )
    )
    assert report["foreign_trips_by_reason"] == {
        "foreign operator": 1,
        "no stop in Germany": 1,
    }
    stops = report["stops"]
    assert stops["merged_by_distance"] == 1
    assert stops["eva_methods"]["exact"] == 1
    assert report["integrity"] == dict.fromkeys(report["integrity"], 0)
    with psycopg.connect(database_url) as conn:
        trips = dict(conn.execute("SELECT trip_key, is_foreign FROM trip").fetchall())
        assert (trips["t8"], trips["t9"], trips["t10"], trips["t4"]) == (False, False, True, True)
        nordhausen = conn.execute(
            """
            SELECT pl.dhid, pl.country_code, pl.eva FROM stop_point sp
              JOIN stop_place pl USING (stop_place_id)
              JOIN id_map m ON m.canonical_id = sp.stop_point_id AND m.entity = 'stop_point'
             WHERE m.source_key = '000010975601'
            """
        ).fetchone()
        assert nordhausen == ("de:16062:8017020", "DE", None)
        klostermansfeld = conn.execute(
            "SELECT country_code, eva FROM stop_place p JOIN id_map m"
            " ON m.canonical_id = p.stop_place_id AND m.entity = 'stop_place'"
            " WHERE m.source_key = '000008010191'"
        ).fetchone()
        assert klostermansfeld == ("DE", 8010191)
        slubice = conn.execute(
            "SELECT country_code FROM stop_place p JOIN id_map m"
            " ON m.canonical_id = p.stop_place_id AND m.entity = 'stop_place'"
            " WHERE m.source_key = '000000002085'"
        ).fetchone()
        assert slubice == (None,)


def test_integrity_failures_roll_the_version_back(
    options: LoadOptions, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "gerlines_static_import.db.trip_integrity",
        lambda _conn, _version: {"first_departure_differs": 3},
    )
    with pytest.raises(IntegrityError, match="first_departure_differs"):
        run_load(options)
    with psycopg.connect(options.database_url) as conn:
        assert conn.execute("SELECT count(*) FROM feed_version").fetchone() == (0,)


def test_trip_integrity_sees_a_wrong_first_departure(options: LoadOptions) -> None:
    run_load(options)
    with psycopg.connect(options.database_url) as conn:
        conn.execute(
            "UPDATE trip SET first_departure_s = first_departure_s + 60 WHERE trip_key = 't1'"
        )
        conn.execute("DELETE FROM stop_time WHERE trip_key = 't3' AND stop_index = 1")
        found = trip_integrity(conn, 1)
    assert found["first_departure_differs"] == 1
    assert found["stop_count_differs_from_pattern"] == 1
    assert found["last_arrival_differs"] == 1


def test_a_second_load_of_the_source_is_refused_while_one_runs(options: LoadOptions) -> None:
    with psycopg.connect(options.database_url) as holder, holder.transaction():
        lock_source(holder, "delfi-gtfs")
        with pytest.raises(LoadLockedError):
            run_load(options)


def test_a_load_without_eva_keeps_the_stored_eva_numbers(options: LoadOptions) -> None:
    run_load(options)
    run_load(replace(options, eva_path=None))
    with psycopg.connect(options.database_url) as conn:
        assert conn.execute(
            "SELECT eva FROM stop_place WHERE dhid = 'de:11000:900003201'"
        ).fetchone() == (8011160,)


STOP_TIMES_BY_CATEGORY = """
    EXPLAIN SELECT t.category_code, count(*) FROM stop_time s
      JOIN trip t USING (feed_version_id, trip_key)
     WHERE s.feed_version_id = %s GROUP BY 1
"""


def test_a_second_version_is_counted_with_fresh_statistics(
    options: LoadOptions, second_version_feed: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_load(options)
    with psycopg.connect(options.database_url, autocommit=True) as conn:
        conn.execute("ANALYZE")
    plans: list[str] = []
    counted = db.table_counts

    def explained(conn: psycopg.Connection, version_id: int) -> dict[str, object]:
        rows = conn.execute(STOP_TIMES_BY_CATEGORY, (version_id,)).fetchall()
        plans.append("\n".join(str(row[0]) for row in rows))
        return counted(conn, version_id)

    monkeypatch.setattr("gerlines_static_import.db.table_counts", explained)
    report = run_load(
        replace(
            options,
            feed_path=second_version_feed,
            report_dir=options.data_root / "static" / "2026-10-26",
        )
    )
    assert report["stored"]["trips"] == {"hsr": 3002, "rfast": 1, "night": 1}
    assert report["stored"]["stop_times"] == {"hsr": 6004, "rfast": 2, "night": 2}
    assert len(plans) == 1
    assert "Nested Loop" not in plans[0], plans[0]
    with psycopg.connect(options.database_url) as conn:
        versions = conn.execute(
            "SELECT feed_version, status FROM feed_version ORDER BY feed_version_id"
        ).fetchall()
    assert versions == [("2026-10-17T14:46:34", "loaded"), ("2026-10-24T14:58:08", "loaded")]


def test_published_on_falls_back_to_the_url_then_the_file_date(tmp_path: Path) -> None:
    path = tmp_path / "anywhere" / "feed.zip"
    path.parent.mkdir()
    path.write_bytes(b"x")
    url = "https://example.org/20261026_fahrplaene_gesamtdeutschland_gtfs.zip"
    stamp = datetime(2026, 10, 25, tzinfo=UTC)
    with_url = InputFile(path, "0" * 64, 1, stamp, url)
    assert published_on(with_url) == date(2026, 10, 26)
    without = InputFile(path, "0" * 64, 1, stamp, None)
    assert published_on(without) == datetime.fromtimestamp(path.stat().st_mtime, UTC).date()
