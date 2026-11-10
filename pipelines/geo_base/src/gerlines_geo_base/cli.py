"""Command line: ``geo-base download`` fetches the sources, ``geo-base build`` writes outputs."""

import argparse
import sys
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

from gerlines_common import project_paths, user_agent_from_env
from gerlines_geo_base.download import Client, download_source
from gerlines_geo_base.sources import ALL_SOURCES


def _parser() -> argparse.ArgumentParser:
    root = project_paths().root
    parser = argparse.ArgumentParser(prog="geo-base")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=root / "data" / "geo",
        help="where downloads and their sidecars live (git-ignored)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("download", help="fetch every source unless a verified copy exists")
    build = commands.add_parser("build", help="write the GeoJSON outputs and the build report")
    build.add_argument("--out-dir", type=Path, default=root / "apps" / "web" / "public" / "geo")
    build.add_argument(
        "--report", type=Path, default=root / "pipelines" / "geo_base" / "build-report.json"
    )
    return parser


def _download(data_dir: Path) -> None:
    client = Client(user_agent_from_env(version("gerlines-geo-base")))
    for source in ALL_SOURCES:
        sidecar = download_source(source, data_dir, client, datetime.now(UTC))
        print(f"{source.key}: {sidecar.bytes} B sha256 {sidecar.sha256}")


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "download":
        _download(args.data_dir)
        return 0
    from gerlines_geo_base.pipeline import build_all  # noqa: PLC0415

    report = build_all(args.data_dir, args.out_dir, args.report)
    for name, sizes in report["outputs"].items():
        print(f"{name}: {sizes['bytes']} B, gzip {sizes['gzip_bytes']} B")
    return 0


if __name__ == "__main__":
    sys.exit(main())
