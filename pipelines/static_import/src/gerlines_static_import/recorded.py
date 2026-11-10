"""Stage a DELFI feed the recorder stored as this week's input, without downloading it again.

The recorder keeps every new DELFI static file under ``<recordings>/delfi-gtfs/<fetch day>/`` and
describes each fetch in that folder's ``day.jsonl``. ``stage_recorded`` takes one stored file,
links it to ``<inputs>/delfi/<Monday>/delfi-gtfs.zip`` (the layout ``download`` writes) and writes
the JSON sidecar, so ``load``, ``enrich`` and ``subset`` see the feed's Monday and source URL rather
than the day it was fetched.
"""

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from gerlines_static_import.download import (
    DELFI_ATTRIBUTION,
    DELFI_FILE_NAME,
    DELFI_LICENCE,
    DownloadError,
    _sidecar_path,
    feed_date_from_delfi_url,
    intact,
    sha256_file,
)

RECORDED_SOURCE = "delfi-gtfs"


class RecordedFeedError(RuntimeError):
    """A recorded feed is missing, damaged or would overwrite another file."""


@dataclass(frozen=True, slots=True)
class RecordedFeed:
    monday: str
    path: Path
    url: str
    observed_at: str
    sha256: str
    size: int
    object_key: str
    etag: str | None
    last_modified: str | None


@dataclass(frozen=True, slots=True)
class StageResult:
    feed: RecordedFeed
    path: Path
    reused: bool


def recorded_feeds(recordings: Path) -> list[RecordedFeed]:
    """Every DELFI feed the recorder stored, oldest Monday first: one per Monday, the first fetch of
    its bytes, or the newest file when DELFI republished the Monday with other bytes."""
    found: dict[str, RecordedFeed] = {}
    for day in sorted((recordings / RECORDED_SOURCE).glob("*/day.jsonl")):
        for raw in day.read_text().splitlines():
            if not raw.strip():
                continue
            line = json.loads(raw)
            if line.get("outcome") != "stored" or not line.get("object"):
                continue
            try:
                monday = feed_date_from_delfi_url(str(line["url"]))
            except DownloadError:
                continue
            if monday in found and found[monday].sha256 == str(line["sha256"]):
                continue
            key = str(line["object"].get("file") or line["object"]["key"])
            headers = line.get("headers") or {}
            found[monday] = RecordedFeed(
                monday=monday,
                path=recordings / key,
                url=str(line["url"]),
                observed_at=str(line.get("observedAt") or line.get("startedAt") or ""),
                sha256=str(line["sha256"]),
                size=int(line["bytes"]),
                object_key=key,
                etag=headers.get("etag"),
                last_modified=headers.get("last-modified"),
            )
    return [found[m] for m in sorted(found)]


def stage_recorded(recordings: Path, inputs: Path, *, monday: str | None = None) -> StageResult:
    """Links the newest (or the named Monday's) recorded feed into ``inputs`` with a sidecar."""
    feeds = recorded_feeds(recordings)
    if not feeds:
        msg = f"no stored DELFI feed under {recordings / RECORDED_SOURCE}"
        raise RecordedFeedError(msg)
    chosen = feeds[-1] if monday is None else next((f for f in feeds if f.monday == monday), None)
    if chosen is None:
        stored = ", ".join(f.monday for f in feeds)
        msg = f"no recorded DELFI feed for {monday} (stored: {stored})"
        raise RecordedFeedError(msg)
    target = inputs / "delfi" / chosen.monday / DELFI_FILE_NAME
    existing = intact(target)
    if existing is not None and existing.get("sha256") == chosen.sha256:
        return StageResult(chosen, target, reused=True)
    if target.exists():
        msg = f"{target} already holds another file; move it away first"
        raise RecordedFeedError(msg)
    if not chosen.path.is_file():
        msg = f"recorded file {chosen.path} is missing"
        raise RecordedFeedError(msg)
    target.parent.mkdir(parents=True, exist_ok=True)
    _link_or_copy(chosen.path, target)
    actual = sha256_file(target)
    if actual != chosen.sha256:
        target.unlink()
        msg = f"{chosen.path}: sha256 {actual} differs from the recorded {chosen.sha256}"
        raise RecordedFeedError(msg)
    sidecar = {
        "url": chosen.url,
        "fetched_at": chosen.observed_at,
        "sha256": chosen.sha256,
        "bytes": chosen.size,
        "etag": chosen.etag,
        "last_modified": chosen.last_modified,
        "licence": DELFI_LICENCE,
        "attribution": DELFI_ATTRIBUTION,
        "recorded_object": chosen.object_key,
    }
    _sidecar_path(target).write_text(json.dumps(sidecar, indent=2) + "\n")
    return StageResult(chosen, target, reused=False)


def _link_or_copy(source: Path, target: Path) -> None:
    """A hard link costs no disk and leaves the recording untouched; copy across volumes."""
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)
