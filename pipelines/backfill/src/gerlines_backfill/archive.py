"""Archive backfilled service days: keep every rollup, drop the raw rows of the day.

A backfilled day is rebuilt from its converted Parquet folder by ``load``, so once its rollups are
refreshed and compressed its ``stop_event`` and ``segment_obs`` chunks are only a reload source.
The chunks are detached and dropped, which logs no invalidation, so the continuous aggregates keep
the day under their policies as they are; ``drop_chunks`` would log one and the next refresh would
empty the rollups of the day. ``history_archive_day`` records each archived day;
``gerlines-rollups`` refuses a forced level-1 refresh and a check over it, and loading the day
again clears the mark.
"""

import time
from dataclasses import dataclass, field
from datetime import date, timedelta

import psycopg
from psycopg import sql

from gerlines_backfill.load import SOURCE_ID, lock_day
from gerlines_rollups.check import PENDING, internal_time
from gerlines_rollups.refresh import ALL_ROLLUPS, present_rollups, refresh

RAW_TABLES = ("stop_event", "segment_obs")


def month_days(month: str) -> list[date]:
    first = date.fromisoformat(f"{month}-01")
    following = date(first.year + first.month // 12, first.month % 12 + 1, 1)
    return [first + timedelta(days=offset) for offset in range((following - first).days)]


class ArchiveError(RuntimeError):
    """A day that cannot be archived safely; no raw row of it was dropped (its rollups may have
    been refreshed and compressed). ``archived`` lists the days of the month archived before it."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.archived: list[dict[str, object]] = []


@dataclass(frozen=True, slots=True)
class Chunk:
    table: str
    schema: str
    name: str


@dataclass(frozen=True, slots=True)
class PreparedDay:
    """A day whose rollups hold its raw rows, with the counts and raw chunks seen then."""

    day: date
    stop_events: int
    legs: int
    chunks: list[Chunk] = field(default_factory=list)
    rollup_chunks_compressed: int = 0


def _sources(conn: psycopg.Connection, day: date) -> set[str]:
    return {
        row[0]
        for row in conn.execute(
            "SELECT DISTINCT source_id FROM stop_event WHERE service_date = %s"
            " UNION SELECT DISTINCT source_id FROM segment_obs WHERE service_date = %s",
            (day, day),
        ).fetchall()
    }


def _raw_counts(conn: psycopg.Connection, day: date) -> tuple[int, int]:
    return conn.execute(
        "SELECT (SELECT count(*) FROM stop_event WHERE service_date = %(d)s),"
        " (SELECT count(*) FROM segment_obs WHERE service_date = %(d)s)",
        {"d": day},
    ).fetchone()


def _level1_counts(conn: psycopg.Connection, day: date) -> tuple[int, int]:
    return conn.execute(
        "SELECT (SELECT count(*) FROM stat_stop WHERE day = %(d)s),"
        " (SELECT count(*) FROM stat_segment WHERE day = %(d)s)",
        {"d": day},
    ).fetchone()


def _day_chunks(conn: psycopg.Connection, day: date) -> list[Chunk]:
    chunks = []
    for table in RAW_TABLES:
        rows = conn.execute(
            "SELECT c.chunk_schema, c.chunk_name, (c.range_start AT TIME ZONE 'UTC')::date,"
            " (c.range_end AT TIME ZONE 'UTC')::date FROM timescaledb_information.chunks c"
            " WHERE c.hypertable_schema = 'public' AND c.hypertable_name = %s AND"
            " (c.range_start AT TIME ZONE 'UTC')::date <= %s"
            " AND (c.range_end AT TIME ZONE 'UTC')::date > %s",
            (table, day, day),
        ).fetchall()
        for schema, name, start, end in rows:
            if (start, end) != (day, day + timedelta(days=1)):
                msg = f"{table} chunk {name} spans {start} to {end}, not the day {day} alone"
                raise ArchiveError(msg)
            chunks.append(Chunk(table, schema, name))
    return chunks


def _regclass(chunk: Chunk) -> sql.Composed:
    return sql.SQL("{}::regclass").format(sql.Literal(f'"{chunk.schema}"."{chunk.name}"'))


def _compress_rollups(conn: psycopg.Connection, day: date) -> int:
    """Compress every rollup chunk that holds the day, whatever its width."""
    return len(
        conn.execute(
            "SELECT compress_chunk(format('%%I.%%I', c.chunk_schema, c.chunk_name)::regclass,"
            " if_not_compressed => true)"
            " FROM _timescaledb_catalog.continuous_agg a"
            " JOIN _timescaledb_catalog.hypertable h ON h.id = a.mat_hypertable_id"
            " JOIN timescaledb_information.chunks c"
            " ON c.hypertable_schema = h.schema_name AND c.hypertable_name = h.table_name"
            " WHERE"
            " (c.range_start AT TIME ZONE 'UTC')::date <= %s"
            " AND (c.range_end AT TIME ZONE 'UTC')::date > %s",
            (day, day),
        ).fetchall()
    )


def _pending(conn: psycopg.Connection, day: date) -> list[str]:
    """Rollups with an invalidation logged over the day: a refresh would recompute it."""
    query = sql.SQL(PENDING).format(
        start=sql.Literal(internal_time(day)),
        end=sql.Literal(internal_time(day + timedelta(days=1))),
    )
    return sorted(name for name, count in conn.execute(query).fetchall() if count)


def prepare_day(conn: psycopg.Connection, day: date) -> PreparedDay | None:
    """Refresh the day's rollups, check level 1 against the raw rows, compress the rollups and
    decompress the raw chunks (outside a transaction: decompressing logs no invalidation). None
    when the day is archived already or holds no raw rows. ``conn`` must be in autocommit mode."""
    if conn.execute("SELECT 1 FROM history_archive_day WHERE service_date = %s", (day,)).fetchone():
        return None
    sources = _sources(conn, day)
    if not sources:
        return None
    if sources != {SOURCE_ID}:
        others = ", ".join(sorted(sources - {SOURCE_ID}))
        msg = f"{day} holds rows of other sources ({others}); only backfilled days are archived"
        raise ArchiveError(msg)
    refresh(conn, day, day + timedelta(days=1), present_rollups(conn, ALL_ROLLUPS))
    stops, legs = _raw_counts(conn, day)
    level1 = _level1_counts(conn, day)
    if level1 != (stops, legs):
        msg = (
            f"{day}: the level-1 rollups hold {level1[0]} stops and {level1[1]} legs, the raw"
            f" rows {stops} and {legs}; refresh them before archiving"
        )
        raise ArchiveError(msg)
    compressed = _compress_rollups(conn, day)
    chunks = _day_chunks(conn, day)
    for chunk in chunks:
        conn.execute(
            sql.SQL("SELECT decompress_chunk({}, if_compressed => true)").format(_regclass(chunk))
        )
    return PreparedDay(day, stops, legs, chunks, compressed)


def detach_day(conn: psycopg.Connection, prepared: PreparedDay) -> None:
    """In one transaction under the day lock that ``load`` also takes: the raw rows are still
    those counted and no rollup has a change logged over the day, else refuse; then detach and
    drop the day's raw chunks and mark the day archived."""
    day = prepared.day
    with conn.transaction():
        lock_day(conn, day)
        counts = _raw_counts(conn, day)
        if counts != (prepared.stop_events, prepared.legs):
            msg = (
                f"{day}: the raw rows changed while archiving ({prepared.stop_events} stops and"
                f" {prepared.legs} legs counted, now {counts[0]} and {counts[1]})"
            )
            raise ArchiveError(msg)
        pending = _pending(conn, day)
        if pending:
            msg = f"{day}: changes pending in {', '.join(pending)}; refresh, then archive again"
            raise ArchiveError(msg)
        if _day_chunks(conn, day) != prepared.chunks:
            msg = f"{day}: the raw chunks changed while archiving"
            raise ArchiveError(msg)
        for chunk in prepared.chunks:
            conn.execute(sql.SQL("CALL detach_chunk({})").format(_regclass(chunk)))
            conn.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(chunk.schema, chunk.name)))
        conn.execute(
            "INSERT INTO history_archive_day (service_date, source_id, stop_events, legs)"
            " VALUES (%s, %s, %s, %s)",
            (day, SOURCE_ID, prepared.stop_events, prepared.legs),
        )


def archive_day(conn: psycopg.Connection, day: date) -> dict[str, object] | None:
    """Archive one service day, or None when it is archived already or holds no raw rows."""
    began = time.perf_counter()
    prepared = prepare_day(conn, day)
    if prepared is None:
        return None
    detach_day(conn, prepared)
    return {
        "service_date": day.isoformat(),
        "stop_events": prepared.stop_events,
        "legs": prepared.legs,
        "raw_chunks_dropped": len(prepared.chunks),
        "rollup_chunks_compressed": prepared.rollup_chunks_compressed,
        "seconds": round(time.perf_counter() - began, 1),
    }


def archive_month(url: str, month: str) -> dict[str, object]:
    """Archive every backfilled service day of ``month`` (YYYY-MM), oldest first. A refusal
    carries the days archived before it (``ArchiveError.archived``)."""
    archived: list[dict[str, object]] = []
    with psycopg.connect(url, autocommit=True, application_name="gerlines-backfill") as conn:
        for day in month_days(month):
            try:
                done = archive_day(conn, day)
            except ArchiveError as error:
                error.archived = archived
                raise
            if done is not None:
                archived.append(done)
    return {"month": month, "archived": archived}
