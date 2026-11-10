import hashlib
import http.client
import io
import json
import urllib.error
import urllib.request
import zipfile
from datetime import UTC, datetime
from email.message import Message
from pathlib import Path

import pytest

from gerlines_geo_base.download import (
    Client,
    DownloadError,
    HttpResponse,
    TransientError,
    download_source,
    http_get,
    read_sidecar,
)
from gerlines_geo_base.sources import Source


def make_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("data/layer.txt", "geodata " * 2000)
    return buffer.getvalue()


PAYLOAD = make_zip()
PAYLOAD_SHA256 = hashlib.sha256(PAYLOAD).hexdigest()
URL = "https://example.org/data/test.zip"
MD5_URL = "https://example.org/data/test.zip.md5"
FETCHED_AT = datetime(2026, 10, 25, 9, 30, tzinfo=UTC)


def make_source(md5_url: str | None = None, sha256: str = PAYLOAD_SHA256) -> Source:
    return Source(
        key="test-source",
        url=URL,
        filename="test.zip",
        licence="DL-DE-BY-2.0",
        attribution="© Example (2026)",
        edition="2026-01-01",
        sha256=sha256,
        md5_url=md5_url,
    )


class FakeHttp:
    """Answers each URL from a queue; the last answer repeats. An exception answer is raised."""

    def __init__(self, answers: dict[str, list[HttpResponse | Exception]]) -> None:
        self.answers = answers
        self.requests: list[tuple[str, str]] = []

    def __call__(self, url: str, user_agent: str) -> HttpResponse:
        self.requests.append((url, user_agent))
        queue = self.answers[url]
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


def ok(body: bytes = PAYLOAD) -> HttpResponse:
    return HttpResponse(body, len(body))


def client(http: FakeHttp, sleeps: list[float] | None = None, attempts: int = 3) -> Client:
    record = sleeps if sleeps is not None else []
    return Client("gerlines/0.1.0 (+x)", http, attempts, 2.0, record.append)


def test_writes_file_and_sidecar_with_checksums(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok()]})

    sidecar = download_source(make_source(), tmp_path, client(http), FETCHED_AT)

    stored = tmp_path / "test-source" / "test.zip"
    assert stored.read_bytes() == PAYLOAD
    assert sidecar.sha256 == PAYLOAD_SHA256
    assert sidecar.bytes == len(PAYLOAD)
    on_disk = json.loads((tmp_path / "test-source" / "test.zip.json").read_text())
    assert on_disk["url"] == URL
    assert on_disk["fetched_at"] == "2026-10-25T09:30:00Z"
    assert on_disk["licence"] == "DL-DE-BY-2.0"
    assert on_disk["attribution"] == "© Example (2026)"
    assert on_disk["edition"] == "2026-01-01"
    assert http.requests == [(URL, "gerlines/0.1.0 (+x)")]


def test_rejects_a_truncated_body_after_every_attempt(tmp_path: Path) -> None:
    http = FakeHttp({URL: [HttpResponse(PAYLOAD[:10], len(PAYLOAD))]})

    with pytest.raises(DownloadError, match="truncated"):
        download_source(make_source(), tmp_path, client(http), FETCHED_AT)

    assert len(http.requests) == 3
    assert not (tmp_path / "test-source" / "test.zip").exists()


def test_retries_transient_failures_with_backoff(tmp_path: Path) -> None:
    sleeps: list[float] = []
    http = FakeHttp(
        {URL: [TransientError("HTTP 503"), HttpResponse(PAYLOAD[:10], len(PAYLOAD)), ok()]}
    )

    sidecar = download_source(make_source(), tmp_path, client(http, sleeps), FETCHED_AT)

    assert sidecar.bytes == len(PAYLOAD)
    assert len(http.requests) == 3
    assert sleeps == [2.0, 4.0]


def test_rejects_a_zip_that_fails_its_crc_check_even_without_content_length(
    tmp_path: Path,
) -> None:
    damaged = bytearray(PAYLOAD)
    damaged[60] ^= 0xFF
    http = FakeHttp({URL: [HttpResponse(bytes(damaged), None)]})

    with pytest.raises(DownloadError, match="zip"):
        download_source(make_source(), tmp_path, client(http), FETCHED_AT)

    assert len(http.requests) == 3
    assert not (tmp_path / "test-source" / "test.zip").exists()


def test_rejects_a_body_that_is_not_a_zip(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok(b"<html>maintenance</html>")]})

    with pytest.raises(DownloadError, match="zip"):
        download_source(make_source(), tmp_path, client(http), FETCHED_AT)


def test_fails_clearly_when_upstream_differs_from_the_pinned_sha256(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok()]})

    with pytest.raises(DownloadError, match="pinned"):
        download_source(make_source(sha256="0" * 64), tmp_path, client(http), FETCHED_AT)

    assert len(http.requests) == 1
    assert not (tmp_path / "test-source" / "test.zip").exists()


def test_checks_the_published_md5(tmp_path: Path) -> None:
    good = hashlib.md5(PAYLOAD, usedforsecurity=False).hexdigest()
    http = FakeHttp({URL: [ok()], MD5_URL: [HttpResponse(f"{good}  test.zip\n".encode(), None)]})

    sidecar = download_source(make_source(MD5_URL), tmp_path, client(http), FETCHED_AT)

    assert sidecar.md5 == good


def test_retries_the_md5_fetch(tmp_path: Path) -> None:
    good = hashlib.md5(PAYLOAD, usedforsecurity=False).hexdigest()
    http = FakeHttp(
        {
            URL: [ok()],
            MD5_URL: [TransientError("timed out"), HttpResponse(f"{good}  x\n".encode(), None)],
        }
    )

    sidecar = download_source(make_source(MD5_URL), tmp_path, client(http), FETCHED_AT)

    assert sidecar.md5 == good


@pytest.mark.parametrize("body", [b"", b"   \n", b"not-a-checksum  test.zip\n", b"abc123"])
def test_rejects_an_md5_file_without_32_hex_characters(tmp_path: Path, body: bytes) -> None:
    http = FakeHttp({URL: [ok()], MD5_URL: [HttpResponse(body, None)]})

    with pytest.raises(DownloadError, match="32 hex"):
        download_source(make_source(MD5_URL), tmp_path, client(http), FETCHED_AT)


def test_rejects_a_body_that_does_not_match_the_md5(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok()], MD5_URL: [HttpResponse(b"0" * 32 + b"  test.zip\n", None)]})

    with pytest.raises(DownloadError, match="md5"):
        download_source(make_source(MD5_URL), tmp_path, client(http), FETCHED_AT)


def test_reuses_a_file_whose_sha256_matches_its_sidecar(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok()]})
    first = download_source(make_source(), tmp_path, client(http), FETCHED_AT)

    second = download_source(make_source(), tmp_path, client(http), datetime.now(UTC))

    assert second == first
    assert len(http.requests) == 1


def test_downloads_again_when_the_file_changed_on_disk(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok()]})
    download_source(make_source(), tmp_path, client(http), FETCHED_AT)
    (tmp_path / "test-source" / "test.zip").write_bytes(b"corrupt")

    download_source(make_source(), tmp_path, client(http), FETCHED_AT)

    assert len(http.requests) == 2
    assert (tmp_path / "test-source" / "test.zip").read_bytes() == PAYLOAD


def test_downloads_again_when_the_source_url_changed(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok()]})
    download_source(make_source(), tmp_path, client(http), FETCHED_AT)
    sidecar_file = tmp_path / "test-source" / "test.zip.json"
    stale = json.loads(sidecar_file.read_text()) | {"url": "https://example.org/aktuell/test.zip"}
    sidecar_file.write_text(json.dumps(stale))

    sidecar = download_source(make_source(), tmp_path, client(http), FETCHED_AT)

    assert len(http.requests) == 2
    assert sidecar.url == URL


def test_read_sidecar_verifies_the_file(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok()]})
    download_source(make_source(), tmp_path, client(http), FETCHED_AT)
    (tmp_path / "test-source" / "test.zip").write_bytes(b"corrupt")

    with pytest.raises(DownloadError, match="sha256"):
        read_sidecar(make_source(), tmp_path)


def test_read_sidecar_rejects_a_file_that_is_not_the_pinned_edition(tmp_path: Path) -> None:
    http = FakeHttp({URL: [ok()]})
    download_source(make_source(), tmp_path, client(http), FETCHED_AT)

    with pytest.raises(DownloadError, match="pinned"):
        read_sidecar(make_source(sha256="f" * 64), tmp_path)


class FakeResponse:
    def __init__(self, body: bytes, length: int | None, error: Exception | None = None) -> None:
        self.body = body
        self.headers = Message()
        if length is not None:
            self.headers["Content-Length"] = str(length)
        self.error = error

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        if self.error is not None:
            raise self.error
        return self.body


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(URL, code, "error", Message(), None)


@pytest.mark.parametrize(
    "failure",
    [
        http.client.IncompleteRead(b"part", 10),
        urllib.error.URLError("connection refused"),
        TimeoutError("timed out"),
        http_error(503),
    ],
    ids=["incomplete-read", "url-error", "timeout", "http-503"],
)
def test_http_get_reports_network_failures_as_transient(
    monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    def urlopen(*_: object, **__: object) -> FakeResponse:
        if isinstance(failure, http.client.IncompleteRead):
            return FakeResponse(b"", 10, failure)
        raise failure

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    with pytest.raises(TransientError):
        http_get(URL, "ua")


def test_http_get_fails_at_once_on_a_client_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def urlopen(*_: object, **__: object) -> FakeResponse:
        raise http_error(404)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    with pytest.raises(DownloadError, match="404") as caught:
        http_get(URL, "ua")
    assert not isinstance(caught.value, TransientError)


def test_http_get_returns_body_and_length(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_, **__: FakeResponse(b"abc", 3))

    assert http_get(URL, "ua") == HttpResponse(b"abc", 3)


def test_http_get_refuses_plain_http() -> None:
    with pytest.raises(DownloadError, match="HTTPS"):
        http_get("http://example.org/x.zip", "ua")
