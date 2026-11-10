"""Research cache under ``data/catalog/``: each fetched body sits next to a JSON sidecar.

The sidecar records what was asked (URL, method, a request digest), when, the SHA-256 and size
of the body, and the licence of the source. A cached body whose SHA-256 matches its sidecar is
reused, so research runs put only light load on the providers. The User-Agent value is never
written to disk because its contact part comes from ``.env``.
"""

import hashlib
import json
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

Transport = Callable[[urllib.request.Request, float], bytes]


class FetchError(RuntimeError):
    """A provider answered with an error or the cache is inconsistent."""


@dataclass(frozen=True, slots=True)
class CachedBody:
    body: bytes
    sidecar: dict[str, object]
    reused: bool


def urllib_transport(request: urllib.request.Request, timeout_s: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout_s) as response:  # noqa: S310
        status = response.status
        if status != 200:
            msg = f"{request.full_url} answered HTTP {status}"
            raise FetchError(msg)
        return response.read()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ResearchCache:
    """Cached GET and POST requests with a minimum pause between two network calls."""

    def __init__(  # noqa: PLR0913
        self,
        root: Path,
        user_agent: str,
        *,
        transport: Transport = urllib_transport,
        min_interval_s: float = 2.0,
        timeout_s: float = 90.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._root = root
        self._user_agent = user_agent
        self._transport = transport
        self._min_interval_s = min_interval_s
        self._timeout_s = timeout_s
        self._clock = clock
        self._sleep = sleep
        self._last_call: float | None = None

    def path_for(self, folder: str, name: str) -> Path:
        return self._root / folder / name

    def get(  # noqa: PLR0913
        self,
        folder: str,
        name: str,
        url: str,
        *,
        licence: str,
        accept: str = "*/*",
        refresh: bool = False,
    ) -> CachedBody:
        request = urllib.request.Request(  # noqa: S310
            url, headers={"User-Agent": self._user_agent, "Accept": accept}
        )
        return self._cached(
            folder,
            name,
            request,
            licence=licence,
            meta={"method": "GET", "url": url},
            refresh=refresh,
        )

    def post_form(  # noqa: PLR0913
        self,
        folder: str,
        name: str,
        url: str,
        form: Mapping[str, str],
        *,
        licence: str,
        accept: str,
        refresh: bool = False,
    ) -> CachedBody:
        data = urllib.parse.urlencode(form).encode()
        request = urllib.request.Request(  # noqa: S310
            url,
            data=data,
            method="POST",
            headers={
                "User-Agent": self._user_agent,
                "Accept": accept,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        meta = {"method": "POST", "url": url, "request_sha256": sha256_hex(data)}
        return self._cached(folder, name, request, licence=licence, meta=meta, refresh=refresh)

    def _cached(  # noqa: PLR0913
        self,
        folder: str,
        name: str,
        request: urllib.request.Request,
        *,
        licence: str,
        meta: dict[str, object],
        refresh: bool,
    ) -> CachedBody:
        path = self.path_for(folder, name)
        sidecar_path = path.with_name(path.name + ".meta.json")
        if not refresh and path.is_file() and sidecar_path.is_file():
            sidecar = json.loads(sidecar_path.read_text())
            body = path.read_bytes()
            same_request = all(sidecar.get(key) == value for key, value in meta.items())
            if same_request and sidecar.get("sha256") == sha256_hex(body):
                return CachedBody(body, sidecar, reused=True)
        self._pause()
        body = self._transport(request, self._timeout_s)
        sidecar = {
            **meta,
            "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "sha256": sha256_hex(body),
            "bytes": len(body),
            "licence": licence,
            "user_agent": "APP_NAME/version (+APP_CONTACT) from .env, value not recorded",
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        sidecar_path.write_text(json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n")
        return CachedBody(body, sidecar, reused=False)

    def _pause(self) -> None:
        now = self._clock()
        if self._last_call is not None:
            wait = self._min_interval_s - (now - self._last_call)
            if wait > 0:
                self._sleep(wait)
        self._last_call = self._clock()
