"""Command line: ``gerlines-rollups <command>``; see pipelines/rollups/README.md."""

import argparse
import json
import os
import sys
from dataclasses import asdict
from datetime import date, timedelta
from pathlib import Path

import psycopg

from gerlines_common import project_paths
from gerlines_rollups import __version__
from gerlines_rollups.check import run_check
from gerlines_rollups.lands import VG250_ARCHIVE, load_areas, read_areas, read_sidecar
from gerlines_rollups.policies import PolicyError, pause, resume
from gerlines_rollups.refresh import (
    ALL_ROLLUPS,
    ArchivedDaysError,
    policy_health,
    refresh,
    refresh_lands,
)

APPLICATION = f"gerlines-rollups/{__version__}"


class MissingDatabaseError(SystemExit):
    """A database command was started without DATABASE_URL."""


def database_url(environ: dict[str, str]) -> str:
    url = environ.get("DATABASE_URL", "").strip()
    if not url:
        msg = "this command needs DATABASE_URL; there is no default"
        raise MissingDatabaseError(msg)
    return url


def day(text: str) -> date:
    return date.fromisoformat(text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gerlines-rollups", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    lands = commands.add_parser("lands", help="load the VG250 Land areas and assign stop places")
    lands.add_argument("--archive", type=Path, help=f"default: <data>/{VG250_ARCHIVE}")

    health = commands.add_parser(
        "health", help="check that every refresh policy ran recently and level 2 sees level 1"
    )
    health.add_argument(
        "--max-age-min",
        type=int,
        help="unhealthy when the last success is older (default 1.5 schedule intervals per job)",
    )

    commands.add_parser(
        "pause", help="pause every refresh policy and wait until none is still running"
    )
    commands.add_parser(
        "resume",
        help="resume paused policies safely after a pause of any length: level-2 threshold"
        " refresh to now + 7 days, then level 1, then level 2",
    )

    for name, text in (
        ("refresh", "refresh the rollups in dependency order"),
        ("check", "compare every rollup with a direct recomputation"),
    ):
        command = commands.add_parser(name, help=text)
        command.add_argument("--from", dest="start", type=day, required=name == "check")
        command.add_argument(
            "--to",
            dest="end",
            type=day,
            required=name == "check",
            help="last service day, inclusive",
        )
        command.add_argument("--json", type=Path, help="write the report here as well")
        if name == "refresh":
            command.add_argument("--only", nargs="+", choices=ALL_ROLLUPS)
            command.add_argument("--force", action="store_true")
    return parser


def emit(report: dict, path: Path | None) -> None:
    text = json.dumps(report, indent=2, default=str) + "\n"
    sys.stdout.write(text)
    if path:
        path.write_text(text)


def run_policies(url: str, command: str) -> int:
    with psycopg.connect(url, application_name=APPLICATION, autocommit=True) as conn:
        try:
            done = pause(conn) if command == "pause" else resume(conn)
        except PolicyError as error:
            sys.stderr.write(f"gerlines-rollups {command}: {error}\n")
            return 2
    emit(asdict(done), None)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    url = database_url(dict(os.environ))
    if args.command == "lands":
        archive = args.archive or project_paths().data / VG250_ARCHIVE
        with psycopg.connect(url, application_name=APPLICATION) as conn:
            report = load_areas(conn, read_areas(archive), read_sidecar(archive)).as_dict()
        with psycopg.connect(url, application_name=APPLICATION, autocommit=True) as conn:
            report["refreshed"] = [asdict(item) for item in refresh_lands(conn)]
        emit(report, None)
        return 0
    if args.command == "health":
        with psycopg.connect(url, application_name=APPLICATION) as conn:
            limit = None if args.max_age_min is None else timedelta(minutes=args.max_age_min)
            rows = policy_health(conn, limit)
        healthy = all(row.healthy for row in rows)
        emit({"healthy": healthy, "policies": [asdict(row) for row in rows]}, None)
        return 0 if healthy else 1
    if args.command in {"pause", "resume"}:
        return run_policies(url, args.command)
    end = args.end + timedelta(days=1) if args.end else None
    try:
        return _refresh_or_check(args, url, end)
    except ArchivedDaysError as error:
        print(f"gerlines-rollups: {error}", file=sys.stderr)
        return 2


def _refresh_or_check(args: argparse.Namespace, url: str, end: date | None) -> int:
    if args.command == "refresh":
        with psycopg.connect(url, application_name=APPLICATION, autocommit=True) as conn:
            done = refresh(conn, args.start, end, tuple(args.only or ALL_ROLLUPS), force=args.force)
        emit({"refreshed": [asdict(item) for item in done]}, args.json)
        return 0
    with psycopg.connect(url, application_name=APPLICATION) as conn:
        results = run_check(conn, args.start, end)
    statuses = {result.status for result in results}
    overall = next((s for s in ("unequal", "pending") if s in statuses), "equal")
    emit(
        {
            "window": {"from": args.start, "to": args.end},
            "equal": overall == "equal",
            "status": overall,
            "rollups": [result.as_dict() for result in results],
        },
        args.json,
    )
    return 0 if all(result.equal for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
