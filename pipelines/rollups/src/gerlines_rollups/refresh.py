"""Refresh the rollups in dependency order, measure what each refresh costs, check the policies."""

import time
from dataclasses import dataclass
from datetime import date, timedelta

import psycopg
from psycopg import sql

LEVEL1 = ("stat_stop", "stat_segment")
LEVEL2 = (
    "station_day",
    "station_hour",
    "train_day",
    "line_day",
    "segment_day",
)
LEVEL3 = ("land_category_day", "land_category_hour")
"""Level 3 reads level 2 joined to ``stop_place_land`` (0066). Its policies refresh to now + 14
days, past the 7 days ahead that level 2 writes, so every level-2 write is logged for level 3."""
LEVEL3_LEAD_DAYS = 14
ALL_ROLLUPS = LEVEL1 + LEVEL2 + LEVEL3


def present_rollups(
    conn: psycopg.Connection, names: tuple[str, ...] = ALL_ROLLUPS
) -> tuple[str, ...]:
    """The rollups of ``names`` in this database, in the order given (level 3 needs 0066)."""
    found = {
        row[0]
        for row in conn.execute(
            "SELECT user_view_name::text FROM _timescaledb_catalog.continuous_agg"
            " WHERE user_view_name = ANY(%s)",
            (list(names),),
        ).fetchall()
    }
    return tuple(name for name in names if name in found)


class ArchivedDaysError(RuntimeError):
    """The range holds service days whose raw rows were dropped (``history_archive_day``)."""


def archived_days(conn: psycopg.Connection, start: date | None, end: date | None) -> list[date]:
    """Archived service days in [start, end); None leaves that side open. Empty before 0096."""
    (present,) = conn.execute(
        "SELECT to_regclass('history_archive_day') IS NOT NULL"
    ).fetchone() or (False,)
    if not present:
        return []
    return [
        row[0]
        for row in conn.execute(
            "SELECT service_date FROM history_archive_day"
            " WHERE (%s::date IS NULL OR service_date >= %s::date)"
            " AND (%s::date IS NULL OR service_date < %s::date) ORDER BY 1",
            (start, start, end, end),
        ).fetchall()
    ]


def refuse_archived(
    conn: psycopg.Connection, start: date | None, end: date | None, what: str
) -> None:
    days = archived_days(conn, start, end)
    if days:
        shown = ", ".join(day.isoformat() for day in days[:5]) + (" ..." if len(days) > 5 else "")
        msg = (
            f"{what} would read service days without raw rows ({len(days)} archived: {shown});"
            " leave them out of the range"
        )
        raise ArchivedDaysError(msg)


@dataclass(frozen=True, slots=True)
class Refreshed:
    name: str
    seconds: float


def refresh(
    conn: psycopg.Connection,
    start: date | None,
    end: date | None,
    names: tuple[str, ...] = ALL_ROLLUPS,
    *,
    force: bool = False,
) -> list[Refreshed]:
    """Refresh ``names`` in order for buckets in [start, end); None leaves that side open.

    A forced level-1 refresh recomputes every day of the range from the raw rows, so it is refused
    over archived days, whose raw rows are gone; a refresh that is not forced recomputes only days
    with logged changes, and dropping archived chunks with ``detach_chunk`` logs none.

    ``conn`` must be in autocommit mode: TimescaleDB refuses a refresh inside a transaction.
    """
    if not conn.autocommit:
        msg = "refresh needs an autocommit connection"
        raise ValueError(msg)
    if force and set(names) & set(LEVEL1):
        refuse_archived(conn, start, end, "a forced level-1 refresh")
    done: list[Refreshed] = []
    for name in names:
        if name not in ALL_ROLLUPS:
            msg = f"unknown rollup {name}"
            raise ValueError(msg)
        began = time.perf_counter()
        conn.execute(
            sql.SQL(
                "CALL refresh_continuous_aggregate({}, {}::date, {}::date, force => {})"
            ).format(sql.Literal(name), sql.Literal(start), sql.Literal(end), sql.Literal(force))
        )
        done.append(Refreshed(name, round(time.perf_counter() - began, 3)))
    return done


MAX_AGE_SCHEDULES = 1.5


@dataclass(frozen=True, slots=True)
class PolicyHealth:
    rollup: str
    job_id: int | None
    scheduled: bool
    last_success_age_s: float | None
    max_age_s: float | None
    last_run_status: str | None
    total_failures: int
    threshold_margin_days: int | None
    level1_logged: bool | None
    healthy: bool


HEALTH = """
SELECT v.name, j.job_id, coalesce(j.scheduled, false),
       CASE WHEN isfinite(s.last_successful_finish)
            THEN extract(epoch FROM now() - s.last_successful_finish)::double precision END,
       extract(epoch FROM j.schedule_interval)::double precision,
       s.last_run_status, coalesce(s.total_failures, 0),
       parent.mat_hypertable_id IS NOT NULL,
       _timescaledb_functions.to_timestamp_without_timezone(t.watermark)::date
         - (now() - (pj.config->>'end_offset')::interval)::date
  FROM unnest(%s::text[]) AS v (name)
  LEFT JOIN timescaledb_information.jobs j
    ON j.proc_name = 'policy_refresh_continuous_aggregate' AND j.hypertable_name = v.name
  LEFT JOIN timescaledb_information.job_stats s ON s.job_id = j.job_id
  LEFT JOIN _timescaledb_catalog.continuous_agg ca ON ca.user_view_name = v.name
  LEFT JOIN _timescaledb_catalog.continuous_agg parent
    ON parent.mat_hypertable_id = ca.raw_hypertable_id
  LEFT JOIN timescaledb_information.jobs pj
    ON pj.proc_name = 'policy_refresh_continuous_aggregate'
   AND pj.hypertable_name = parent.user_view_name
  LEFT JOIN _timescaledb_catalog.continuous_aggs_invalidation_threshold t
    ON t.hypertable_id = parent.mat_hypertable_id
"""


def policy_health(conn: psycopg.Connection, max_age: timedelta | None = None) -> list[PolicyHealth]:
    """One row per rollup: its policy is scheduled and succeeded within max_age (default 1.5
    schedules), and for level 2, every day level 1 can write lies below the level-2 threshold on
    level 1, so level 2 logs those writes. A level-1 write at or above that threshold is not
    logged and is lost for good when it commits after a concurrent level-2 run."""
    found = []
    for name, job_id, scheduled, age, schedule_s, status, failures, level2, margin in conn.execute(
        HEALTH, (list(present_rollups(conn)),)
    ).fetchall():
        limit = (
            max_age.total_seconds()
            if max_age is not None
            else None
            if schedule_s is None
            else MAX_AGE_SCHEDULES * schedule_s
        )
        logged = (margin is not None and margin >= 1) if level2 else None
        healthy = (
            job_id is not None
            and scheduled
            and age is not None
            and limit is not None
            and age <= limit
            and logged is not False
        )
        found.append(
            PolicyHealth(
                name,
                job_id,
                scheduled,
                None if age is None else round(age, 1),
                limit,
                status,
                failures,
                margin,
                logged,
                healthy,
            )
        )
    return found


def refresh_lands(conn: psycopg.Connection) -> list[Refreshed]:
    """Rebuild level 3 over its whole range after the Land of stop places changed: a change in
    ``stop_place_land`` alone logs no invalidation, so only a forced refresh picks it up."""
    (end,) = conn.execute(
        "SELECT (now() + make_interval(days => %s))::date", (LEVEL3_LEAD_DAYS,)
    ).fetchone() or (None,)
    return refresh(conn, None, end, present_rollups(conn, LEVEL3), force=True)
