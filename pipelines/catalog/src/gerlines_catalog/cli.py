"""Command line: ``gerlines-catalog <command>``; see pipelines/catalog/README.md."""

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

from gerlines_catalog import __version__, upstream, wikidata
from gerlines_catalog.cache import ResearchCache
from gerlines_common import project_paths, user_agent_from_env

RESEARCH_QUERIES = {
    "operators": wikidata.operator_query,
    "search": wikidata.search_query,
    "sitelinks": wikidata.sitelink_query,
    "series": wikidata.series_query,
    "series-classes": wikidata.series_class_query,
    "ancestors": wikidata.ancestor_query,
    "colours": wikidata.colour_query,
    "hex": wikidata.hex_query,
    "official-colours": wikidata.official_colour_query,
}


class MissingDatabaseError(SystemExit):
    """A database command was started without naming its database."""


def required_url(environ: dict[str, str], name: str) -> str:
    url = environ.get(name, "").strip()
    if not url:
        msg = f"this command needs {name}; there is no default"
        raise MissingDatabaseError(msg)
    return url


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gerlines-catalog", description=__doc__)
    parser.add_argument("--data", type=Path, help="data folder (default: <repository>/data)")
    parser.add_argument("--catalog", type=Path, help="seed folder (default: <repository>/catalog)")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("validate", help="validate every seed file and the references between them")

    load = commands.add_parser("load", help="validate, then upsert the seeds into DATABASE_URL")
    load.add_argument("--dry-run", action="store_true", help="roll back instead of committing")

    commands.add_parser(
        "fingerprint", help="row count and MD5 of every catalogue table in DATABASE_URL"
    )

    coverage = commands.add_parser(
        "coverage", help="coverage of the feed in FEED_DATABASE_URL (read only) by the seeds"
    )
    coverage.add_argument("--day", required=True, help="reference service day, YYYY-MM-DD")
    coverage.add_argument("--feed-version", type=int, default=1)
    coverage.add_argument("--out", type=Path, help="write the report JSON here as well")

    fetch = commands.add_parser("fetch", help="fetch the pinned upstream files into the cache")
    fetch.add_argument("--refresh", action="store_true")

    research = commands.add_parser("research", help="run a named Wikidata query through the cache")
    research.add_argument("query", choices=sorted(RESEARCH_QUERIES))
    research.add_argument(
        "inputs", nargs="+", help="item ids, search terms, titles or labels; @file reads lines"
    )
    research.add_argument("--name", help="cache name (default: the query name)")
    research.add_argument("--out", type=Path, help="write the rows here instead of stdout")
    research.add_argument("--refresh", action="store_true")
    research.add_argument(
        "--chunk", type=int, default=25, help="inputs per query; the proxy cuts long answers"
    )

    lines = commands.add_parser(
        "line-colours", help="normalise the pinned Träwelling line colours into the seed CSV"
    )
    lines.add_argument("--out", type=Path, help="default: <catalog>/line-colours.csv")

    verbund = commands.add_parser(
        "verbuende", help="build the Verbund seed from the Wikipedia list and Wikidata"
    )
    verbund.add_argument("--out", type=Path, help="default: <catalog>/verbuende.yaml")

    classes = commands.add_parser(
        "series-classes",
        help="derive unit kind, traction and double deck from Wikidata and check the seeds",
    )
    classes.add_argument("--out", type=Path, help="write the derivation report JSON here")

    ice = commands.add_parser(
        "fleet-ice-lines",
        help="print fleet rule rows for the current ICE lines from the German Wikipedia line list",
    )
    ice.add_argument("--source", required=True, help="source_id of the cited list revision")
    ice.add_argument("--valid-from", required=True, type=date.fromisoformat)
    ice.add_argument("--valid-to", required=True, type=date.fromisoformat)
    lists = commands.add_parser(
        "fleet-ic-regional-lines",
        help="fleet rule rows for IC, Railjet, RE and RB lines from the cited Wikipedia line lists,"
        " matched to the timetable in FEED_DATABASE_URL (read only)",
    )
    lists.add_argument("--day", required=True, type=date.fromisoformat, help="service day")
    lists.add_argument("--feed-version", type=int, required=True,
                       help="feed_version_id of the loaded timetable to match")  # fmt: skip
    lists.add_argument("--valid-from", required=True, type=date.fromisoformat)
    lists.add_argument("--valid-to", required=True, type=date.fromisoformat)
    lists.add_argument("--write", action="store_true", help="replace the generated block of"
                       " fleet-rules.yaml instead of printing it")  # fmt: skip
    lists.add_argument("--report", type=Path, help="write the skipped rows as JSON here")
    lists.add_argument("--refresh", action="store_true", help="fetch the revisions again")
    _photo_parsers(commands)
    return parser


def _focus(text: str) -> tuple[float, float]:
    x, y = (float(part) for part in text.split(","))
    if not (0 <= x <= 1 and 0 <= y <= 1):
        msg = "focus is x,y with both between 0 and 1"
        raise argparse.ArgumentTypeError(msg)
    return x, y


def _photo_parsers(commands: argparse._SubParsersAction) -> None:
    photos = commands.add_parser("photos", help="vehicle photos from Wikimedia Commons")
    photos.add_argument("--photos", type=Path, help="photo folder (default: <data>/photos)")
    steps = photos.add_subparsers(dest="photo_command", required=True)
    found = steps.add_parser("candidates", help="find candidate files for every series")
    found.add_argument("--refresh", action="store_true")
    for name in ("approve", "reject"):
        step = steps.add_parser(name, help=f"{name} one candidate file of a series")
        step.add_argument("series_id")
        step.add_argument("file_title", help="File:… as in candidates.json")
        step.add_argument("--reason", required=True)
        step.add_argument("--by", default="user", help="user, or pick:<id> for a pre-selection")
        step.add_argument("--focus", type=_focus, help="crop focus x,y between 0 and 1")
    steps.add_parser("store", help="download approved photos at 330 and 960 px")
    steps.add_parser("check", help="every approved photo has its credit and verified copies")
    photo_load = steps.add_parser(
        "load", help="write the photos a maintainer reviewed into DATABASE_URL"
    )
    photo_load.add_argument("--dry-run", action="store_true")
    photo_load.add_argument(
        "--include-pending",
        action="store_true",
        help="also load the picks still waiting for a maintainer (development, screenshots)",
    )
    review = steps.add_parser("review", help="local review page on 127.0.0.1")
    review.add_argument("--port", type=int, default=8791)


def photos(args: argparse.Namespace, data: Path, catalog_dir: Path, environ: dict[str, str]) -> int:
    from gerlines_catalog import photo_commands  # noqa: PLC0415
    from gerlines_catalog.cache import urllib_transport  # noqa: PLC0415

    photos_dir = args.photos or data / "photos"
    step = args.photo_command
    if step in {"approve", "reject"}:
        record = photo_commands.decide(
            catalog_dir, photos_dir, series_id=args.series_id, file_title=args.file_title,
            decision=step, reason=args.reason, by=args.by, focus=args.focus,
        )  # fmt: skip
        print(f"{record.photo_id} {record.approval.decision} rank={record.rank}")
        return 0
    if step == "check":
        return photo_commands.check(catalog_dir, photos_dir)
    if step == "load":
        url = required_url(environ, "DATABASE_URL")
        return photo_commands.load(
            catalog_dir, photos_dir, url, args.dry_run, include_pending=args.include_pending
        )
    if step == "review":
        from gerlines_catalog import photo_review  # noqa: PLC0415

        return photo_review.serve(catalog_dir, photos_dir, args.port)
    agent = user_agent_from_env(f"catalog-{__version__}")
    transport = photo_commands.paced(urllib_transport)
    api = ResearchCache(data / "catalog", agent, transport=transport, min_interval_s=0)
    if step == "candidates":
        return photo_commands.candidates(api, catalog_dir, photos_dir, args.refresh)
    images = ResearchCache(photos_dir, agent, transport=transport, min_interval_s=0)
    return photo_commands.store(api, images, catalog_dir, photos_dir)


def expand_inputs(inputs: list[str]) -> list[str]:
    expanded: list[str] = []
    for item in inputs:
        if item.startswith("@"):
            lines = Path(item[1:]).read_text().splitlines()
            expanded.extend(line.strip() for line in lines if line.strip())
        else:
            expanded.append(item)
    return expanded


def research_cache(data: Path) -> ResearchCache:
    return ResearchCache(data / "catalog", user_agent_from_env(f"catalog-{__version__}"))


def research(args: argparse.Namespace, data: Path) -> int:
    inputs = expand_inputs(args.inputs)
    cache = research_cache(data)
    rows: list[dict] = []
    for start in range(0, len(inputs), args.chunk):
        query = RESEARCH_QUERIES[args.query](inputs[start : start + args.chunk])
        rows += wikidata.run(cache, args.name or args.query, query, refresh=args.refresh)
    flat = [{key: entry["value"] for key, entry in row.items()} for row in rows]
    text = json.dumps(flat, ensure_ascii=False, indent=1) + "\n"
    if args.out:
        args.out.write_text(text)
    else:
        sys.stdout.write(text)
    return 0


def main(argv: list[str] | None = None) -> int:  # noqa: PLR0911, PLR0912
    args = build_parser().parse_args(argv)
    paths = project_paths()
    data = args.data or paths.data
    catalog_dir = args.catalog or paths.root / "catalog"
    environ = dict(os.environ)
    if args.command == "research":
        return research(args, data)
    if args.command == "photos":
        return photos(args, data, catalog_dir, environ)
    if args.command == "fetch":
        cache = research_cache(data)
        for item in upstream.UPSTREAM_FILES:
            cached = upstream.fetch(cache, item, refresh=args.refresh)
            state = "reused" if cached.reused else "fetched"
            print(f"{state} {item.url} sha256={cached.sidecar['sha256']}")
        return 0
    from gerlines_catalog import commands  # noqa: PLC0415

    if args.command == "validate":
        return commands.validate(catalog_dir)
    if args.command == "load":
        return commands.load(catalog_dir, required_url(environ, "DATABASE_URL"), args.dry_run)
    if args.command == "fingerprint":
        return commands.fingerprint(required_url(environ, "DATABASE_URL"))
    if args.command == "coverage":
        return commands.coverage_report(
            catalog_dir,
            required_url(environ, "FEED_DATABASE_URL"),
            args.day,
            args.feed_version,
            args.out,
        )
    if args.command == "line-colours":
        return commands.line_colours(
            research_cache(data), catalog_dir, args.out or catalog_dir / "line-colours.csv"
        )
    if args.command == "series-classes":
        return commands.series_class_report(research_cache(data), catalog_dir, args.out)
    if args.command == "fleet-ice-lines":
        return commands.fleet_ice_lines(
            research_cache(data), catalog_dir, args.source, args.valid_from, args.valid_to
        )
    if args.command == "fleet-ic-regional-lines":
        agent = user_agent_from_env(f"catalog-{__version__}")
        cache = ResearchCache(data / "catalog", agent, min_interval_s=1.0)
        return commands.fleet_ic_regional_lines(
            cache,
            catalog_dir,
            required_url(environ, "FEED_DATABASE_URL"),
            day=args.day,
            feed_version=args.feed_version,
            valid=(args.valid_from, args.valid_to),
            write=args.write,
            report=args.report,
            refresh=args.refresh,
        )
    if args.command == "verbuende":
        return commands.verbuende(research_cache(data), args.out or catalog_dir / "verbuende.yaml")
    return 2


if __name__ == "__main__":
    sys.exit(main())
