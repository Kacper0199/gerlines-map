"""Commands for the neighbours' rail OSM: corridor, filter and clip, merge, SOURCE.md."""

import argparse
import json
import resource
import time
from collections.abc import Callable
from pathlib import Path

HELD_FILE = "held.geojson"


def _emit(name: str, started: float, extra: dict) -> None:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576
    print(
        json.dumps(
            {"step": name, "wall_s": round(time.time() - started, 1), "peak_rss_mb": round(peak)}
            | extra
        ),
        flush=True,
    )


def _count(path: Path) -> dict[str, int]:
    import osmium  # noqa: PLC0415

    counts = {"nodes": 0, "ways": 0, "relations": 0}
    for obj in osmium.FileProcessor(str(path)):
        counts["nodes" if obj.is_node() else "ways" if obj.is_way() else "relations"] += 1
    return counts


def _write_sidecar(path: Path, record: dict) -> None:
    path.with_name(path.name + ".json").write_text(json.dumps(record, indent=1))


def cmd_corridor(args: argparse.Namespace) -> None:
    import shapely  # noqa: PLC0415

    from gerlines_rail_graph.neighbours import (  # noqa: PLC0415
        area_km2,
        corridor,
        read_polygon,
        sha256_of,
        write_polygon,
    )
    from gerlines_rail_graph.patterns import Pattern  # noqa: PLC0415

    started = time.time()
    patterns = [Pattern.from_json(p) for p in json.loads(args.patterns.read_text())]
    params = {
        "cap_km": args.cap_km,
        "share": args.share,
        "min_km": args.min_km,
        "max_km": args.max_km,
    }
    drawn = corridor(patterns, args.outline, **params)
    previous = read_polygon(args.previous) if args.previous else shapely.Polygon()
    area = shapely.union_all([drawn, previous])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_polygon(
        args.out,
        area,
        {
            "patterns": str(args.patterns),
            "patterns_sha256": sha256_of(args.patterns),
            "previous": str(args.previous) if args.previous else None,
            **params,
        },
    )
    _emit(
        "corridor",
        started,
        {
            "patterns": len(patterns),
            "area_km2": round(area_km2(area)),
            "added_km2": round(area_km2(shapely.difference(area, previous))),
            "drawn_not_in_previous_km2": round(area_km2(shapely.difference(drawn, previous))),
            "previous_not_drawn_km2": round(area_km2(shapely.difference(previous, drawn))),
            "removed_km2": round(area_km2(shapely.difference(previous, area))),
        },
    )


def _region_of(pbf: Path) -> str:
    return pbf.name.removesuffix(".osm.pbf").removesuffix("-rail")


def _filter_commit() -> str | None:
    import subprocess  # noqa: PLC0415

    try:
        done = subprocess.run(  # noqa: S603
            ["git", "-C", str(Path(__file__).parent), "rev-parse", "--short=8", "HEAD"],  # noqa: S607
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() or None


def rail_record(raw: Path, rail: Path, commit: str | None) -> dict:
    """Provenance of a rail filter: the download it came from (url and sha256 from the download
    sidecar ``<raw>.json`` when present) and the filter that made it."""
    from gerlines_rail_graph.neighbours import FILTER_VERSION, sha256_of  # noqa: PLC0415

    download = raw.with_name(raw.name + ".json")
    meta = json.loads(download.read_text()) if download.exists() else {}
    return {
        "region": _region_of(raw),
        "url": meta.get("url"),
        "raw_file": raw.name,
        "raw_sha256": meta.get("sha256") or sha256_of(raw),
        "raw_osm_timestamp": meta.get("osm_replication_timestamp"),
        "sha256": sha256_of(rail),
        "filter_version": FILTER_VERSION,
        "filter_commit": commit,
    }


def cmd_neighbours(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.neighbours import (  # noqa: PLC0415
        area_km2,
        clip_to_corridor,
        filter_rail,
        held_area,
        read_polygon,
        region_polygons,
        sha256_of,
        write_polygon,
    )

    started = time.time()
    area = read_polygon(args.corridor)
    region_polygons([_region_of(p) for p in args.pbf], args.index)
    corridor_sha = sha256_of(args.corridor)
    args.out.mkdir(parents=True, exist_ok=True)
    commit = _filter_commit()
    regions = {}
    for pbf in args.pbf:
        stem = _region_of(pbf)
        rail = args.out / f"{stem}-rail.osm.pbf"
        kept = rail.exists() and pbf.resolve() == rail.resolve()
        rail_meta = rail.with_name(rail.name + ".json")
        if not kept:
            filter_rail(pbf, rail)
            _write_sidecar(rail, rail_record(pbf, rail, commit))
        filtered_from = json.loads(rail_meta.read_text()) if rail_meta.exists() else None
        clipped = clip_to_corridor(rail, args.out / f"{stem}-corridor.osm.pbf", area)
        record = {
            "region": stem,
            "source": str(pbf),
            "source_sha256": sha256_of(pbf),
            "filtered_from": filtered_from,
            "corridor": str(args.corridor),
            "corridor_sha256": corridor_sha,
            "rail": _count(rail),
            "corridor_counts": _count(clipped),
            "sha256": sha256_of(clipped),
        }
        _write_sidecar(clipped, record)
        regions[stem] = {"rail": record["rail"], "corridor": record["corridor_counts"]}
        if not args.keep_rail and not kept:
            rail.unlink()
            rail_meta.unlink(missing_ok=True)
    held = held_area(area, list(regions), args.index)
    write_polygon(
        args.out / HELD_FILE,
        held,
        {"corridor": str(args.corridor), "corridor_sha256": corridor_sha, "regions": list(regions)},
    )
    _emit(
        "neighbours",
        started,
        {
            "regions": regions,
            "corridor_km2": round(area_km2(area)),
            "held_km2": round(area_km2(held)),
        },
    )


def cmd_merge_osm(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.neighbours import merge_osm, sha256_of  # noqa: PLC0415

    started = time.time()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    counts = merge_osm(args.base, args.add, args.out)
    record = {
        "base": {"path": str(args.base), "sha256": sha256_of(args.base)},
        "additions": [{"path": str(p), "sha256": sha256_of(p)} for p in args.add],
        "rule": "an added object enters only with a higher version than the base's copy",
        "objects": counts,
        "sha256": sha256_of(args.out),
        "bytes": args.out.stat().st_size,
    }
    _write_sidecar(args.out, record)
    _emit("merge-osm", started, {"out": str(args.out), "bytes": record["bytes"], **counts})


def cmd_source_md(args: argparse.Namespace) -> None:
    import osmium  # noqa: PLC0415

    started = time.time()
    rows, total, deleted = [], 0, 0
    for meta_path in sorted(args.dir.glob("*.osm.pbf.json")):
        meta = json.loads(meta_path.read_text())
        raw = args.dir / meta["file"]
        if raw.exists():
            header = osmium.io.Reader(str(raw), osmium.osm.NOTHING).header()
            meta["osm_replication_timestamp"] = header.get("osmosis_replication_timestamp", "")
            meta_path.write_text(json.dumps(meta, indent=1))
            state = "kept"
        else:
            deleted += 1
            state = "deleted"
        total += meta["bytes"]
        rows.append(
            f"| `{meta['file']}` | {state} | {meta['url']} | {meta['bytes']:,} | "
            f"{meta.get('osm_replication_timestamp', '')} | {meta['md5']} | {meta['sha256']} |"
        )
    kept = ""
    if args.kept is not None:
        filters = sorted(args.kept.glob("*-rail.osm.pbf"))
        kept = (
            f"- Kept: {deleted} of {len(rows)} extracts are deleted (disk); their rail filters\n"
            f"  ({len(filters)} files `<region>-rail.osm.pbf`, each with a sidecar naming the raw\n"
            f"  sha256 below) are kept in `{args.kept}`, enough to clip a corridor again.\n"
        )
    text = (
        "# OpenStreetMap extracts of the neighbouring regions\n\n"
        "- Source: Geofabrik GmbH (https://download.geofabrik.de), the `-latest` extracts\n"
        "  of `services/router/config/neighbours.txt`, region polygons from\n"
        "  `geofabrik-index-v1.json`.\n"
        "- Fetched by `services/router/scripts/download-neighbours.sh`, one connection at a\n"
        "  time with"
        f" the project User-Agent, each file checked against Geofabrik's md5;\n"
        f"  {total:,} bytes in all.\n"
        "- Licence: Open Database License 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)\n"
        "- Attribution: © OpenStreetMap contributors (https://www.openstreetmap.org/copyright),\n"
        "  extracts by Geofabrik GmbH.\n"
        + kept
        + "- Written by `gerlines-rail-graph source-md` from the download sidecars.\n\n"
        "| File | State | URL | Bytes | OSM data as of | md5 | sha256 |\n"
        "| --- | --- | --- | --- | --- | --- | --- |\n" + "\n".join(rows) + "\n"
    )
    (args.dir / "SOURCE.md").write_text(text)
    _emit("source-md", started, {"files": len(rows), "deleted": deleted, "bytes": total})


def register(sub: argparse._SubParsersAction) -> dict[str, Callable[[argparse.Namespace], None]]:
    corridor = sub.add_parser(
        "corridor", help="area beyond Germany that the feed's cross-border legs run through"
    )
    corridor.add_argument(
        "--patterns",
        type=Path,
        required=True,
        help="every pattern of the feed (patterns without --only), not the new ones only",
    )
    corridor.add_argument("--outline", type=Path, required=True)
    corridor.add_argument("--out", type=Path, required=True)
    corridor.add_argument(
        "--previous", type=Path, help="the last corridor: the new one is its union with it"
    )
    corridor.add_argument("--cap-km", type=float, default=300.0)
    corridor.add_argument("--share", type=float, default=0.2)
    corridor.add_argument("--min-km", type=float, default=5.0)
    corridor.add_argument("--max-km", type=float, default=25.0)

    neighbours = sub.add_parser(
        "neighbours",
        help="rail objects of neighbouring extracts, clipped to the corridor; writes held.geojson",
    )
    neighbours.add_argument("--corridor", type=Path, required=True)
    neighbours.add_argument(
        "--index", type=Path, required=True, help="Geofabrik index-v1.json with region polygons"
    )
    neighbours.add_argument("--out", type=Path, required=True)
    neighbours.add_argument(
        "--keep-rail", action="store_true", help="keep <region>-rail.osm.pbf to clip again later"
    )
    neighbours.add_argument(
        "pbf",
        type=Path,
        nargs="+",
        help="<region>.osm.pbf, or a kept <region>-rail.osm.pbf to clip again without filtering",
    )

    merge = sub.add_parser(
        "merge-osm", help="lay extracts over a base extract; the base wins equal versions"
    )
    merge.add_argument("--base", type=Path, required=True)
    merge.add_argument("--add", type=Path, action="append", required=True)
    merge.add_argument("--out", type=Path, required=True)

    source = sub.add_parser("source-md", help="SOURCE.md of a download folder from its sidecars")
    source.add_argument("--dir", type=Path, required=True)
    source.add_argument(
        "--kept", type=Path, help="folder of the kept rail filters, for the Kept line"
    )

    return {
        "corridor": cmd_corridor,
        "neighbours": cmd_neighbours,
        "merge-osm": cmd_merge_osm,
        "source-md": cmd_source_md,
    }
