"""Evaluation of every pattern's candidate shapes, in chunks across worker processes.

Each chunk is written to its own JSON lines file when it finishes, so an interrupted run resumes
with the chunks that are missing. A worker builds the rail index once and keeps a rail-length
cache per stop pair for the chunks it handles.
"""

import json
import time
from collections.abc import Sequence
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from gerlines_rail_graph.patterns import Pattern
from gerlines_rail_graph.store import ShapeStore

METHODS = ("motis", "pfaedle")


@dataclass(frozen=True, slots=True)
class EvalConfig:
    work: Path
    osm: Path
    outline: Path
    chunk_size: int = 250
    eval_name: str = "eval"
    coverage: Path | None = None

    @property
    def eval_dir(self) -> Path:
        return self.work / self.eval_name


_STATE: dict = {}


LEG_SEPARATOR = "\x1f"


def _init(config: EvalConfig, *, with_shapes: bool = True) -> None:
    from gerlines_rail_graph.index import load_rail_index  # noqa: PLC0415
    from gerlines_rail_graph.reversals import reversal_points  # noqa: PLC0415

    index, _ = load_rail_index(config.osm, config.outline, config.coverage)
    graph = index.graph.with_stations(reversal_points())
    _STATE["index"] = replace(index, graph=graph)
    _STATE["stations"] = reversal_points()
    if with_shapes:
        _STATE["stores"] = {m: ShapeStore.load(config.work / "candidates" / m) for m in METHODS}
        legs_file = config.eval_dir / "legs.json"
        cached = json.loads(legs_file.read_text()) if legs_file.exists() else {}
        _STATE["legs"] = {tuple(k.split(LEG_SEPARATOR)): v for k, v in cached.items()}


def _init_legs(config: EvalConfig) -> None:
    _init(config, with_shapes=False)


def stop_pairs(patterns: Sequence[Pattern]) -> dict[tuple[str, str], tuple]:
    """Each distinct consecutive stop pair with the two stop positions in EPSG:25832."""
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415

    pairs: dict[tuple[str, str], tuple] = {}
    for pattern in patterns:
        lonlat = pattern.stop_lonlat()
        xy = to_xy(lonlat[:, 0], lonlat[:, 1])
        keys = [s[0] for s in pattern.stops]
        for j in range(len(keys) - 1):
            pairs.setdefault((keys[j], keys[j + 1]), (tuple(xy[j]), tuple(xy[j + 1])))
    return pairs


def _legs_chunk(items: list[tuple[tuple[str, str], tuple]]) -> dict[str, list]:
    from gerlines_rail_graph.evaluate import reference_lengths  # noqa: PLC0415

    graph = _STATE["index"].graph
    return {
        LEG_SEPARATOR.join(key): list(reference_lengths(graph, np.array(a), np.array(b)))
        for key, (a, b) in items
    }


def compute_legs(config: EvalConfig, patterns: Sequence[Pattern], workers: int, log=print) -> dict:
    """Strict and lower-bound rail path lengths of every distinct stop pair, once, into
    ``eval/legs.json``."""
    out = config.eval_dir / "legs.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    pairs = sorted(stop_pairs(patterns).items())
    size = max(1, len(pairs) // (workers * 8) + 1)
    batches = [pairs[i : i + size] for i in range(0, len(pairs), size)]
    found: dict[str, list] = {}
    begun = time.time()
    with ProcessPoolExecutor(max(1, workers), initializer=_init_legs, initargs=(config,)) as pool:
        for k, result in enumerate(pool.map(_legs_chunk, batches), start=1):
            found.update(result)
            log(json.dumps({"legs_batches": k, "of": len(batches)}))
    partial = out.with_name(out.name + ".partial")
    partial.write_text(json.dumps(found))
    partial.replace(out)
    return {
        "stop_pairs": len(found),
        "without_rail_path": sum(v[0] is None and v[1] is None for v in found.values()),
        "without_strict_path": sum(v[0] is None for v in found.values()),
        "wall_s": round(time.time() - begun, 1),
    }


def evaluate_pattern(
    pattern: Pattern, shapes: dict, index, leg_cache: dict, stations: np.ndarray | None = None
) -> dict:
    """Per method, the gate row of one pattern (see ``evaluate.as_row``), measured on the
    candidate without its spurs (``spurs.remove_spurs``, the same cut ``build`` makes)."""
    from gerlines_rail_graph.evaluate import as_row, evaluate_trip  # noqa: PLC0415
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415
    from gerlines_rail_graph.shape import clean  # noqa: PLC0415
    from gerlines_rail_graph.spurs import remove_spurs, spur_row  # noqa: PLC0415

    lonlat = pattern.stop_lonlat()
    stops_xy = to_xy(lonlat[:, 0], lonlat[:, 1])
    keys = [s[0] for s in pattern.stops]
    out = {}
    for method, raw in shapes.items():
        despurred = None
        shape_xy = None
        if raw is not None and len(raw) >= 2:
            despurred = remove_spurs(clean(to_xy(raw[:, 0], raw[:, 1])), stops_xy, stations)
            shape_xy = despurred.xy
        metrics = evaluate_trip(
            stops_xy,
            shape_xy,
            index,
            is_sbahn=pattern.category == "sbahn",
            legs=(leg_cache, keys),
        )
        out[method] = {**as_row(metrics), **spur_row(despurred)}
    return out


def _run_chunk(number: int, patterns: list[dict], out: Path) -> dict:
    begun = time.perf_counter()
    index = _STATE["index"]
    stores = _STATE["stores"]
    lines = []
    for data in patterns:
        pattern = Pattern.from_json(data)
        shapes = {m: stores[m].get(pattern.pattern_id) for m in METHODS}
        rows = evaluate_pattern(pattern, shapes, index, _STATE["legs"], _STATE["stations"])
        lines.append(json.dumps({"pattern_id": pattern.pattern_id, **rows}))
    partial = out.with_name(out.name + ".partial")
    partial.write_text("\n".join(lines) + "\n")
    partial.replace(out)
    return {"chunk": number, "patterns": len(patterns), "s": time.perf_counter() - begun}


def chunk_path(eval_dir: Path, number: int) -> Path:
    return eval_dir / f"chunk-{number:05d}.jsonl"


def evaluate_all(config: EvalConfig, patterns: Sequence[Pattern], workers: int, log=print) -> dict:
    """Evaluates the chunks without an output file; returns timing figures."""
    config.eval_dir.mkdir(parents=True, exist_ok=True)
    ordered = sorted(patterns, key=lambda p: (p.route_key, p.pattern_id))
    chunks = [ordered[i : i + config.chunk_size] for i in range(0, len(ordered), config.chunk_size)]
    todo = [n for n in range(len(chunks)) if not chunk_path(config.eval_dir, n).exists()]
    begun = time.time()
    done = []
    if workers <= 1:
        _init(config)
        for n in todo:
            done.append(
                _run_chunk(n, [p.as_json() for p in chunks[n]], chunk_path(config.eval_dir, n))
            )
            log(json.dumps(done[-1]))
    else:
        with ProcessPoolExecutor(workers, initializer=_init, initargs=(config,)) as pool:
            futures = [
                pool.submit(
                    _run_chunk, n, [p.as_json() for p in chunks[n]], chunk_path(config.eval_dir, n)
                )
                for n in todo
            ]
            for future in as_completed(futures):
                done.append(future.result())
                log(json.dumps({**done[-1], "finished": len(done), "of": len(todo)}))
    seconds = np.array([d["s"] / max(d["patterns"], 1) for d in done])
    return {
        "chunks": len(chunks),
        "chunks_run": len(todo),
        "patterns_run": sum(d["patterns"] for d in done),
        "wall_s": round(time.time() - begun, 1),
        "s_per_pattern_p50": round(float(np.median(seconds)), 3) if seconds.size else None,
    }


def read_rows(eval_dir: Path) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    for path in sorted(eval_dir.glob("chunk-*.jsonl")):
        for line in path.read_text().splitlines():
            if line:
                row = json.loads(line)
                rows[row.pop("pattern_id")] = row
    return rows
