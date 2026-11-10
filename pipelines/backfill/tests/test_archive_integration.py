import json
import shutil
import threading
import time
from dataclasses import replace
from datetime import date
from pathlib import Path

import polars as pl
import psycopg
import pytest

from gerlines_backfill.archive import ArchiveError, archive_month, detach_day, prepare_day
from gerlines_backfill.cli import main
from gerlines_backfill.load import MonthInput, load_month, lock_day
from gerlines_backfill.month import convert_month
from gerlines_rollups.refresh import ALL_ROLLUPS

FIXTURES = Path(__file__).parent / "fixtures"
DAYS = [date(2025, 11, 12), date(2025, 11, 30)]
ROLLUP_TOTALS = (
    "SELECT (SELECT count(*) FROM stat_stop), (SELECT count(*) FROM stat_segment),"
    " (SELECT coalesce(sum(n_stops), 0) FROM station_day),"
    " (SELECT coalesce(sum(n_stops), 0) FROM station_hour),"
    " (SELECT coalesce(sum(n_legs), 0) FROM segment_day),"
    " (SELECT coalesce(sum(n_stops), 0) FROM land_category_day)"
)


@pytest.fixture
def month(tmp_path: Path) -> MonthInput:
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    for name in ("2025-11", "2025-12"):
        shutil.copy(FIXTURES / f"piebro-{name}.parquet", inputs / f"data-{name}.parquet")
    convert_month(inputs, "2025-11", tmp_path / "out")
    stations = tmp_path / "stations.parquet"
    pl.DataFrame(
        {"eva": [8000152], "lat": [52.3768], "lon": [9.7411], "name": ["Hannover Hbf"]},
        schema_overrides={"eva": pl.Int64},
    ).with_columns(meta_evas=pl.lit([], dtype=pl.List(pl.Int64))).write_parquet(stations)
    return MonthInput(
        month="2025-11",
        folder=tmp_path / "out" / "2025-11",
        source_file=FIXTURES / "piebro-2025-11.parquet",
        object_key="piebro/test/data-2025-11.parquet",
        request_url="https://huggingface.co/datasets/piebro/deutsche-bahn-data/resolve/x/y",
        stations=stations,
        until=None,
        overrides=None,
    )


def raw_counts(url: str) -> tuple[int, int]:
    with psycopg.connect(url) as conn:
        return conn.execute(
            "SELECT (SELECT count(*) FROM stop_event), (SELECT count(*) FROM segment_obs)"
        ).fetchone()


def rollup_totals(url: str) -> tuple[int, ...]:
    with psycopg.connect(url) as conn:
        return conn.execute(ROLLUP_TOTALS).fetchone()


def refresh_everything(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        for name in ALL_ROLLUPS:
            conn.execute("CALL refresh_continuous_aggregate(%s, NULL, NULL)", (name,))


def test_archiving_drops_the_raw_rows_and_keeps_every_rollup(
    database_url: str, month: MonthInput
) -> None:
    load_month(database_url, month, compress=True)
    stops, legs = raw_counts(database_url)
    report = archive_month(database_url, "2025-11")
    assert [day["service_date"] for day in report["archived"]] == [d.isoformat() for d in DAYS]
    assert sum(day["stop_events"] for day in report["archived"]) == stops
    assert sum(day["legs"] for day in report["archived"]) == legs
    assert raw_counts(database_url) == (0, 0)
    kept = rollup_totals(database_url)
    assert kept[0] == stops
    assert kept[1] == legs
    assert all(value > 0 for value in kept)
    refresh_everything(database_url)
    assert rollup_totals(database_url) == kept
    with psycopg.connect(database_url) as conn:
        archived = conn.execute(
            "SELECT service_date, stop_events, legs FROM history_archive_day ORDER BY 1"
        ).fetchall()
        compressed = conn.execute(
            "SELECT count(*) FILTER (WHERE NOT is_compressed) FROM timescaledb_information.chunks c"
            " JOIN _timescaledb_catalog.hypertable h ON h.table_name = c.hypertable_name"
            " JOIN _timescaledb_catalog.continuous_agg a ON a.mat_hypertable_id = h.id"
        ).fetchone()[0]
    assert [row[0] for row in archived] == DAYS
    assert compressed == 0
    assert archive_month(database_url, "2025-11")["archived"] == []


def test_reloading_an_archived_day_restores_its_raw_rows_and_clears_the_mark(
    database_url: str, month: MonthInput
) -> None:
    load_month(database_url, month, compress=True)
    before = raw_counts(database_url)
    archive_month(database_url, "2025-11")
    kept_before = rollup_totals(database_url)
    load_month(database_url, month, compress=True)
    assert raw_counts(database_url) == before
    with psycopg.connect(database_url) as conn:
        assert conn.execute("SELECT count(*) FROM history_archive_day").fetchone()[0] == 0
    refresh_everything(database_url)
    assert rollup_totals(database_url) == kept_before


def test_a_day_with_rows_of_another_source_is_not_archived(
    database_url: str, month: MonthInput
) -> None:
    load_month(database_url, month)
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('test-live', 'Test live', 'CC0-1.0', 'Test')"
        )
        conn.execute(
            "INSERT INTO stop_event (service_date, trip_instance_id, stop_index, source_id,"
            " stop_place_id, cancelled, additional, observed_at, raw_object_id)"
            " SELECT service_date, trip_instance_id, stop_index, 'test-live', stop_place_id,"
            " cancelled, additional, observed_at, raw_object_id"
            " FROM stop_event WHERE service_date = %s LIMIT 1",
            (DAYS[0],),
        )
    with pytest.raises(ArchiveError, match="test-live"):
        archive_month(database_url, "2025-11")
    with psycopg.connect(database_url) as conn:
        assert conn.execute("SELECT count(*) FROM history_archive_day").fetchone()[0] == 0


def test_the_archive_command_reports_each_month_and_stops_on_a_refusal(
    database_url: str,
    month: MonthInput,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    load_month(database_url, month, compress=True)
    monkeypatch.setenv("DATABASE_URL", database_url)
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('test-live', 'Test live', 'CC0-1.0', 'Test')"
        )
        conn.execute(
            "INSERT INTO stop_event (service_date, trip_instance_id, stop_index, source_id,"
            " stop_place_id, cancelled, additional, observed_at, raw_object_id)"
            " SELECT service_date, trip_instance_id, stop_index, 'test-live', stop_place_id,"
            " cancelled, additional, observed_at, raw_object_id"
            " FROM stop_event WHERE service_date = %s LIMIT 1",
            (DAYS[0],),
        )
    assert main(["archive", "--first", "2025-11", "--last", "2025-11"]) == 1
    refused = capsys.readouterr()
    assert "test-live" in refused.err
    assert json.loads(refused.out.splitlines()[-1])["archived"] == []
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0;"
            " DELETE FROM stop_event WHERE source_id = 'test-live'"
        )
    assert main(["archive", "--first", "2025-11", "--last", "2025-11"]) == 0
    report = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert [day["service_date"] for day in report["archived"]] == [d.isoformat() for d in DAYS]


def test_a_row_written_between_the_count_and_the_detach_is_refused(
    database_url: str, month: MonthInput
) -> None:
    load_month(database_url, month, compress=True)
    before = raw_counts(database_url)
    with psycopg.connect(database_url, autocommit=True) as conn:
        prepared = prepare_day(conn, DAYS[0])
        assert prepared is not None
        with psycopg.connect(database_url) as writer:
            writer.execute(
                "INSERT INTO stop_event (service_date, trip_instance_id, stop_index, source_id,"
                " stop_place_id, cancelled, additional, observed_at, raw_object_id)"
                " SELECT service_date, trip_instance_id, stop_index + 100, source_id,"
                " stop_place_id, cancelled, additional, observed_at, raw_object_id"
                " FROM stop_event WHERE service_date = %s LIMIT 1",
                (DAYS[0],),
            )
        with pytest.raises(ArchiveError, match="changed"):
            detach_day(conn, prepared)
    assert raw_counts(database_url) == (before[0] + 1, before[1])
    with psycopg.connect(database_url) as conn:
        assert conn.execute("SELECT count(*) FROM history_archive_day").fetchone()[0] == 0


def test_a_pending_invalidation_of_the_day_is_refused(database_url: str, month: MonthInput) -> None:
    load_month(database_url, month, compress=True)
    with psycopg.connect(database_url, autocommit=True) as conn:
        prepared = prepare_day(conn, DAYS[0])
        assert prepared is not None
        conn.execute(
            "UPDATE stop_event SET additional = additional WHERE service_date = %s"
            " AND stop_index = 0",
            (DAYS[0],),
        )
        with pytest.raises(ArchiveError, match="pending"):
            detach_day(conn, prepared)


def test_load_takes_the_day_lock_that_archive_takes(database_url: str, month: MonthInput) -> None:
    load_month(database_url, month, compress=True)
    with psycopg.connect(database_url) as holder:
        lock_day(holder, DAYS[0])
        loading = threading.Thread(target=load_month, args=(database_url, month))
        loading.start()
        deadline = time.monotonic() + 30
        waiting = 0
        while waiting == 0 and time.monotonic() < deadline:
            time.sleep(0.2)
            waiting = holder.execute(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
            ).fetchone()[0]
        assert waiting == 1
        assert loading.is_alive()
        holder.rollback()
        loading.join(60)
    assert not loading.is_alive()


def test_loading_over_the_cut_over_clears_the_mark_of_a_removed_day(
    database_url: str, month: MonthInput
) -> None:
    load_month(database_url, month, compress=True)
    archive_month(database_url, "2025-11")
    load_month(database_url, replace(month, until=DAYS[1]), compress=True)
    with psycopg.connect(database_url) as conn:
        marks = conn.execute("SELECT service_date FROM history_archive_day").fetchall()
    assert marks == []


def test_day_boundaries_do_not_depend_on_the_session_time_zone(
    database_url: str, month: MonthInput, monkeypatch: pytest.MonkeyPatch
) -> None:
    load_month(database_url, month, compress=True)
    monkeypatch.setenv("PGTZ", "America/New_York")
    report = archive_month(database_url, "2025-11")
    assert [day["service_date"] for day in report["archived"]] == [d.isoformat() for d in DAYS]
    assert raw_counts(database_url) == (0, 0)
