"""Command line: ``gerlines-backfill <command>``; see pipelines/backfill/README.md."""

import argparse
import json
import os
import signal
import sys
import time
from collections.abc import Mapping
from datetime import date
from pathlib import Path

from gerlines_backfill import __version__
from gerlines_backfill.archive import ArchiveError, archive_month
from gerlines_backfill.download import (
    download_month,
    file_url,
    hub_files,
    month_path,
    months_between,
    read_json,
    render_source,
    revision_url,
    tree_url,
)
from gerlines_backfill.load import (
    DEFAULT_OVERRIDES,
    MonthInput,
    dry_run_places,
    load_month,
    write_review,
)
from gerlines_backfill.month import convert_month
from gerlines_common import project_paths, user_agent_from_env

FIRST_FULL_MONTH = "2025-11"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gerlines-backfill", description=__doc__)
    parser.add_argument("--data", type=Path, help="data folder (default: <repository>/data)")
    commands = parser.add_subparsers(dest="command", required=True)

    download = commands.add_parser("download", help="fetch the monthly Parquet files")
    download.add_argument("--first", default=FIRST_FULL_MONTH, help="first month, YYYY-MM")
    download.add_argument("--last", required=True, help="last month, YYYY-MM")
    download.add_argument("--revision", help="dataset commit (default: the current main)")
    download.add_argument("--fetched", type=date.fromisoformat, default=date.today())

    convert = commands.add_parser("convert", help="monthly Parquet to stop, run and leg folders")
    convert.add_argument(
        "--inputs", type=Path, required=True, help="folder with data-YYYY-MM.parquet"
    )
    convert.add_argument("--first", default=FIRST_FULL_MONTH, help="first month, YYYY-MM")
    convert.add_argument("--last", required=True, help="last month, YYYY-MM")
    convert.add_argument("--out", type=Path, help="default: <data>/backfill/piebro")

    load = commands.add_parser("load", help="load converted months into the database")
    load.add_argument("--inputs", type=Path, required=True, help="folder with data-YYYY-MM.parquet")
    load.add_argument("--revision", required=True, help="dataset commit the files came from")
    load.add_argument("--converted", type=Path, help="default: <data>/backfill/piebro")
    load.add_argument("--stations", type=Path, help="Bahn-Vorhersage stations.parquet")
    load.add_argument("--first", default=FIRST_FULL_MONTH, help="first month, YYYY-MM")
    load.add_argument("--last", required=True, help="last month, YYYY-MM")
    load.add_argument(
        "--until", type=date.fromisoformat, help="first service day of the live recording"
    )
    load.add_argument("--compress", action="store_true", help="compress the loaded chunks")
    load.add_argument("--report", type=Path, help="append one JSON line per month")
    load.add_argument(
        "--overrides", type=Path, default=DEFAULT_OVERRIDES, help="reviewed place decisions"
    )

    places = commands.add_parser("places", help="dry run of the station matching, writes nothing")
    places.add_argument("--converted", type=Path, help="default: <data>/backfill/piebro")
    places.add_argument("--stations", type=Path, help="Bahn-Vorhersage stations.parquet")
    places.add_argument("--first", default=FIRST_FULL_MONTH, help="first month, YYYY-MM")
    places.add_argument("--last", required=True, help="last month, YYYY-MM")
    places.add_argument(
        "--overrides", type=Path, default=DEFAULT_OVERRIDES, help="reviewed place decisions"
    )
    places.add_argument("--review", type=Path, help="folder for <month>-place-review.csv")

    archive = commands.add_parser(
        "archive", help="drop the raw rows of loaded months, keep their rollups"
    )
    archive.add_argument("--first", required=True, help="first month, YYYY-MM")
    archive.add_argument("--last", required=True, help="last month, YYYY-MM")
    archive.add_argument("--report", type=Path, help="append one JSON line per month")
    return parser


def database_url(environ: Mapping[str, str]) -> str:
    url = environ.get("DATABASE_URL", "").strip()
    if not url:
        msg = "this command needs DATABASE_URL; there is no default"
        raise SystemExit(msg)
    return url


def exit_on_terminate() -> None:
    """SIGTERM raises SystemExit, so a stopped load still marks its ingest_run failed."""

    def stop(number: int, _frame: object) -> None:
        sys.exit(128 + number)

    signal.signal(signal.SIGTERM, stop)


def _load(args: argparse.Namespace, data: Path) -> int:
    exit_on_terminate()
    url = database_url(os.environ)
    converted = args.converted or data / "backfill" / "piebro"
    for month in months_between(args.first, args.last):
        source = args.inputs / f"data-{month}.parquet"
        report = load_month(
            url,
            MonthInput(
                month=month,
                folder=converted / month,
                source_file=source,
                object_key=f"piebro/{args.inputs.name}/{source.name}",
                request_url=file_url(args.revision, month_path(month)),
                stations=args.stations,
                until=args.until,
                overrides=args.overrides,
            ),
            compress=args.compress,
        )
        line = json.dumps(report)
        print(line, flush=True)
        if args.report:
            with args.report.open("a") as handle:
                handle.write(line + "\n")
    return 0


def _places(args: argparse.Namespace, data: Path) -> int:
    url = database_url(os.environ)
    converted = args.converted or data / "backfill" / "piebro"
    for month in months_between(args.first, args.last):
        places = dry_run_places(url, converted / month, args.stations, args.overrides)
        if args.review:
            write_review(args.review / f"{month}-place-review.csv", places.review)
        report = {
            "month": month,
            "stations": len(places.mapping),
            "stop_place_methods": places.methods,
            "places_for_review": len(places.review),
        }
        print(json.dumps(report), flush=True)
    return 0


def _archive(args: argparse.Namespace) -> int:
    exit_on_terminate()
    url = database_url(os.environ)
    for month in months_between(args.first, args.last):
        refused: ArchiveError | None = None
        try:
            report = archive_month(url, month)
        except ArchiveError as error:
            refused = error
            report = {"month": month, "archived": error.archived, "refused": str(error)}
        line = json.dumps(report)
        print(line, flush=True)
        if args.report:
            with args.report.open("a") as handle:
                handle.write(line + "\n")
        if refused is not None:
            print(f"gerlines-backfill archive: {refused}", file=sys.stderr)
            return 1
    return 0


def _convert(args: argparse.Namespace, data: Path) -> int:
    out = args.out or data / "backfill" / "piebro"
    for month in months_between(args.first, args.last):
        started = time.perf_counter()
        summary = convert_month(args.inputs, month, out)
        print(
            f"{month}: {summary['stops']:,} stops, {summary['trips']:,} runs, "
            f"{summary['segments']:,} legs in {time.perf_counter() - started:.0f} s",
            flush=True,
        )
    return 0


def _download(args: argparse.Namespace, data: Path) -> int:
    agent = user_agent_from_env(__version__)
    revision = args.revision or json.loads(read_json(revision_url(), agent))["sha"]
    listing = hub_files(read_json(tree_url(revision), agent))
    out_dir = data / "inputs" / "piebro" / args.fetched.isoformat()
    rows = []
    for month in months_between(args.first, args.last):
        hub = listing.get(month_path(month))
        if hub is None:
            print(f"{month}: not in the dataset at {revision}", file=sys.stderr)
            return 1
        result = download_month(hub, revision, out_dir, agent)
        state = "reused" if result.reused else "fetched"
        print(f"{month}: {state} {result.size:,} bytes sha256 {result.sha256}", flush=True)
        rows.append((result.path.name, result.size, result.sha256))
        (out_dir / "SOURCE.md").write_text(render_source(revision, args.fetched, rows))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    data = args.data or project_paths().data
    if args.command == "download":
        return _download(args, data)
    if args.command == "convert":
        return _convert(args, data)
    if args.command == "load":
        return _load(args, data)
    if args.command == "places":
        return _places(args, data)
    if args.command == "archive":
        return _archive(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
