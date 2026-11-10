"""Fetch a source once, verify it, and keep a sidecar with its provenance."""

import hashlib
import http.client
import io
import json
import re
import time
import urllib.error
import urllib.request
import zipfile
import zlib
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from gerlines_geo_base.sources import Source

TIMEOUT_SECONDS = 300
SERVER_ERROR = 500
MD5_HEX = re.compile(r"[0-9a-f]{32}")


class DownloadError(RuntimeError):
    """A download or a file on disk failed verification."""


class TransientError(DownloadError):
    """A failure worth retrying: dropped connection, timeout, partial body, HTTP 5xx."""


@dataclass(frozen=True, slots=True)
class HttpResponse:
    body: bytes
    content_length: int | None


@dataclass(frozen=True, slots=True)
class Sidecar:
    url: str
    fetched_at: str
    bytes: int
    sha256: str
    md5: str | None
    licence: str
    attribution: str
    edition: str


HttpGet = Callable[[str, str], HttpResponse]
BodyCheck = Callable[[bytes], str | None]


def http_get(url: str, user_agent: str) -> HttpResponse:
    if not url.startswith("https://"):
        msg = f"refusing a non-HTTPS source: {url}"
        raise DownloadError(msg)
    request = urllib.request.Request(url, headers={"User-Agent": user_agent})  # noqa: S310
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310
            length = response.headers.get("Content-Length")
            return HttpResponse(response.read(), int(length) if length else None)
    except urllib.error.HTTPError as error:
        msg = f"{url}: HTTP {error.code}"
        if error.code >= SERVER_ERROR:
            raise TransientError(msg) from error
        raise DownloadError(msg) from error
    except (
        http.client.HTTPException,
        urllib.error.URLError,
        TimeoutError,
        ConnectionError,
    ) as error:
        msg = f"{url}: {type(error).__name__} {error}"
        raise TransientError(msg) from error


def source_path(source: Source, root: Path) -> Path:
    return root / source.key / source.filename


def sidecar_path(source: Source, root: Path) -> Path:
    return source_path(source, root).with_name(f"{source.filename}.json")


def read_sidecar(source: Source, root: Path) -> Sidecar:
    """Return the sidecar of a downloaded source after checking the file and the pinned sha256."""
    data = json.loads(sidecar_path(source, root).read_text(encoding="utf-8"))
    sidecar = Sidecar(**data)
    path = source_path(source, root)
    if not path.is_file() or _sha256(path.read_bytes()) != sidecar.sha256:
        msg = f"{path} does not match the sha256 in its sidecar"
        raise DownloadError(msg)
    _check_pinned(source, sidecar.sha256)
    return sidecar


@dataclass(frozen=True, slots=True)
class Client:
    user_agent: str
    get: HttpGet = http_get
    attempts: int = 4
    backoff_seconds: float = 2.0
    sleep: Callable[[float], None] = time.sleep


def download_source(source: Source, root: Path, client: Client, now: datetime) -> Sidecar:
    """Download ``source`` under ``root/<key>/`` unless a verified copy is already there."""
    try:
        sidecar = read_sidecar(source, root)
        if sidecar.url == source.url:
            return sidecar
    except (FileNotFoundError, DownloadError):
        pass

    body = _fetch(
        source.url, client, _archive_problem if source.filename.endswith(".zip") else None
    )
    sha256 = _sha256(body)
    _check_pinned(source, sha256)
    md5 = _verified_md5(source, body, client)
    sidecar = Sidecar(
        url=source.url,
        fetched_at=now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        bytes=len(body),
        sha256=sha256,
        md5=md5,
        licence=source.licence,
        attribution=source.attribution,
        edition=source.edition,
    )
    path = source_path(source, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{source.filename}.part")
    partial.write_bytes(body)
    partial.replace(path)
    sidecar_path(source, root).write_text(
        json.dumps(asdict(sidecar), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return sidecar


def _fetch(url: str, client: Client, check: BodyCheck | None) -> bytes:
    """Get ``url``, retrying transient failures and bodies that fail ``check``, with backoff."""
    problem = "no attempt made"
    for attempt in range(client.attempts):
        if attempt:
            client.sleep(client.backoff_seconds * 2 ** (attempt - 1))
        try:
            response = client.get(url, client.user_agent)
        except TransientError as error:
            problem = str(error)
            continue
        body = response.body
        expected = response.content_length
        if expected is not None and len(body) != expected:
            problem = f"truncated, {len(body)} of {expected} bytes"
            continue
        problem = check(body) if check is not None else None
        if problem is None:
            return body
    msg = f"{url}: {problem} after {client.attempts} attempts"
    raise DownloadError(msg)


def _archive_problem(body: bytes) -> str | None:
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            damaged = archive.testzip()
    except (zipfile.BadZipFile, zlib.error, EOFError, ValueError) as error:
        return f"not a readable zip archive ({error})"
    return None if damaged is None else f"zip member {damaged} fails its CRC check"


def _md5_problem(body: bytes) -> str | None:
    words = body.decode("ascii", errors="replace").split()
    if not words or not MD5_HEX.fullmatch(words[0].lower()):
        return "md5 file does not start with 32 hex characters"
    return None


def _verified_md5(source: Source, body: bytes, client: Client) -> str | None:
    if source.md5_url is None:
        return None
    published = _fetch(source.md5_url, client, _md5_problem).decode("ascii").split()[0].lower()
    actual = hashlib.md5(body, usedforsecurity=False).hexdigest()
    if actual != published:
        msg = f"{source.url}: md5 {actual} differs from the published {published}"
        raise DownloadError(msg)
    return actual


def _check_pinned(source: Source, sha256: str) -> None:
    if sha256 != source.sha256:
        msg = (
            f"{source.url}: sha256 {sha256} differs from the pinned {source.sha256} "
            f"({source.edition}); upstream changed, review the new edition and update sources.py"
        )
        raise DownloadError(msg)


def _sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()
