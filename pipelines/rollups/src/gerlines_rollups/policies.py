"""Pause and resume the refresh policies without leaving a level-1 write unlogged for level 2."""

import time
from dataclasses import dataclass
from datetime import date, timedelta

import psycopg

from gerlines_rollups.refresh import (
    ALL_ROLLUPS,
    LEVEL1,
    LEVEL2,
    LEVEL3,
    LEVEL3_LEAD_DAYS,
    Refreshed,
    present_rollups,
    refresh,
)

POLICY = "policy_refresh_continuous_aggregate"
THRESHOLD_SETTERS = ("station_day", "segment_day")

JOBS = """
SELECT hypertable_name, job_id FROM timescaledb_information.jobs
 WHERE proc_name = %s AND hypertable_name = ANY(%s)
"""
RUNNING = """
SELECT j.hypertable_name FROM timescaledb_information.job_stats s
  JOIN timescaledb_information.jobs j USING (job_id)
 WHERE j.proc_name = %s AND j.hypertable_name = ANY(%s) AND s.job_status = 'Running'
 ORDER BY 1
"""


class PolicyError(RuntimeError):
    """The policies are not in a state the command can work from; nothing was changed after it."""


@dataclass(frozen=True, slots=True)
class Paused:
    paused: list[str]
    waited_s: float


@dataclass(frozen=True, slots=True)
class Resumed:
    paused: list[str]
    waited_s: float
    threshold_to: date
    refreshed: list[Refreshed]
    resumed: list[str]


def policy_jobs(conn: psycopg.Connection, names: tuple[str, ...] = ALL_ROLLUPS) -> dict[str, int]:
    return dict(conn.execute(JOBS, (POLICY, list(names))).fetchall())


def _set_scheduled(conn: psycopg.Connection, job_id: int, *, scheduled: bool) -> None:
    conn.execute("SELECT alter_job(%s, scheduled => %s)", (job_id, scheduled))


def pause(
    conn: psycopg.Connection,
    names: tuple[str, ...] = ALL_ROLLUPS,
    *,
    timeout_s: float = 900,
    poll_s: float = 1,
) -> Paused:
    """Unschedule the policies of ``names`` and wait until none of them is still running, because
    ``alter_job`` does not stop a run in progress."""
    jobs = policy_jobs(conn, names)
    paused = [name for name in names if name in jobs]
    for name in paused:
        _set_scheduled(conn, jobs[name], scheduled=False)
    began = time.monotonic()
    while running := [row[0] for row in conn.execute(RUNNING, (POLICY, paused)).fetchall()]:
        if time.monotonic() - began > timeout_s:
            msg = f"still running after {timeout_s:.0f} s: {', '.join(running)} (left paused)"
            raise PolicyError(msg)
        time.sleep(poll_s)
    return Paused(paused, round(time.monotonic() - began, 1))


def resume(conn: psycopg.Connection, *, timeout_s: float = 900) -> Resumed:
    """Resume after a pause of any length: with every policy paused and idle, refresh level 2 to
    now + 7 days so its thresholds on level 1 lie past anything level 1 writes, and level 3 (when
    migrated) to now + 14 days for the same reason on level 2, then resume levels 1, 2 and 3. A
    plain resume after more than about five days lets the first level-1 run write
    days above a stale threshold, unlogged, racing the first level-2 run."""
    if not conn.autocommit:
        msg = "resume needs an autocommit connection"
        raise ValueError(msg)
    jobs = policy_jobs(conn)
    required = LEVEL1 + LEVEL2 + present_rollups(conn, LEVEL3)
    if missing := [name for name in required if name not in jobs]:
        msg = (
            f"no refresh policy for {', '.join(missing)}; apply the migrations first"
            " (packages/db/README.md, 0064)"
        )
        raise PolicyError(msg)
    paused = pause(conn, timeout_s=timeout_s)
    (threshold_to,) = conn.execute("SELECT (now() + INTERVAL '7 days')::date").fetchone() or (None,)
    refreshed = refresh(conn, None, threshold_to, THRESHOLD_SETTERS)
    level3 = tuple(name for name in LEVEL3 if name in required)
    if level3:
        level3_to = threshold_to + timedelta(days=LEVEL3_LEAD_DAYS - 7)
        refreshed += refresh(conn, None, level3_to, level3)
    resumed = list(required)
    for name in resumed:
        _set_scheduled(conn, jobs[name], scheduled=True)
    return Resumed(paused.paused, paused.waited_s, threshold_to, refreshed, resumed)
