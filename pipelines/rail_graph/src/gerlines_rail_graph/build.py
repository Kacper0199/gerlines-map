"""Final shapes of every pattern: geometry in worker processes, then elevation and hashing.

``build_all`` writes ``build/geometry`` (lon, lat, m per vertex) and ``build/meta.jsonl``;
``finish_all`` adds Z from the DEM, bakes bridges and tunnels, hashes, and writes
``final/shapes`` (lon, lat, z, m) and ``final/meta.jsonl``. One meta line per pattern.
Both stream: ``build_all`` hands patterns to the workers in key order and writes each chunk as it
comes back, ``finish_all`` reads the geometry and the metas a chunk of shapes at a time, so the
parent's memory stays bounded by a few chunks, not the country.
"""

import itertools
import json
import os
from collections import deque
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from gerlines_rail_graph.choose import FALLBACKS
from gerlines_rail_graph.patterns import Pattern
from gerlines_rail_graph.shape import (
    BuiltShape,
    bake_z,
    build_geometry,
    content_hash,
    outside_positions,
    rounded,
    thin_profile,
)
from gerlines_rail_graph.spurs import SPUR_VERSION
from gerlines_rail_graph.store import ShapeStore, ShapeStoreWriter, read_index, read_rows

STRAIGHT = "straight"
OSM_NOTE = "© OpenStreetMap contributors, ODbL 1.0; matched by {method}"
STRAIGHT_NOTE = "straight lines between DELFI stop positions (CC BY 4.0), no track shape passed QA"
CHUNK_VERTICES = 4_000_000


@dataclass(frozen=True, slots=True)
class BuildConfig:
    work: Path
    osm: Path
    outline: Path


_STATE: dict = {}


def _init(config: BuildConfig) -> None:
    from gerlines_rail_graph.index import load_rail_index  # noqa: PLC0415
    from gerlines_rail_graph.reversals import reversal_points  # noqa: PLC0415
    from gerlines_rail_graph.structures import StructureIndex  # noqa: PLC0415

    index, _ = load_rail_index(config.osm, config.outline)
    _STATE["structures"] = StructureIndex.load(index, config.osm)
    _STATE["stores"] = {
        m: ShapeStore.load(config.work / "candidates" / m) for m in ("motis", "pfaedle")
    }
    _STATE["stations"] = reversal_points()


def build_one(
    pattern: Pattern,
    choice: Mapping,
    stores: Mapping[str, ShapeStore],
    structures,
    stations: np.ndarray | None = None,
) -> BuiltShape:
    outcome = choice["outcome"]
    if outcome in FALLBACKS:
        return build_geometry(None, pattern.stop_lonlat(), STRAIGHT, outcome)
    lonlat = stores[outcome].get(pattern.pattern_id)
    spans = structures.spans if structures is not None else None
    return build_geometry(
        lonlat, pattern.stop_lonlat(), outcome, "pass", spans, stations_xy=stations
    )


def _build_chunk(items: list[tuple[dict, dict]]) -> list[tuple[str, np.ndarray, str]]:
    out = []
    for data, choice in items:
        pattern = Pattern.from_json(data)
        built = build_one(
            pattern, choice, _STATE["stores"], _STATE["structures"], _STATE.get("stations")
        )
        meta = {
            "pattern_id": pattern.pattern_id,
            "method": built.method,
            "qa_status": built.qa_status,
            "stop_arc_m": built.stop_arc_m,
            "tunnel_spans": [list(s) for s in built.tunnel_spans],
            "bridge_spans": [list(s) for s in built.bridge_spans],
            "bake_ranges": [list(r) for r in built.bake_ranges],
            "spurs": {**built.spurs, "version": SPUR_VERSION},
        }
        mark = built.essential if built.essential is not None else np.ones(len(built.m))
        coords = np.column_stack([built.lonlat, built.m, mark])
        out.append((pattern.pattern_id, coords, json.dumps(meta) + "\n"))
    return out


def _in_order(pool: ProcessPoolExecutor, task: Callable, batches: Iterable, ahead: int) -> Iterator:
    """Results of ``task`` per batch in submission order, with at most ``ahead`` batches
    submitted and not yet consumed."""
    pending: deque[Future] = deque()
    for batch in batches:
        pending.append(pool.submit(task, batch))
        if len(pending) >= ahead:
            yield pending.popleft().result()
    while pending:
        yield pending.popleft().result()


def build_all(
    config: BuildConfig,
    patterns: Sequence[Pattern],
    choice: Mapping[str, Mapping],
    workers: int,
    chunk_size: int = 500,
) -> dict:
    """Builds every pattern in worker processes and writes ``build/geometry`` and
    ``build/meta.jsonl`` in pattern id order, one chunk at a time as the workers return them."""
    ordered = sorted(patterns, key=lambda p: p.pattern_id)
    _check_ids(ordered, choice)
    batches = (
        [(p.as_json(), choice[p.pattern_id]) for p in ordered[i : i + chunk_size]]
        for i in range(0, len(ordered), chunk_size)
    )
    out = config.work / "build"
    workers = max(1, workers)
    summary = {"shapes": 0, "vertices": 0, "with_tunnel": 0, "with_bridge": 0}
    with (
        ProcessPoolExecutor(workers, initializer=_init, initargs=(config,)) as pool,
        _LineWriter(out / "meta.jsonl") as lines,
        ShapeStoreWriter(out / "geometry", dims=4) as writer,
    ):
        for result in _in_order(pool, _build_chunk, batches, ahead=2 * workers):
            for pattern_id, coords, line in result:
                if len(coords) >= 2:
                    writer.add(pattern_id, coords)
                lines.write(line)
                meta = json.loads(line)
                summary["shapes"] += 1
                summary["vertices"] += len(coords)
                summary["with_tunnel"] += bool(meta["tunnel_spans"])
                summary["with_bridge"] += bool(meta["bridge_spans"])
    return summary


def _check_ids(ordered: Sequence[Pattern], choice: Mapping[str, Mapping]) -> None:
    """Refuses duplicate pattern ids and patterns without a choice before any worker starts."""
    ids = [p.pattern_id for p in ordered]
    duplicates = sum(a == b for a, b in itertools.pairwise(ids))
    missing = sum(i not in choice for i in ids)
    problems = []
    if duplicates:
        problems.append(f"{duplicates} duplicate pattern id{'s' * (duplicates > 1)}")
    if missing:
        problems.append(f"{missing} pattern{'s' * (missing > 1)} without a choice")
    if problems:
        msg = f"build refused: {', '.join(problems)}"
        raise ValueError(msg)


class _LineWriter:
    """A text file written line by line to a ``.partial`` sibling, synced and renamed into place
    only when the block finishes without an error; an error inside the block stays the one
    raised, and the partial file is removed either way."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.partial = path.with_name(path.name + ".partial")

    def __enter__(self) -> "_LineWriter":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self.partial.open("w")
        return self

    def write(self, line: str) -> None:
        self._file.write(line)

    def __exit__(self, kind, error, trace) -> None:
        try:
            if kind is None:
                self._file.flush()
                os.fsync(self._file.fileno())
            self._file.close()
        except OSError:
            self.partial.unlink(missing_ok=True)
            if kind is None:
                raise
            return
        if kind is None:
            self.partial.replace(self.path)
        else:
            self.partial.unlink(missing_ok=True)


def read_lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def chunks(offsets: np.ndarray, budget: int) -> Iterator[tuple[int, int]]:
    """Consecutive shape index ranges of at most ``budget`` vertices (at least one shape)."""
    count = len(offsets) - 1
    first = 0
    while first < count:
        last = int(np.searchsorted(offsets, offsets[first] + budget, side="right")) - 1
        last = min(max(last, first + 1), count)
        yield first, last
        first = last


def _outside_lonlat(lonlat: np.ndarray, m: np.ndarray, meta: Mapping) -> tuple[list, list, list]:
    """The bake ranges of a shape and the (lon, lat) of its terrain samples beyond each end."""
    ranges = [tuple(r) for r in meta.get("bake_ranges", [])]
    spans = [tuple(s) for s in meta["tunnel_spans"] + meta["bridge_spans"]]
    before, after = outside_positions(ranges, spans, float(m[-1]))

    sides = [*before, *after]
    if not sides:
        return ranges, [], []
    flat = np.concatenate(sides)
    points = np.column_stack([np.interp(flat, m, lonlat[:, 0]), np.interp(flat, m, lonlat[:, 1])])
    parts = np.split(points, np.cumsum([len(p) for p in sides])[:-1])
    return ranges, parts[: len(before)], parts[len(before) :]


class _Metas:
    """The metas of ``meta.jsonl`` by pattern id, parsed only for the chunk asked for."""

    def __init__(self, path: Path) -> None:
        self._file = path.open("rb")
        self._at: dict[str, int] = {}
        position = 0
        for line in self._file:
            if line.strip():
                self._at[json.loads(line)["pattern_id"]] = position
            position += len(line)

    def __enter__(self) -> "_Metas":
        return self

    def __exit__(self, kind, error, trace) -> None:
        self._file.close()

    def take(self, keys: Iterable[str]) -> dict[str, dict]:
        found = {}
        for key in keys:
            self._file.seek(self._at[key])
            found[key] = json.loads(self._file.readline())
        return found


def _chunk_points(geometry: Path, offsets: np.ndarray, metas: Sequence[Mapping]) -> tuple:
    """Every vertex and terrain sample of the shapes between ``offsets`` as one (lon, lat)
    array, with the vertex block and each shape's ranges and samples."""
    block = read_rows(geometry, int(offsets[0]), int(offsets[-1]))
    extra, per_shape = [], []
    for i, meta in enumerate(metas):
        lo, hi = int(offsets[i] - offsets[0]), int(offsets[i + 1] - offsets[0])
        found = _outside_lonlat(block[lo:hi, :2], block[lo:hi, 2], meta)
        per_shape.append(found)
        extra += [*found[1], *found[2]]
    points = np.vstack([block[:, :2], *extra]) if extra else block[:, :2]
    return block, points, per_shape


def _chunked(work: Path, chunk_vertices: int) -> Iterator[tuple]:
    """Per chunk of ``build/geometry``: its keys, its offsets, its build metas and the output of
    ``_chunk_points``."""
    path = work / "build" / "geometry"
    keys, offsets = read_index(path)
    with _Metas(work / "build" / "meta.jsonl") as metas:
        for first, last in chunks(offsets, chunk_vertices):
            names = [str(k) for k in keys[first:last]]
            found = metas.take(names)
            part = offsets[first : last + 1]
            ordered = [found[k] for k in names]
            yield names, part, ordered, _chunk_points(path, part, ordered)


def dem_points(work: Path, chunk_vertices: int = CHUNK_VERTICES) -> Iterator[np.ndarray]:
    """The (lon, lat) of every point ``finish_all`` samples, chunk by chunk."""
    for *_, (_, points, _) in _chunked(work, chunk_vertices):
        yield points


def finish_all(
    work: Path,
    heights: Callable[[np.ndarray], np.ndarray],
    chunk_vertices: int = CHUNK_VERTICES,
) -> dict:
    """Z, baked ranges and the content hash per shape; ``heights(lonlat) -> z`` samples the DEM.

    Shapes and their metas are read and finished ``chunk_vertices`` at a time: one DEM call per
    chunk for its vertices and the terrain samples beyond each bake range, then the finished
    shapes and metas are streamed to ``final/shapes`` and ``final/meta.jsonl``.
    """
    hashes: set[str] = set()
    finite = True
    used = 0
    with (
        _LineWriter(work / "final" / "meta.jsonl") as lines,
        ShapeStoreWriter(work / "final" / "shapes", dims=4) as writer,
    ):
        for names, offsets, metas, (block, points, per_shape) in _chunked(work, chunk_vertices):
            used += 1
            z_points = heights(points)
            finite &= bool(np.isfinite(z_points).all())
            z_block, z_extra = z_points[: len(block)], z_points[len(block) :]
            taken = 0
            for i, (ranges, before, after) in enumerate(per_shape):
                lo, hi = int(offsets[i] - offsets[0]), int(offsets[i + 1] - offsets[0])
                low, high = [], []
                for side, store in ((before, low), (after, high)):
                    for pts in side:
                        store.append(z_extra[taken : taken + len(pts)])
                        taken += len(pts)
                coords, meta = _finish_shape(
                    block[lo:hi], z_block[lo:hi], metas[i], ranges, low, high
                )
                writer.add(names[i], coords)
                lines.write(json.dumps(meta) + "\n")
                hashes.add(meta["shape_hash"])
    return {
        "shapes": len(writer.keys),
        "distinct_hashes": len(hashes),
        "z_finite": finite,
        "chunks": used,
    }


def _finish_shape(  # noqa: PLR0913, PLR0917
    rows: np.ndarray,
    z: np.ndarray,
    meta: Mapping,
    ranges: Sequence,
    before: Sequence[np.ndarray] = (),
    after: Sequence[np.ndarray] = (),
) -> tuple[np.ndarray, dict]:
    lonlat, m = rows[:, :2], rows[:, 2]
    z = bake_z(m, z, ranges, before, after)
    keep = thin_profile(m, z, rows[:, 3] > 0)
    lonlat, m, z = lonlat[keep], m[keep], z[keep]
    coords = rounded(lonlat, z, m)
    built = BuiltShape(
        lonlat=lonlat,
        m=m,
        stop_arc_m=meta["stop_arc_m"],
        method=meta["method"],
        qa_status=meta["qa_status"],
        tunnel_spans=[tuple(s) for s in meta["tunnel_spans"]],
        bridge_spans=[tuple(s) for s in meta["bridge_spans"]],
    )
    return coords, {
        **meta,
        "shape_hash": content_hash(coords, built),
        "length_m": float(coords[-1, 3]),
        "z_min": float(z.min()),
        "z_max": float(z.max()),
    }


def source_note(method: str) -> str:
    return STRAIGHT_NOTE if method == STRAIGHT else OSM_NOTE.format(method=method)
