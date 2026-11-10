import errno
import os

import numpy as np
import pytest

from gerlines_rail_graph.store import PARTS, ShapeStore, ShapeStoreWriter, read_index, read_rows


def no_space(*_args, **_kwargs):
    raise OSError(errno.ENOSPC, "No space left on device")


def test_the_writer_streams_shapes_into_a_store_read_back_memory_mapped(tmp_path):
    shapes = {
        "a": np.arange(8.0).reshape(-1, 4),
        "b": np.arange(12.0).reshape(-1, 4) + 100,
        "c": np.arange(16.0).reshape(-1, 4) - 5,
    }
    path = tmp_path / "final" / "shapes"

    with ShapeStoreWriter(path, dims=4, block_rows=3) as writer:
        for key, coords in shapes.items():
            writer.add(key, coords)

    store = ShapeStore.load(path)
    assert isinstance(store.coords, np.memmap)
    assert store.keys.tolist() == ["a", "b", "c"]
    for key, coords in shapes.items():
        assert store.get(key).tolist() == coords.tolist()
    assert sorted(p.name for p in path.parent.iterdir()) == ["shapes"]


def test_the_writer_refuses_keys_out_of_order_and_keeps_the_old_store(tmp_path):
    path = tmp_path / "shapes"
    ShapeStore.from_mapping({"z": np.zeros((2, 4))}, dims=4).save(path)

    def write_out_of_order() -> None:
        with ShapeStoreWriter(path, dims=4) as writer:
            writer.add("b", np.zeros((2, 4)))
            writer.add("a", np.zeros((2, 4)))

    with pytest.raises(ValueError, match="sorted"):
        write_out_of_order()

    assert ShapeStore.load(path).keys.tolist() == ["z"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["shapes"]


@pytest.mark.parametrize("rows", [(), (3, 2, 7), (2, 9)])
def test_the_writer_writes_the_bytes_a_saved_store_has(tmp_path, rows):
    shapes = {
        f"k{i}": np.random.default_rng(i).normal(size=(n, 4)) * 1e3 for i, n in enumerate(rows)
    }
    ShapeStore.from_mapping(shapes, dims=4).save(tmp_path / "saved")

    with ShapeStoreWriter(tmp_path / "written", dims=4, block_rows=2) as writer:
        for key, coords in shapes.items():
            writer.add(key, coords)

    for name in PARTS:
        saved = (tmp_path / "saved" / f"{name}.npy").read_bytes()
        assert (tmp_path / "written" / f"{name}.npy").read_bytes() == saved


def test_rows_and_index_are_read_without_the_whole_store(tmp_path):
    shapes = {"a": np.arange(8.0).reshape(-1, 4), "b": np.arange(12.0).reshape(-1, 4) + 100}
    ShapeStore.from_mapping(shapes, dims=4).save(tmp_path / "s")

    keys, offsets = read_index(tmp_path / "s")
    rows = read_rows(tmp_path / "s", 1, 4)

    assert keys.tolist() == ["a", "b"]
    assert offsets.tolist() == [0, 2, 5]
    assert type(rows) is np.ndarray
    assert rows.tolist() == np.vstack([shapes["a"], shapes["b"]])[1:4].tolist()
    assert read_rows(tmp_path / "s", 2, 2).shape == (0, 4)
    with pytest.raises(ValueError, match="rows 4 to 9"):
        read_rows(tmp_path / "s", 4, 9)


def test_rows_of_a_truncated_coords_file_raise_rather_than_come_back_short(tmp_path):
    ShapeStore.from_mapping({"a": np.arange(40.0).reshape(-1, 4)}, dims=4).save(tmp_path / "t")
    coords = tmp_path / "t" / "coords.npy"
    coords.write_bytes(coords.read_bytes()[:-64])

    assert read_rows(tmp_path / "t", 0, 7).shape == (7, 4)
    with pytest.raises(ValueError, match="short"):
        read_rows(tmp_path / "t", 0, 10)


def test_a_failed_close_of_the_writer_keeps_the_old_store_and_no_partial_folder(
    tmp_path, monkeypatch
):
    path = tmp_path / "shapes"
    ShapeStore.from_mapping({"a": np.zeros((2, 4))}, dims=4).save(path)
    monkeypatch.setattr(np.lib.format, "write_array_header_1_0", no_space)

    with pytest.raises(OSError, match="No space"), ShapeStoreWriter(path, dims=4) as writer:
        writer.add("b", np.ones((3, 4)))

    assert ShapeStore.load(path).keys.tolist() == ["a"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["shapes"]


def test_the_writer_syncs_every_file_before_it_swaps_the_store_in(tmp_path, monkeypatch):
    synced = []
    real_fsync = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: synced.append(fd) or real_fsync(fd))

    with ShapeStoreWriter(tmp_path / "shapes", dims=4) as writer:
        writer.add("a", np.ones((3, 4)))

    assert len(synced) == len(PARTS)
