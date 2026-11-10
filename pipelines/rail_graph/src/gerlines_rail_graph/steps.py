"""Bookkeeping that makes each production step resumable and idempotent for one feed version.

A finished step leaves ``<work>/steps/<name>.json`` with a fingerprint of its inputs and
parameters; running it again with the same fingerprint does nothing unless forced.
"""

import hashlib
import json
import time
from collections.abc import Mapping
from pathlib import Path


def file_fingerprint(path: Path) -> dict:
    """Size and modification time of a file, or of every file in a folder (cheap, no hashing)."""
    if path.is_dir():
        return {
            str(p.relative_to(path)): file_fingerprint(p)
            for p in sorted(path.rglob("*"))
            if p.is_file()
        }
    stat = path.stat()
    return {"bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def sha256_file(path: Path, chunk: int = 1 << 22) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def fingerprint(inputs: Mapping[str, Path], params: Mapping) -> str:
    payload = {
        "inputs": {k: file_fingerprint(Path(v)) for k, v in sorted(inputs.items())},
        "params": dict(sorted(params.items())),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def write_json(path: Path, data: object, *, indent: int | None = None) -> None:
    """Atomic JSON write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(data, ensure_ascii=False, indent=indent))
    partial.replace(path)


class Step:
    """One run of a named step; ``skip`` is true when it already finished with the same key."""

    def __init__(self, work: Path, name: str, key: str, *, force: bool = False) -> None:
        self.marker = work / "steps" / f"{name}.json"
        self.name = name
        self.key = key
        self.started = time.time()
        previous = json.loads(self.marker.read_text()) if self.marker.exists() else None
        self.skip = not force and previous is not None and previous.get("fingerprint") == key
        self.previous = previous
        self.summary: dict = {}

    def done(self, summary: Mapping) -> dict:
        record = {
            "step": self.name,
            "fingerprint": self.key,
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wall_s": round(time.time() - self.started, 1),
            **summary,
        }
        write_json(self.marker, record, indent=1)
        return record
