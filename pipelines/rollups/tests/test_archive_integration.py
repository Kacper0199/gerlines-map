from datetime import date

import psycopg
import pytest

from gerlines_rollups.check import run_check
from gerlines_rollups.cli import main
from gerlines_rollups.refresh import ArchivedDaysError, archived_days, refresh

ARCHIVED = date(2025, 11, 12)


def archive(url: str, day: date) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO source (source_id, name, licence, attribution)"
            " VALUES ('test-archive', 'Test archive', 'CC0-1.0', 'Test')"
            " ON CONFLICT DO NOTHING"
        )
        conn.execute(
            "INSERT INTO history_archive_day (service_date, source_id, stop_events, legs)"
            " VALUES (%s, 'test-archive', 0, 0)",
            (day,),
        )


def test_archived_days_lists_the_days_in_a_half_open_range(database_url: str) -> None:
    archive(database_url, ARCHIVED)
    with psycopg.connect(database_url) as conn:
        assert archived_days(conn, date(2025, 11, 1), date(2025, 12, 1)) == [ARCHIVED]
        assert archived_days(conn, None, None) == [ARCHIVED]
        assert archived_days(conn, date(2025, 11, 13), None) == []
        assert archived_days(conn, None, ARCHIVED) == []


def test_a_forced_level_one_refresh_over_an_archived_day_is_refused(database_url: str) -> None:
    archive(database_url, ARCHIVED)
    with psycopg.connect(database_url, autocommit=True) as conn:
        with pytest.raises(ArchivedDaysError, match="2025-11-12"):
            refresh(conn, None, date(2025, 12, 1), force=True)
        with pytest.raises(ArchivedDaysError):
            refresh(conn, ARCHIVED, date(2025, 11, 13), ("stat_segment",), force=True)
        done = refresh(conn, None, date(2025, 12, 1), ("station_day", "segment_day"), force=True)
        assert [item.name for item in done] == ["station_day", "segment_day"]
        assert [item.name for item in refresh(conn, None, date(2025, 12, 1))][:2] == [
            "stat_stop",
            "stat_segment",
        ]
        forced = refresh(conn, date(2025, 11, 13), date(2025, 12, 1), force=True)
        assert len(forced) > 2


def test_the_check_refuses_a_range_with_archived_days(database_url: str) -> None:
    archive(database_url, ARCHIVED)
    with psycopg.connect(database_url) as conn:
        with pytest.raises(ArchivedDaysError, match="2025-11-12"):
            run_check(conn, date(2025, 11, 1), date(2025, 12, 1))
        assert all(
            result.equal for result in run_check(conn, date(2025, 11, 13), date(2025, 12, 1))
        )


def test_the_command_line_names_the_archived_days_and_exits_2(
    database_url: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    archive(database_url, ARCHIVED)
    monkeypatch.setenv("DATABASE_URL", database_url)
    assert main(["refresh", "--force"]) == 2
    assert "2025-11-12" in capsys.readouterr().err
    assert main(["check", "--from", "2025-11-01", "--to", "2025-11-30"]) == 2
