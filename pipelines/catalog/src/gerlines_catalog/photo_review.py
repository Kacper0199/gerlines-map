"""Local review page for vehicle photos: candidates per series, approve or reject with a reason.

Runs on 127.0.0.1 only, answers only requests whose Host is that address, and accepts a decision
only with the random token of the running server, so another site in the browser cannot post
decisions. Decisions go through ``photo_commands.decide`` with ``by: user``, the review record.
"""

import html
import secrets
import sys
import urllib.parse
from collections.abc import Callable
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from gerlines_catalog.photo_commands import decide, read_candidates
from gerlines_catalog.photos import PHOTOS_FILE, PhotoError, PhotoRecord, read_photos

SHOWN_CANDIDATES = 24
MAX_FORM_BYTES = 8_192
STYLE = """
body{font:14px/1.45 system-ui,sans-serif;margin:24px;max-width:1200px}
body{color:#1b1d1f;background:#f6f4ef}
a{color:inherit}h1{font-size:24px}h2{font-size:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{background:#fff;border:1px solid #d8d3c8;border-radius:10px;padding:12px}
.card img{width:100%;aspect-ratio:3/2;object-fit:cover;border-radius:6px;background:#e9e5dc}
.approve{border-color:#2f7d4f;border-width:2px}.reject{opacity:.6}
input[type=text]{width:100%;box-sizing:border-box;margin:4px 0}
small{color:#5b5e62}table{border-collapse:collapse}td,th{padding:4px 8px;text-align:left}
"""


def _e(text: object) -> str:
    return html.escape(str(text), quote=True)


def _page(title: str, body: str) -> bytes:
    return (
        "<!doctype html><html lang=en><head><meta charset=utf-8>"
        '<meta name=viewport content="width=device-width,initial-scale=1">'
        '<meta name=referrer content="no-referrer">'
        f"<title>{_e(title)}</title><style>{STYLE}</style></head><body>{body}</body></html>"
    ).encode()


def index_page(document: dict, records: list[PhotoRecord]) -> bytes:
    rows = []
    for entry in document["series"]:
        mine = [r for r in records if r.series_id == entry["series_id"]]
        approved = sum(r.approval.decision == "approve" for r in mine)
        pending = sum(r.approval.user_review == "pending" for r in mine)
        link = "?" + urllib.parse.urlencode({"series": entry["series_id"]})
        rows.append(
            f"<tr><td><a href='{_e(link)}'>{_e(entry['series_id'])}</a></td>"
            f"<td>{len(entry['candidates'])}</td><td>{approved}</td><td>{pending}</td></tr>"
        )
    table = (
        "<table><tr><th>Series</th><th>Candidates</th><th>Approved</th>"
        "<th>Waiting for your review</th></tr>" + "".join(rows) + "</table>"
    )
    return _page("Photo review", f"<h1>Photo review</h1>{table}")


def _decision_form(series_id: str, candidate: dict, record: PhotoRecord | None, token: str) -> str:
    reason = record.approval.reason if record else ""
    focus = ",".join(str(v) for v in record.focus) if record else "0.5,0.5"
    return (
        "<form method=post action='/decide'>"
        f"<input type=hidden name=token value='{_e(token)}'>"
        f"<input type=hidden name=series_id value='{_e(series_id)}'>"
        f"<input type=hidden name=file_title value='{_e(candidate['file_title'])}'>"
        f"<input type=text name=reason required placeholder='Reason' value='{_e(reason)}'>"
        f"<input type=text name=focus placeholder='Focus x,y' value='{_e(focus)}'>"
        "<button name=decision value=approve>Approve</button> "
        "<button name=decision value=reject>Reject</button></form>"
    )


def series_page(document: dict, records: list[PhotoRecord], series_id: str, token: str) -> bytes:
    entry = next((s for s in document["series"] if s["series_id"] == series_id), None)
    if entry is None:
        return _page("Unknown series", "<p>Unknown series. <a href='/'>All series</a></p>")
    by_title = {r.file_title: r for r in records if r.series_id == series_id}
    cards = []
    for candidate in entry["candidates"][:SHOWN_CANDIDATES]:
        record = by_title.get(candidate["file_title"])
        state = record.approval.decision if record else ""
        status = (
            f"<p><b>{_e(state)}</b> by {_e(record.approval.by)}, rank {_e(record.rank or '')}, "
            f"{_e(record.approval.reason)}</p>"
            if record
            else ""
        )
        thumb = candidate.get("thumb_url") or ""
        cards.append(
            f"<div class='card {_e(state)}'>"
            f"<img src='{_e(thumb)}' alt='{_e(candidate['file_title'])}' loading=lazy>"
            f"<p><a href='{_e(candidate['page_url'])}' target=_blank rel=noreferrer>"
            f"{_e(candidate['file_title'])}</a><br><small>{_e(candidate['credit']['author'])}, "
            f"{_e(candidate['licence']['name'])}, {_e(candidate['width'])} by "
            f"{_e(candidate['height'])}, {_e(candidate['found_by'])}</small></p>"
            f"{status}{_decision_form(series_id, candidate, record, token)}</div>"
        )
    body = (
        f"<p><a href='/'>All series</a></p><h1>{_e(series_id)}</h1>"
        f"<p>{len(entry['candidates'])} candidates, the first {SHOWN_CANDIDATES} by score. "
        "Approve at most two per series. Your decision replaces the pre-selection.</p>"
        f"<div class=grid>{''.join(cards)}</div>"
    )
    return _page(f"Photo review {series_id}", body)


def parse_focus(text: str) -> tuple[float, float] | None:
    if not text.strip():
        return None
    x, y = (float(part) for part in text.split(","))
    if not (0 <= x <= 1 and 0 <= y <= 1):
        msg = "focus is x,y between 0 and 1"
        raise ValueError(msg)
    return x, y


def handler(
    catalog_dir: Path,
    photos_dir: Path,
    token: str,
    port: int,
    decider: Callable[..., PhotoRecord] = decide,
) -> type[BaseHTTPRequestHandler]:
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Review(BaseHTTPRequestHandler):
        def _send(self, status: HTTPStatus, body: bytes, location: str | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Cache-Control", "no-store")
            if location:
                self.send_header("Location", location)
            self.end_headers()
            self.wfile.write(body)

        def _host_ok(self) -> bool:
            if self.headers.get("Host") in allowed_hosts:
                return True
            self._send(HTTPStatus.FORBIDDEN, _page("Forbidden", "<p>Wrong host.</p>"))
            return False

        def do_GET(self) -> None:
            if not self._host_ok():
                return
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            try:
                document = read_candidates(photos_dir)
                records = read_photos(catalog_dir / PHOTOS_FILE)
            except PhotoError as error:
                message = "".join(f"<p>{_e(problem)}</p>" for problem in error.problems)
                self._send(HTTPStatus.SERVICE_UNAVAILABLE, _page("Not ready", message))
                return
            series = query.get("series", [""])[0]
            body = (
                series_page(document, records, series, token)
                if series
                else index_page(document, records)
            )
            self._send(HTTPStatus.OK, body)

        def do_POST(self) -> None:
            if not self._host_ok():
                return
            length = int(self.headers.get("Content-Length") or 0)
            if self.path != "/decide" or not 0 < length <= MAX_FORM_BYTES:
                self._send(HTTPStatus.BAD_REQUEST, _page("Bad request", "<p>Bad request.</p>"))
                return
            form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8"))
            field = {key: values[0] for key, values in form.items()}
            if not secrets.compare_digest(field.get("token", ""), token):
                self._send(HTTPStatus.FORBIDDEN, _page("Forbidden", "<p>Stale page.</p>"))
                return
            try:
                decider(
                    catalog_dir, photos_dir,
                    series_id=field.get("series_id", ""),
                    file_title=field.get("file_title", ""),
                    decision=field.get("decision", ""),
                    reason=field.get("reason", "").strip(),
                    by="user",
                    focus=parse_focus(field.get("focus", "")),
                )  # fmt: skip
            except (PhotoError, ValueError) as error:
                message = f"<p>{_e(error)}</p><p><a href='/'>All series</a></p>"
                self._send(HTTPStatus.UNPROCESSABLE_ENTITY, _page("Not saved", message))
                return
            back = "/?" + urllib.parse.urlencode({"series": field.get("series_id", "")})
            self._send(HTTPStatus.SEE_OTHER, b"", location=back)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            sys.stderr.write(f"{self.address_string()} {format % args}\n")

    return Review


def serve(catalog_dir: Path, photos_dir: Path, port: int) -> int:
    token = secrets.token_urlsafe(24)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler(catalog_dir, photos_dir, token, port))
    print(f"photo review on http://127.0.0.1:{port}/ (Ctrl+C stops it)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
