"""Command line: ``gerlines-static-import <command>``; see pipelines/static_import/README.md."""

import argparse
import json
import os
import sys
import time
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from gerlines_common import project_paths, user_agent_from_env
from gerlines_static_import import __version__
from gerlines_static_import.categories import TRAIN_CATEGORIES, Category
from gerlines_static_import.display_names import run_display_names
from gerlines_static_import.download import UrllibHttp, ensure_delfi, ensure_eva_mirror
from gerlines_static_import.enrich import write_enriched, write_report, write_subset
from gerlines_static_import.inventory import rail_route_combinations, write_inventory
from gerlines_static_import.load import LoadOptions, peak_rss_mb, run_load
from gerlines_static_import.products import run_products
from gerlines_static_import.recorded import stage_recorded
from gerlines_static_import.validate import (
    ValidatorRun,
    read_summary,
    run_validator,
    summary_markdown,
)

OUTLINE = Path("apps/web/public/geo/germany-outline.geojson")
PLACE_OVERRIDES = Path("pipelines/static_import/place-identity-overrides.csv")


def default_place_overrides() -> Path | None:
    """The shipped override file; a path given with --place-overrides must exist."""
    path = project_paths().root / PLACE_OVERRIDES
    return path if path.exists() else None


def parse_categories(value: str) -> frozenset[Category]:
    try:
        return frozenset(Category(code.strip()) for code in value.split(",") if code.strip())
    except ValueError as error:
        msg = f"unknown category in {value!r}; known: {', '.join(c.value for c in Category)}"
        raise argparse.ArgumentTypeError(msg) from error


class MissingDatabaseError(SystemExit):
    """``load`` was started without naming its target database."""


def database_url(environ: dict[str, str]) -> str:
    """The target of ``load``: only ``DATABASE_URL``, so no default can hit a shared database."""
    url = environ.get("DATABASE_URL", "").strip()
    if not url:
        msg = "load needs DATABASE_URL naming the target database; there is no default"
        raise MissingDatabaseError(msg)
    return url


def static_dir(data: Path, feed: Path) -> Path:
    return data / "static" / feed.parent.name


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gerlines-static-import", description=__doc__)
    parser.add_argument("--data", type=Path, help="data folder (default: <repository>/data)")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("download", help="fetch this week's DELFI GTFS and the EVA mirror copy")

    inventory = commands.add_parser("inventory", help="rail route combinations with categories")
    inventory.add_argument("feed", type=Path)
    inventory.add_argument("--out", type=Path, required=True)

    load = commands.add_parser("load", help="load one feed version into the database")
    load.add_argument("feed", type=Path)
    load.add_argument("--eva", type=Path, help="EVA-enriched mirror zip of the same week")
    load.add_argument(
        "--categories",
        type=parse_categories,
        default=TRAIN_CATEGORIES,
        help="comma-separated category codes (default: the six train categories)",
    )
    load.add_argument(
        "--outline",
        type=Path,
        help="national outline GeoJSON (default: apps/web/public/geo/germany-outline.geojson)",
    )
    load.add_argument(
        "--place-overrides",
        type=Path,
        help="reviewed stop place identity decisions (default: "
        "pipelines/static_import/place-identity-overrides.csv)",
    )

    enrich = commands.add_parser("enrich", help="write the enriched full feed for MOTIS")
    enrich.add_argument("feed", type=Path)

    subset = commands.add_parser("subset", help="write a feed with only the chosen categories")
    subset.add_argument("feed", type=Path)
    subset.add_argument("--categories", type=parse_categories, default=TRAIN_CATEGORIES)
    subset.add_argument("--name", default="delfi-gtfs-trains.zip")
    subset.add_argument("--trips", type=Path, help="keep only these trip ids (one per line)")

    staged = commands.add_parser(
        "stage-recorded",
        help="link a DELFI feed the recorder stored to inputs/delfi/<Monday>/ with a sidecar",
    )
    staged.add_argument("--recordings", type=Path, help="default: <data>/recordings")
    staged.add_argument("--monday", help="the feed's Monday (default: the newest stored)")

    names = commands.add_parser(
        "display-names", help="stop place display names that name their town"
    )
    names.add_argument("--eva", type=Path, required=True, help="EVA-enriched mirror zip")
    names.add_argument("--stada", type=Path, required=True, help="StaDa full station list JSON")
    names.add_argument("--vg250", type=Path, required=True, help="BKG VG250 GeoPackage archive")
    names.add_argument(
        "--dry-run", action="store_true", help="read only: compute and report, write nothing"
    )

    products = commands.add_parser(
        "products", help="the product (ICE, IC, NJ ...) of every train of one feed version"
    )
    products.add_argument("--feed-version", type=int, required=True, help="feed_version_id")
    products.add_argument("--gtfsde", type=Path, help="gtfs.de long-distance static zip")

    validate = commands.add_parser("validate", help="run gtfs-validator in Docker")
    validate.add_argument("feed", type=Path)
    validate.add_argument("--out", type=Path, required=True)
    validate.add_argument("--memory", default="10g")
    validate.add_argument("--heap", default="9g")
    validate.add_argument("--threads", type=int, default=4)
    validate.add_argument("--date", help="reference date for time-based rules (YYYY-MM-DD)")
    return parser


def _subset(args: argparse.Namespace, data: Path, started: float) -> int:
    out_dir = static_dir(data, args.feed)
    only = (
        frozenset(t.strip() for t in args.trips.read_text().splitlines() if t.strip())
        if args.trips
        else None
    )
    subset = write_subset(args.feed, out_dir / args.name, args.categories, only_trips=only)
    payload = {
        "rows": dict(subset.rows),
        "wall_s": round(time.perf_counter() - started, 1),
        "peak_rss_mb": peak_rss_mb(),
    }
    write_report(out_dir / (Path(args.name).stem + "-report.json"), payload)
    print(json.dumps(payload, indent=2))
    return 0


def print_platform_warnings(report: dict[str, object]) -> None:
    check = report.get("platform_stop_numbers")
    for warning in check.get("warnings", []) if isinstance(check, dict) else []:
        print(f"warning: {warning}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:  # noqa: PLR0911
    args = build_parser().parse_args(argv)
    data: Path = args.data or project_paths().data
    started = time.perf_counter()
    if args.command == "download":
        http = UrllibHttp(timeout_s=300)
        agent = user_agent_from_env(__version__, os.environ)
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        for fetch in (ensure_delfi, ensure_eva_mirror):
            result = fetch(http, data / "inputs", agent, fetched_at=now)
            state = "reused" if result.reused else "downloaded"
            print(f"{state} {result.path} sha256 {result.sidecar['sha256']}")
        return 0
    if args.command == "inventory":
        with zipfile.ZipFile(args.feed) as archive:
            combinations = rail_route_combinations(archive)
        write_inventory(combinations, args.out)
        fallbacks = [c for c in combinations if c.rule.startswith("fallback:")]
        print(f"{len(combinations)} combinations, {len(fallbacks)} by fallback")
        for combination in fallbacks:
            print(f"fallback {combination}")
        return 1 if fallbacks else 0
    if args.command == "load":
        report = run_load(
            LoadOptions(
                feed_path=args.feed,
                database_url=database_url(dict(os.environ)),
                categories=args.categories,
                data_root=data,
                eva_path=args.eva,
                report_dir=static_dir(data, args.feed),
                outline_path=args.outline or project_paths().root / OUTLINE,
                place_overrides=args.place_overrides or default_place_overrides(),
            )
        )
        print(json.dumps({k: report[k] for k in ("stored", "wall_s", "peak_rss_mb")}, indent=2))
        print_platform_warnings(report)
        return 0
    if args.command == "enrich":
        out_dir = static_dir(data, args.feed)
        report = write_enriched(args.feed, out_dir / "delfi-gtfs-enriched.zip")
        payload = report.as_dict() | {
            "wall_s": round(time.perf_counter() - started, 1),
            "peak_rss_mb": peak_rss_mb(),
        }
        write_report(out_dir / "enrich-report.json", payload)
        print(json.dumps(payload, indent=2))
        return 0
    if args.command == "subset":
        return _subset(args, data, started)
    if args.command == "stage-recorded":
        result = stage_recorded(
            args.recordings or data / "recordings", data / "inputs", monday=args.monday
        )
        state = "reused" if result.reused else "staged"
        print(f"{state} {result.feed.monday} {result.path} sha256 {result.feed.sha256}")
        return 0
    if args.command == "display-names":
        report = run_display_names(
            args.eva, args.stada, args.vg250, database_url(dict(os.environ)), dry_run=args.dry_run
        )
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    if args.command == "products":
        report = run_products(args.feed_version, args.gtfsde, database_url(dict(os.environ)))
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    if args.command == "validate":
        completed = run_validator(
            ValidatorRun(
                feed=args.feed,
                output_dir=args.out,
                memory=args.memory,
                heap=args.heap,
                threads=args.threads,
                date=args.date,
            )
        )
        (args.out / "validator.log").write_text(completed.stdout + completed.stderr)
        if completed.returncode != 0:
            print(completed.stderr[-4000:], file=sys.stderr)
            return completed.returncode
        summary = summary_markdown(read_summary(args.out))
        (args.out / "summary.md").write_text(summary)
        print(summary)
        print(f"wall {time.perf_counter() - started:.0f} s")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
