import http.client
import json
import threading
import urllib.parse
from collections.abc import Iterator
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from gerlines_catalog.photo_commands import CANDIDATES_FILE
from gerlines_catalog.photo_review import handler, parse_focus

TOKEN = "test-token"  # noqa: S105
CANDIDATE = {
    "file_title": "File:<script>alert(1)</script>.jpg",
    "page_url": "https://commons.wikimedia.org/wiki/File:X.jpg",
    "thumb_url": "https://upload.wikimedia.org/x/330px-X.jpg",
    "credit": {"author": "A & B"},
    "licence": {"name": "CC BY-SA 4.0"},
    "width": 4000,
    "height": 2667,
    "found_by": "commons-category",
}


@pytest.fixture
def server(tmp_path: Path) -> Iterator[tuple[int, list[dict]]]:
    photos = tmp_path / "photos"
    photos.mkdir()
    document = {"series": [{"series_id": "db-403", "candidates": [CANDIDATE]}]}
    (photos / CANDIDATES_FILE).write_text(json.dumps(document))
    calls: list[dict] = []

    def decider(*_args: object, **kwargs: object) -> None:
        calls.append(kwargs)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler(tmp_path, photos, TOKEN, 0))
    port = httpd.server_address[1]
    httpd.RequestHandlerClass = handler(tmp_path, photos, TOKEN, port, decider)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield port, calls
    httpd.shutdown()
    httpd.server_close()


def request(port: int, method: str, path: str, body: str = "", host: str | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Host": host or f"127.0.0.1:{port}"}
    if body:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    conn.request(method, path, body=body or None, headers=headers)
    response = conn.getresponse()
    return response.status, response.read().decode(), dict(response.getheaders())


def test_pages_escape_candidate_text(server: tuple[int, list[dict]]) -> None:
    port, _ = server
    status, body, headers = request(port, "GET", "/?series=db-403")
    assert status == 200
    assert "<script>alert(1)</script>" not in body
    assert "&lt;script&gt;" in body
    assert "A &amp; B" in body
    assert headers["X-Frame-Options"] == "DENY"
    assert request(port, "GET", "/")[0] == 200


def test_other_hosts_and_stale_tokens_are_refused(server: tuple[int, list[dict]]) -> None:
    port, calls = server
    assert request(port, "GET", "/", host="evil.example")[0] == 403
    form = urllib.parse.urlencode(
        {"token": "wrong", "series_id": "db-403", "file_title": "File:X.jpg",
         "decision": "approve", "reason": "ok"}
    )  # fmt: skip
    assert request(port, "POST", "/decide", form)[0] == 403
    assert request(port, "POST", "/decide", form, host="evil.example")[0] == 403
    assert calls == []


def test_a_decision_is_recorded_as_the_users(server: tuple[int, list[dict]]) -> None:
    port, calls = server
    form = urllib.parse.urlencode(
        {"token": TOKEN, "series_id": "db-403", "file_title": "File:X.jpg",
         "decision": "reject", "reason": " blurred ", "focus": "0.4,0.6"}
    )  # fmt: skip
    status, _, headers = request(port, "POST", "/decide", form)
    assert status == 303
    assert headers["Location"] == "/?series=db-403"
    assert calls == [
        {"series_id": "db-403", "file_title": "File:X.jpg", "decision": "reject",
         "reason": "blurred", "by": "user", "focus": (0.4, 0.6)}
    ]  # fmt: skip


def test_a_missing_candidates_file_is_explained_not_a_traceback(
    server: tuple[int, list[dict]], tmp_path: Path
) -> None:
    port, _ = server
    (tmp_path / "photos" / CANDIDATES_FILE).unlink()
    status, body, headers = request(port, "GET", "/")
    assert status == 503
    assert "photos candidates" in body
    assert headers["Cache-Control"] == "no-store"


def test_focus_parsing() -> None:
    assert parse_focus("") is None
    assert parse_focus("0.5,0.25") == (0.5, 0.25)
    with pytest.raises(ValueError, match="between 0 and 1"):
        parse_focus("2,0")
