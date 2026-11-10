"""Load converted months into ``trip_instance``, ``stop_event`` and ``segment_obs``.

Runs are stored without a timetable link (``backfill``, migration 0087), stops with
``final_quality = final_only``, everything under the source ``piebro-deutsche-bahn-data`` with the
monthly file as its raw object. A day is replaced as a whole in its own transaction, so a load can
be repeated or resumed. Days from ``until`` on are removed and skipped: they belong to the live
recording, and a load refuses days on or after the first service day another source recorded
unless ``until`` cuts them off. Reviewed decisions of ``place-overrides.csv`` come first; other
EVA numbers resolve to the stop places of the static import (``id_map`` of the EVA mirror, then
``stop_place.eva``, then a place whose dhid carries the EVA).
A station left open is matched at its Bahn-Vorhersage coordinates: a static place without EVA
within 150 m whose name agrees strongly, then the nearest place of its station's other EVA numbers
within 150 m, then a place without EVA within 150 m whose name agrees fairly, then one within 25 m
that shares a word of the name; only a station that matches none of them gets its own place. Every
take by coordinates or meta EVA and every close place not taken is written to ``place-review.csv``
beside the month. Every load resolves again from the static data, so ``id_map`` under the
backfill source follows the latest static import.
"""

import csv
import hashlib
import io
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl
import psycopg

from gerlines_backfill import __version__
from gerlines_backfill.download import ATTRIBUTION, DATASET, HUB, LICENCE_URL
from gerlines_static_import.eva import (
    differs_only_by_suffix,
    eva_in_stop_id,
    name_score,
    name_tokens,
)

GERLINES_NAMESPACE = uuid.UUID("5d1b7a4e-2f4c-5a8e-9c63-0b8f1e6d2a71")
SOURCE_ID = "piebro-deutsche-bahn-data"
STATIONS_SOURCE_ID = "bahn-vorhersage"
EVA_MIRROR_SOURCE_ID = "traines-delfi-eva"
JOB = "backfill-load"
STATIC_IMPORT_JOB = "static-import"
LIVE_MARGIN_DAYS = 2
LIVE_EVENTS_SQL = (
    "SELECT min(service_date) FROM stop_event WHERE source_id <> %s AND service_date >= %s"
)
SOURCES = (
    (
        SOURCE_ID,
        "piebro/deutsche-bahn-data, DB Timetables (IRIS) monthly processed data",
        f"{HUB}/datasets/{DATASET}",
        "CC-BY-4.0",
        LICENCE_URL,
        ATTRIBUTION,
    ),
    (
        STATIONS_SOURCE_ID,
        "Bahn-Vorhersage collected station data",
        "https://bahnvorhersage.de/open-data/stops",
        "ODbL-1.0",
        "https://opendatacommons.org/licenses/odbl/1-0/",
        "Bahn-Vorhersage, Deutsche Bahn, Derf, Trainline, DELFI",
    ),
)
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
NEAR_M = 150.0
SAME_POINT_M = 25.0
STRONG_NAME_SCORE = 0.8
MIN_NAME_SCORE = 0.5
SEPARATE = "separate"
DEFAULT_OVERRIDES = Path(__file__).resolve().parents[2] / "place-overrides.csv"
METHODS = (
    "override",
    "eva_mirror",
    "stop_place_eva",
    "dhid_eva",
    "near_static",
    "meta_eva",
    "near_static_weak",
    "same_point",
    "created",
)
REVIEW_COLUMNS = (
    "eva",
    "name",
    "place_id",
    "place_name",
    "distance_m",
    "score",
    "decision",
    "candidates",
)

TRIP_COLUMNS = (
    "trip_instance_id",
    "service_date",
    "train_number",
    "category_code",
    "origin_stop_place_id",
    "origin_departure",
    "is_added",
    "first_source_id",
    "first_observed_at",
    "first_raw_object_id",
    "backfill",
)
STOP_COLUMNS = (
    "service_date",
    "trip_instance_id",
    "stop_index",
    "source_id",
    "stop_place_id",
    "scheduled_arrival",
    "scheduled_departure",
    "arrival_delay_s",
    "departure_delay_s",
    "final_arrival",
    "final_departure",
    "final_quality",
    "cancelled",
    "additional",
    "observed_at",
    "raw_object_id",
)
SEGMENT_COLUMNS = (
    "service_date",
    "trip_instance_id",
    "from_index",
    "source_id",
    "to_index",
    "from_stop_place_id",
    "to_stop_place_id",
    "dep_delay_from_s",
    "arr_delay_to_s",
    "delay_gain_s",
    "run_sched_s",
    "run_act_s",
    "dwell_delay_s",
    "observed_at",
    "raw_object_id",
)


@dataclass(frozen=True, slots=True)
class MonthInput:
    month: str
    folder: Path
    source_file: Path
    object_key: str
    request_url: str
    stations: Path | None
    until: date | None = None
    overrides: Path | None = None


def trip_instance_id(trip_key: str) -> uuid.UUID:
    """UUIDv5 over two parts, so it never equals a live id (five parts, packages/schema ids)."""
    return uuid.uuid5(GERLINES_NAMESPACE, f"trip_instance:piebro\x1f{trip_key}")


def stop_place_id(eva: int) -> uuid.UUID:
    return uuid.uuid5(GERLINES_NAMESPACE, f"stop_place:eva:{eva}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def _ensure_sources(conn: psycopg.Connection) -> None:
    for row in SOURCES:
        conn.execute(
            "INSERT INTO source (source_id, name, homepage_url, licence, licence_url, attribution)"
            " VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (source_id) DO NOTHING",
            row,
        )


def _raw_object(conn: psycopg.Connection, run_id: uuid.UUID, month: MonthInput) -> uuid.UUID:
    fetched = datetime.fromtimestamp(month.source_file.stat().st_mtime, UTC)
    row = conn.execute(
        "INSERT INTO raw_object (source_id, ingest_run_id, object_key, sha256, bytes, content_type,"
        " fetched_at, http_status, request_url)"
        " VALUES (%s, %s, %s, %s, %s, 'application/vnd.apache.parquet', %s, 200, %s)"
        " ON CONFLICT (object_key) DO UPDATE SET ingest_run_id = excluded.ingest_run_id,"
        " sha256 = excluded.sha256, bytes = excluded.bytes, fetched_at = excluded.fetched_at,"
        " request_url = excluded.request_url"
        " RETURNING raw_object_id",
        (
            SOURCE_ID,
            run_id,
            month.object_key,
            _sha256(month.source_file),
            month.source_file.stat().st_size,
            fetched,
            month.request_url,
        ),
    ).fetchone()
    return row[0]


def _station_list(
    stations: Path | None,
) -> tuple[dict[int, tuple[float, float]], dict[int, list[int]]]:
    """Coordinates and meta EVA numbers (the other EVAs of the same station) per EVA number."""
    if stations is None:
        return {}, {}
    frame = pl.read_parquet(stations, columns=["eva", "lat", "lon", "meta_evas"])
    points = {
        int(eva): (float(lat), float(lon))
        for eva, lat, lon in frame.drop_nulls(["lat", "lon"])
        .select("eva", "lat", "lon")
        .iter_rows()
    }
    meta = {
        int(eva): list(others or []) for eva, others in frame.select("eva", "meta_evas").iter_rows()
    }
    return points, meta


class CutOverError(RuntimeError):
    """A day to load is on or after the first service day of the live recording."""


class OverrideError(ValueError):
    """A row of the overrides file names no EVA number, or a place that does not exist."""


def read_overrides(path: Path | None) -> dict[int, str]:
    """Reviewed decisions: EVA number to a stop_place_id, a dhid, or ``separate``."""
    if path is None or not path.exists():
        return {}
    found: dict[int, str] = {}
    with path.open(newline="") as handle:
        for line, row in enumerate(csv.DictReader(handle), start=2):
            eva = (row.get("eva") or "").strip()
            place = (row.get("place") or "").strip()
            if not eva.isdigit() or not place:
                msg = f"{path} line {line}: eva {eva or '(empty)'}, place {place or '(empty)'}"
                raise OverrideError(msg)
            found[int(eva)] = place
    return found


def _override_places(
    conn: psycopg.Connection, overrides: dict[int, str]
) -> dict[int, uuid.UUID | None]:
    """The place each override names; None keeps the station on a place of its own."""
    chosen: dict[int, uuid.UUID | None] = {}
    for eva, ref in sorted(overrides.items()):
        if ref == SEPARATE:
            chosen[eva] = None
            continue
        try:
            row = conn.execute(
                "SELECT stop_place_id FROM stop_place WHERE stop_place_id = %s", (uuid.UUID(ref),)
            ).fetchone()
        except ValueError:
            row = conn.execute(
                "SELECT stop_place_id FROM stop_place WHERE dhid = %s", (ref,)
            ).fetchone()
        if row is None:
            msg = f"override for EVA {eva}: no stop place {ref}"
            raise OverrideError(msg)
        chosen[eva] = row[0]
    return chosen


def _static_by_eva(
    conn: psycopg.Connection, evas: list[int]
) -> dict[int, list[tuple[str, uuid.UUID]]]:
    """Static places per EVA number, best first: EVA mirror id_map, stop_place.eva, dhid."""
    found: dict[int, list[tuple[str, uuid.UUID]]] = {}

    def add(eva: int, method: str, place: uuid.UUID) -> None:
        places = found.setdefault(eva, [])
        if all(place != known for _, known in places):
            places.append((method, place))

    keys = [str(eva) for eva in evas]
    for eva, place in conn.execute(
        "SELECT m.source_key::integer, m.canonical_id FROM id_map m"
        " JOIN stop_place p ON p.stop_place_id = m.canonical_id"
        " WHERE m.source_id = %s AND m.entity = 'stop_place' AND m.source_key = ANY(%s)"
        " AND p.name_source_id <> %s ORDER BY m.canonical_id",
        (EVA_MIRROR_SOURCE_ID, keys, SOURCE_ID),
    ).fetchall():
        add(eva, "eva_mirror", place)
    for eva, place in conn.execute(
        "SELECT eva, stop_place_id FROM stop_place WHERE eva = ANY(%s) AND name_source_id <> %s"
        " ORDER BY eva, geom IS NULL, stop_place_id",
        (evas, SOURCE_ID),
    ).fetchall():
        add(eva, "stop_place_eva", place)
    wanted = set(evas)
    for place, dhid in conn.execute(
        "SELECT stop_place_id, dhid FROM stop_place"
        " WHERE eva IS NULL AND name_source_id <> %s AND split_part(dhid, ':', 3) = ANY(%s)"
        " ORDER BY geom IS NULL, stop_place_id",
        (SOURCE_ID, keys),
    ).fetchall():
        eva = eva_in_stop_id(dhid)
        if eva in wanted:
            add(eva, "dhid_eva", place)
    return found


@dataclass(slots=True)
class Places:
    mapping: dict[int, uuid.UUID] = field(default_factory=dict)
    methods: dict[str, int] = field(default_factory=lambda: dict.fromkeys(METHODS, 0))
    review: list[tuple[object, ...]] = field(default_factory=list)

    def take(self, eva: int, place: uuid.UUID, method: str) -> None:
        self.mapping[eva] = place
        self.methods[method] += 1

    def note(  # noqa: PLR0913, PLR0917
        self,
        eva: int,
        name: str,
        candidate: "Candidate | None",
        decision: str,
        candidates: int = 1,
        place: uuid.UUID | None = None,
    ) -> None:
        if candidate is None:
            self.review.append((eva, name, place or "", "", "", "", decision, candidates))
            return
        self.review.append(
            (
                eva,
                name,
                candidate.place,
                candidate.name,
                round(candidate.distance, 1),
                "" if candidate.score is None else round(candidate.score, 2),
                decision,
                candidates,
            )
        )


@dataclass(frozen=True, slots=True)
class Candidate:
    place: uuid.UUID
    name: str
    distance: float
    score: float | None = None


def place_name_score(ours: str, theirs: str) -> float:
    """Agreement of two station names; 0 when they differ only by a direction or Hbf suffix."""
    if differs_only_by_suffix(ours, theirs):
        return 0.0
    left, right = set(name_tokens(ours)), set(name_tokens(theirs))
    if not left or not right:
        return 0.0
    contained = len(left & right) / min(len(left), len(right))
    return max(name_score(ours, theirs), contained)


def _near_static(
    conn: psycopg.Connection, name: str, point: tuple[float, float]
) -> list[Candidate]:
    """Static places without EVA within 150 m, best agreement of name and distance first."""
    rows = conn.execute(
        "SELECT stop_place_id, name,"
        " ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)"
        " FROM stop_place WHERE eva IS NULL AND name_source_id <> %s AND geom IS NOT NULL"
        " AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)",
        (point[1], point[0], SOURCE_ID, point[1], point[0], NEAR_M),
    ).fetchall()
    candidates = [
        Candidate(place, theirs, distance, place_name_score(name, theirs))
        for place, theirs, distance in rows
    ]
    return sorted(
        candidates,
        key=lambda row: (-(row.score - row.distance / NEAR_M), str(row.place)),
    )


def _meta_places(
    conn: psycopg.Connection, places: set[uuid.UUID], point: tuple[float, float]
) -> list[Candidate]:
    """Static places of the station's other EVA numbers, nearest first."""
    rows = conn.execute(
        "SELECT stop_place_id, name,"
        " ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)"
        " FROM stop_place WHERE stop_place_id = ANY(%s) AND geom IS NOT NULL",
        (point[1], point[0], list(places)),
    ).fetchall()
    return sorted(
        (Candidate(place, theirs, distance) for place, theirs, distance in rows),
        key=lambda row: (row.distance, str(row.place)),
    )


def _shares_a_word(name: str, theirs: str) -> bool:
    return bool(set(name_tokens(name)) & set(name_tokens(theirs)))


def _match_open(  # noqa: PLR0913, PLR0917
    conn: psycopg.Connection,
    eva: int,
    name: str,
    point: tuple[float, float],
    meta_places: set[uuid.UUID],
    places: Places,
) -> bool:
    """Near with a strong name, then the meta-EVA place within 150 m, then near with a fair name."""
    near = _near_static(conn, name, point)
    strong = [row for row in near if row.score >= STRONG_NAME_SCORE]
    if strong:
        places.take(eva, strong[0].place, "near_static")
        places.note(eva, name, strong[0], "near_static", len(strong))
        return True
    meta = _meta_places(conn, meta_places, point) if meta_places else []
    close = [row for row in meta if row.distance <= NEAR_M]
    if close:
        places.take(eva, close[0].place, "meta_eva")
        places.note(eva, name, close[0], "meta_eva", len(close))
        return True
    fair = [row for row in near if row.score >= MIN_NAME_SCORE]
    if fair:
        places.take(eva, fair[0].place, "near_static_weak")
        places.note(eva, name, fair[0], "near_static_weak", len(fair))
        return True
    same_point = [
        row for row in near if row.distance <= SAME_POINT_M and _shares_a_word(name, row.name)
    ]
    if same_point:
        places.take(eva, same_point[0].place, "same_point")
        places.note(eva, name, same_point[0], "same_point", len(same_point))
        return True
    for row in near:
        places.note(eva, name, row, "created")
    if meta:
        places.note(eva, name, meta[0], "meta_too_far", len(meta))
    return False


def _create_place(
    conn: psycopg.Connection, eva: int, name: str, point: tuple[float, float] | None
) -> uuid.UUID:
    canonical = stop_place_id(eva)
    conn.execute(
        "INSERT INTO stop_place"
        " (stop_place_id, name, name_source_id, eva, geom, geom_source_id)"
        " VALUES (%s, %s, %s, %s,"
        " CASE WHEN %s::float8 IS NULL THEN NULL"
        " ELSE ST_SetSRID(ST_MakePoint(%s::float8, %s::float8), 4326) END, %s)"
        " ON CONFLICT (stop_place_id) DO NOTHING",
        (
            canonical,
            name or f"EVA {eva}",
            SOURCE_ID,
            eva,
            None if point is None else point[1],
            None if point is None else point[1],
            None if point is None else point[0],
            None if point is None else STATIONS_SOURCE_ID,
        ),
    )
    return canonical


def resolve_places(
    conn: psycopg.Connection,
    names: dict[int, str],
    stations: Path | None,
    *,
    overrides: dict[int, str] | None = None,
    write: bool = True,
) -> Places:
    """EVA numbers to stop places, overrides first; with ``write`` False nothing is inserted."""
    evas = sorted(names)
    places = Places()
    points, meta = _station_list(stations)
    for eva, named in _override_places(conn, overrides or {}).items():
        if eva not in names:
            continue
        if named is None:
            point = points.get(eva)
            own = _create_place(conn, eva, names[eva], point) if write else stop_place_id(eva)
            places.note(eva, names[eva], None, "override_separate", 0, own)
            places.take(eva, own, "override")
        else:
            places.note(eva, names[eva], None, "override", 0, named)
            places.take(eva, named, "override")
    for eva, found in _static_by_eva(conn, evas).items():
        if eva not in places.mapping:
            method, canonical = found[0]
            places.take(eva, canonical, method)
    open_evas = [eva for eva in evas if eva not in places.mapping]
    members = sorted({other for eva in open_evas for other in meta.get(eva, [])})
    static = _static_by_eva(conn, members) if members else {}
    for eva in open_evas:
        point = points.get(eva)
        meta_places = {place for other in meta.get(eva, []) for _, place in static.get(other, [])}
        if point is not None and _match_open(conn, eva, names[eva], point, meta_places, places):
            continue
        canonical = _create_place(conn, eva, names[eva], point) if write else stop_place_id(eva)
        if point is None:
            places.note(eva, names[eva], None, "created_without_point", 0, canonical)
        places.take(eva, canonical, "created")
    if write:
        with conn.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO id_map (source_id, entity, source_key, canonical_id)"
                " VALUES (%s, 'stop_place', %s, %s)"
                " ON CONFLICT (source_id, entity, source_key)"
                " DO UPDATE SET canonical_id = excluded.canonical_id, last_seen_at = now()",
                [
                    (SOURCE_ID, str(eva), canonical)
                    for eva, canonical in sorted(places.mapping.items())
                ],
            )
    return places


def write_review(path: Path, rows: list[tuple[object, ...]]) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(REVIEW_COLUMNS)
        writer.writerows(rows)


def _places_frame(mapping: dict[int, uuid.UUID]) -> pl.DataFrame:
    return pl.DataFrame(
        {"eva": list(mapping), "stop_place_id": [str(value) for value in mapping.values()]},
        schema={"eva": pl.Int32, "stop_place_id": pl.String},
    )


def _ids(trips: pl.DataFrame) -> pl.DataFrame:
    return trips.select(
        "trip_key",
        pl.Series("trip_instance_id", [str(trip_instance_id(key)) for key in trips["trip_key"]]),
    )


def _text_times(frame: pl.DataFrame) -> pl.DataFrame:
    return frame.with_columns(pl.col(pl.Datetime).dt.strftime(TIME_FORMAT))


def _copy(
    conn: psycopg.Connection, table: str, columns: tuple[str, ...], frame: pl.DataFrame
) -> None:
    if frame.is_empty():
        return
    buffer = io.BytesIO()
    _text_times(frame.select(columns)).write_csv(buffer, include_header=False)
    with conn.cursor().copy(f"COPY {table} ({', '.join(columns)}) FROM STDIN (FORMAT csv)") as copy:
        copy.write(buffer.getvalue())


DAY_LOCK_CLASS = 724461884
"""Advisory lock class of a backfilled service day, held by ``load`` and ``archive`` per day."""


def lock_day(conn: psycopg.Connection, day: date) -> None:
    """Wait for the transaction lock of one service day (``load`` and ``archive`` take it)."""
    conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (DAY_LOCK_CLASS, day.toordinal()))


def _delete_events(conn: psycopg.Connection, day: date) -> None:
    conn.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0")
    for table in ("segment_obs", "stop_event"):
        conn.execute(
            f"DELETE FROM {table} WHERE source_id = %s AND service_date = %s",  # noqa: S608
            (SOURCE_ID, day),
        )


def _delete_day(conn: psycopg.Connection, day: date) -> None:
    _delete_events(conn, day)
    conn.execute(
        "DELETE FROM trip_instance WHERE backfill AND first_source_id = %s AND service_date = %s",
        (SOURCE_ID, day),
    )


def _upsert_trips(conn: psycopg.Connection, day: date, trips: pl.DataFrame) -> None:
    """Runs keep their rows: deleting one checks the stop_event key in every chunk."""
    conn.execute(
        "CREATE TEMP TABLE backfill_trip (LIKE trip_instance INCLUDING DEFAULTS) ON COMMIT DROP"
    )
    _copy(conn, "backfill_trip", TRIP_COLUMNS, trips)
    columns = ", ".join(TRIP_COLUMNS)
    updates = ", ".join(f"{name} = excluded.{name}" for name in TRIP_COLUMNS[1:])
    conn.execute(
        f"INSERT INTO trip_instance ({columns}) SELECT {columns} FROM backfill_trip"  # noqa: S608
        f" ON CONFLICT (trip_instance_id) DO UPDATE SET {updates}"
    )
    conn.execute(
        "DELETE FROM trip_instance t WHERE backfill AND first_source_id = %s"
        " AND service_date = %s AND NOT EXISTS"
        " (SELECT 1 FROM backfill_trip b WHERE b.trip_instance_id = t.trip_instance_id)",
        (SOURCE_ID, day),
    )


def live_from(conn: psycopg.Connection) -> date | None:
    """The first service day another source recorded stop events for.

    Searched from two days before the first run of another source that is not a static import,
    so the backfilled months before the recording are never read.
    """
    first = conn.execute(
        "SELECT min(started_at) FROM ingest_run WHERE source_id <> %s AND job <> %s",
        (SOURCE_ID, STATIC_IMPORT_JOB),
    ).fetchone()[0]
    if first is None:
        return None
    since = first.astimezone(UTC).date() - timedelta(days=LIVE_MARGIN_DAYS)
    return conn.execute(LIVE_EVENTS_SQL, (SOURCE_ID, since)).fetchone()[0]


def check_cut_over(days: list[date], until: date | None, live: date | None) -> None:
    if live is None:
        return
    if until is not None and until > live:
        msg = f"--until {until} is after {live}, the first service day of the live recording"
        raise CutOverError(msg)
    if until is None and days and days[-1] >= live:
        msg = (
            f"the live recording starts on {live}: load with --until {live} or earlier,"
            " or its days are counted twice"
        )
        raise CutOverError(msg)


def _day_frames(
    folder: Path, day: date, places: pl.DataFrame, raw_object_id: uuid.UUID
) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    trips = pl.read_parquet(folder / "trips" / f"{day}.parquet")
    stops = pl.read_parquet(folder / "stops" / f"{day}.parquet")
    legs = pl.read_parquet(folder / "segments" / f"{day}.parquet")
    ids = _ids(trips)
    provenance = {
        "source_id": pl.lit(SOURCE_ID),
        "raw_object_id": pl.lit(str(raw_object_id)),
    }
    trip_rows = (
        trips.join(ids, on="trip_key")
        .join(
            places.rename({"eva": "origin_eva", "stop_place_id": "origin_stop_place_id"}),
            on="origin_eva",
        )
        .with_columns(
            pl.lit(value=False).alias("is_added"),
            pl.lit(SOURCE_ID).alias("first_source_id"),
            pl.col("origin_departure").alias("first_observed_at"),
            pl.lit(str(raw_object_id)).alias("first_raw_object_id"),
            pl.lit(value=True).alias("backfill"),
        )
    )
    stop_rows = (
        stops.join(ids, on="trip_key")
        .join(places, on="eva")
        .with_columns(
            pl.coalesce(
                "final_arrival",
                "final_departure",
                "scheduled_arrival",
                "scheduled_departure",
                "trip_start",
            ).alias("observed_at"),
            **provenance,
        )
    )
    leg_rows = (
        legs.join(ids, on="trip_key")
        .join(
            places.rename({"eva": "from_eva", "stop_place_id": "from_stop_place_id"}), on="from_eva"
        )
        .join(places.rename({"eva": "to_eva", "stop_place_id": "to_stop_place_id"}), on="to_eva")
        .with_columns(**provenance)
    )
    return trip_rows, stop_rows, leg_rows


def _month_names(folder: Path) -> dict[int, str]:
    summary = json.loads((folder / "summary.json").read_text())
    return {int(eva): name for eva, name in summary["stations"].items()}


def dry_run_places(url: str, folder: Path, stations: Path | None, overrides: Path | None) -> Places:
    """Resolve a converted month's stations in a read-only transaction that writes nothing."""
    with psycopg.connect(url) as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        places = resolve_places(
            conn,
            _month_names(folder),
            stations,
            overrides=read_overrides(overrides),
            write=False,
        )
        conn.rollback()
    return places


def compress_days(conn: psycopg.Connection, first: date, end: date) -> int:
    compressed = 0
    for table in ("stop_event", "segment_obs"):
        rows = conn.execute(
            "SELECT compress_chunk(chunk, if_not_compressed => true)"
            " FROM show_chunks(%s::regclass, older_than => %s::date, newer_than => %s::date) chunk",
            (table, end, first),
        ).fetchall()
        compressed += len(rows)
    return compressed


def load_month(url: str, month: MonthInput, *, compress: bool = False) -> dict[str, object]:
    started = time.perf_counter()
    days = sorted(
        date.fromisoformat(path.stem) for path in (month.folder / "trips").glob("*.parquet")
    )
    totals = {"trip_instance": 0, "stop_event": 0, "segment_obs": 0}
    with psycopg.connect(url, autocommit=True) as conn:
        overrides = read_overrides(month.overrides)
        live = live_from(conn)
        check_cut_over(days, month.until, live)
        with conn.transaction():
            _ensure_sources(conn)
            run_id = conn.execute(
                "INSERT INTO ingest_run (source_id, job, app_version) VALUES (%s, %s, %s)"
                " RETURNING ingest_run_id",
                (SOURCE_ID, JOB, __version__),
            ).fetchone()[0]
        loaded: list[str] = []
        chunks = 0
        current: date | None = None
        try:
            with conn.transaction():
                raw_object_id = _raw_object(conn, run_id, month)
                places = resolve_places(
                    conn, _month_names(month.folder), month.stations, overrides=overrides
                )
            write_review(month.folder / "place-review.csv", places.review)
            frame = _places_frame(places.mapping)
            for current in days:
                with conn.transaction():
                    lock_day(conn, current)
                    conn.execute(
                        "DELETE FROM history_archive_day WHERE service_date = %s", (current,)
                    )
                    if month.until is not None and current >= month.until:
                        _delete_day(conn, current)
                        continue
                    trips, stops, legs = _day_frames(month.folder, current, frame, raw_object_id)
                    _delete_events(conn, current)
                    _upsert_trips(conn, current, trips)
                    _copy(conn, "stop_event", STOP_COLUMNS, stops)
                    _copy(conn, "segment_obs", SEGMENT_COLUMNS, legs)
                totals["trip_instance"] += trips.height
                totals["stop_event"] += stops.height
                totals["segment_obs"] += legs.height
                loaded.append(current.isoformat())
                if compress:
                    chunks += compress_days(conn, current, current + timedelta(days=1))
        except BaseException as error:
            where = f"{month.month} {current}" if current is not None else month.month
            conn.execute(
                "UPDATE ingest_run SET status = 'failed', finished_at = now(), error_message = %s"
                " WHERE ingest_run_id = %s",
                (f"{where}: {error.__class__.__name__}: {error}"[:2000], run_id),
            )
            raise
        conn.execute(
            "UPDATE ingest_run SET status = 'succeeded', finished_at = now()"
            " WHERE ingest_run_id = %s",
            (run_id,),
        )
    return {
        "month": month.month,
        "days_loaded": len(loaded),
        "first_day": loaded[0] if loaded else None,
        "last_day": loaded[-1] if loaded else None,
        "until": month.until.isoformat() if month.until else None,
        "live_from": live.isoformat() if live else None,
        "rows": totals,
        "stations": len(places.mapping),
        "stop_places_created": places.methods["created"],
        "stop_place_methods": places.methods,
        "places_for_review": len(places.review),
        "chunks_compressed": chunks,
        "seconds": round(time.perf_counter() - started, 1),
    }
