import hashlib
import io
import json
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from http.client import IncompleteRead
from pathlib import Path

import pytest

from gerlines_static_import.download import (
    DELFI_SHARING_URL,
    EVA_MIRROR_URL,
    DownloadError,
    HttpResponse,
    ensure_delfi,
    ensure_eva_mirror,
    feed_date_from_delfi_url,
    sha256_file,
)
from gerlines_static_import.download import (
    _copy as copy_body,
)

UA = "testapp/0.0.0 (+https://example.org/contact)"
FEED_URL = (
    "https://www.opendata-oepnv.de/fileadmin/datasets/delfi/"
    "20261019_fahrplaene_gesamtdeutschland_gtfs.zip"
)


@dataclass
class Call:
    method: str
    url: str
    headers: Mapping[str, str]


@dataclass
class ScriptedHttp:
    responses: dict[tuple[str, str], HttpResponse | list[HttpResponse]]
    calls: list[Call] = field(default_factory=list)

    def request(self, method: str, url: str, headers: Mapping[str, str]) -> HttpResponse:
        self.calls.append(Call(method, url, dict(headers)))
        scripted = self.responses[(method, url)]
        return scripted.pop(0) if isinstance(scripted, list) else scripted


def zip_bytes(text: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("feed_info.txt", text)
    return buffer.getvalue()


class BrokenBody(io.BytesIO):
    """A body that breaks off with a read error after its bytes."""

    def read(self, size: int | None = -1) -> bytes:
        chunk = super().read(size)
        if not chunk:
            raise IncompleteRead(b"")
        return chunk


def response(status: int, body: bytes = b"", **headers: str) -> HttpResponse:
    normalised = {k.replace("_", "-").lower(): v for k, v in headers.items()}
    if body and "content-length" not in normalised:
        normalised["content-length"] = str(len(body))
    return HttpResponse(status=status, headers=normalised, body=io.BytesIO(body))


def delfi_http(body: bytes) -> ScriptedHttp:
    return ScriptedHttp(
        {
            ("GET", DELFI_SHARING_URL): response(303, location=FEED_URL),
            ("GET", FEED_URL): response(200, body, last_modified="Mon, 19 Oct 2026 07:35:00 GMT"),
        }
    )


def test_feed_date_comes_from_the_monday_file_name() -> None:
    assert feed_date_from_delfi_url(FEED_URL) == "2026-10-19"


def test_feed_date_refuses_an_unexpected_file_name() -> None:
    with pytest.raises(DownloadError, match="file name"):
        feed_date_from_delfi_url("https://example.org/latest.zip")


def test_downloads_the_monday_file_with_a_sidecar(tmp_path: Path) -> None:
    body = zip_bytes("feed")
    http = delfi_http(body)
    result = ensure_delfi(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    target = tmp_path / "delfi" / "2026-10-19" / "delfi-gtfs.zip"
    assert result.path == target
    assert not result.reused
    assert target.read_bytes() == body
    sidecar = json.loads((tmp_path / "delfi" / "2026-10-19" / "delfi-gtfs.zip.json").read_text())
    assert sidecar == {
        "url": FEED_URL,
        "requested_url": DELFI_SHARING_URL,
        "fetched_at": "2026-10-25T09:00:00Z",
        "sha256": hashlib.sha256(body).hexdigest(),
        "bytes": len(body),
        "etag": None,
        "last_modified": "Mon, 19 Oct 2026 07:35:00 GMT",
        "licence": "CC-BY-4.0",
        "attribution": "DELFI e.V.",
    }
    assert all(call.headers["User-Agent"] == UA for call in http.calls)


def test_reuses_the_file_when_its_sha256_matches_the_sidecar(tmp_path: Path) -> None:
    body = zip_bytes("feed")
    ensure_delfi(delfi_http(body), tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    second = delfi_http(body)
    result = ensure_delfi(second, tmp_path, UA, fetched_at="2026-10-26T09:00:00Z")
    assert result.reused
    assert [call.url for call in second.calls] == [DELFI_SHARING_URL]


def test_downloads_again_when_the_file_on_disk_was_damaged(tmp_path: Path) -> None:
    body = zip_bytes("feed")
    first = ensure_delfi(delfi_http(body), tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    first.path.write_bytes(b"PK trunc")
    result = ensure_delfi(delfi_http(body), tmp_path, UA, fetched_at="2026-10-25T10:00:00Z")
    assert not result.reused
    assert first.path.read_bytes() == body


def test_refuses_a_truncated_download_and_leaves_no_file(tmp_path: Path) -> None:
    http = ScriptedHttp(
        {
            ("GET", DELFI_SHARING_URL): response(303, location=FEED_URL),
            ("GET", FEED_URL): response(200, b"PK short", content_length="100"),
        }
    )
    with pytest.raises(DownloadError, match="expected 100 bytes"):
        ensure_delfi(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    assert list((tmp_path / "delfi" / "2026-10-19").iterdir()) == []


def test_resumes_a_download_cut_short_by_a_proxy(tmp_path: Path) -> None:
    body = zip_bytes("the whole national feed")
    cut = 9
    http = ScriptedHttp(
        {
            ("GET", DELFI_SHARING_URL): response(303, location=FEED_URL),
            ("GET", FEED_URL): [
                response(200, body[:cut], content_length=str(len(body)), etag='"v1"'),
                response(
                    206,
                    body[cut:],
                    content_range=f"bytes {cut}-{len(body) - 1}/{len(body)}",
                    etag='"v1"',
                ),
            ],
        }
    )
    result = ensure_delfi(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    assert result.path.read_bytes() == body
    assert result.sidecar["sha256"] == hashlib.sha256(body).hexdigest()
    assert http.calls[-1].headers["Range"] == f"bytes={cut}-"
    assert http.calls[-1].headers["If-Range"] == '"v1"'


def test_gives_up_when_a_resume_does_not_continue_where_it_stopped(tmp_path: Path) -> None:
    body = zip_bytes("the whole national feed")
    http = ScriptedHttp(
        {
            ("GET", DELFI_SHARING_URL): response(303, location=FEED_URL),
            ("GET", FEED_URL): [
                response(200, body[:9], content_length=str(len(body))),
                response(200, body),
            ],
        }
    )
    with pytest.raises(DownloadError, match="resume"):
        ensure_delfi(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    assert list((tmp_path / "delfi" / "2026-10-19").iterdir()) == []


def test_refuses_a_sharing_link_that_does_not_redirect(tmp_path: Path) -> None:
    http = ScriptedHttp({("GET", DELFI_SHARING_URL): response(200, b"<html>")})
    with pytest.raises(DownloadError, match="redirect"):
        ensure_delfi(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")


def test_mirror_lands_in_the_folder_of_its_last_modified_date(tmp_path: Path) -> None:
    body = zip_bytes("eva")
    http = ScriptedHttp(
        {
            ("GET", EVA_MIRROR_URL): response(
                200, body, last_modified="Mon, 19 Oct 2026 19:38:38 GMT", etag='"abc"'
            )
        }
    )
    result = ensure_eva_mirror(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    assert result.path == tmp_path / "delfi" / "2026-10-19" / "delfi-gtfs-extended-zhv-evaNr.zip"
    assert sha256_file(result.path) == hashlib.sha256(body).hexdigest()
    sidecar = json.loads(result.path.with_name(result.path.name + ".json").read_text())
    assert sidecar["etag"] == '"abc"'
    assert sidecar["licence"] == "CC-BY-4.0 AND ODbL-1.0"
    assert "OpenStreetMap" in str(sidecar["attribution"])


def test_mirror_is_requested_conditionally_and_reused_on_304(tmp_path: Path) -> None:
    body = zip_bytes("eva")
    first = ScriptedHttp(
        {
            ("GET", EVA_MIRROR_URL): response(
                200, body, last_modified="Mon, 19 Oct 2026 19:38:38 GMT", etag='"abc"'
            )
        }
    )
    ensure_eva_mirror(first, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    second = ScriptedHttp({("GET", EVA_MIRROR_URL): response(304)})
    result = ensure_eva_mirror(second, tmp_path, UA, fetched_at="2026-10-26T09:00:00Z")
    assert result.reused
    assert second.calls[0].headers["If-None-Match"] == '"abc"'
    assert second.calls[0].headers["If-Modified-Since"] == "Mon, 19 Oct 2026 19:38:38 GMT"


def test_reports_http_errors(tmp_path: Path) -> None:
    http = ScriptedHttp({("GET", EVA_MIRROR_URL): response(503)})
    with pytest.raises(DownloadError, match="503"):
        ensure_eva_mirror(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")


def test_refuses_a_body_that_is_not_a_zip(tmp_path: Path) -> None:
    http = ScriptedHttp(
        {
            ("GET", DELFI_SHARING_URL): response(303, location=FEED_URL),
            ("GET", FEED_URL): response(200, b"<html>maintenance</html>"),
        }
    )
    with pytest.raises(DownloadError, match="not a readable zip"):
        ensure_delfi(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    assert list((tmp_path / "delfi" / "2026-10-19").iterdir()) == []


def test_refuses_a_transfer_without_length_that_broke_off(tmp_path: Path) -> None:
    broken = HttpResponse(status=200, headers={}, body=BrokenBody(zip_bytes("feed")[:20]))
    http = ScriptedHttp(
        {
            ("GET", DELFI_SHARING_URL): response(303, location=FEED_URL),
            ("GET", FEED_URL): broken,
        }
    )
    with pytest.raises(DownloadError, match="without Content-Length broke off"):
        ensure_delfi(http, tmp_path, UA, fetched_at="2026-10-25T09:00:00Z")
    assert list((tmp_path / "delfi" / "2026-10-19").iterdir()) == []


class FullDisk(io.BytesIO):
    def write(self, data: bytes) -> int:  # type: ignore[override]
        raise OSError(28, "No space left on device")


def test_a_write_error_is_not_mistaken_for_a_short_read() -> None:
    body = response(200, zip_bytes("feed"))
    with pytest.raises(OSError, match="No space left"):
        copy_body(body, FullDisk(), hashlib.sha256())


def test_a_read_error_ends_the_copy_as_unclean() -> None:
    body = HttpResponse(status=200, headers={}, body=BrokenBody(b"abc"))
    assert copy_body(body, io.BytesIO(), hashlib.sha256()) == (3, False)
