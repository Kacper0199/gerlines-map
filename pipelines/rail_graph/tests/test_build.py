import errno
import json

import numpy as np
import pytest

from gerlines_rail_graph import build
from gerlines_rail_graph.build import dem_points, finish_all, read_lines
from gerlines_rail_graph.project import geodesic_arc
from gerlines_rail_graph.shape import max_grade
from gerlines_rail_graph.store import ShapeStore


def line(lat: float, count: int) -> np.ndarray:
    lon = np.linspace(9.0, 9.0 + 0.0001 * (count - 1), count)
    lonlat = np.column_stack([lon, np.full(count, lat)])
    return np.column_stack([lonlat, geodesic_arc(lonlat), np.ones(count)])


def valley_heights(lonlat: np.ndarray) -> np.ndarray:
    """100 m terrain with a 20 m deep valley around lon 9.0040 (a bridge site)."""
    distance = np.abs(lonlat[:, 0] - 9.0040) * 67_000
    return 100.0 - 20.0 * np.clip((40.0 - distance) / 20.0, 0.0, 1.0)


@pytest.fixture
def work(tmp_path):
    shapes = {"p1": line(50.0, 90), "p2": line(50.1, 60), "p3": line(50.2, 2)}
    m1 = shapes["p1"][:, 2]
    bridge = [float(np.interp(9.0037, shapes["p1"][:, 0], m1)), 0.0]
    bridge[1] = float(np.interp(9.0043, shapes["p1"][:, 0], m1))
    metas = [
        {
            "pattern_id": "p1",
            "method": "motis",
            "qa_status": "pass",
            "stop_arc_m": [0.0, float(m1[-1])],
            "tunnel_spans": [],
            "bridge_spans": [bridge],
            "bake_ranges": [[bridge[0] - 25.0, bridge[1] + 25.0, bridge[0], bridge[1]]],
        },
        {
            "pattern_id": "p2",
            "method": "pfaedle",
            "qa_status": "pass",
            "stop_arc_m": [0.0, float(shapes["p2"][-1, 2])],
            "tunnel_spans": [],
            "bridge_spans": [],
            "bake_ranges": [],
        },
        {
            "pattern_id": "p3",
            "method": "straight",
            "qa_status": "unmeasured",
            "stop_arc_m": [0.0, float(shapes["p3"][-1, 2])],
            "tunnel_spans": [],
            "bridge_spans": [],
            "bake_ranges": [],
        },
    ]
    ShapeStore.from_mapping(shapes, dims=4).save(tmp_path / "build" / "geometry")
    (tmp_path / "build" / "meta.jsonl").write_text("".join(json.dumps(m) + "\n" for m in metas))
    return tmp_path


def test_finish_bakes_hashes_and_writes_every_shape_whatever_the_chunk_size(work):
    small = finish_all(work, valley_heights, chunk_vertices=50)
    small_shapes = ShapeStore.load(work / "final" / "shapes")
    small_meta = read_lines(work / "final" / "meta.jsonl")
    small_coords = {k: v.copy() for k, v in small_shapes.items()}

    large = finish_all(work, valley_heights, chunk_vertices=10_000)

    assert small == {"shapes": 3, "distinct_hashes": 3, "z_finite": True, "chunks": 3}
    assert large == {**small, "chunks": 1}
    final = ShapeStore.load(work / "final" / "shapes")
    assert read_lines(work / "final" / "meta.jsonl") == small_meta
    for key, coords in final.items():
        assert coords.tolist() == small_coords[key].tolist()
    p1 = final.get("p1")
    assert max_grade(p1[:, 3], p1[:, 2]) <= 0.060
    assert p1[:, 2].min() == 100.0
    assert [m["pattern_id"] for m in small_meta] == ["p1", "p2", "p3"]
    assert all(m["shape_hash"] and m["length_m"] > 0 for m in small_meta)


def test_dem_points_cover_vertices_and_the_samples_beyond_each_bake_range(work):
    points = np.vstack(list(dem_points(work, chunk_vertices=50)))

    assert len(points) == 90 + 60 + 2 + 10
    assert np.isfinite(points).all()


def test_finish_reads_the_build_metas_whatever_their_line_order(work, tmp_path):
    finish_all(work, valley_heights, chunk_vertices=50)
    expected = {
        name: (work / "final" / name).read_bytes() for name in ("meta.jsonl", "shapes/coords.npy")
    }
    meta_file = work / "build" / "meta.jsonl"
    lines = meta_file.read_text().splitlines(keepends=True)
    meta_file.write_text("".join(reversed(lines)) + "\n")

    finish_all(work, valley_heights, chunk_vertices=50)

    for name, data in expected.items():
        assert (work / "final" / name).read_bytes() == data
    assert sorted(p.name for p in (work / "final").iterdir()) == ["meta.jsonl", "shapes"]


def test_a_full_disk_at_the_shapes_copy_keeps_the_old_metas_beside_the_old_shapes(
    work, monkeypatch
):
    finish_all(work, valley_heights, chunk_vertices=50)
    before = {p: p.read_bytes() for p in (work / "final").rglob("*") if p.is_file()}

    def no_space(*_args, **_kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(np.lib.format, "write_array_header_1_0", no_space)
    with pytest.raises(OSError, match="No space"):
        finish_all(work, lambda lonlat: valley_heights(lonlat) + 7.0, chunk_vertices=50)

    assert {p: p.read_bytes() for p in (work / "final").rglob("*") if p.is_file()} == before
    assert sorted(p.name for p in (work / "final").iterdir()) == ["meta.jsonl", "shapes"]


class FailingClose:
    def __init__(self, file) -> None:
        self.file = file

    def write(self, text: str) -> None:
        self.file.write(text)

    def fileno(self) -> int:
        return self.file.fileno()

    def flush(self) -> None:
        self.file.flush()

    def close(self) -> None:
        self.file.close()
        raise OSError(errno.EIO, "close failed")


def test_a_failed_close_of_the_meta_file_raises_and_leaves_no_partial(tmp_path):
    lines = build._LineWriter(tmp_path / "meta.jsonl")

    def write_one() -> None:
        with lines:
            lines._file = FailingClose(lines._file)
            lines.write("{}\n")

    with pytest.raises(OSError, match="close failed"):
        write_one()

    assert list(tmp_path.iterdir()) == []


def test_the_meta_file_keeps_the_original_error_when_its_close_fails_too(tmp_path):
    lines = build._LineWriter(tmp_path / "meta.jsonl")

    def fail_inside() -> None:
        with lines:
            lines._file = FailingClose(lines._file)
            raise KeyError("original")

    with pytest.raises(KeyError, match="original"):
        fail_inside()

    assert list(tmp_path.iterdir()) == []
