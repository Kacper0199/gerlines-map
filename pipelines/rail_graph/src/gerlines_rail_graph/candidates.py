"""Candidate shapes per pattern: MOTIS ``route_shapes`` from a local server, pfaedle output."""

import csv
import time
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from gerlines_rail_graph.motis import fetch_trip, slice_to_trip, trip_id
from gerlines_rail_graph.patterns import Pattern


def motis_shape(
    pattern: Pattern, base_url: str, tag: str, fetch: Callable[[str, str], dict] = fetch_trip
) -> tuple[list[tuple[float, float]] | None, str, float | None]:
    """Geometry of the pattern's representative trip cut to its stops, the reason, latency ms."""
    if pattern.rep_date is None:
        return None, "no_service_date_in_router_window", None
    motis_id = trip_id(pattern.rep_date, pattern.rep_departure_s, pattern.rep_trip, tag)
    begun = time.perf_counter()
    try:
        itinerary = fetch(base_url, motis_id)
    except OSError as error:
        return None, f"error: {type(error).__name__}", None
    latency = (time.perf_counter() - begun) * 1000
    points, how = slice_to_trip(
        itinerary, [s[0] for s in pattern.stops], tag, [(s[2], s[3]) for s in pattern.stops]
    )
    return points, how, latency


def fetch_motis(
    patterns: Sequence[Pattern],
    base_url: str,
    tag: str,
    workers: int = 4,
    fetch: Callable[[str, str], dict] = fetch_trip,
) -> tuple[dict[str, list | None], dict[str, str], dict]:
    """MOTIS shapes for every pattern, the reason per pattern and a summary."""

    def one(pattern: Pattern):
        return pattern.pattern_id, *motis_shape(pattern, base_url, tag, fetch)

    shapes: dict[str, list | None] = {}
    how: dict[str, str] = {}
    latencies: list[float] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for pattern_id, points, reason, latency in pool.map(one, patterns):
            shapes[pattern_id] = points
            how[pattern_id] = reason
            if latency is not None:
                latencies.append(latency)
    reasons = Counter(_reason_class(r) for r in how.values())
    lat = np.array(latencies)
    return (
        shapes,
        how,
        {
            "patterns": len(patterns),
            "with_shape": sum(1 for v in shapes.values() if v),
            "reasons": dict(reasons),
            "latency_ms_p50": round(float(np.percentile(lat, 50)), 1) if lat.size else None,
            "latency_ms_p95": round(float(np.percentile(lat, 95)), 1) if lat.size else None,
        },
    )


def _reason_class(reason: str) -> str:
    for marker in ("_not_in_run_", "error: "):
        if marker in reason:
            return reason.split(marker, maxsplit=1)[0] + marker.strip(": _")
    return reason


def pfaedle_shape_ids(trips_txt: Path, wanted: Iterable[str]) -> dict[str, str]:
    """``shape_id`` per wanted trip from pfaedle's output ``trips.txt``."""
    wanted = set(wanted)
    with trips_txt.open(encoding="utf-8-sig", newline="") as text:
        return {
            row["trip_id"]: row["shape_id"]
            for row in csv.DictReader(text)
            if row["trip_id"] in wanted and row.get("shape_id")
        }


def read_shape_points(shapes_txt: Path, shape_ids: Iterable[str]) -> dict[str, np.ndarray]:
    """(lon, lat) per wanted shape in ``shape_pt_sequence`` order, streaming a large file."""
    wanted = set(shape_ids)
    found: dict[str, list[tuple[int, float, float]]] = {}
    with shapes_txt.open(encoding="utf-8-sig", newline="") as text:
        reader = csv.reader(text)
        header = next(reader)
        sid, seq = header.index("shape_id"), header.index("shape_pt_sequence")
        lat, lon = header.index("shape_pt_lat"), header.index("shape_pt_lon")
        for row in reader:
            if row[sid] in wanted:
                found.setdefault(row[sid], []).append(
                    (int(row[seq]), float(row[lon]), float(row[lat]))
                )
    out = {}
    for key, rows in found.items():
        rows.sort()
        out[key] = np.array([[x, y] for _, x, y in rows], dtype=float)
    return out


def extract_pfaedle(
    patterns: Sequence[Pattern],
    feed_dir: Path,
    alternate_dir: Path | None = None,
    stations_xy: np.ndarray | None = None,
) -> tuple[dict[str, np.ndarray | None], dict]:
    """pfaedle shapes of the representative trips; a pattern without one maps to None. With an
    alternate run (strict turns), legs that turn back away from stops come from it
    (``splice.splice_turn_legs``); the summary's ``splice`` names them per pattern."""
    shape_of = pfaedle_shape_ids(feed_dir / "trips.txt", (p.rep_trip for p in patterns))
    points = read_shape_points(feed_dir / "shapes.txt", set(shape_of.values()))
    shapes = {p.pattern_id: points.get(shape_of.get(p.rep_trip, "")) for p in patterns}
    summary: dict = {
        "patterns": len(patterns),
        "with_shape": sum(1 for v in shapes.values() if v is not None and len(v) >= 2),
        "distinct_shapes": len(points),
    }
    if alternate_dir is not None:
        from gerlines_rail_graph.splice import (  # noqa: PLC0415
            candidates_to_splice,
            read_trip_shapes,
            splice_turn_legs,
        )

        faulty = candidates_to_splice(patterns, shapes, stations_xy)
        trips = {p.rep_trip for p in faulty}
        shapes, spliced, counts = splice_turn_legs(
            faulty,
            shapes,
            read_trip_shapes(feed_dir, trips),
            read_trip_shapes(alternate_dir, trips),
            stations_xy,
        )
        summary["splice"] = {**counts, "spliced": spliced}
    return shapes, summary
