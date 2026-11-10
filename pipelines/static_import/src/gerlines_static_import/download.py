"""Download the weekly DELFI GTFS and the EVA-enriched mirror copy, with JSON sidecars.

Each file lands in ``<inputs>/delfi/<YYYY-MM-DD>/`` next to ``<file>.json``, which records the
URL, the time of the fetch, the SHA-256, the size and the licence. A file whose SHA-256 still
matches its sidecar is reused without downloading it again.
"""

import hashlib
import json
import re
import urllib.error
import urllib.request
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from http.client import IncompleteRead
from pathlib import Path
from typing import BinaryIO, Protocol
from urllib.parse import urljoin

DELFI_SHARING_URL = (
    "https://www.opendata-oepnv.de/ht/de/datensaetze/sharing?"
    "tx_vrrkit_view%5Bsharing%5D=eyJkYXRhc2V0IjoiZGV1dHNjaGxhbmR3ZWl0ZS1zb2xsZmFocnBsYW5kYXRlbi1ndGZzIn0"
)
EVA_MIRROR_URL = "https://mirror.traines.eu/german-delfi-gtfs/delfi-gtfs-extended-zhv-evaNr.zip"
DELFI_FILE_NAME = "delfi-gtfs.zip"
EVA_MIRROR_FILE_NAME = "delfi-gtfs-extended-zhv-evaNr.zip"
DELFI_LICENCE = "CC-BY-4.0"
DELFI_ATTRIBUTION = "DELFI e.V."
EVA_MIRROR_LICENCE = "CC-BY-4.0 AND ODbL-1.0"
EVA_MIRROR_ATTRIBUTION = (
    "DELFI e.V., VRR, DB InfraGO (RIS::Stations, StaDa) and OpenStreetMap contributors "
    "via db-hafas-stations, compiled by mirror.traines.eu"
)

_REDIRECTS = frozenset({301, 302, 303, 307, 308})
_DELFI_FILE = re.compile(r"/(\d{4})(\d{2})(\d{2})_fahrplaene_gesamtdeutschland_gtfs\.zip$")
_CHUNK = 1 << 20
_RESUME_ATTEMPTS = 8


class DownloadError(RuntimeError):
    """A download could not be completed or verified."""


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: BinaryIO


class _Digest(Protocol):
    def update(self, data: bytes, /) -> None: ...


class Http(Protocol):
    def request(self, method: str, url: str, headers: Mapping[str, str]) -> HttpResponse: ...


@dataclass(frozen=True, slots=True)
class FetchResult:
    path: Path
    sidecar: dict[str, object]
    reused: bool


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


class UrllibHttp:
    """``Http`` over urllib that never follows redirects and lower-cases header names."""

    def __init__(self, timeout_s: float = 60.0) -> None:
        self._opener = urllib.request.build_opener(_NoRedirect())
        self._timeout_s = timeout_s

    def request(self, method: str, url: str, headers: Mapping[str, str]) -> HttpResponse:
        req = urllib.request.Request(url, method=method, headers=dict(headers))  # noqa: S310
        try:
            raw = self._opener.open(req, timeout=self._timeout_s)
        except urllib.error.HTTPError as error:
            raw = error
        return HttpResponse(
            status=raw.status,
            headers={k.lower(): v for k, v in raw.headers.items()},
            body=raw,
        )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def feed_date_from_delfi_url(url: str) -> str:
    match = _DELFI_FILE.search(url)
    if match is None:
        msg = f"unexpected DELFI file name in {url}"
        raise DownloadError(msg)
    return "-".join(match.groups())


def read_sidecar(path: Path) -> dict[str, object] | None:
    sidecar = _sidecar_path(path)
    if not sidecar.is_file():
        return None
    return json.loads(sidecar.read_text())


def intact(path: Path) -> dict[str, object] | None:
    """Return the sidecar when ``path`` exists and its SHA-256 matches it."""
    sidecar = read_sidecar(path)
    if sidecar is None or not path.is_file():
        return None
    return sidecar if sha256_file(path) == sidecar.get("sha256") else None


def ensure_delfi(
    http: Http,
    inputs_dir: Path,
    user_agent: str,
    *,
    fetched_at: str,
    sharing_url: str = DELFI_SHARING_URL,
) -> FetchResult:
    """Resolve the keyless sharing link to this week's file and make sure it is on disk."""
    feed_url = _resolve_redirect(http, sharing_url, user_agent)
    target = inputs_dir / "delfi" / feed_date_from_delfi_url(feed_url) / DELFI_FILE_NAME
    existing = intact(target)
    if existing is not None:
        return FetchResult(target, existing, reused=True)
    response = http.request("GET", feed_url, {"User-Agent": user_agent})
    _expect_ok(response, feed_url)
    sidecar = _store(
        http,
        response,
        target,
        url=feed_url,
        requested_url=sharing_url,
        fetched_at=fetched_at,
        licence=DELFI_LICENCE,
        attribution=DELFI_ATTRIBUTION,
        user_agent=user_agent,
    )
    return FetchResult(target, sidecar, reused=False)


def ensure_eva_mirror(
    http: Http,
    inputs_dir: Path,
    user_agent: str,
    *,
    fetched_at: str,
    url: str = EVA_MIRROR_URL,
) -> FetchResult:
    """Fetch the EVA-enriched copy conditionally, into the folder of its Last-Modified day."""
    latest = _latest_intact(inputs_dir / "delfi", EVA_MIRROR_FILE_NAME)
    headers = {"User-Agent": user_agent}
    if latest is not None:
        _, sidecar = latest
        if sidecar.get("etag"):
            headers["If-None-Match"] = str(sidecar["etag"])
        if sidecar.get("last_modified"):
            headers["If-Modified-Since"] = str(sidecar["last_modified"])
    response = http.request("GET", url, headers)
    if response.status == 304 and latest is not None:
        response.body.close()
        path, sidecar = latest
        return FetchResult(path, sidecar, reused=True)
    _expect_ok(response, url)
    last_modified = response.headers.get("last-modified")
    if not last_modified:
        msg = f"{url} sent no Last-Modified header, so its feed date is unknown"
        raise DownloadError(msg)
    day = parsedate_to_datetime(last_modified).date().isoformat()
    target = inputs_dir / "delfi" / day / EVA_MIRROR_FILE_NAME
    sidecar = _store(
        http,
        response,
        target,
        url=url,
        requested_url=url,
        fetched_at=fetched_at,
        licence=EVA_MIRROR_LICENCE,
        attribution=EVA_MIRROR_ATTRIBUTION,
        user_agent=user_agent,
    )
    return FetchResult(target, sidecar, reused=False)


def _latest_intact(root: Path, file_name: str) -> tuple[Path, dict[str, object]] | None:
    if not root.is_dir():
        return None
    for day in sorted((p for p in root.iterdir() if p.is_dir()), reverse=True):
        candidate = day / file_name
        sidecar = intact(candidate)
        if sidecar is not None:
            return candidate, sidecar
    return None


def _resolve_redirect(http: Http, url: str, user_agent: str) -> str:
    response = http.request("GET", url, {"User-Agent": user_agent})
    response.body.close()
    location = response.headers.get("location")
    if response.status not in _REDIRECTS or not location:
        msg = f"expected a redirect from {url}, got HTTP {response.status}"
        raise DownloadError(msg)
    return urljoin(url, location)


def _expect_ok(response: HttpResponse, url: str) -> None:
    if response.status != 200:
        response.body.close()
        msg = f"GET {url} answered HTTP {response.status}"
        raise DownloadError(msg)


def _store(  # noqa: PLR0913
    http: Http,
    response: HttpResponse,
    target: Path,
    *,
    url: str,
    requested_url: str,
    fetched_at: str,
    licence: str,
    attribution: str,
    user_agent: str,
) -> dict[str, object]:
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    try:
        digest, size, headers = _transfer(http, response, partial, url=url, user_agent=user_agent)
        if target.suffix == ".zip":
            _check_zip(partial, url)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    partial.replace(target)
    sidecar: dict[str, object] = {
        "url": url,
        "requested_url": requested_url,
        "fetched_at": fetched_at,
        "sha256": digest,
        "bytes": size,
        "etag": headers.get("etag"),
        "last_modified": headers.get("last-modified"),
        "licence": licence,
        "attribution": attribution,
    }
    _sidecar_path(target).write_text(json.dumps(sidecar, indent=2) + "\n")
    return sidecar


def _transfer(
    http: Http, response: HttpResponse, partial: Path, *, url: str, user_agent: str
) -> tuple[str, int, Mapping[str, str]]:
    """Stream the body to ``partial``, resuming with Range while the length is short."""
    digest = hashlib.sha256()
    headers = response.headers
    expected_header = headers.get("content-length")
    expected = int(expected_header) if expected_header is not None else None
    validator = headers.get("etag") or headers.get("last-modified")
    size = 0
    clean = False
    with partial.open("wb") as out:
        for attempt in range(_RESUME_ATTEMPTS + 1):
            if attempt > 0:
                resumed = _resume(http, url, user_agent, size, validator)
                if resumed is None:
                    break
                response = resumed
            copied, clean = _copy(response, out, digest)
            size += copied
            if expected is None or size >= expected:
                break
    if expected is None and not clean:
        msg = f"{url}: the transfer without Content-Length broke off after {size} bytes"
        raise DownloadError(msg)
    if expected is not None and size != expected:
        msg = (
            f"{url}: expected {expected} bytes, received {size}; "
            f"the server did not resume the transfer from byte {size}"
        )
        raise DownloadError(msg)
    return digest.hexdigest(), size, headers


def _check_zip(path: Path, url: str) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
    except zipfile.BadZipFile as error:
        msg = f"{url}: the download is not a readable zip ({error})"
        raise DownloadError(msg) from error
    if not names:
        msg = f"{url}: the zip has no members"
        raise DownloadError(msg)


def _copy(response: HttpResponse, out: BinaryIO, digest: _Digest) -> tuple[int, bool]:
    """Copy until the body ends; a read error ends the copy, a write error propagates."""
    copied = 0
    try:
        while True:
            try:
                chunk = response.body.read(_CHUNK)
            except (OSError, IncompleteRead):
                return copied, False
            if not chunk:
                return copied, True
            out.write(chunk)
            digest.update(chunk)
            copied += len(chunk)
    finally:
        response.body.close()


def _resume(
    http: Http, url: str, user_agent: str, offset: int, validator: str | None
) -> HttpResponse | None:
    headers = {"User-Agent": user_agent, "Range": f"bytes={offset}-"}
    if validator:
        headers["If-Range"] = validator
    response = http.request("GET", url, headers)
    content_range = response.headers.get("content-range", "")
    if response.status != 206 or not content_range.startswith(f"bytes {offset}-"):
        response.body.close()
        return None
    return response


def _sidecar_path(path: Path) -> Path:
    return path.with_name(path.name + ".json")
