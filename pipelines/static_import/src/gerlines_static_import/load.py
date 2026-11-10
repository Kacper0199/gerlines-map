"""Load one DELFI feed version for a category set into the database, in one transaction."""

import csv
import json
import resource
import sys
import time
import zipfile
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from uuid import UUID

import psycopg

from gerlines_static_import import __version__, db
from gerlines_static_import.categories import Category
from gerlines_static_import.download import (
    EVA_MIRROR_ATTRIBUTION,
    EVA_MIRROR_LICENCE,
    DownloadError,
    feed_date_from_delfi_url,
    read_sidecar,
    sha256_file,
)
from gerlines_static_import.eva import EvaIndex, EvaMatch, read_eva_stations
from gerlines_static_import.gtfs import read_feed_info
from gerlines_static_import.identity import (
    Override,
    read_overrides,
    resolve_identity,
    write_identity_review,
)
from gerlines_static_import.inventory import read_agency_names
from gerlines_static_import.operators import Operator, build_catalog
from gerlines_static_import.platform_codes import stop_number_check
from gerlines_static_import.spatial import NationalOutline
from gerlines_static_import.stops import (
    StopModel,
    assign_canonical_ids,
    build_model,
    fill_countries,
    merge_lone_places,
    read_stops,
)
from gerlines_static_import.timetable import (
    RouteSelection,
    ServiceSelection,
    StopTimesResult,
    Trip,
    TripSelection,
    select_routes,
    select_services,
    select_trips,
    stream_stop_times,
)

DELFI = db.SourceRow(
    source_id="delfi-gtfs",
    name="DELFI national GTFS timetable",
    homepage_url="https://www.opendata-oepnv.de/ht/de/organisation/delfi/startseite",
    licence="CC-BY-4.0",
    licence_url="https://creativecommons.org/licenses/by/4.0/",
    attribution="DELFI e.V.",
)
EVA_MIRROR = db.SourceRow(
    source_id="traines-delfi-eva",
    name="DELFI GTFS extended with ZHV and EVA numbers (mirror.traines.eu)",
    homepage_url="https://mirror.traines.eu/german-delfi-gtfs/",
    licence=EVA_MIRROR_LICENCE,
    licence_url="https://mirror.traines.eu/german-delfi-gtfs/LICENSE.txt",
    attribution=EVA_MIRROR_ATTRIBUTION,
)
JOB = "static-import"
REFERENCE_EVA = {
    8011160: "Berlin Hbf",
    8002549: "Hamburg Hbf",
    8000261: "München Hbf",
    8000207: "Köln Hbf",
    8000105: "Frankfurt (Main) Hbf",
    8000096: "Stuttgart Hbf",
    8000152: "Hannover Hbf",
    8010205: "Leipzig Hbf",
    8010085: "Dresden Hbf",
    8000284: "Nürnberg Hbf",
}


class ReconciliationError(RuntimeError):
    """Counts read from the feed and counts stored in the database differ."""


class IntegrityError(ReconciliationError):
    """Stored trips disagree with their patterns or with their own stop times."""


@dataclass(frozen=True, slots=True)
class LoadOptions:
    feed_path: Path
    database_url: str
    categories: frozenset[Category]
    data_root: Path
    eva_path: Path | None = None
    report_dir: Path | None = None
    outline_path: Path | None = None
    place_overrides: Path | None = None


@dataclass(slots=True)
class Timer:
    phases: dict[str, float] = field(default_factory=dict)

    @contextmanager
    def phase(self, name: str) -> Iterator[None]:
        started = time.perf_counter()
        try:
            yield
        finally:
            self.phases[name] = round(time.perf_counter() - started, 2)


def peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return round(peak / divisor, 1)


@dataclass(frozen=True, slots=True)
class InputFile:
    path: Path
    sha256: str
    size: int
    fetched_at: datetime
    url: str | None


def describe_input(path: Path) -> InputFile:
    sidecar = read_sidecar(path) or {}
    sha = str(sidecar.get("sha256") or sha256_file(path))
    fetched = sidecar.get("fetched_at")
    fetched_at = (
        datetime.fromisoformat(str(fetched))
        if fetched
        else datetime.fromtimestamp(path.stat().st_mtime, UTC)
    )
    url = sidecar.get("url")
    return InputFile(path, sha, path.stat().st_size, fetched_at, str(url) if url else None)


def published_on(feed: InputFile) -> date:
    """The Monday of the file: its folder name, else the date in its URL, else its file date."""
    try:
        return date.fromisoformat(feed.path.parent.name)
    except ValueError:
        pass
    if feed.url:
        try:
            return date.fromisoformat(feed_date_from_delfi_url(feed.url))
        except DownloadError:
            pass
    return datetime.fromtimestamp(feed.path.stat().st_mtime, UTC).date()


def object_key(path: Path, data_root: Path) -> str:
    return path.resolve().relative_to(data_root.resolve()).as_posix()


def load_eva_index(eva_path: Path | None) -> EvaIndex | None:
    if eva_path is None:
        return None
    with zipfile.ZipFile(eva_path) as archive:
        return EvaIndex(read_eva_stations(archive))


@dataclass(slots=True)
class EvaJoin:
    matches: dict[str, EvaMatch] = field(default_factory=dict)
    agreement: Counter[str] = field(default_factory=Counter)

    def assign(self, model: StopModel, index: EvaIndex, *, exact: bool, dhid_only: bool) -> None:
        for place in model.places.values():
            if place.key in self.matches or (dhid_only and place.dhid is None):
                continue
            if exact:
                match = index.exact(place.key, place.lat, place.lon)
                if match is not None:
                    self._compare(index.match(place.name, place.lat, place.lon), match)
            else:
                match = index.match(place.name, place.lat, place.lon)
            if match is not None:
                place.eva = match.eva
                self.matches[place.key] = match

    def _compare(self, spatial: EvaMatch | None, exact: EvaMatch) -> None:
        if spatial is None:
            self.agreement["spatial_none"] += 1
        elif spatial.eva == exact.eva:
            self.agreement["spatial_agrees"] += 1
        else:
            self.agreement["spatial_differs"] += 1

    def precision(self) -> dict[str, object]:
        agrees = self.agreement["spatial_agrees"]
        differs = self.agreement["spatial_differs"]
        decided = agrees + differs
        return dict(self.agreement) | {
            "exact": sum(m.method == "exact" for m in self.matches.values()),
            "spatial": sum(m.method == "spatial" for m in self.matches.values()),
            "spatial_precision": round(agrees / decided, 4) if decided else None,
        }

    def prune(self, model: StopModel) -> None:
        for key in [k for k in self.matches if k not in model.places]:
            del self.matches[key]


def resolve_stops(
    model: StopModel, index: EvaIndex | None, outline: NationalOutline | None
) -> tuple[EvaJoin, dict[str, int]]:
    """Countries, exact EVA numbers, merged lone places and spatial EVA numbers, in that order."""
    filled = fill_countries(model, outline) if outline is not None else 0
    join = EvaJoin()
    if index is not None:
        join.assign(model, index, exact=True, dhid_only=False)
        join.assign(model, index, exact=False, dhid_only=True)
    merged = merge_lone_places(model)
    join.prune(model)
    if index is not None:
        join.assign(model, index, exact=False, dhid_only=False)
    return join, {
        "countries_from_outline": filled,
        "merged_by_eva": merged.by_eva,
        "merged_by_distance": merged.by_distance,
    }


def eva_mappings(model: StopModel, matches: dict[str, EvaMatch]) -> list[tuple[str, UUID]]:
    """One place per EVA number: the closest of the places that matched it."""
    best: dict[int, tuple[float, UUID]] = {}
    for key, match in matches.items():
        canonical = model.places[key].canonical
        if canonical is None:
            continue
        current = best.get(match.eva)
        if current is None or match.distance_m < current[0]:
            best[match.eva] = (match.distance_m, canonical)
    return [(str(eva), canonical) for eva, (_, canonical) in sorted(best.items())]


def run_load(options: LoadOptions) -> dict[str, object]:
    timer = Timer()
    started = time.perf_counter()
    feed = describe_input(options.feed_path)
    eva_input = describe_input(options.eva_path) if options.eva_path else None
    overrides = read_overrides(options.place_overrides)
    categories = sorted(c.value for c in options.categories)
    report: dict[str, object] = {
        "feed": {"path": str(feed.path), "sha256": feed.sha256, "bytes": feed.size},
        "categories": categories,
        "app_version": __version__,
    }
    with zipfile.ZipFile(options.feed_path) as archive:
        with timer.phase("read_routes_trips_services"):
            info = read_feed_info(archive)
            agency_names = read_agency_names(archive)
            catalog = build_catalog(agency_names)
            routes = select_routes(archive, agency_names, catalog, options.categories)
            trips = select_trips(archive, routes.routes)
            services = select_services(archive, {trip.service_key for trip in trips.trips.values()})
        with psycopg.connect(options.database_url, autocommit=True) as control:
            db.upsert_sources(control, [DELFI, EVA_MIRROR])
            run_id = db.start_run(control, DELFI.source_id, JOB, __version__)
            try:
                with psycopg.connect(options.database_url) as conn, conn.transaction():
                    db.lock_source(conn, DELFI.source_id)
                    load = _load_in_transaction(
                        conn,
                        archive,
                        options=options,
                        feed=feed,
                        eva_input=eva_input,
                        overrides=overrides,
                        info_version=info.version,
                        valid=(info.start, info.end),
                        run_id=run_id,
                        catalog_operators=list(catalog.operators.values()),
                        agency_count=len(agency_names),
                        routes=routes,
                        trips=trips,
                        services=services,
                        timer=timer,
                    )
                    report.update(load)
                    report["timings_s"] = timer.phases
                    report["wall_s"] = round(time.perf_counter() - started, 1)
                    report["peak_rss_mb"] = peak_rss_mb()
                    db.close_feed_version(
                        conn, int(load["feed_version_id"]), json.dumps(report["stored"])
                    )
            except Exception as error:
                db.finish_run(control, run_id, f"{type(error).__name__}: {error}"[:2000])
                raise
            db.finish_run(control, run_id)
            report["ingest_run_id"] = str(run_id)
    review = report.pop("eva_review", [])
    identity_review = report.pop("identity_review", [])
    if options.report_dir is not None:
        options.report_dir.mkdir(parents=True, exist_ok=True)
        (options.report_dir / "load-report.json").write_text(
            json.dumps(report, indent=2, default=str) + "\n"
        )
        write_eva_review(options.report_dir / "eva-review.csv", review)
        write_identity_review(options.report_dir / "place-identity.csv", identity_review)
    return report


EVA_REVIEW_COLUMNS = (
    "place_key", "place_name", "country", "lat", "lon", "eva", "eva_name", "distance_m", "score",
    "method",
)  # fmt: skip


def eva_review(model: StopModel, matches: dict[str, EvaMatch]) -> list[tuple[object, ...]]:
    rows = []
    for key, place in sorted(model.places.items()):
        match = matches.get(key)
        rows.append(
            (
                key,
                place.name,
                place.country_code or "",
                place.lat,
                place.lon,
                match.eva if match else "",
                match.eva_name if match else "",
                round(match.distance_m, 1) if match else "",
                round(match.score, 3) if match else "",
                match.method if match else "",
            )
        )
    return rows


def write_eva_review(path: Path, rows: list[tuple[object, ...]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(EVA_REVIEW_COLUMNS)
        writer.writerows(rows)


def quantiles(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values)
    last = len(ordered) - 1
    return {
        "min": round(ordered[0], 3),
        "p50": round(ordered[min(last, len(ordered) // 2)], 3),
        "p95": round(ordered[min(last, int(0.95 * len(ordered)))], 3),
        "max": round(ordered[-1], 3),
    }


def _load_in_transaction(  # noqa: PLR0913
    conn: psycopg.Connection,
    archive: zipfile.ZipFile,
    *,
    options: LoadOptions,
    feed: InputFile,
    eva_input: InputFile | None,
    overrides: list[Override],
    info_version: str,
    valid: tuple[date | None, date | None],
    run_id: UUID,
    catalog_operators: list[Operator],
    agency_count: int,
    routes: RouteSelection,
    trips: TripSelection,
    services: ServiceSelection,
    timer: Timer,
) -> dict[str, object]:
    now = datetime.now(UTC)
    raw_id = db.upsert_raw_object(
        conn,
        source_id=DELFI.source_id,
        run_id=run_id,
        object_key=object_key(feed.path, options.data_root),
        sha256=feed.sha256,
        size=feed.size,
        fetched_at=feed.fetched_at,
        request_url=feed.url,
    )
    if eva_input is not None:
        eva_run = db.start_run(conn, EVA_MIRROR.source_id, JOB, __version__)
        db.upsert_raw_object(
            conn,
            source_id=EVA_MIRROR.source_id,
            run_id=eva_run,
            object_key=object_key(eva_input.path, options.data_root),
            sha256=eva_input.sha256,
            size=eva_input.size,
            fetched_at=eva_input.fetched_at,
            request_url=eva_input.url,
        )
        db.finish_run(conn, eva_run)
    alias_conflicts = db.upsert_operators(conn, catalog_operators, DELFI.source_id, now)
    version_id, existed = db.open_feed_version(
        conn,
        db.VersionKey(DELFI.source_id, feed.sha256),
        raw_object_id=raw_id,
        published_on=published_on(feed),
        feed_version=info_version,
        valid_from=valid[0],
        valid_to=valid[1],
        category_codes=sorted(c.value for c in options.categories),
        run_id=run_id,
    )
    db.create_stop_time_stage(conn)
    with timer.phase("stream_stop_times"), db.StopTimeStage(conn) as stage:
        stop_times = stream_stop_times(archive, trips.trips, routes.routes, stage)
    with timer.phase("stops_and_eva"):
        rows = read_stops(archive, stop_times.served_stops)
        model = build_model(rows, sorted(stop_times.served_stops))
        outline = (
            NationalOutline.from_geojson(options.outline_path) if options.outline_path else None
        )
        join, stop_counts = resolve_stops(model, load_eva_index(options.eva_path), outline)
        assign_canonical_ids(model, DELFI.source_id, db.known_stop_ids(conn, DELFI.source_id))
        identity = resolve_identity(
            model,
            db.stored_places(conn, DELFI.source_id),
            overrides,
            source_id=DELFI.source_id,
        )
        join.prune(model)
        matches = join.matches
    with timer.phase("write_stops"):
        released_ids = db.upsert_stops(conn, model, DELFI.source_id)
        remapped_keys = db.remap_id_map(
            conn,
            DELFI.source_id,
            "stop_place",
            [
                (m.key, model.places[model.merged.get(m.key, m.key)].canonical)
                for m in identity.matches
                if m.action == "separated"
            ],
            now,
        )
        place_ids = db.upsert_id_map(
            conn,
            DELFI.source_id,
            "stop_place",
            [(p.key, p.canonical) for p in model.places.values() if p.canonical]
            + [
                (key, model.places[target].canonical)
                for key, target in model.merged.items()
                if model.places[target].canonical
            ],
            now,
        )
        point_ids = db.upsert_id_map(
            conn,
            DELFI.source_id,
            "stop_point",
            [(p.key, p.canonical) for p in model.points.values() if p.canonical],
            now,
        )
        eva_ids = db.upsert_id_map(
            conn, EVA_MIRROR.source_id, "stop_place", eva_mappings(model, matches), now
        )
    kept = {key: trip for key, trip in trips.trips.items() if key in stop_times.trip_times}
    foreign = foreign_trips(kept, routes, stop_times, model)
    with timer.phase("write_timetable"):
        db.write_timetable(
            conn,
            version_id,
            routes=routes.routes.values(),
            services=services.services.values(),
            calendar_dates=services.calendar_dates,
            patterns=stop_times.patterns.values(),
            point_ids={key: p.canonical for key, p in model.points.items() if p.canonical},
            trips=(
                (
                    trip,
                    stop_times.trip_times[key],
                    routes.routes[trip.route_key].category.value,
                    key in foreign,
                )
                for key, trip in kept.items()
            ),
        )
    with timer.phase("reconcile"):
        db.refresh_statistics(conn)
        stored = db.table_counts(conn, version_id)
        expected = _expected_counts(routes, trips, services, stop_times)
        _reconcile(expected, stored)
        integrity = db.trip_integrity(conn, version_id)
        if any(integrity.values()):
            msg = f"stored trips disagree with their patterns or stop times: {integrity}"
            raise IntegrityError(msg)
    rail_places = len(model.places)
    dropped_by_category = Counter(
        routes.routes[trips.trips[key].route_key].category.value for key in stop_times.dropped_trips
    )
    return {
        "eva_review": eva_review(model, matches),
        "platform_stop_numbers": stop_number_check(model.points.values()),
        "identity_review": identity.matches,
        "feed_version_id": version_id,
        "reloaded_existing_version": existed,
        "feed_info_version": info_version,
        "valid": [str(valid[0]), str(valid[1])],
        "feed_rows": {
            "routes": routes.total,
            "trips": trips.total,
            "stop_times": stop_times.total_rows,
            "calendar": services.calendar_total,
            "calendar_dates": services.calendar_dates_total,
            "agencies": agency_count,
        },
        "selected": {
            "routes_by_category": dict(routes.by_category),
            "routes_excluded_by_category": dict(routes.excluded_by_category),
            "trips_by_category": dict(trips.by_category),
            "trips_excluded": trips.excluded,
            "trips_dropped_by_category": dict(dropped_by_category),
            "trips_dropped_by_reason": dict(Counter(stop_times.dropped_trips.values())),
            "stop_times_kept": stop_times.kept_rows,
            "stop_times_dropped": stop_times.dropped_rows,
            "stop_times_other": stop_times.total_rows
            - stop_times.kept_rows
            - stop_times.dropped_rows,
        },
        "expected": expected,
        "stored": stored,
        "integrity": integrity,
        "foreign_trips_by_reason": dict(Counter(foreign.values())),
        "fallback_routes": [
            {"route_id": r.route_key, "type": r.route_type, "name": r.short_name}
            for r in routes.fallbacks
        ],
        "unmapped_routes": [
            {"route_id": r.route_key, "type": r.route_type, "name": r.short_name}
            for r in routes.unmapped
        ],
        "operators": len(catalog_operators),
        "operator_alias_conflicts": alias_conflicts,
        "stops": {
            "stop_places": rail_places,
            "stop_points": len(model.points),
            "synthesised_places": sum(p.synthesised for p in model.places.values()),
            "places_with_dhid": sum(p.dhid is not None for p in model.places.values()),
            "places_with_eva": len(matches),
            "eva_methods": join.precision(),
            **stop_counts,
            "eva_share": round(len(matches) / rail_places, 4) if rail_places else 0.0,
            "german_places": sum(p.country_code == "DE" for p in model.places.values()),
            "german_places_with_eva": sum(model.places[k].country_code == "DE" for k in matches),
            "eva_numbers_mapped": eva_ids.written,
            "identity": identity.counts()
            | {"ids_released": released_ids, "keys_remapped": remapped_keys},
            "eva_reference_check": {
                f"{eva} {name}": sorted(
                    f"{p.key} {p.name}" for p in model.places.values() if p.eva == eva
                )
                for eva, name in REFERENCE_EVA.items()
            },
            "eva_distance_m": quantiles([m.distance_m for m in matches.values()]),
            "eva_name_score": quantiles([m.score for m in matches.values()]),
            "id_map_conflicts": {
                "stop_place": place_ids.conflicts,
                "stop_point": point_ids.conflicts,
                "eva": eva_ids.conflicts,
            },
        },
    }


def foreign_trips(
    trips: dict[str, Trip],
    routes: RouteSelection,
    stop_times: StopTimesResult,
    model: StopModel,
) -> dict[str, str]:
    """Foreign trips with the reason: a foreign operator, else no stop in Germany."""
    german = {key for key, point in model.points.items() if point.country_code == "DE"}
    result = {}
    for key, trip in trips.items():
        if routes.routes[trip.route_key].is_foreign:
            result[key] = "foreign operator"
            continue
        pattern = stop_times.patterns[stop_times.trip_times[key].trip_pattern_id]
        if not any(stop in german for stop in pattern.stop_keys):
            result[key] = "no stop in Germany"
    return result


def _expected_counts(
    routes: RouteSelection,
    trips: TripSelection,
    services: ServiceSelection,
    stop_times: StopTimesResult,
) -> dict[str, object]:
    trips_by_category = Counter(trips.by_category)
    for key in stop_times.dropped_trips:
        trips_by_category[routes.routes[trips.trips[key].route_key].category.value] -= 1
    return {
        "routes": dict(routes.by_category),
        "trips": {k: v for k, v in trips_by_category.items() if v},
        "stop_times": dict(stop_times.rows_by_category),
        "trip_patterns": len(stop_times.patterns),
        "trip_pattern_stops": sum(len(p.stop_keys) for p in stop_times.patterns.values()),
        "services": len(services.services),
        "calendar_dates": len(services.calendar_dates),
    }


def _reconcile(expected: dict[str, object], stored: dict[str, object]) -> None:
    differences = {
        key: {"expected": value, "stored": stored.get(key)}
        for key, value in expected.items()
        if stored.get(key) != value
    }
    if differences:
        msg = f"stored rows differ from the feed: {json.dumps(differences, default=str)}"
        raise ReconciliationError(msg)
