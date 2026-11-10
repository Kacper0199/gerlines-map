"""Compact on-disk store of many polylines keyed by id, memory-mapped when read.

A store is a folder of three ``.npy`` files: sorted ``keys``, ``offsets`` and the concatenated
``coords``; rows ``offsets[i]:offsets[i+1]`` belong to ``keys[i]``. Worker processes map the
files instead of copying them, so the operating system shares the pages between them.
"""

import os
import shutil
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType

import numpy as np

PARTS = ("keys", "offsets", "coords")


def _swap_in(partial: Path, path: Path) -> None:
    """Replaces ``path`` by the finished ``partial`` folder: a crash leaves one or the other."""
    old = path.with_name(path.name + ".old")
    if path.exists():
        path.replace(old)
    partial.replace(path)
    shutil.rmtree(old, ignore_errors=True)


@dataclass(frozen=True, slots=True)
class ShapeStore:
    keys: np.ndarray
    offsets: np.ndarray
    coords: np.ndarray

    @classmethod
    def from_mapping(
        cls, shapes: Mapping[str, Sequence[Sequence[float]] | np.ndarray | None], dims: int = 2
    ) -> "ShapeStore":
        kept = sorted(k for k, v in shapes.items() if v is not None and len(v) >= 2)
        arrays = [np.asarray(shapes[k], dtype=np.float64).reshape(-1, dims) for k in kept]
        offsets = np.zeros(len(arrays) + 1, dtype=np.int64)
        offsets[1:] = np.cumsum([len(a) for a in arrays])
        coords = np.concatenate(arrays) if arrays else np.zeros((0, dims))
        return cls(np.array(kept, dtype=str), offsets, coords)

    def __len__(self) -> int:
        return len(self.keys)

    def __contains__(self, key: str) -> bool:
        return self._index(key) is not None

    def _index(self, key: str) -> int | None:
        i = int(np.searchsorted(self.keys, key))
        return i if i < len(self.keys) and self.keys[i] == key else None

    def get(self, key: str) -> np.ndarray | None:
        i = self._index(key)
        if i is None:
            return None
        return np.asarray(self.coords[self.offsets[i] : self.offsets[i + 1]])

    def items(self) -> Iterator[tuple[str, np.ndarray]]:
        for i, key in enumerate(self.keys):
            yield str(key), np.asarray(self.coords[self.offsets[i] : self.offsets[i + 1]])

    def save(self, path: Path) -> None:
        """Writes the folder atomically: a crash leaves the old store or the new one."""
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        shutil.rmtree(partial, ignore_errors=True)
        partial.mkdir()
        for name in PARTS:
            np.save(partial / f"{name}.npy", getattr(self, name), allow_pickle=False)
        _swap_in(partial, path)

    @classmethod
    def load(cls, path: Path, *, mmap: bool = True) -> "ShapeStore":
        mode = "r" if mmap else None
        keys = np.load(path / "keys.npy", allow_pickle=False)
        offsets = np.load(path / "offsets.npy", allow_pickle=False)
        coords = np.load(path / "coords.npy", mmap_mode=mode, allow_pickle=False)
        return cls(keys, offsets, coords)


def read_index(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """The ``keys`` and ``offsets`` of the store at ``path``, without its coordinates."""
    return (
        np.load(path / "keys.npy", allow_pickle=False),
        np.load(path / "offsets.npy", allow_pickle=False),
    )


def read_rows(path: Path, start: int, stop: int) -> np.ndarray:
    """Rows ``start:stop`` of the store at ``path``, read from the file rather than mapped, so the
    rows read before do not stay resident in the process."""
    with (path / "coords.npy").open("rb") as file:
        version = np.lib.format.read_magic(file)
        read_header = (
            np.lib.format.read_array_header_1_0
            if version == (1, 0)
            else np.lib.format.read_array_header_2_0
        )
        shape, fortran_order, dtype = read_header(file)
        if fortran_order or len(shape) != 2:
            msg = f"{path / 'coords.npy'} is not a C-ordered table of rows"
            raise ValueError(msg)
        if not 0 <= start <= stop <= shape[0]:
            msg = f"rows {start} to {stop} are outside the {shape[0]} rows of {path}"
            raise ValueError(msg)
        file.seek(start * shape[1] * dtype.itemsize, 1)
        rows = np.fromfile(file, dtype=dtype, count=(stop - start) * shape[1])
    if len(rows) != (stop - start) * shape[1]:
        msg = f"{path / 'coords.npy'} is short: rows {start} to {stop} not all on disk"
        raise ValueError(msg)
    return rows.reshape(-1, shape[1])


def _save_synced(path: Path, array: np.ndarray) -> None:
    with path.open("wb") as file:
        np.save(file, array, allow_pickle=False)
        file.flush()
        os.fsync(file.fileno())


class ShapeStoreWriter:
    """Writes a store one shape at a time, in key order, without holding the coordinates:
    rows go to a raw file and are copied behind the ``coords.npy`` header in blocks when the
    writer closes, through file reads and writes rather than a mapping, so the copy stays out of
    the process's resident memory."""

    def __init__(self, path: Path, dims: int, block_rows: int = 1 << 20) -> None:
        self.path = path
        self.dims = dims
        self.block_rows = block_rows
        self.partial = path.with_name(path.name + ".partial")
        self.keys: list[str] = []
        self.offsets = [0]

    def __enter__(self) -> "ShapeStoreWriter":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.partial, ignore_errors=True)
        self.partial.mkdir()
        self._raw = (self.partial / "coords.raw").open("wb")
        return self

    def add(self, key: str, coords: np.ndarray) -> None:
        if self.keys and key <= self.keys[-1]:
            msg = f"keys must be added sorted and unique: {key!r} after {self.keys[-1]!r}"
            raise ValueError(msg)
        rows = np.ascontiguousarray(coords, dtype="<f8").reshape(-1, self.dims)
        self._raw.write(rows.tobytes())
        self.keys.append(key)
        self.offsets.append(self.offsets[-1] + len(rows))

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        trace: TracebackType | None,
    ) -> None:
        self._raw.close()
        if kind is not None:
            shutil.rmtree(self.partial, ignore_errors=True)
            return
        try:
            self._commit()
        except BaseException:
            shutil.rmtree(self.partial, ignore_errors=True)
            raise

    def _commit(self) -> None:
        raw = self.partial / "coords.raw"
        header = {"descr": "<f8", "fortran_order": False, "shape": (self.offsets[-1], self.dims)}
        block_bytes = self.block_rows * self.dims * 8
        with raw.open("rb") as source, (self.partial / "coords.npy").open("wb") as target:
            np.lib.format.write_array_header_1_0(target, header)
            while block := source.read(block_bytes):
                target.write(block)
            target.flush()
            os.fsync(target.fileno())
        raw.unlink()
        _save_synced(self.partial / "keys.npy", np.array(self.keys, dtype=str))
        _save_synced(self.partial / "offsets.npy", np.array(self.offsets, dtype=np.int64))
        _swap_in(self.partial, self.path)
