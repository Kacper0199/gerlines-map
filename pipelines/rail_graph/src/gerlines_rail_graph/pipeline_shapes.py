"""Production steps after the evaluation: choose, build, finish (elevation), load, export."""

import argparse
import contextlib
import itertools
import json
import resource
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from gerlines_rail_graph.pipeline import add_work, database_url, emit, load_patterns
from gerlines_rail_graph.steps import Step, fingerprint, sha256_file, write_json


def cmd_osm_structures(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.osm import read_structures  # noqa: PLC0415
    from gerlines_rail_graph.structures import STRUCTURES_FILE  # noqa: PLC0415

    out = args.osm / STRUCTURES_FILE
    if out.exists() and not args.force:
        emit({"step": "osm-structures", "skipped": True})
        return
    ids, bridge, tunnel = read_structures(args.rail_pbf)
    np.savez_compressed(out, way_ids=ids, bridge=bridge, tunnel=tunnel)
    emit(
        {
            "step": "osm-structures",
            "ways": len(ids),
            "bridge_ways": int(bridge.sum()),
            "tunnel_ways": int(tunnel.sum()),
        }
    )


def cmd_choose(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.choose import choose_all, qa_report  # noqa: PLC0415
    from gerlines_rail_graph.national import read_rows  # noqa: PLC0415
    from gerlines_rail_graph.splice import SPLICED_FILE  # noqa: PLC0415

    inputs = {"patterns": args.work / "patterns.json", "eval": args.work / "eval"}
    spliced_file = args.work / "candidates" / SPLICED_FILE
    if spliced_file.exists():
        inputs["spliced"] = spliced_file
    key = fingerprint(inputs, {"v": 1})
    step = Step(args.work, "choose", key, force=args.force)
    if step.skip:
        emit({"step": "choose", "skipped": True})
        return
    patterns = load_patterns(args.work)
    rows = read_rows(args.work / "eval")
    missing = [p.pattern_id for p in patterns if p.pattern_id not in rows]
    if missing:
        msg = f"{len(missing)} patterns have no evaluation row: run evaluate-all first"
        raise SystemExit(msg)
    spliced = json.loads(spliced_file.read_text()) if spliced_file.exists() else {}
    choice = choose_all(patterns, rows, frozenset(spliced))
    report = qa_report(patterns, choice)
    evaluated = args.work / "steps" / "evaluate.json"
    report["coverage"] = (
        json.loads(evaluated.read_text()).get("coverage") if evaluated.exists() else None
    )
    write_json(args.work / "choice.json", choice)
    write_json(args.work / "qa-report.json", report, indent=1)
    emit(step.done({"patterns": len(choice), "report": report}))


def cmd_build(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.build import BuildConfig, build_all  # noqa: PLC0415
    from gerlines_rail_graph.guard import heavy_lock, require_free_memory  # noqa: PLC0415
    from gerlines_rail_graph.reversals import REVERSALS_FILE  # noqa: PLC0415
    from gerlines_rail_graph.spurs import SPUR_VERSION  # noqa: PLC0415

    key = fingerprint(
        {
            "choice": args.work / "choice.json",
            "motis": args.work / "candidates" / "motis",
            "pfaedle": args.work / "candidates" / "pfaedle",
            "osm": args.osm,
            "reversals": REVERSALS_FILE,
        },
        {"v": 1, "spurs": SPUR_VERSION},
    )
    step = Step(args.work, "build", key, force=args.force)
    if step.skip:
        emit({"step": "build", "skipped": True})
        return
    patterns = load_patterns(args.work)
    choice = json.loads((args.work / "choice.json").read_text())
    free = require_free_memory()
    if args.heavy_lock is None and args.workers > 1:
        msg = "more than one build worker is a heavy job: pass --heavy-lock"
        raise SystemExit(msg)
    lock = (
        heavy_lock(args.heavy_lock, "WP-2.2", f"gerlines-rail-graph build --workers {args.workers}")
        if args.heavy_lock is not None
        else contextlib.nullcontext()
    )
    with lock:
        summary = build_all(
            BuildConfig(args.work, args.osm, args.outline), patterns, choice, args.workers
        )
    emit(
        step.done(
            {
                **summary,
                "free_percent_at_start": free,
                "children_peak_rss_mb": round(
                    resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1048576
                ),
            }
        )
    )


def cmd_finish(args: argparse.Namespace) -> None:
    from gerlines_common.user_agent import user_agent_from_env  # noqa: PLC0415
    from gerlines_rail_graph.build import dem_points, finish_all  # noqa: PLC0415
    from gerlines_rail_graph.elevation import (  # noqa: PLC0415
        TileCache,
        archive_record,
        pmtiles_archive,
        sample_sorted,
        tiles_for,
        write_sidecar,
    )
    from gerlines_rail_graph.guard import heavy_lock, require_free_memory  # noqa: PLC0415
    from gerlines_rail_graph.shape import BAKE_VERSION  # noqa: PLC0415

    archive_sha = None if args.dem_archive is None else sha256_file(args.dem_archive)
    key = fingerprint(
        {"geometry": args.work / "build" / "meta.jsonl"},
        {"v": 2, "bake": BAKE_VERSION, "dem_archive_sha256": archive_sha},
    )
    step = Step(args.work, "finish", key, force=args.force)
    if step.skip:
        emit({"step": "finish", "skipped": True})
        return
    free = require_free_memory()
    user_agent = user_agent_from_env(args.app_version)
    archive = (
        contextlib.nullcontext() if args.dem_archive is None else pmtiles_archive(args.dem_archive)
    )
    with heavy_lock(args.heavy_lock, "WP-2.2", "gerlines-rail-graph finish"), archive as lookup:
        cache = TileCache(args.dem, user_agent, pause_s=args.pause, archive=lookup)
        tiles: set[tuple[int, int]] = set()
        for points in dem_points(args.work):
            tiles |= tiles_for(points[:, 0], points[:, 1])
        fetched = cache.ensure(tiles)
        record = None if archive_sha is None else archive_record(args.dem_archive, archive_sha)
        write_sidecar(
            args.dem,
            len(tiles),
            fetched,
            user_agent.split(" ")[0],
            from_archive=cache.from_archive,
            archive=record,
        )
        summary = finish_all(args.work, lambda lonlat: sample_sorted(cache, lonlat))
    emit(
        step.done(
            {
                "dem_tiles": len(tiles),
                "dem_from_archive": cache.from_archive,
                "dem_fetched": fetched,
                "free_percent_at_start": free,
                "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576),
                **summary,
            }
        )
    )


def load_provenance(steps: Path) -> dict:
    """The sources a loaded shape row names: the feed, the MOTIS run, the pfaedle run and the
    strict-turn pfaedle run whose legs were spliced in (None without one)."""
    provenance = {
        name: json.loads((steps / f"{name}.json").read_text()).get(field)
        for name, field in (
            ("patterns", "feed_sha256"),
            ("fetch-motis", "router_run"),
            ("extract-pfaedle", "pfaedle_inputs"),
        )
    }
    extract = json.loads((steps / "extract-pfaedle.json").read_text())
    provenance["extract-pfaedle-alternate"] = extract.get("alternate_inputs")
    return provenance


def cmd_load(args: argparse.Namespace) -> None:
    import psycopg  # noqa: PLC0415

    from gerlines_rail_graph.build import read_lines  # noqa: PLC0415
    from gerlines_rail_graph.db import load  # noqa: PLC0415
    from gerlines_rail_graph.elevation import SOURCE_NOTE  # noqa: PLC0415
    from gerlines_rail_graph.guard import hold_locks, require_free_memory  # noqa: PLC0415
    from gerlines_rail_graph.national import read_rows  # noqa: PLC0415
    from gerlines_rail_graph.spurs import SPUR_VERSION  # noqa: PLC0415
    from gerlines_rail_graph.store import ShapeStore  # noqa: PLC0415
    from gerlines_rail_graph.stubs import STUBS_FILE  # noqa: PLC0415

    url = database_url()
    free = require_free_memory()
    shapes = ShapeStore.load(args.work / "final" / "shapes")
    metas = read_lines(args.work / "final" / "meta.jsonl")
    choice = json.loads((args.work / "choice.json").read_text())
    rows = read_rows(args.work / "eval")
    provenance = load_provenance(args.work / "steps")
    provenance["spur_version"] = SPUR_VERSION
    stub_file = args.work / "final" / STUBS_FILE
    stubs = read_lines(stub_file) if stub_file.exists() else None
    command = f"gerlines-rail-graph load --feed-version {args.feed_version}"
    with (
        hold_locks([args.heavy_lock, args.db_load_lock], "WP-2.2", command),
        psycopg.connect(url) as conn,
    ):
        counts = load(
            conn,
            args.feed_version,
            shapes,
            metas,
            choice,
            rows,
            provenance,
            SOURCE_NOTE,
            stubs,
            replace_all=not args.merge,
            restub=args.restub,
        )
    emit(
        {
            "step": "load",
            "feed_version_id": args.feed_version,
            "merge": args.merge,
            "restub": args.restub,
            "free_percent_at_start": free,
            **counts,
        }
    )


def cmd_export_geojson(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.build import read_lines  # noqa: PLC0415
    from gerlines_rail_graph.store import ShapeStore  # noqa: PLC0415

    shapes = ShapeStore.load(args.work / "final" / "shapes")
    metas = {m["pattern_id"]: m for m in read_lines(args.work / "final" / "meta.jsonl")}
    choice = json.loads((args.work / "choice.json").read_text())
    wanted = args.pattern or [
        p for p, c in choice.items() if args.all or set(c["flags"]) & set(args.flag or [])
    ]
    out = args.work / "geojson"
    out.mkdir(parents=True, exist_ok=True)
    for pid in wanted:
        coords = shapes.get(pid)
        meta = metas[pid]
        feature = {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords[:, :3].round(7).tolist()},
            "properties": {
                **{k: meta[k] for k in ("shape_hash", "method", "qa_status", "length_m")},
                "stop_arc_m": meta["stop_arc_m"],
                "tunnel_spans": meta["tunnel_spans"],
                "bridge_spans": meta["bridge_spans"],
                "m": coords[:, 3].round(3).tolist(),
                "flags": choice[pid]["flags"],
                "verdicts": choice[pid]["verdicts"],
            },
        }
        write_json(out / f"{pid}.geojson", {"type": "FeatureCollection", "features": [feature]})
    emit({"step": "export-geojson", "files": len(wanted)})


GRADE_LIMIT = 0.060
STRUCTURE_END_M = 60.0
REVIEW_FIGURES = {
    "max_stop_gap_m",
    "max_stop_gap_at_turn",
    "max_grade",
    "max_grade_at_m",
    "u_turn_stops",
    "u_turns_at_station",
}
TIMETABLE_REVERSAL_DEG = 120.0
U_TURN_BANDS_M = (30.0, 80.0, 150.0, 300.0)
GAP_AT_TURN_M = 80.0


def turn_stop_distances(
    turns_lonlat: np.ndarray,
    stops_lonlat: np.ndarray,
    stations: np.ndarray | None = None,
    track_m: np.ndarray | None = None,
) -> list[tuple[float, bool, float]]:
    """Per turn not within ``STATION_M`` of a curated station: the straight-line distance (m) to
    the nearest intermediate stop as the timetable places it (not its arc, which the build moves
    onto a turn), whether the timetable reverses there (the directions from the stop before
    and to the stop after differ by more than ``TIMETABLE_REVERSAL_DEG``), and the turn's
    distance along the track (``track_m``, one per turn; infinite without it). Without an
    intermediate stop the distances are infinite."""
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415
    from gerlines_rail_graph.spurs import STATION_M  # noqa: PLC0415

    if not len(turns_lonlat):
        return []
    points = to_xy(turns_lonlat[:, 0], turns_lonlat[:, 1])
    stops = to_xy(stops_lonlat[:, 0], stops_lonlat[:, 1])
    places = (
        None if stations is None or not len(stations) else to_xy(stations[:, 0], stations[:, 1])
    )
    track = np.full(len(points), np.inf) if track_m is None else np.asarray(track_m, dtype=float)
    out = []
    for point, along in zip(points, track, strict=True):
        if places is not None and np.min(np.hypot(*(places - point).T)) <= STATION_M:
            continue
        if len(stops) < 3:
            out.append((float("inf"), False, float("inf")))
            continue
        gaps = np.hypot(*(stops[1:-1] - point).T)
        k = int(np.argmin(gaps)) + 1
        a, b = stops[k] - stops[k - 1], stops[k + 1] - stops[k]
        norms = np.linalg.norm(a) * np.linalg.norm(b)
        cos = float(a @ b / norms) if norms > 0 else 1.0
        reverses = bool(cos < np.cos(np.radians(TIMETABLE_REVERSAL_DEG)))
        out.append((float(gaps[k - 1]), reverses, float(along)))
    return out


def track_distances(xy: np.ndarray, turn_arcs: np.ndarray, stops_xy: np.ndarray) -> np.ndarray:
    """Per turn (projected arc), the distance along the line to the nearest intermediate stop's
    forward position on it, as the gate measures (``spurs._at_stop``); infinite without one."""
    from shapely import LineString  # noqa: PLC0415

    from gerlines_rail_graph.metrics import forward_positions  # noqa: PLC0415

    turn_arcs = np.asarray(turn_arcs, dtype=float)
    if len(stops_xy) < 3 or not len(turn_arcs):
        return np.full(len(turn_arcs), np.inf)
    inner = np.asarray(forward_positions(LineString(xy), stops_xy), dtype=float)[1:-1]
    return np.min(np.abs(turn_arcs[:, None] - inner[None, :]), axis=1)


def shape_violations(
    coords: np.ndarray,
    stop_arcs: list[float],
    stops_lonlat: np.ndarray,
    *,
    check_grade: bool = True,
    stations: np.ndarray | None = None,
) -> dict:
    """Property checks of one final shape (M, stop order, Z, geodesic length, hairpins that are
    no reversal at a stop) with the farthest stop and, on track shapes, the steepest grade
    across 50 m and where it is (a review figure: terrain heights under the track carry
    cuttings, embankments and street bridges)."""
    from gerlines_rail_graph.project import geodesic_segments, to_xy  # noqa: PLC0415
    from gerlines_rail_graph.shape import steepest  # noqa: PLC0415
    from gerlines_rail_graph.spurs import (  # noqa: PLC0415
        REVERSAL_STOP_M,
        hairpin_vertices,
        pack_hairpins,
        pack_u_turns,
        u_turns,
        unexplained,
    )

    m, z = coords[:, 3], coords[:, 2]
    length = float(m[-1])
    geodesic = float(geodesic_segments(coords[:, :2]).sum())
    at_lon = np.interp(stop_arcs, m, coords[:, 0])
    at_lat = np.interp(stop_arcs, m, coords[:, 1])
    at = np.column_stack([at_lon, at_lat])
    gaps = [
        float(geodesic_segments(np.vstack([a, b]))[0]) if not np.allclose(a, b) else 0.0
        for a, b in zip(at, stops_lonlat, strict=True)
    ]
    grade, grade_at = steepest(m, z) if check_grade and np.isfinite(z).all() else (0.0, None)
    xy = to_xy(coords[:, 0], coords[:, 1])
    turns = hairpin_vertices(xy)
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
    u = u_turns(xy)
    u_at = np.column_stack([np.interp(u, cum, coords[:, 0]), np.interp(u, cum, coords[:, 1])])
    stops_xy = to_xy(stops_lonlat[:, 0], stops_lonlat[:, 1])
    u_stops = turn_stop_distances(u_at, stops_lonlat, stations, track_distances(xy, u, stops_xy))
    worst = int(np.argmax(gaps))
    worst_at = float(np.interp(stop_arcs[worst], m, cum))
    at_turn = bool(len(u) and np.min(np.abs(np.asarray(u) - worst_at)) <= GAP_AT_TURN_M)
    return {
        "hairpin_not_at_stop": bool(unexplained(m[turns], stop_arcs, coords[turns, :2], stations)),
        "u_turn_not_at_stop": any(max(d, t) > REVERSAL_STOP_M for d, _, t in u_stops),
        "pack_u_turn_off_stop": bool(pack_u_turns(xy, m, stop_arcs)),
        "pack_hairpin_off_stop": bool(pack_hairpins(xy, m, stop_arcs)),
        "u_turn_stops": u_stops,
        "u_turns_at_station": len(u) - len(u_stops),
        "m_not_from_zero": bool(m[0] != 0),
        "m_backwards": bool(np.any(np.diff(m) < 0)),
        "stops_out_of_order": bool(np.any(np.diff(stop_arcs) < 0)),
        "stops_outside_shape": bool(min(stop_arcs) < 0 or max(stop_arcs) > length + 0.01),
        "z_not_finite": bool(not np.isfinite(z).all()),
        "length_off_geodesic": bool(abs(length - geodesic) > 0.001 * max(geodesic, 1.0)),
        "max_grade": grade,
        "max_grade_at_m": grade_at,
        "max_stop_gap_m": max(gaps),
        "max_stop_gap_at_turn": at_turn,
    }


def u_turn_bands() -> dict[str, dict[str, int]]:
    """Review figure: U-turns of distinct final shapes by distance to the nearest stop."""
    edges = (0.0, *U_TURN_BANDS_M)
    names = [f"{int(a)}-{int(b)} m" for a, b in itertools.pairwise(edges)] + [
        f"over {int(edges[-1])} m"
    ]
    return {
        n: {"u_turns": 0, "timetable_reversal": 0, "flagged_stop_on_reversal": 0} for n in names
    }


def add_u_turns(bands: dict, stops: list[tuple], flagged: bool, along_track: bool = False) -> None:
    """Count turns (straight distance, timetable reversal, track distance) into the bands by
    their straight-line distance, or by their distance along the track."""
    names = list(bands)
    for row in stops:
        distance, reverses = (row[2] if along_track else row[0]), row[1]
        band = bands[names[int(np.searchsorted(U_TURN_BANDS_M, distance, side="left"))]]
        band["u_turns"] += 1
        band["timetable_reversal"] += int(bool(reverses))
        band["flagged_stop_on_reversal"] += int(bool(flagged))


def far_stop_report(far: Sequence[tuple[str, float, bool]]) -> dict:
    """Unflagged stops over 80 m (pattern, gap, at a reversal): all of them, and among them those
    whose stop arc lies at a reversal, a review bucket next to the total, never instead of it
    (such a stop may be an arc moved onto a spur)."""
    at = [[pid, gap] for pid, gap, reversal in far if reversal]
    other = [[pid, gap] for pid, gap, reversal in far if not reversal]
    return {
        "stop_over_80m_unflagged": len(far),
        "stop_over_80m_unflagged_at_reversal": len(at),
        "examples": other[:10],
        "at_reversal_examples": at[:10],
    }


def cmd_verify(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.build import STRAIGHT, read_lines  # noqa: PLC0415
    from gerlines_rail_graph.reversals import load_reversal_stations  # noqa: PLC0415
    from gerlines_rail_graph.store import ShapeStore  # noqa: PLC0415

    shapes = ShapeStore.load(args.work / "final" / "shapes")
    metas = read_lines(args.work / "final" / "meta.jsonl")
    patterns = {p.pattern_id: p for p in load_patterns(args.work)}
    stations = np.array([[s.lon, s.lat] for s in load_reversal_stations()]).reshape(-1, 2)
    choice = json.loads((args.work / "choice.json").read_text())
    counts: dict[str, int] = {}
    far: list[tuple[str, float, bool]] = []
    steep = []
    bands = u_turn_bands()
    track_bands = u_turn_bands()
    at_station = 0
    seen: set[str] = set()
    for meta in metas:
        pid = meta["pattern_id"]
        found = shape_violations(
            shapes.get(pid),
            meta["stop_arc_m"],
            patterns[pid].stop_lonlat(),
            check_grade=meta["method"] != STRAIGHT,
            stations=stations,
        )
        for key, value in found.items():
            if key not in REVIEW_FIGURES and value:
                counts[key] = counts.get(key, 0) + 1
        if found["max_grade"] > GRADE_LIMIT:
            ends = [v for r in meta.get("bake_ranges", []) for v in r[:2]]
            near = min((abs(found["max_grade_at_m"] - v) for v in ends), default=np.inf)
            steep.append([pid, round(found["max_grade"], 3), bool(near <= STRUCTURE_END_M)])
        flagged = {"stop_over_80m", "stop_on_reversal", "low_quality", "unmeasured"} & set(
            choice[pid]["flags"]
        )
        if found["max_stop_gap_m"] > 80 and not flagged:
            far.append(
                (pid, round(found["max_stop_gap_m"], 1), bool(found["max_stop_gap_at_turn"]))
            )
        if meta.get("shape_hash") not in seen:
            seen.add(meta.get("shape_hash"))
            at_station += found["u_turns_at_station"]
            flagged_turn = "stop_on_reversal" in choice[pid]["flags"]
            add_u_turns(bands, found["u_turn_stops"], flagged_turn)
            add_u_turns(track_bands, found["u_turn_stops"], flagged_turn, along_track=True)
    emit(
        {
            "step": "verify",
            "shapes": len(metas),
            "violations": counts,
            **far_stop_report(far),
            "u_turns_by_stop_distance": bands,
            "u_turns_by_track_distance": track_bands,
            "u_turns_at_curated_station": at_station,
            "grade_over_60_permille": {
                "shapes": len(steep),
                "at_structure_end": sum(e[2] for e in steep),
                "elsewhere": sum(not e[2] for e in steep),
                "steepest": sorted(steep, key=lambda e: -e[1])[:10],
            },
        }
    )


def corridor_patterns(  # noqa: PLR0913, PLR0917
    bounds: np.ndarray,
    keys: np.ndarray,
    bbox: tuple,
    patterns: dict,
    per_category: int,
    lonlat_of=None,
) -> list[str]:
    """Patterns whose final shape crosses the box, the busiest few per category.

    The bounding boxes only preselect: a long pattern on a parallel line has a box over the
    corridor too, so with ``lonlat_of(key)`` the shape itself must cross the box.
    """
    import shapely  # noqa: PLC0415

    lon0, lat0, lon1, lat1 = bbox
    hit = (
        (bounds[:, 0] <= lon1)
        & (bounds[:, 2] >= lon0)
        & (bounds[:, 1] <= lat1)
        & (bounds[:, 3] >= lat0)
    )
    area = shapely.box(lon0, lat0, lon1, lat1)
    by_cat: dict[str, list] = {}
    for key in keys[hit]:
        if lonlat_of is not None and not shapely.intersects(
            area, shapely.linestrings(np.asarray(lonlat_of(str(key)))[:, :2])
        ):
            continue
        p = patterns[str(key)]
        by_cat.setdefault(p.category, []).append(p)
    picked = []
    for members in by_cat.values():
        members.sort(key=lambda p: (-p.train_km_week, p.pattern_id))
        picked += [p.pattern_id for p in members[:per_category]]
    return picked


def national_corridors() -> tuple:
    """The SP-3 corridors plus long tunnels and the Essen to Düsseldorf main line."""
    from gerlines_rail_graph.sample import CORRIDORS, Corridor  # noqa: PLC0415

    return (
        *CORRIDORS,
        Corridor("landruecken-tunnel", (9.58, 50.28, 9.72, 50.43)),
        Corridor("katzenberg-tunnel", (7.50, 47.64, 7.62, 47.75)),
        Corridor("essen-duesseldorf", (6.76, 51.20, 7.03, 51.46)),
    )


def cmd_overlay_national(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.build import read_lines  # noqa: PLC0415
    from gerlines_rail_graph.index import way_classes  # noqa: PLC0415
    from gerlines_rail_graph.osm import RailWays  # noqa: PLC0415
    from gerlines_rail_graph.overlay import corridor_data, write_preview  # noqa: PLC0415
    from gerlines_rail_graph.project import to_lonlat  # noqa: PLC0415
    from gerlines_rail_graph.store import ShapeStore  # noqa: PLC0415

    shapes = ShapeStore.load(args.work / "final" / "shapes")
    metas = {m["pattern_id"]: m for m in read_lines(args.work / "final" / "meta.jsonl")}
    patterns = {p.pattern_id: p for p in load_patterns(args.work)}
    starts = shapes.offsets[:-1]
    bounds = np.column_stack(
        [
            np.minimum.reduceat(shapes.coords[:, 0], starts),
            np.minimum.reduceat(shapes.coords[:, 1], starts),
            np.maximum.reduceat(shapes.coords[:, 0], starts),
            np.maximum.reduceat(shapes.coords[:, 1], starts),
        ]
    )
    ways = RailWays.load(args.osm / "ways.npz")
    classes = way_classes(args.osm, ways)
    lonlat = to_lonlat(ways.xy)
    way_of_point = np.repeat(np.arange(len(ways)), np.diff(ways.offsets))
    data = {}
    for corridor in national_corridors():
        ids = corridor_patterns(
            bounds, shapes.keys, corridor.bbox, patterns, args.per_category, shapes.get
        )
        methods: dict[str, dict] = {"final-motis": {}, "final-pfaedle": {}, "final-straight": {}}
        trips = {}
        for pid in ids:
            p = patterns[pid]
            methods[f"final-{metas[pid]['method']}"][pid] = shapes.get(pid)[:, :2].tolist()
            trips[pid] = {
                "route_short_name": p.route_short_name,
                "trip_short_name": "",
                "headsign": p.stops[-1][1],
                "category": f"{p.category}, {metas[pid]['qa_status']}",
                "stops": [list(s) for s in p.stops],
            }
        lon0, lat0, lon1, lat1 = corridor.bbox
        inside = (
            (lonlat[:, 0] >= lon0 - 0.02)
            & (lonlat[:, 0] <= lon1 + 0.02)
            & (lonlat[:, 1] >= lat0 - 0.02)
            & (lonlat[:, 1] <= lat1 + 0.02)
        )
        picked = np.unique(way_of_point[inside])
        rail = [lonlat[ways.offsets[w] : ways.offsets[w + 1]] for w in picked]
        data[corridor.name] = corridor_data(
            f"{corridor.name}: national result",
            corridor.bbox,
            trips,
            methods,
            rail,
            classes[picked],
        )
    write_preview(args.out, data)
    emit({"step": "overlay-national", "pages": len(data)})


def cmd_stubs(args: argparse.Namespace) -> None:
    """Track stubs beyond each final shape's ends (D-055): ``final/stubs.jsonl``."""
    from gerlines_rail_graph.build import read_lines  # noqa: PLC0415
    from gerlines_rail_graph.osm import RailWays  # noqa: PLC0415
    from gerlines_rail_graph.store import ShapeStore  # noqa: PLC0415
    from gerlines_rail_graph.stubs import (  # noqa: PLC0415
        STUB_M,
        STUB_VERSION,
        STUBS_FILE,
        TrackWalker,
        stub_rows,
    )

    meta_file = args.work / "final" / "meta.jsonl"
    inputs = {"meta": meta_file, "ways": args.osm / "ways.npz"}
    step = Step(
        args.work,
        "stubs",
        fingerprint(inputs, {"stub_m": STUB_M, "version": STUB_VERSION}),
        force=args.force,
    )
    if step.skip:
        emit({"step": "stubs", "skipped": True})
        return
    shapes = ShapeStore.load(args.work / "final" / "shapes")
    walker = TrackWalker(RailWays.load(args.osm / "ways.npz"))
    rows, summary = stub_rows(read_lines(meta_file), shapes.get, walker)
    out = args.work / "final" / STUBS_FILE
    out.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
    lengths = np.array([[r["before"]["length_m"], r["after"]["length_m"]] for r in rows]).reshape(
        -1, 2
    )
    percentiles = {
        side: [round(float(v), 1) for v in np.percentile(lengths[:, k], [10, 50, 90])]
        if len(lengths)
        else []
        for k, side in enumerate(("before", "after"))
    }
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576
    emit(step.done({**summary, "length_p10_p50_p90": percentiles, "peak_rss_mb": round(peak)}))


def cmd_reversal_groups(args: argparse.Namespace) -> None:
    """Review: disputed reversals at stops across all chosen track shapes, decided by
    the neighbour direction and the OSM track ends; ``reversal-groups.json``, not a gate."""
    from gerlines_rail_graph.build import STRAIGHT, read_lines  # noqa: PLC0415
    from gerlines_rail_graph.osm import RailWays  # noqa: PLC0415
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415
    from gerlines_rail_graph.reversal_groups import (  # noqa: PLC0415
        decide,
        disputed,
        report,
        stop_calls,
        walker_buffer_test,
    )
    from gerlines_rail_graph.spurs import arc  # noqa: PLC0415
    from gerlines_rail_graph.store import ShapeStore  # noqa: PLC0415
    from gerlines_rail_graph.stubs import TrackWalker  # noqa: PLC0415

    shapes = ShapeStore.load(args.work / "final" / "shapes")
    patterns = {p.pattern_id: p for p in load_patterns(args.work)}
    calls = []
    for meta in read_lines(args.work / "final" / "meta.jsonl"):
        if meta["method"] == STRAIGHT:
            continue
        pattern = patterns[meta["pattern_id"]]
        coords = shapes.get(meta["pattern_id"])
        xy = to_xy(coords[:, 0], coords[:, 1])
        arcs = np.interp(meta["stop_arc_m"], coords[:, 3], arc(xy))
        lonlat = pattern.stop_lonlat()
        stops_xy = to_xy(lonlat[:, 0], lonlat[:, 1])
        ids = [stop[0] for stop in pattern.stops]
        calls.extend(stop_calls(meta["pattern_id"], ids, stops_xy, xy, arcs))
    test = walker_buffer_test(TrackWalker(RailWays.load(args.osm / "ways.npz")))
    decisions = [decide(group, test) for group in disputed(calls).values()]
    summary = {"stop_calls": len(calls), **report(decisions)}
    (args.work / "reversal-groups.json").write_text(
        json.dumps({**summary, "decisions": decisions}, indent=1)
    )
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576
    emit({"step": "reversal-groups", **summary, "peak_rss_mb": round(peak)})


def register(sub) -> dict:
    overlay = sub.add_parser("overlay-national", help="corridor pages of the chosen shapes")
    add_work(overlay)
    overlay.add_argument("--osm", type=Path, required=True)
    overlay.add_argument("--per-category", type=int, default=3)
    overlay.add_argument("--out", type=Path, required=True)

    verify = sub.add_parser("verify", help="property checks on every final shape")
    add_work(verify)

    stubs = sub.add_parser("stubs", help="track stubs beyond the shape ends (D-055)")
    add_work(stubs)
    stubs.add_argument("--osm", type=Path, required=True, help="the OSM cache folder")

    groups = sub.add_parser(
        "reversal-groups", help="review: disputed reversals at stops (not a gate)"
    )
    add_work(groups)
    groups.add_argument("--osm", type=Path, required=True, help="the OSM cache folder")

    structures = sub.add_parser("osm-structures", help="bridge and tunnel flags of track ways")
    structures.add_argument("--rail-pbf", type=Path, required=True)
    structures.add_argument("--osm", type=Path, required=True, help="the OSM cache folder")
    structures.add_argument("--force", action="store_true")

    choose = sub.add_parser("choose", help="gate, method per group, flags and the QA report")
    add_work(choose)

    build = sub.add_parser("build", help="final geometry per pattern (heavy, takes the lock)")
    add_work(build)
    build.add_argument("--osm", type=Path, required=True)
    build.add_argument("--outline", type=Path, required=True)
    build.add_argument("--workers", type=int, default=4)
    build.add_argument("--heavy-lock", type=Path, help="data/locks/heavy; needed above 1 worker")

    finish = sub.add_parser("finish", help="elevation from Mapterhorn, baked spans, hashes")
    add_work(finish)
    finish.add_argument("--dem", type=Path, required=True, help="data/rail_graph/dem")
    finish.add_argument(
        "--dem-archive",
        type=Path,
        help="local PMTiles extract of Mapterhorn planet.pmtiles, read before the tile endpoint",
    )
    finish.add_argument("--app-version", default="0.1.0")
    finish.add_argument("--heavy-lock", type=Path, required=True, help="data/locks/heavy")
    finish.add_argument("--pause", type=float, default=0.2, help="seconds between tile fetches")

    load = sub.add_parser("load", help="shape_pattern and trip_pattern_shape (DATABASE_URL)")
    add_work(load)
    load.add_argument("--feed-version", type=int, required=True)
    load.add_argument("--heavy-lock", type=Path, required=True, help="data/locks/heavy")
    load.add_argument("--db-load-lock", type=Path, required=True, help="data/locks/db-load")
    load.add_argument(
        "--merge",
        action="store_true",
        help="replace only the links of the patterns built here (keeps links from reuse)",
    )
    load.add_argument(
        "--restub",
        action="store_true",
        help="also replace the stored stubs of shapes loaded earlier (needs a new shape epoch)",
    )

    export = sub.add_parser("export-geojson", help="GeoJSON per pattern for QA pages")
    add_work(export)
    export.add_argument("--pattern", action="append")
    export.add_argument("--flag", action="append", help="every pattern with this review flag")
    export.add_argument("--all", action="store_true")

    return {
        "verify": cmd_verify,
        "stubs": cmd_stubs,
        "reversal-groups": cmd_reversal_groups,
        "overlay-national": cmd_overlay_national,
        "osm-structures": cmd_osm_structures,
        "choose": cmd_choose,
        "build": cmd_build,
        "finish": cmd_finish,
        "load": cmd_load,
        "export-geojson": cmd_export_geojson,
    }
