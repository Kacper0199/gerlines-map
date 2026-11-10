"""Production steps for one feed version: patterns, candidates, evaluation, choice, shapes, load.

Every step reads and writes under ``--work`` (``data/rail_graph/feeds/<published on>``), is
skipped when its inputs and parameters are unchanged (``--force`` reruns it), and prints one JSON
line with wall time and peak memory.
"""

import argparse
import json
import os
import resource
from datetime import date
from pathlib import Path

from gerlines_rail_graph.steps import Step, fingerprint, write_json

MOTIS_WINDOW = (date(2026, 10, 24), date(2026, 12, 11))
REFERENCE_WEEK = (date(2026, 10, 26), date(2026, 11, 1))


def peak_rss_mb() -> int:
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576)


def emit(record: dict) -> None:
    print(json.dumps({**record, "peak_rss_mb": peak_rss_mb()}, ensure_ascii=False))


def database_url() -> str:
    """Only ``DATABASE_URL``; there is no default, so nothing can hit a shared database."""
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        msg = "this step needs DATABASE_URL naming the database; there is no default"
        raise SystemExit(msg)
    return url


def load_patterns(work: Path):
    from gerlines_rail_graph.patterns import Pattern  # noqa: PLC0415

    return [Pattern.from_json(p) for p in json.loads((work / "patterns.json").read_text())]


def cmd_patterns(args: argparse.Namespace) -> None:
    import psycopg  # noqa: PLC0415

    from gerlines_rail_graph.index import load_coverage  # noqa: PLC0415
    from gerlines_rail_graph.patterns import read_patterns  # noqa: PLC0415

    url = database_url()
    window = (date.fromisoformat(args.window_from), date.fromisoformat(args.window_to))
    week = (date.fromisoformat(args.week_from), date.fromisoformat(args.week_to))
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT published_on, sha256, status FROM feed_version WHERE feed_version_id = %s",
            (args.feed_version,),
        )
        row = cur.fetchone()
        if row is None or row[2] != "loaded":
            msg = f"feed version {args.feed_version} is not loaded"
            raise SystemExit(msg)
        published_on, sha256, _ = row
        key = fingerprint(
            {"outline": args.outline, **({"only": args.only} if args.only else {})},
            {
                "feed_sha256": sha256,
                "window": window,
                "week": week,
                "limit": args.limit,
            },
        )
        step = Step(args.work, "patterns", key, force=args.force)
        if step.skip:
            emit({"step": "patterns", "skipped": True})
            return
        outline = load_coverage(args.outline, inset_m=0.0)
        patterns = read_patterns(conn, args.feed_version, window, week, outline, args.limit)
    if args.only:
        from gerlines_rail_graph.reuse import restrict  # noqa: PLC0415

        patterns = restrict(patterns, json.loads(args.only.read_text()))
    write_json(args.work / "patterns.json", [p.as_json() for p in patterns])
    (args.work / "rep-trips.txt").write_text("".join(f"{p.rep_trip}\n" for p in patterns))
    by_cat: dict[str, dict] = {}
    for p in patterns:
        entry = by_cat.setdefault(f"{p.category}:{p.scope}", {"patterns": 0, "train_km_week": 0})
        entry["patterns"] += 1
        entry["train_km_week"] = round(entry["train_km_week"] + p.train_km_week)
    emit(
        step.done(
            {
                "feed_version_id": args.feed_version,
                "published_on": published_on.isoformat(),
                "feed_sha256": sha256,
                "patterns": len(patterns),
                "without_service_date_in_window": sum(p.rep_date is None for p in patterns),
                "groups": len({p.group for p in patterns}),
                "by_category_scope": dict(sorted(by_cat.items())),
            }
        )
    )


def cmd_reuse(args: argparse.Namespace) -> None:
    import psycopg  # noqa: PLC0415

    from gerlines_rail_graph.guard import hold_locks  # noqa: PLC0415
    from gerlines_rail_graph.reuse import reuse_shapes  # noqa: PLC0415

    url = database_url()
    command = f"gerlines-rail-graph reuse --feed-version {args.feed_version}"
    with hold_locks([args.db_load_lock], "rollover", command), psycopg.connect(url) as conn:
        report = reuse_shapes(
            conn, args.feed_version, args.from_version, max_stop_m=args.max_stop_m
        )
    new_ids = report.pop("new_pattern_ids")
    write_json(args.work / "new-patterns.json", new_ids)
    write_json(args.work / "reuse.json", report, indent=1)
    emit({"step": "reuse", **report})


def cmd_fetch_motis(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.candidates import fetch_motis  # noqa: PLC0415
    from gerlines_rail_graph.reuse import without_router  # noqa: PLC0415
    from gerlines_rail_graph.store import ShapeStore  # noqa: PLC0415

    if (args.router_run is None) == (not args.without_router):
        msg = "fetch-motis needs exactly one of --router-run and --without-router"
        raise SystemExit(msg)
    inputs = {"patterns": args.work / "patterns.json"}
    if args.router_run is not None:
        inputs["router_run"] = args.router_run
    key = fingerprint(inputs, {"tag": args.tag, "without_router": args.without_router})
    step = Step(args.work, "fetch-motis", key, force=args.force)
    if step.skip:
        emit({"step": "fetch-motis", "skipped": True})
        return
    patterns = load_patterns(args.work)
    if args.without_router:
        shapes, how, summary = without_router(patterns)
    else:
        shapes, how, summary = fetch_motis(patterns, args.base_url, args.tag, args.workers)
    ShapeStore.from_mapping(shapes).save(args.work / "candidates" / "motis")
    write_json(args.work / "candidates" / "motis.how.json", how, indent=0)
    emit(step.done({"router_run": str(args.router_run) if args.router_run else None, **summary}))


def input_record(path: Path, *, with_hash: bool) -> dict:
    from gerlines_rail_graph.steps import file_fingerprint, sha256_file  # noqa: PLC0415

    record = {"path": str(path), **file_fingerprint(path)}
    if with_hash:
        record["sha256"] = sha256_file(path)
    return record


def _cfg_lines(text: str) -> str:
    kept = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    return "\n".join(kept).strip() + "\n"


def pfaedle_params(run_dir: Path, named: Path | None) -> dict | None:
    """The parameters a pfaedle run used, as ``run-pfaedle.sh`` wrote them to ``params.cfg``,
    checked against the file the sidecar names (comment lines aside)."""
    if named is None:
        return None
    written = run_dir / "params.cfg"
    if not written.exists():
        msg = f"{written} is missing: the run did not record its parameters"
        raise SystemExit(msg)
    text = written.read_text(encoding="utf-8")
    if _cfg_lines(text) != _cfg_lines(named.read_text(encoding="utf-8")):
        msg = f"{named} differs from the parameters the run used ({written})"
        raise SystemExit(msg)
    return {"path": str(named), "text": text}


def cmd_pfaedle_sidecar(args: argparse.Namespace) -> None:
    """Writes ``inputs.json`` beside a pfaedle run: what it read, so a reuse can be checked."""
    out = args.pfaedle / "inputs.json"
    if out.exists() and not args.force:
        emit({"step": "pfaedle-sidecar", "skipped": True})
        return
    stats = json.loads((args.pfaedle / "stats.json").read_text())
    sidecar = {
        "image": args.image,
        "osm": input_record(args.osm, with_hash=True),
        "gtfs": input_record(args.gtfs, with_hash=True),
        "output_trips": input_record(args.pfaedle / "gtfs-out" / "trips.txt", with_hash=False),
        "params": pfaedle_params(args.pfaedle, args.params),
        "pfaedle_stats": stats,
        "note": args.note,
    }
    write_json(out, sidecar, indent=1)
    emit({"step": "pfaedle-sidecar", **sidecar})


def check_pfaedle_inputs(sidecar: dict) -> None:
    """Refuses to reuse a pfaedle run whose OSM or GTFS input changed since it ran."""
    from gerlines_rail_graph.steps import file_fingerprint  # noqa: PLC0415

    for name in ("osm", "gtfs"):
        recorded = sidecar[name]
        current = file_fingerprint(Path(recorded["path"]))
        if current["bytes"] != recorded["bytes"] or current["mtime_ns"] != recorded["mtime_ns"]:
            msg = f"pfaedle input {name} changed since the run: rerun pfaedle (a heavy job)"
            raise SystemExit(msg)


def check_alternate(default: dict, alternate: dict) -> None:
    """Refuses an alternate pfaedle run that read other inputs or ran without parameters."""
    for name in ("osm", "gtfs"):
        if default[name].get("sha256") != alternate[name].get("sha256"):
            msg = f"the alternate pfaedle run read another {name} file than the default run"
            raise SystemExit(msg)
    if default.get("image") != alternate.get("image"):
        msg = "the alternate pfaedle run used another image than the default run"
        raise SystemExit(msg)
    if not alternate.get("params"):
        msg = "the alternate pfaedle run has no parameters in its inputs.json"
        raise SystemExit(msg)


def cmd_extract_pfaedle(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.candidates import extract_pfaedle  # noqa: PLC0415
    from gerlines_rail_graph.reversals import REVERSALS_FILE, reversal_points  # noqa: PLC0415
    from gerlines_rail_graph.splice import SPLICE_JOIN_M, SPLICED_FILE  # noqa: PLC0415
    from gerlines_rail_graph.spurs import SPUR_VERSION  # noqa: PLC0415
    from gerlines_rail_graph.store import ShapeStore  # noqa: PLC0415

    sidecar = json.loads((args.pfaedle / "inputs.json").read_text())
    check_pfaedle_inputs(sidecar)
    inputs = {"patterns": args.work / "patterns.json", "trips": args.pfaedle / "gtfs-out/trips.txt"}
    params: dict = {"pfaedle_inputs": sidecar}
    alternate = None
    if args.alternate is not None:
        alternate = json.loads((args.alternate / "inputs.json").read_text())
        check_pfaedle_inputs(alternate)
        check_alternate(sidecar, alternate)
        inputs |= {
            "alternate_trips": args.alternate / "gtfs-out/trips.txt",
            "reversals": REVERSALS_FILE,
        }
        params |= {
            "alternate_inputs": alternate,
            "splice": 1,
            "join_m": SPLICE_JOIN_M,
            "spurs": SPUR_VERSION,
        }
    step = Step(args.work, "extract-pfaedle", fingerprint(inputs, params), force=args.force)
    if step.skip:
        emit({"step": "extract-pfaedle", "skipped": True})
        return
    patterns = load_patterns(args.work)
    shapes, summary = extract_pfaedle(
        patterns,
        args.pfaedle / "gtfs-out",
        None if args.alternate is None else args.alternate / "gtfs-out",
        reversal_points(),
    )
    ShapeStore.from_mapping(shapes).save(args.work / "candidates" / "pfaedle")
    spliced = summary.pop("splice", {}).copy()
    write_json(args.work / "candidates" / SPLICED_FILE, spliced.pop("spliced", {}), indent=1)
    done = {"pfaedle_inputs": sidecar, "alternate_inputs": alternate, **summary, "splice": spliced}
    emit(step.done(done))


def evaluate_key(args: argparse.Namespace) -> str:
    """Fingerprint of an evaluation: its inputs (coverage included) and the metric versions."""
    from gerlines_rail_graph.reversals import REVERSALS_FILE  # noqa: PLC0415
    from gerlines_rail_graph.spurs import SPUR_VERSION  # noqa: PLC0415

    return fingerprint(
        {
            "patterns": args.work / "patterns.json",
            "motis": args.work / "candidates" / "motis",
            "pfaedle": args.work / "candidates" / "pfaedle",
            "osm": args.osm,
            "outline": args.outline,
            **({"coverage": args.coverage} if args.coverage else {}),
            "reversals": REVERSALS_FILE,
        },
        {
            "chunk_size": args.chunk_size,
            "sample": args.sample,
            "metrics": METRICS_VERSION,
            "spurs": SPUR_VERSION,
        },
    )


def coverage_record(coverage: Path | None) -> dict | None:
    """The measured area beyond the outline an evaluation used, by path and sha256."""
    from gerlines_rail_graph.steps import sha256_file  # noqa: PLC0415

    return None if coverage is None else {"path": str(coverage), "sha256": sha256_file(coverage)}


def cmd_evaluate_all(args: argparse.Namespace) -> None:
    import random  # noqa: PLC0415
    import shutil  # noqa: PLC0415

    from gerlines_rail_graph.guard import heavy_lock, require_free_memory  # noqa: PLC0415
    from gerlines_rail_graph.national import EvalConfig, compute_legs, evaluate_all  # noqa: PLC0415

    name = "evaluate" if args.sample is None else f"evaluate-sample-{args.sample}"
    config = EvalConfig(
        args.work,
        args.osm,
        args.outline,
        args.chunk_size,
        "eval" if args.sample is None else name,
        args.coverage,
    )
    key = evaluate_key(args)
    step = Step(args.work, name, key, force=args.force)
    if step.skip:
        emit({"step": name, "skipped": True})
        return
    stamp = config.eval_dir / "fingerprint.txt"
    if config.eval_dir.exists() and (not stamp.exists() or stamp.read_text() != key):
        shutil.rmtree(config.eval_dir)
    config.eval_dir.mkdir(parents=True, exist_ok=True)
    stamp.write_text(key)
    patterns = load_patterns(args.work)
    if args.sample is not None:
        patterns = random.Random(args.seed).sample(patterns, args.sample)  # noqa: S311
    free_start = require_free_memory()
    command = f"gerlines-rail-graph {name} --workers {args.workers}"
    with heavy_lock(args.heavy_lock, "WP-2.2", command):
        legs = None
        if not (config.eval_dir / "legs.json").exists():
            legs = compute_legs(config, patterns, args.workers, log=lambda s: None)
            emit({"step": f"{name}:legs", **legs})
        summary = evaluate_all(config, patterns, args.workers, log=print)
    emit(
        step.done(
            {
                "patterns": len(patterns),
                "workers": args.workers,
                "free_percent_at_start": free_start,
                "legs": legs,
                "coverage": coverage_record(args.coverage),
                **summary,
                "children_peak_rss_mb": round(
                    resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1048576
                ),
            }
        )
    )


METRICS_VERSION = "2026-11-08.1"


def add_work(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--work", type=Path, required=True, help="data/rail_graph/feeds/<date>")
    parser.add_argument("--force", action="store_true", help="rerun even when inputs are unchanged")


def register(sub) -> dict:
    patterns = sub.add_parser("patterns", help="trip patterns of a loaded feed version (DB)")
    add_work(patterns)
    patterns.add_argument("--feed-version", type=int, required=True)
    patterns.add_argument("--outline", type=Path, required=True)
    patterns.add_argument("--window-from", default=MOTIS_WINDOW[0].isoformat())
    patterns.add_argument("--window-to", default=MOTIS_WINDOW[1].isoformat())
    patterns.add_argument("--week-from", default=REFERENCE_WEEK[0].isoformat())
    patterns.add_argument("--week-to", default=REFERENCE_WEEK[1].isoformat())
    patterns.add_argument("--limit", type=int)
    patterns.add_argument(
        "--only", type=Path, help="JSON list of pattern ids (new-patterns.json from reuse)"
    )

    reuse = sub.add_parser(
        "reuse", help="link a new version's patterns to earlier versions' shapes (DATABASE_URL)"
    )
    add_work(reuse)
    reuse.add_argument("--feed-version", type=int, required=True)
    reuse.add_argument(
        "--from-version", type=int, action="append", required=True, help="earlier version ids"
    )
    reuse.add_argument("--max-stop-m", type=float, default=80.0)
    reuse.add_argument("--db-load-lock", type=Path, required=True, help="data/locks/db-load")

    motis = sub.add_parser("fetch-motis", help="MOTIS shape per pattern from a local server")
    add_work(motis)
    motis.add_argument("--router-run", type=Path, help="the served MOTIS run dir")
    motis.add_argument(
        "--without-router",
        action="store_true",
        help="no MOTIS shape for any pattern (MOTIS not reimported for this feed yet)",
    )
    motis.add_argument("--base-url", default="http://127.0.0.1:8090")
    motis.add_argument("--tag", default="de")
    motis.add_argument("--workers", type=int, default=4)

    sidecar = sub.add_parser("pfaedle-sidecar", help="record the inputs of a pfaedle run")
    sidecar.add_argument("--pfaedle", type=Path, required=True)
    sidecar.add_argument("--osm", type=Path, required=True)
    sidecar.add_argument("--gtfs", type=Path, required=True)
    sidecar.add_argument("--image", required=True)
    sidecar.add_argument("--note", default="")
    sidecar.add_argument("--params", type=Path, help="the PFAEDLE_PARAMS_FILE of the run, if any")
    sidecar.add_argument("--force", action="store_true")

    pfaedle = sub.add_parser("extract-pfaedle", help="pfaedle shape per pattern from its feed")
    add_work(pfaedle)
    pfaedle.add_argument(
        "--pfaedle", type=Path, required=True, help="pfaedle run dir with inputs.json"
    )
    pfaedle.add_argument(
        "--alternate",
        type=Path,
        help="pfaedle run with strict turns (inputs.json with params): legs that turn back "
        "away from stops come from it",
    )

    evaluate = sub.add_parser(
        "evaluate-all", help="metrics of every pattern's candidates (heavy job, takes the lock)"
    )
    add_work(evaluate)
    evaluate.add_argument("--osm", type=Path, required=True)
    evaluate.add_argument("--outline", type=Path, required=True)
    evaluate.add_argument(
        "--coverage",
        type=Path,
        help="area beyond the outline whose track the OSM caches hold (corridor)",
    )
    evaluate.add_argument("--workers", type=int, default=4)
    evaluate.add_argument("--chunk-size", type=int, default=250)
    evaluate.add_argument("--sample", type=int, help="only this many random patterns")
    evaluate.add_argument("--seed", type=int, default=20261025)
    evaluate.add_argument("--heavy-lock", type=Path, required=True, help="data/locks/heavy")

    return {
        "evaluate-all": cmd_evaluate_all,
        "patterns": cmd_patterns,
        "reuse": cmd_reuse,
        "fetch-motis": cmd_fetch_motis,
        "pfaedle-sidecar": cmd_pfaedle_sidecar,
        "extract-pfaedle": cmd_extract_pfaedle,
    }
