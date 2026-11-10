"""Fetch the monthly processed Parquet files of piebro/deutsche-bahn-data at a pinned revision.

Every file is checked against the sha256 the Hub publishes for its LFS object before it is kept;
``SOURCE.md`` next to the files records the URL, revision, licence and digests.
"""

import hashlib
import json
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import BinaryIO

DATASET = "piebro/deutsche-bahn-data"
HUB = "https://huggingface.co"
FOLDER = "monthly_processed_data"
LICENCE = "CC BY 4.0"
LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/"
ATTRIBUTION = (
    "Deutsche Bahn train data, collected and processed by piebro "
    "(https://github.com/piebro/deutsche-bahn-data), CC BY 4.0, data from Deutsche Bahn"
)
CHUNK = 1 << 20

Opener = Callable[[str, dict[str, str]], BinaryIO]


class VerificationError(RuntimeError):
    """A downloaded file does not match the size or sha256 the Hub lists."""


@dataclass(frozen=True, slots=True)
class HubFile:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True, slots=True)
class Downloaded:
    path: Path
    size: int
    sha256: str
    reused: bool


def months_between(first: str, last: str) -> list[str]:
    year, month = (int(part) for part in first.split("-"))
    end = tuple(int(part) for part in last.split("-"))
    if (year, month) > end:
        msg = f"{first} is after {last}"
        raise ValueError(msg)
    months = []
    while (year, month) <= end:
        months.append(f"{year:04d}-{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def month_path(month: str) -> str:
    return f"{FOLDER}/data-{month}.parquet"


def file_url(revision: str, path: str) -> str:
    return f"{HUB}/datasets/{DATASET}/resolve/{revision}/{path}"


def revision_url() -> str:
    return f"{HUB}/api/datasets/{DATASET}"


def tree_url(revision: str) -> str:
    return f"{HUB}/api/datasets/{DATASET}/tree/{revision}/{FOLDER}"


def hub_files(listing: bytes) -> dict[str, HubFile]:
    files = {}
    for entry in json.loads(listing):
        if entry.get("type") != "file" or "lfs" not in entry:
            continue
        files[entry["path"]] = HubFile(entry["path"], int(entry["size"]), entry["lfs"]["oid"])
    return files


def http_opener(url: str, headers: dict[str, str]) -> BinaryIO:
    request = urllib.request.Request(url, headers=headers)  # noqa: S310
    return urllib.request.urlopen(request, timeout=60)  # noqa: S310


def read_json(url: str, user_agent: str, opener: Opener = http_opener) -> bytes:
    with opener(url, {"User-Agent": user_agent}) as response:
        return response.read()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(CHUNK):
            digest.update(block)
    return digest.hexdigest()


def download_month(
    hub: HubFile, revision: str, out_dir: Path, user_agent: str, opener: Opener = http_opener
) -> Downloaded:
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / Path(hub.path).name
    if target.is_file() and target.stat().st_size == hub.size and _sha256(target) == hub.sha256:
        return Downloaded(target, hub.size, hub.sha256, reused=True)
    partial = target.with_suffix(".parquet.part")
    digest = hashlib.sha256()
    size = 0
    try:
        with (
            opener(file_url(revision, hub.path), {"User-Agent": user_agent}) as response,
            partial.open("wb") as handle,
        ):
            while block := response.read(CHUNK):
                digest.update(block)
                handle.write(block)
                size += len(block)
        if size != hub.size or digest.hexdigest() != hub.sha256:
            msg = (
                f"{hub.path}: got {size} bytes sha256 {digest.hexdigest()}, "
                f"the Hub lists {hub.size} bytes sha256 {hub.sha256}"
            )
            raise VerificationError(msg)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return Downloaded(target, size, hub.sha256, reused=False)


def render_source(revision: str, fetched: date, rows: list[tuple[str, int, str]]) -> str:
    lines = [
        "# piebro/deutsche-bahn-data, monthly processed data",
        "",
        f"- Dataset: {HUB}/datasets/{DATASET} (folder `{FOLDER}/`)",
        f"- Revision: `{revision}`, files from `{file_url(revision, FOLDER + '/')}`",
        f"- Fetched: {fetched.isoformat()} by `gerlines-backfill download`",
        f"- Licence: {LICENCE} ({LICENCE_URL})",
        f"- Attribution: {ATTRIBUTION}",
        "- Each file was checked against the sha256 of its LFS object listed by the Hub.",
        "",
        "| File | Bytes | sha256 |",
        "| --- | --- | --- |",
    ]
    lines.extend(f"| `{name}` | {size:,} | {sha} |" for name, size, sha in rows)
    return "\n".join(lines) + "\n"
