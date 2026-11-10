import errno
import itertools
import json
from concurrent.futures import Future
from pathlib import Path

import numpy as np
import pytest

from gerlines_rail_graph import build
from gerlines_rail_graph.build import BuildConfig, _in_order, build_all, build_one
from gerlines_rail_graph.osm import RailWays
from gerlines_rail_graph.patterns import Pattern
from gerlines_rail_graph.project import to_xy
from gerlines_rail_graph.spurs import SPUR_VERSION
from gerlines_rail_graph.store import PARTS, ShapeStore
from gerlines_rail_graph.structures import STRUCTURES_FILE

TRACK_LATS = (50.000, 50.020)
BRIDGE_LON = (9.030, 9.036)


def track_lonlat(lat: float) -> np.ndarray:
    lon = np.round(np.arange(9.000, 9.0601, 0.002), 6)
    return np.column_stack([lon, np.full(len(lon), lat)])


def write_osm(osm: Path) -> None:
    osm.mkdir()
    pieces, way_ids, node_ids = [], [], []
    next_node = 1
    for track, lat in enumerate(TRACK_LATS):
        lonlat = track_lonlat(lat)
        lon = lonlat[:, 0]
        cuts = [
            0,
            int(np.searchsorted(lon, BRIDGE_LON[0])),
            int(np.searchsorted(lon, BRIDGE_LON[1])),
        ]
        cuts.append(len(lon) - 1)
        nodes = np.arange(next_node, next_node + len(lon))
        next_node += len(lon)
        for part, (a, b) in enumerate(itertools.pairwise(cuts)):
            pieces.append(lonlat[a : b + 1])
            node_ids.append(nodes[a : b + 1])
            way_ids.append(100 * (track + 1) + part)
    offsets = np.zeros(len(pieces) + 1, dtype=np.int64)
    offsets[1:] = np.cumsum([len(p) for p in pieces])
    lonlat = np.concatenate(pieces)
    RailWays(
        way_ids=np.array(way_ids, dtype=np.int64),
        railway=np.array(["rail"] * len(pieces)),
        service=np.array([""] * len(pieces)),
        offsets=offsets,
        node_ids=np.concatenate(node_ids).astype(np.int64),
        xy=to_xy(lonlat[:, 0], lonlat[:, 1]),
    ).save(osm / "ways.npz")
    ids = np.array(way_ids, dtype=np.int64)
    np.savez_compressed(osm / "way_kinds.npz", way_ids=ids, bits=np.full(len(ids), 2))
    bridge = np.array([w % 100 == 1 for w in way_ids])
    np.savez_compressed(
        osm / STRUCTURES_FILE, way_ids=ids, bridge=bridge, tunnel=np.zeros(len(ids), dtype=bool)
    )


def write_outline(path: Path) -> None:
    ring = [[8.0, 49.0], [10.0, 49.0], [10.0, 51.0], [8.0, 51.0], [8.0, 49.0]]
    feature = {
        "type": "Feature",
        "properties": {},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [feature]}))


def pattern(number: int, lat: float, first: int, last: int) -> Pattern:
    lonlat = track_lonlat(lat)
    stops = [(f"s{number}-{j}", f"Stop {j}", *map(float, lonlat[j])) for j in (first, last)]
    return Pattern(
        pattern_id=f"p{number:02d}",
        route_key=f"route-{20 - number:02d}",
        route_short_name=f"RB{number}",
        category="regional",
        direction_id=number % 2,
        stops=stops,
        rep_trip=f"trip-{number}",
        rep_date="2026-10-19",
        rep_departure_s=3600 * number,
        trips=1,
        trip_days_week=5,
        length_km=4.0,
    )


@pytest.fixture
def rail_work(tmp_path):
    work, osm, outline = tmp_path / "work", tmp_path / "osm", tmp_path / "outline.geojson"
    write_osm(osm)
    write_outline(outline)
    spans = [(0, 30), (2, 25), (5, 30), (0, 14), (10, 28), (1, 29), (3, 20), (0, 30)]
    outcomes = [
        "motis",
        "pfaedle",
        "motis",
        "unmeasured",
        "pfaedle",
        "motis",
        "low_quality",
        "pfaedle",
    ]
    patterns = [pattern(n, TRACK_LATS[n % 2], first, last) for n, (first, last) in enumerate(spans)]
    candidates: dict[str, dict] = {"motis": {}, "pfaedle": {}}
    for p, (first, last) in zip(patterns, spans, strict=True):
        line = track_lonlat(p.stop_lonlat()[0, 1])[first : last + 1]
        candidates["motis"][p.pattern_id] = line
        candidates["pfaedle"][p.pattern_id] = line + np.array([0.0, 0.00002])
    for method, shapes in candidates.items():
        ShapeStore.from_mapping(shapes).save(work / "candidates" / method)
    choice = {p.pattern_id: {"outcome": o} for p, o in zip(patterns, outcomes, strict=True)}
    return BuildConfig(work, osm, outline), patterns, choice


def reference(config: BuildConfig, patterns, choice, out: Path) -> None:
    build._init(config)
    geometry, metas = {}, []
    for p in patterns:
        built = build_one(
            p,
            choice[p.pattern_id],
            build._STATE["stores"],
            build._STATE["structures"],
            build._STATE["stations"],
        )
        mark = built.essential if built.essential is not None else np.ones(len(built.m))
        geometry[p.pattern_id] = np.column_stack([built.lonlat, built.m, mark])
        metas.append(
            {
                "pattern_id": p.pattern_id,
                "method": built.method,
                "qa_status": built.qa_status,
                "stop_arc_m": built.stop_arc_m,
                "tunnel_spans": [list(s) for s in built.tunnel_spans],
                "bridge_spans": [list(s) for s in built.bridge_spans],
                "bake_ranges": [list(r) for r in built.bake_ranges],
                "spurs": {**built.spurs, "version": SPUR_VERSION},
            }
        )
    ShapeStore.from_mapping(geometry, dims=4).save(out / "geometry")
    metas.sort(key=lambda m: m["pattern_id"])
    (out / "meta.jsonl").write_text("".join(json.dumps(m) + "\n" for m in metas))


def output_bytes(folder: Path) -> dict[str, bytes]:
    files = [folder / "geometry" / f"{name}.npy" for name in PARTS] + [folder / "meta.jsonl"]
    return {f.name: f.read_bytes() for f in files}


@pytest.mark.parametrize(("workers", "chunk_size"), [(2, 3), (1, 500)])
def test_build_all_writes_the_bytes_of_every_pattern_built_alone_in_key_order(
    rail_work, tmp_path, workers, chunk_size
):
    config, patterns, choice = rail_work
    reference(config, patterns, choice, tmp_path / "expected")

    summary = build_all(config, patterns, choice, workers, chunk_size=chunk_size)

    assert output_bytes(config.work / "build") == output_bytes(tmp_path / "expected")
    assert sorted(p.name for p in (config.work / "build").iterdir()) == ["geometry", "meta.jsonl"]
    geometry = ShapeStore.load(config.work / "build" / "geometry")
    metas = build.read_lines(config.work / "build" / "meta.jsonl")
    assert [str(k) for k in geometry.keys] == [m["pattern_id"] for m in metas]
    assert summary == {
        "shapes": len(patterns),
        "vertices": int(geometry.offsets[-1]),
        "with_tunnel": 0,
        "with_bridge": sum(bool(m["bridge_spans"]) for m in metas),
    }
    assert summary["with_bridge"] > 0
    assert {m["method"] for m in metas} == {"motis", "pfaedle", "straight"}


def test_a_full_disk_at_the_geometry_copy_keeps_the_old_build_whole(rail_work, monkeypatch):
    config, patterns, choice = rail_work
    build_all(config, patterns, choice, 1)
    before = output_bytes(config.work / "build")
    changed = {**choice, patterns[0].pattern_id: {"outcome": "unmeasured"}}

    def no_space(*_args, **_kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(np.lib.format, "write_array_header_1_0", no_space)
    with pytest.raises(OSError, match="No space"):
        build_all(config, patterns, changed, 1)

    assert output_bytes(config.work / "build") == before
    assert sorted(p.name for p in (config.work / "build").iterdir()) == ["geometry", "meta.jsonl"]


def test_build_all_refuses_duplicate_ids_and_missing_choices_before_any_work(rail_work):
    config, patterns, choice = rail_work
    missing = {k: v for k, v in choice.items() if k != patterns[2].pattern_id}

    with pytest.raises(ValueError, match="1 duplicate pattern id"):
        build_all(config, [*patterns, patterns[3]], choice, 2)
    with pytest.raises(ValueError, match="1 pattern without a choice"):
        build_all(config, patterns, missing, 2)

    assert not (config.work / "build").exists()


class CountingPool:
    def __init__(self) -> None:
        self.unread = 0
        self.most_unread = 0

    def submit(self, task, batch):
        future = Future()
        future.set_result(task(batch))
        self.unread += 1
        self.most_unread = max(self.most_unread, self.unread)
        return future


def test_in_order_keeps_at_most_ahead_batches_unread_and_keeps_their_order():
    pool = CountingPool()
    seen = []
    for result in _in_order(pool, lambda batch: batch * 10, iter(range(9)), ahead=3):
        pool.unread -= 1
        seen.append(result)

    assert seen == [n * 10 for n in range(9)]
    assert pool.most_unread == 3
