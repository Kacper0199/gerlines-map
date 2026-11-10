import json
import time
from collections.abc import Callable
from dataclasses import asdict
from datetime import timedelta

import psycopg

from gerlines_rollups.refresh import LEVEL1, LEVEL2, policy_health


def test_a_policy_that_never_ran_is_unhealthy_and_has_no_age(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(
            "SELECT alter_job(job_id, scheduled => true) FROM timescaledb_information.jobs"
            " WHERE proc_name = 'policy_refresh_continuous_aggregate'"
            " AND hypertable_name = 'stat_stop'"
        )
        rows = {row.rollup: row for row in policy_health(conn, timedelta(minutes=30))}
    never = rows["stat_stop"]
    assert never.scheduled
    assert never.last_success_age_s is None
    assert not never.healthy
    json.dumps([asdict(row) for row in rows.values()], allow_nan=False)


POLICY = "policy_refresh_continuous_aggregate"
RESUME = (
    "SELECT alter_job(job_id, scheduled => true, next_start => now())"
    " FROM timescaledb_information.jobs WHERE proc_name = %s"
)
COUNT = "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = %s"
DONE = (
    "SELECT count(*) FROM timescaledb_information.job_stats s"
    " JOIN timescaledb_information.jobs j USING (job_id)"
    " WHERE j.proc_name = %s AND s.last_successful_finish > %s"
)


def run_every_policy(conn: psycopg.Connection) -> None:
    """Resume every policy, let the scheduler run each once, then stop the scheduler again."""
    (since,) = conn.execute("SELECT now()").fetchone() or (None,)
    (policies,) = conn.execute(COUNT, (POLICY,)).fetchone() or (0,)
    conn.execute(RESUME, (POLICY,))
    conn.execute("SELECT _timescaledb_functions.start_background_workers()")
    deadline = time.monotonic() + 45
    try:
        while True:
            done = conn.execute(DONE, (POLICY, since)).fetchone()
            if done == (policies,):
                return
            assert time.monotonic() < deadline, f"only {done} policies ran"
            time.sleep(0.5)
    finally:
        conn.execute("SELECT _timescaledb_functions.stop_background_workers()")


def test_the_max_age_follows_each_schedule_unless_given(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as conn:
        derived = policy_health(conn)
        given = policy_health(conn, timedelta(minutes=10))
    assert {row.max_age_s for row in derived} == {2700.0}
    assert {row.max_age_s for row in given} == {600.0}


def test_level_two_is_red_while_level_one_writes_land_at_or_above_its_threshold(
    database_factory: Callable[[int | None], str],
    migrator: Callable[..., None],
) -> None:
    url = database_factory(63)
    with psycopg.connect(url, autocommit=True) as conn:
        for name in LEVEL2:
            conn.execute(
                "SELECT add_continuous_aggregate_policy(%s, start_offset => NULL,"
                " end_offset => INTERVAL '-2 days', schedule_interval => INTERVAL '30 minutes')",
                (name,),
            )
        run_every_policy(conn)
        before = {row.rollup: row for row in policy_health(conn)}
    assert all(before[name].healthy for name in LEVEL1)
    assert all(before[name].level1_logged is None for name in LEVEL1)
    for name in LEVEL2:
        assert before[name].last_success_age_s is not None
        assert before[name].threshold_margin_days == 0
        assert before[name].level1_logged is False
        assert not before[name].healthy

    with psycopg.connect(url, autocommit=True) as conn:
        for name in LEVEL2:
            conn.execute("SELECT remove_continuous_aggregate_policy(%s)", (name,))
    migrator(url, after=63)
    with psycopg.connect(url, autocommit=True) as conn:
        run_every_policy(conn)
        after = {row.rollup: row for row in policy_health(conn)}
    assert all(row.healthy for row in after.values())
    for name in LEVEL2:
        assert after[name].threshold_margin_days == 5
        assert after[name].level1_logged is True
