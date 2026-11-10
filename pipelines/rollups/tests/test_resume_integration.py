import json
from collections.abc import Callable

import psycopg
import pytest

from gerlines_rollups.cli import main
from gerlines_rollups.refresh import (
    ALL_ROLLUPS,
    LEVEL1,
    LEVEL2,
    LEVEL3,
    LEVEL3_LEAD_DAYS,
    policy_health,
)

SCHEDULED = (
    "SELECT hypertable_name, scheduled FROM timescaledb_information.jobs"
    " WHERE proc_name = 'policy_refresh_continuous_aggregate'"
)


def level_two_policies_without_a_threshold(url: str) -> None:
    """Level 2 as it stands after a long pause: policies in place, threshold behind level 1."""
    with psycopg.connect(url, autocommit=True) as conn:
        for name in LEVEL2:
            conn.execute(
                "SELECT add_continuous_aggregate_policy(%s, start_offset => NULL,"
                " end_offset => INTERVAL '-7 days', schedule_interval => INTERVAL '30 minutes')",
                (name,),
            )
        conn.execute(
            "SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs"
            " WHERE proc_name = 'policy_refresh_continuous_aggregate'"
        )


def run_cli(
    argv: list[str], url: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> tuple[int, str, str]:
    monkeypatch.setenv("DATABASE_URL", url)
    code = main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_resume_moves_a_lagging_level_two_threshold_before_level_one_runs_again(
    database_factory: Callable[[int | None], str],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    url = database_factory(63)
    level_two_policies_without_a_threshold(url)
    with psycopg.connect(url) as conn:
        before = {row.rollup: row for row in policy_health(conn)}
    assert all(before[name].level1_logged is False for name in LEVEL2)

    code, out, _ = run_cli(["resume"], url, monkeypatch, capsys)

    assert code == 0
    report = json.loads(out)
    assert [item["name"] for item in report["refreshed"]] == ["station_day", "segment_day"]
    assert report["resumed"] == list(LEVEL1 + LEVEL2)
    with psycopg.connect(url) as conn:
        scheduled = dict(conn.execute(SCHEDULED).fetchall())
        after = {row.rollup: row for row in policy_health(conn)}
    assert scheduled == dict.fromkeys(LEVEL1 + LEVEL2, True)
    for name in LEVEL2:
        assert after[name].threshold_margin_days == 5
        assert after[name].level1_logged is True


def test_resume_changes_nothing_while_a_policy_is_missing(
    database_factory: Callable[[int | None], str],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    url = database_factory(63)

    code, out, err = run_cli(["resume"], url, monkeypatch, capsys)

    assert code == 2
    assert out == ""
    assert "station_day" in err
    with psycopg.connect(url) as conn:
        scheduled = dict(conn.execute(SCHEDULED).fetchall())
        margins = {row.rollup: row.threshold_margin_days for row in policy_health(conn)}
    assert scheduled == dict.fromkeys(LEVEL1, False)
    assert all(margins[name] is None or margins[name] < 0 for name in LEVEL2)


def test_pause_stops_every_policy(
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert run_cli(["resume"], database_url, monkeypatch, capsys)[0] == 0

    code, out, _ = run_cli(["pause"], database_url, monkeypatch, capsys)

    assert code == 0
    assert json.loads(out)["paused"] == list(ALL_ROLLUPS)
    with psycopg.connect(database_url) as conn:
        assert dict(conn.execute(SCHEDULED).fetchall()) == dict.fromkeys(ALL_ROLLUPS, False)


def test_resume_puts_level_three_thresholds_past_every_level_two_write(
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    code, out, _ = run_cli(["resume"], database_url, monkeypatch, capsys)

    assert code == 0
    report = json.loads(out)
    assert [item["name"] for item in report["refreshed"]] == [
        "station_day",
        "segment_day",
        *LEVEL3,
    ]
    assert report["resumed"] == list(ALL_ROLLUPS)
    with psycopg.connect(database_url) as conn:
        after = {row.rollup: row for row in policy_health(conn)}
    for name in LEVEL3:
        assert after[name].threshold_margin_days == LEVEL3_LEAD_DAYS - 7
        assert after[name].level1_logged is True
