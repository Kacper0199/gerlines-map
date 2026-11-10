"""Database writes for the static import: COPY into staging tables, then set-based upserts.

Every function takes an open psycopg connection and leaves transaction control to the caller,
so one feed version is loaded in a single transaction and a failure leaves no partial version.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

import psycopg
from psycopg import sql

from gerlines_static_import.identity import StoredPlace
from gerlines_static_import.operators import Operator
from gerlines_static_import.stops import KnownIds, StopModel
from gerlines_static_import.timetable import (
    Pattern,
    Route,
    Service,
    StopTimeRow,
    Trip,
    TripTimes,
)


@dataclass(frozen=True, slots=True)
class SourceRow:
    source_id: str
    name: str
    homepage_url: str
    licence: str
    licence_url: str
    attribution: str


@dataclass(frozen=True, slots=True)
class IdMapResult:
    written: int
    conflicts: int


def upsert_sources(conn: psycopg.Connection, sources: Iterable[SourceRow]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO source (source_id, name, homepage_url, licence, licence_url, attribution)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (source_id) DO UPDATE SET
              name = excluded.name,
              homepage_url = excluded.homepage_url,
              licence = excluded.licence,
              licence_url = excluded.licence_url,
              attribution = excluded.attribution
            """,
            [
                (s.source_id, s.name, s.homepage_url, s.licence, s.licence_url, s.attribution)
                for s in sources
            ],
        )


def start_run(conn: psycopg.Connection, source_id: str, job: str, app_version: str) -> UUID:
    row = conn.execute(
        "INSERT INTO ingest_run (source_id, job, app_version) VALUES (%s, %s, %s)"
        " RETURNING ingest_run_id",
        (source_id, job, app_version),
    ).fetchone()
    if row is None:
        msg = "ingest_run insert returned no row"
        raise RuntimeError(msg)
    return row[0]


def finish_run(conn: psycopg.Connection, run_id: UUID, error: str | None = None) -> None:
    conn.execute(
        "UPDATE ingest_run SET status = %s, finished_at = now(), error_message = %s"
        " WHERE ingest_run_id = %s",
        ("failed" if error else "succeeded", error, run_id),
    )


def upsert_raw_object(  # noqa: PLR0913
    conn: psycopg.Connection,
    *,
    source_id: str,
    run_id: UUID,
    object_key: str,
    sha256: str,
    size: int,
    fetched_at: datetime,
    request_url: str | None,
) -> UUID:
    conn.execute(
        """
        INSERT INTO raw_object (source_id, ingest_run_id, object_key, sha256, bytes,
                                content_type, fetched_at, http_status, request_url)
        VALUES (%s, %s, %s, %s, %s, 'application/zip', %s, 200, %s)
        ON CONFLICT (object_key) DO NOTHING
        """,
        (source_id, run_id, object_key, sha256, size, fetched_at, request_url),
    )
    row = conn.execute(
        "SELECT raw_object_id, sha256 FROM raw_object WHERE object_key = %s", (object_key,)
    ).fetchone()
    if row is None or row[1] != sha256:
        msg = f"raw_object {object_key} exists with another sha256"
        raise RuntimeError(msg)
    return row[0]


def upsert_operators(
    conn: psycopg.Connection, operators: Iterable[Operator], source_id: str, seen_at: datetime
) -> int:
    """Insert new operators, fill a missing country, record aliases; return alias conflicts."""
    rows = list(operators)
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO operator (operator_id, name, name_source_id, country_code)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (operator_id) DO UPDATE SET
              country_code = COALESCE(excluded.country_code, operator.country_code)
            """,
            [(o.operator_id, o.name, source_id, o.country_code) for o in rows],
        )
        cur.execute("CREATE TEMP TABLE stage_alias (alias text, operator_id text) ON COMMIT DROP")
        with cur.copy("COPY stage_alias (alias, operator_id) FROM STDIN") as copy:
            for operator in rows:
                for alias in sorted(operator.aliases):
                    copy.write_row((alias, operator.operator_id))
        cur.execute(
            """
            INSERT INTO operator_alias (source_id, alias, operator_id, first_seen_at, last_seen_at)
            SELECT %(source)s, alias, operator_id, %(seen)s, %(seen)s FROM stage_alias
            ON CONFLICT (source_id, alias) DO UPDATE SET last_seen_at = excluded.last_seen_at
            WHERE operator_alias.operator_id = excluded.operator_id
            """,
            {"source": source_id, "seen": seen_at},
        )
        written = cur.rowcount
        staged = cur.execute("SELECT count(*) FROM stage_alias").fetchone()
        cur.execute("DROP TABLE stage_alias")
    return (staged[0] if staged else 0) - written


def known_stop_ids(conn: psycopg.Connection, source_id: str) -> KnownIds:
    """Mapped place and point keys of ``source_id``, and places and points by DHID."""
    places = dict(
        conn.execute(
            "SELECT source_key, canonical_id FROM id_map WHERE source_id = %s AND entity = %s",
            (source_id, "stop_place"),
        ).fetchall()
    )
    points = dict(
        conn.execute(
            "SELECT source_key, canonical_id FROM id_map WHERE source_id = %s AND entity = %s",
            (source_id, "stop_point"),
        ).fetchall()
    )
    places_by_dhid = dict(
        conn.execute("SELECT dhid, stop_place_id FROM stop_place WHERE dhid IS NOT NULL").fetchall()
    )
    points_by_dhid = dict(
        conn.execute("SELECT dhid, stop_point_id FROM stop_point WHERE dhid IS NOT NULL").fetchall()
    )
    return KnownIds(places, points, places_by_dhid, points_by_dhid)


def stored_places(conn: psycopg.Connection, source_id: str) -> list[StoredPlace]:
    """Stop places ``source_id`` has mapped in ``id_map``, with their keys, for identity reuse."""
    rows = conn.execute(
        """
        SELECT p.stop_place_id, p.name, ST_Y(p.geom), ST_X(p.geom), p.dhid, p.ifopt, p.eva,
               array_agg(m.source_key ORDER BY m.source_key)
          FROM stop_place p
          JOIN id_map m ON m.canonical_id = p.stop_place_id
         WHERE m.source_id = %s AND m.entity = 'stop_place'
         GROUP BY p.stop_place_id
        """,
        (source_id,),
    ).fetchall()
    return [
        StoredPlace(
            stop_place_id=row[0],
            name=row[1],
            lat=row[2],
            lon=row[3],
            dhid=row[4],
            ifopt=row[5],
            eva=row[6],
            keys=tuple(row[7]),
        )
        for row in rows
    ]


def _point(lat: float | None, lon: float | None) -> str | None:
    if lat is None or lon is None:
        return None
    return f"SRID=4326;POINT({lon!r} {lat!r})"


def upsert_stops(conn: psycopg.Connection, model: StopModel, source_id: str) -> int:
    """Write places and points; names, coordinates and EVA follow the latest feed.

    A stored place gives up a DHID or IFOPT that a place of this feed carries under another id
    (a ``separate`` override after the place took the id); returns how many ids it gave up.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TEMP TABLE stage_place (
              stop_place_id uuid, name text, dhid text, eva integer, ifopt text,
              country_code text, geom geometry(Point, 4326)
            ) ON COMMIT DROP
            """
        )
        with cur.copy(
            "COPY stage_place (stop_place_id, name, dhid, eva, ifopt, country_code, geom)"
            " FROM STDIN"
        ) as copy:
            for place in model.places.values():
                copy.write_row(
                    (
                        place.canonical,
                        place.name,
                        place.dhid,
                        place.eva,
                        place.ifopt,
                        place.country_code,
                        _point(place.lat, place.lon),
                    )
                )
        released = 0
        for column in ("dhid", "ifopt"):
            cur.execute(
                sql.SQL(
                    "UPDATE stop_place p SET {column} = NULL FROM stage_place s"
                    " WHERE s.{column} IS NOT NULL AND p.{column} = s.{column}"
                    " AND p.stop_place_id <> s.stop_place_id"
                ).format(column=sql.Identifier(column))
            )
            released += cur.rowcount
        cur.execute(
            """
            INSERT INTO stop_place (stop_place_id, name, name_source_id, dhid, eva, ifopt,
                                    country_code, geom, geom_source_id)
            SELECT stop_place_id, name, %(source)s, dhid, eva, ifopt, country_code, geom,
                   CASE WHEN geom IS NULL THEN NULL ELSE %(source)s END
              FROM stage_place
            ON CONFLICT (stop_place_id) DO UPDATE SET
              name = excluded.name,
              name_source_id = excluded.name_source_id,
              dhid = COALESCE(stop_place.dhid, excluded.dhid),
              eva = COALESCE(excluded.eva, stop_place.eva),
              ifopt = COALESCE(stop_place.ifopt, excluded.ifopt),
              country_code = COALESCE(excluded.country_code, stop_place.country_code),
              geom = COALESCE(excluded.geom, stop_place.geom),
              geom_source_id = CASE WHEN excluded.geom IS NULL THEN stop_place.geom_source_id
                                    ELSE excluded.geom_source_id END
            """,
            {"source": source_id},
        )
        cur.execute(
            """
            CREATE TEMP TABLE stage_point (
              stop_point_id uuid, stop_place_id uuid, name text, platform_code text,
              dhid text, ifopt text, geom geometry(Point, 4326)
            ) ON COMMIT DROP
            """
        )
        with cur.copy(
            "COPY stage_point (stop_point_id, stop_place_id, name, platform_code, dhid, ifopt,"
            " geom) FROM STDIN"
        ) as copy:
            for point in model.points.values():
                copy.write_row(
                    (
                        point.canonical,
                        model.places[point.place_key].canonical,
                        point.name or None,
                        point.platform_code,
                        point.dhid,
                        point.ifopt,
                        _point(point.lat, point.lon),
                    )
                )
        cur.execute(
            """
            INSERT INTO stop_point (stop_point_id, stop_place_id, name, name_source_id,
                                    platform_code, dhid, ifopt, geom, geom_source_id)
            SELECT stop_point_id, stop_place_id, name,
                   CASE WHEN name IS NULL THEN NULL ELSE %(source)s END,
                   platform_code, dhid, ifopt, geom,
                   CASE WHEN geom IS NULL THEN NULL ELSE %(source)s END
              FROM stage_point
            ON CONFLICT (stop_point_id) DO UPDATE SET
              stop_place_id = excluded.stop_place_id,
              name = excluded.name,
              name_source_id = excluded.name_source_id,
              platform_code = excluded.platform_code,
              dhid = COALESCE(stop_point.dhid, excluded.dhid),
              ifopt = COALESCE(stop_point.ifopt, excluded.ifopt),
              geom = COALESCE(excluded.geom, stop_point.geom),
              geom_source_id = CASE WHEN excluded.geom IS NULL THEN stop_point.geom_source_id
                                    ELSE excluded.geom_source_id END
            """,
            {"source": source_id},
        )
        cur.execute("DROP TABLE stage_place")
        cur.execute("DROP TABLE stage_point")
    return released


def upsert_id_map(
    conn: psycopg.Connection,
    source_id: str,
    entity: str,
    mappings: Iterable[tuple[str, UUID]],
    seen_at: datetime,
) -> IdMapResult:
    """The documented id_map upsert; a key now mapped elsewhere is counted, never overwritten."""
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TEMP TABLE stage_id (source_key text, canonical_id uuid) ON COMMIT DROP"
        )
        with cur.copy("COPY stage_id (source_key, canonical_id) FROM STDIN") as copy:
            for key, canonical in mappings:
                copy.write_row((key, canonical))
        cur.execute(
            """
            INSERT INTO id_map (source_id, entity, source_key, canonical_id,
                                first_seen_at, last_seen_at)
            SELECT %(source)s, %(entity)s, source_key, canonical_id, %(seen)s, %(seen)s
              FROM stage_id
            ON CONFLICT (source_id, entity, source_key)
            DO UPDATE SET last_seen_at = excluded.last_seen_at
            WHERE id_map.canonical_id = excluded.canonical_id
            """,
            {"source": source_id, "entity": entity, "seen": seen_at},
        )
        written = cur.rowcount
        staged = cur.execute("SELECT count(*) FROM stage_id").fetchone()
        cur.execute("DROP TABLE stage_id")
    total = staged[0] if staged else 0
    return IdMapResult(written=written, conflicts=total - written)


def remap_id_map(
    conn: psycopg.Connection,
    source_id: str,
    entity: str,
    mappings: Iterable[tuple[str, UUID]],
    seen_at: datetime,
) -> int:
    """Point keys a separate override gave their own place at it; the one overwrite of id_map."""
    with conn.cursor() as cur:
        cur.executemany(
            """
            UPDATE id_map SET canonical_id = %(canonical)s, last_seen_at = %(seen)s
             WHERE source_id = %(source)s AND entity = %(entity)s AND source_key = %(key)s
               AND canonical_id <> %(canonical)s
            """,
            [
                {"source": source_id, "entity": entity, "key": key, "canonical": canonical,
                 "seen": seen_at}
                for key, canonical in mappings
            ],
        )  # fmt: skip
        return cur.rowcount


@dataclass(frozen=True, slots=True)
class VersionKey:
    source_id: str
    sha256: str


def open_feed_version(  # noqa: PLR0913
    conn: psycopg.Connection,
    key: VersionKey,
    *,
    raw_object_id: UUID,
    published_on: object,
    feed_version: str | None,
    valid_from: object,
    valid_to: object,
    category_codes: Sequence[str],
    run_id: UUID,
) -> tuple[int, bool]:
    """Return the version id and whether it existed; an existing version is emptied first."""
    row = conn.execute(
        "SELECT feed_version_id FROM feed_version WHERE source_id = %s AND sha256 = %s",
        (key.source_id, key.sha256),
    ).fetchone()
    values = (
        raw_object_id,
        published_on,
        feed_version,
        valid_from,
        valid_to,
        list(category_codes),
        run_id,
    )
    if row is None:
        created = conn.execute(
            """
            INSERT INTO feed_version (source_id, sha256, raw_object_id, published_on, feed_version,
                                      valid_from, valid_to, category_codes, ingest_run_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING feed_version_id
            """,
            (key.source_id, key.sha256, *values),
        ).fetchone()
        if created is None:
            msg = "feed_version insert returned no row"
            raise RuntimeError(msg)
        return created[0], False
    version_id = row[0]
    for table in (
        "stop_time",
        "trip",
        "trip_pattern_stop",
        "trip_pattern",
        "service_calendar_date",
        "service_calendar",
        "route",
    ):
        conn.execute(
            sql.SQL("DELETE FROM {} WHERE feed_version_id = %s").format(sql.Identifier(table)),
            (version_id,),
        )
    conn.execute(
        """
        UPDATE feed_version SET raw_object_id = %s, published_on = %s, feed_version = %s,
               valid_from = %s, valid_to = %s, category_codes = %s, ingest_run_id = %s,
               status = 'loading', loaded_at = NULL, row_counts = '{}'
         WHERE feed_version_id = %s
        """,
        (*values, version_id),
    )
    return version_id, True


def create_stop_time_stage(conn: psycopg.Connection) -> None:
    conn.execute(
        """
        CREATE TEMP TABLE stage_stop_time (
          trip_key text, stop_index smallint, stop_sequence integer, arrival_s integer,
          departure_s integer, pickup_type smallint, drop_off_type smallint
        ) ON COMMIT DROP
        """
    )


class StopTimeStage:
    """Context manager around a COPY into ``stage_stop_time``; call it with each trip's rows."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._cursor = conn.cursor()
        self._copy_context = self._cursor.copy(
            "COPY stage_stop_time (trip_key, stop_index, stop_sequence, arrival_s, departure_s,"
            " pickup_type, drop_off_type) FROM STDIN"
        )
        self._copy: psycopg.Copy | None = None

    def __enter__(self) -> "StopTimeStage":
        self._copy = self._copy_context.__enter__()
        return self

    def __call__(self, rows: Iterable[StopTimeRow]) -> None:
        if self._copy is None:
            msg = "stage is not open"
            raise RuntimeError(msg)
        for row in rows:
            self._copy.write_row(row)

    def __exit__(self, *exc: object) -> None:
        self._copy_context.__exit__(*exc)  # type: ignore[arg-type]
        self._cursor.close()


def write_timetable(  # noqa: PLR0913
    conn: psycopg.Connection,
    version_id: int,
    *,
    routes: Iterable[Route],
    services: Iterable[Service],
    calendar_dates: Iterable[tuple[str, object, int]],
    patterns: Iterable[Pattern],
    point_ids: dict[str, UUID],
    trips: Iterable[tuple[Trip, TripTimes, str, bool]],
) -> None:
    with conn.cursor() as cur:
        with cur.copy(
            "COPY route (feed_version_id, route_key, agency_key, operator_id, short_name,"
            " long_name, gtfs_route_type, category_code, category_rule, is_foreign) FROM STDIN"
        ) as copy:
            for r in routes:
                copy.write_row(
                    (
                        version_id,
                        r.route_key,
                        r.agency_key or None,
                        r.operator_id,
                        r.short_name or None,
                        r.long_name or None,
                        r.route_type,
                        r.category.value,
                        r.classification.rule,
                        r.is_foreign,
                    )
                )
        with cur.copy(
            "COPY service_calendar (feed_version_id, service_key, weekdays, start_date, end_date)"
            " FROM STDIN"
        ) as copy:
            for s in services:
                copy.write_row((version_id, s.service_key, s.weekdays, s.start_date, s.end_date))
        with cur.copy(
            "COPY service_calendar_date (feed_version_id, service_key, service_date,"
            " exception_type) FROM STDIN"
        ) as copy:
            for service_key, day, kind in calendar_dates:
                copy.write_row((version_id, service_key, day, kind))
        pattern_list = list(patterns)
        with cur.copy(
            "COPY trip_pattern (feed_version_id, trip_pattern_id, route_key, shape_key,"
            " stop_count) FROM STDIN"
        ) as copy:
            for p in pattern_list:
                copy.write_row(
                    (
                        version_id,
                        p.trip_pattern_id,
                        p.route_key,
                        p.shape_key or None,
                        len(p.stop_keys),
                    )
                )
        with cur.copy(
            "COPY trip_pattern_stop (feed_version_id, trip_pattern_id, stop_index, stop_point_id)"
            " FROM STDIN"
        ) as copy:
            for p in pattern_list:
                for index, stop_key in enumerate(p.stop_keys):
                    copy.write_row((version_id, p.trip_pattern_id, index, point_ids[stop_key]))
        with cur.copy(
            "COPY trip (feed_version_id, trip_key, route_key, service_key, trip_pattern_id,"
            " shape_key, headsign, short_name, direction_id, block_key, category_code,"
            " is_foreign, first_departure_s, last_arrival_s, wheelchair_accessible,"
            " bikes_allowed) FROM STDIN"
        ) as copy:
            for trip, times, category, foreign in trips:
                copy.write_row(
                    (
                        version_id,
                        trip.trip_key,
                        trip.route_key,
                        trip.service_key,
                        times.trip_pattern_id,
                        trip.shape_key or None,
                        trip.headsign or None,
                        trip.short_name or None,
                        trip.direction_id,
                        trip.block_key or None,
                        category,
                        foreign,
                        times.first_departure_s,
                        times.last_arrival_s,
                        trip.wheelchair_accessible,
                        trip.bikes_allowed,
                    )
                )
        cur.execute(
            """
            INSERT INTO stop_time (feed_version_id, trip_key, stop_index, stop_sequence,
                                   arrival_s, departure_s, pickup_type, drop_off_type)
            SELECT %s, s.trip_key, s.stop_index, s.stop_sequence, s.arrival_s, s.departure_s,
                   s.pickup_type, s.drop_off_type
              FROM stage_stop_time s
              JOIN trip t ON t.feed_version_id = %s AND t.trip_key = s.trip_key
            """,
            (version_id, version_id),
        )


class LoadLockedError(RuntimeError):
    """Another import of the same source holds the lock."""


def lock_source(conn: psycopg.Connection, source_id: str) -> None:
    """Take the transaction-scoped advisory lock of ``source_id`` or refuse at once."""
    row = conn.execute(
        "SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0))",
        (f"gerlines-static-import:{source_id}",),
    ).fetchone()
    if row is None or not row[0]:
        msg = f"another static import of {source_id} is running"
        raise LoadLockedError(msg)


TIMETABLE_TABLES = (
    "route",
    "service_calendar",
    "service_calendar_date",
    "trip_pattern",
    "trip_pattern_stop",
    "trip",
    "stop_time",
)


def refresh_statistics(conn: psycopg.Connection) -> None:
    """Planner statistics that include the version written in this transaction.

    Without them a database that already holds a version estimates the new one at one row and joins
    `stop_time` to `trip` in a nested loop that runs for hours.
    """
    conn.execute(
        sql.SQL("ANALYZE {}").format(
            sql.SQL(", ").join(sql.Identifier(table) for table in TIMETABLE_TABLES)
        )
    )


def trip_integrity(conn: psycopg.Connection, version_id: int) -> dict[str, int]:
    """Trips whose stop times disagree with their pattern or with their first and last times."""
    row = conn.execute(
        """
        WITH per_trip AS (
          SELECT s.trip_key, count(*) AS stops, max(s.stop_index) AS last_index,
                 min(s.stop_index) AS first_index
            FROM stop_time s WHERE s.feed_version_id = %(v)s GROUP BY s.trip_key
        ),
        ends AS (
          SELECT t.trip_key, t.first_departure_s, t.last_arrival_s, p.stop_count, pt.stops,
                 pt.first_index, pt.last_index,
                 COALESCE(f.departure_s, f.arrival_s) AS first_time,
                 COALESCE(l.arrival_s, l.departure_s) AS last_time
            FROM trip t
            JOIN trip_pattern p USING (feed_version_id, trip_pattern_id)
            LEFT JOIN per_trip pt ON pt.trip_key = t.trip_key
            LEFT JOIN stop_time f ON f.feed_version_id = t.feed_version_id
                 AND f.trip_key = t.trip_key AND f.stop_index = 0
            LEFT JOIN stop_time l ON l.feed_version_id = t.feed_version_id
                 AND l.trip_key = t.trip_key AND l.stop_index = p.stop_count - 1
           WHERE t.feed_version_id = %(v)s
        )
        SELECT
          count(*) FILTER (WHERE stops IS DISTINCT FROM stop_count),
          count(*) FILTER (WHERE first_index IS DISTINCT FROM 0
                              OR last_index IS DISTINCT FROM stop_count - 1),
          count(*) FILTER (WHERE first_time IS DISTINCT FROM first_departure_s),
          count(*) FILTER (WHERE last_time IS DISTINCT FROM last_arrival_s),
          (SELECT count(*) FROM trip_pattern p
            WHERE p.feed_version_id = %(v)s AND p.stop_count <> (
              SELECT count(*) FROM trip_pattern_stop ps
               WHERE ps.feed_version_id = p.feed_version_id
                 AND ps.trip_pattern_id = p.trip_pattern_id))
        FROM ends
        """,
        {"v": version_id},
    ).fetchone()
    names = (
        "stop_count_differs_from_pattern",
        "stop_index_not_contiguous",
        "first_departure_differs",
        "last_arrival_differs",
        "pattern_stops_differ_from_stop_count",
    )
    return dict(zip(names, (int(value) for value in row or (0,) * 5), strict=True))


def close_feed_version(conn: psycopg.Connection, version_id: int, row_counts: str) -> None:
    conn.execute(
        "UPDATE feed_version SET status = 'loaded', loaded_at = %s, row_counts = %s::jsonb"
        " WHERE feed_version_id = %s",
        (datetime.now(UTC), row_counts, version_id),
    )


def table_counts(conn: psycopg.Connection, version_id: int) -> dict[str, object]:
    """Counts as stored, for reconciliation with the counts read from the feed."""

    def by_category(query: str) -> dict[str, int]:
        return dict(conn.execute(query, (version_id,)).fetchall())

    def scalar(query: str) -> int:
        row = conn.execute(query, (version_id,)).fetchone()
        return int(row[0]) if row else 0

    return {
        "routes": by_category(
            "SELECT category_code, count(*) FROM route WHERE feed_version_id = %s GROUP BY 1"
        ),
        "trips": by_category(
            "SELECT category_code, count(*) FROM trip WHERE feed_version_id = %s GROUP BY 1"
        ),
        "stop_times": by_category(
            """
            SELECT t.category_code, count(*) FROM stop_time s
              JOIN trip t USING (feed_version_id, trip_key)
             WHERE s.feed_version_id = %s GROUP BY 1
            """
        ),
        "trip_patterns": scalar("SELECT count(*) FROM trip_pattern WHERE feed_version_id = %s"),
        "trip_pattern_stops": scalar(
            "SELECT count(*) FROM trip_pattern_stop WHERE feed_version_id = %s"
        ),
        "services": scalar("SELECT count(*) FROM service_calendar WHERE feed_version_id = %s"),
        "calendar_dates": scalar(
            "SELECT count(*) FROM service_calendar_date WHERE feed_version_id = %s"
        ),
        "foreign_trips": scalar(
            "SELECT count(*) FROM trip WHERE feed_version_id = %s AND is_foreign"
        ),
    }
