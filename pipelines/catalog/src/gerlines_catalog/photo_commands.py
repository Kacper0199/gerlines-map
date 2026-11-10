"""``gerlines-catalog photos``: find candidates, record decisions, store, check and load photos."""

import io
import json
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import psycopg
from PIL import Image

from gerlines_catalog import commons
from gerlines_catalog.cache import ResearchCache, Transport, sha256_hex
from gerlines_catalog.photos import (
    MAX_APPROVED_PER_SERIES,
    PHOTOS_FILE,
    Approval,
    PhotoError,
    PhotoRecord,
    StoredFile,
    file_problems,
    next_photo_id,
    read_photos,
    write_photos,
)
from gerlines_catalog.seeds import read_catalog

CANDIDATES_FILE = "candidates.json"
MIN_INTERVAL_S = 1.0
MAX_IMAGE_BYTES = 5_000_000
THUMBNAIL_HOSTS = frozenset({"upload.wikimedia.org", "thumb.wikimedia.org"})
SHOWN_PROBLEMS = 10
_PIL_FORMATS = {"image/jpeg": "JPEG", "image/png": "PNG"}


def paced(transport: Transport, min_interval_s: float = MIN_INTERVAL_S) -> Transport:
    """One pause shared by every cache that uses the returned transport."""
    lock = threading.Lock()
    last: list[float] = []

    def call(request: urllib.request.Request, timeout_s: float) -> bytes:
        with lock:
            if last:
                wait = min_interval_s - (time.monotonic() - last[0])
                if wait > 0:
                    time.sleep(wait)
            try:
                return transport(request, timeout_s)
            finally:
                last[:] = [time.monotonic()]

    return call


def _print(data: object) -> None:
    sys.stdout.write(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


def _series_ids(catalog_dir: Path) -> set[str]:
    return {s.series_id for s in read_catalog(catalog_dir).vehicle_series}


def candidates(cache: ResearchCache, catalog_dir: Path, photos_dir: Path, refresh: bool) -> int:
    series = [
        (s.series_id, s.wikidata_qid, s.commons_category)
        for s in read_catalog(catalog_dir).vehicle_series
    ]
    found = commons.collect(cache, series, refresh=refresh)
    rows = [
        {
            "series_id": entry.series_id,
            "wikidata_qid": entry.qid,
            "commons_category": entry.category,
            "p18": entry.p18,
            "left_out": dict(sorted(entry.left_out.items())),
            "candidates": [{**asdict(c), "score": c.score} for c in entry.candidates],
        }
        for entry in found
    ]
    photos_dir.mkdir(parents=True, exist_ok=True)
    out = photos_dir / CANDIDATES_FILE
    document = {"retrieved_at": datetime.now(UTC).isoformat(timespec="seconds"), "series": rows}
    out.write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    licences = Counter(c.licence.licence_id for entry in found for c in entry.candidates)
    _print(
        {
            "series": len(found),
            "with_candidates": sum(1 for entry in found if entry.candidates),
            "candidates": sum(len(entry.candidates) for entry in found),
            "left_out": sum(sum(entry.left_out.values()) for entry in found),
            "licences": dict(licences.most_common()),
            "file": str(out),
        }
    )
    return 0


def read_candidates(photos_dir: Path) -> dict:
    path = photos_dir / CANDIDATES_FILE
    if not path.is_file():
        msg = f"{path} is missing; run `gerlines-catalog photos candidates` first"
        raise PhotoError([msg])
    return json.loads(path.read_text(encoding="utf-8"))


def _candidate(document: dict, series_id: str, file_title: str) -> dict:
    for entry in document["series"]:
        if entry["series_id"] != series_id:
            continue
        for candidate in entry["candidates"]:
            if candidate["file_title"] == file_title:
                return candidate
    msg = f"{file_title} is not a candidate of {series_id}"
    raise PhotoError([msg])


def _rerank(records: list[PhotoRecord], series_id: str) -> list[PhotoRecord]:
    approved = sorted(
        (r for r in records if r.series_id == series_id and r.rank is not None),
        key=lambda r: r.rank or 0,
    )
    ranks = {r.photo_id: index for index, r in enumerate(approved, start=1)}
    return [
        r.model_copy(update={"rank": ranks[r.photo_id]}) if r.photo_id in ranks else r
        for r in records
    ]


_DECISIONS = threading.Lock()


def decide(  # noqa: PLR0913
    catalog_dir: Path,
    photos_dir: Path,
    *,
    series_id: str,
    file_title: str,
    decision: str,
    reason: str,
    by: str,
    focus: tuple[float, float] | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> PhotoRecord:
    """Record one decision in ``photos.yaml``; a second decision on a file replaces the first.

    Decisions in one process are made one at a time, so the review page's threads never lose one.
    """
    with _DECISIONS:
        return _decide(
            catalog_dir, photos_dir, series_id=series_id, file_title=file_title,
            decision=decision, reason=reason, by=by, focus=focus, now=now,
        )  # fmt: skip


def _decide(  # noqa: PLR0913
    catalog_dir: Path,
    photos_dir: Path,
    *,
    series_id: str,
    file_title: str,
    decision: str,
    reason: str,
    by: str,
    focus: tuple[float, float] | None,
    now: Callable[[], datetime],
) -> PhotoRecord:
    path = catalog_dir / PHOTOS_FILE
    records = read_photos(path, _series_ids(catalog_dir))
    document = read_candidates(photos_dir)
    previous = next(
        (r for r in records if r.series_id == series_id and r.file_title == file_title), None
    )
    others = [r for r in records if r is not previous]
    approved_others = [r for r in others if r.series_id == series_id and r.rank is not None]
    if decision == "approve" and len(approved_others) >= MAX_APPROVED_PER_SERIES:
        msg = f"{series_id} already has {MAX_APPROVED_PER_SERIES} approved photos"
        raise PhotoError([msg])
    approval = Approval(
        decision=decision,
        by=by,
        at=now().replace(microsecond=0),
        reason=reason,
        user_review="done" if by == "user" else "pending",
    )
    rank = len(approved_others) + 1 if decision == "approve" else None
    if previous is not None:
        same_file = decision == "approve" and previous.approval.decision == "approve"
        record = previous.model_copy(
            update={
                "approval": approval,
                "rank": previous.rank if same_file else rank,
                "files": previous.files if same_file else [],
                "focus": focus or previous.focus,
            }
        )
    else:
        candidate = _candidate(document, series_id, file_title)
        record = PhotoRecord.model_validate(
            {
                "photo_id": next_photo_id(records, series_id),
                "series_id": series_id,
                "rank": rank,
                "file_title": candidate["file_title"],
                "page_url": candidate["page_url"],
                "original_url": candidate["original_url"],
                "original_width": candidate["width"],
                "original_height": candidate["height"],
                "mime": candidate["mime"],
                "commons_sha1": candidate["commons_sha1"],
                "author": candidate["credit"]["author"],
                "author_url": candidate["credit"]["author_url"],
                "licence": candidate["licence"]["licence_id"],
                "licence_name": candidate["licence"]["name"],
                "licence_url": candidate["licence"]["url"],
                "attribution_required": candidate["licence"]["attribution_required"],
                "found_by": candidate["found_by"],
                "retrieved_at": candidate["retrieved_at"] or document["retrieved_at"],
                "focus": focus or (0.5, 0.5),
                "approval": approval.model_dump(),
            }
        )
    updated = _rerank([*others, record], series_id)
    write_photos(path, updated)
    return next(r for r in updated if r.photo_id == record.photo_id)


def _image(body: bytes, mime: str) -> tuple[int, int]:
    with Image.open(io.BytesIO(body)) as image:
        if image.format != _PIL_FORMATS[mime]:
            msg = f"expected {mime}, got {image.format}"
            raise PhotoError([msg])
        image.verify()
        return image.size


def store(
    api_cache: ResearchCache, image_cache: ResearchCache, catalog_dir: Path, photos_dir: Path
) -> int:
    """Download both widths of every approved photo not stored yet; the Commons file must not
    have changed since it was approved (same SHA-1)."""
    path = catalog_dir / PHOTOS_FILE
    records = read_photos(path, _series_ids(catalog_dir))
    todo = [r for r in records if r.approval.decision == "approve" and not r.stored()]
    titles = [r.file_title for r in todo]
    pages = {width: commons.file_pages(api_cache, titles, width=width) for width in (330, 960)}
    stored: dict[str, list[StoredFile]] = {}
    problems: list[str] = []
    for record in todo:
        files: list[StoredFile] = []
        for width, by_title in pages.items():
            info = (by_title.get(record.file_title, {}).get("imageinfo") or [{}])[0]
            if info.get("sha1") != record.commons_sha1:
                problems.append(f"{record.photo_id}: the Commons file changed since approval")
                break
            thumb = commons.without_query(str(info.get("thumburl", "")))
            parsed = urllib.parse.urlsplit(thumb)
            if parsed.scheme != "https" or parsed.hostname not in THUMBNAIL_HOSTS:
                problems.append(f"{record.photo_id}: no thumbnail at {width} px")
                break
            cached = image_cache.get(
                record.series_id, record.file_name(width), thumb,
                licence=record.licence, accept=record.mime,
            )  # fmt: skip
            if len(cached.body) > MAX_IMAGE_BYTES:
                problems.append(f"{record.photo_id}: {width} px copy is too large")
                break
            size = _image(cached.body, record.mime)
            if size[0] != width:
                problems.append(f"{record.photo_id}: {width} px copy is {size[0]} px wide")
                break
            files.append(
                StoredFile(
                    width_class=width, width=size[0], height=size[1],
                    bytes=len(cached.body), sha256=sha256_hex(cached.body),
                )
            )  # fmt: skip
        else:
            stored[record.photo_id] = files
    updated = [r.model_copy(update={"files": stored[r.photo_id]}) if r.photo_id in stored else r
               for r in records]  # fmt: skip
    write_photos(path, updated)
    total = sum(f.bytes for r in updated for f in r.files)
    _print(
        {
            "stored": len(stored),
            "problem_count": len(problems),
            "problems": problems[:SHOWN_PROBLEMS],
            "bytes_on_disk": total,
        }
    )
    return 1 if problems else 0


def check(catalog_dir: Path, photos_dir: Path) -> int:
    try:
        records = read_photos(catalog_dir / PHOTOS_FILE, _series_ids(catalog_dir))
    except PhotoError as error:
        sys.stderr.write(f"{error}\n")
        return 1
    problems = file_problems(photos_dir, records)
    approved = [r for r in records if r.approval.decision == "approve"]
    _print(
        {
            "records": len(records),
            "approved": len(approved),
            "rejected": len(records) - len(approved),
            "series_with_photo": len({r.series_id for r in approved}),
            "licences": dict(Counter(r.licence for r in approved).most_common()),
            "waiting_for_user_review": sum(r.approval.user_review == "pending" for r in records),
            "files": sum(len(r.files) for r in approved),
            "problem_count": len(problems),
            "problems": problems[:SHOWN_PROBLEMS],
        }
    )
    return 1 if problems else 0


def publishable(records: list[PhotoRecord], *, include_pending: bool) -> list[PhotoRecord]:
    """Approved records a maintainer reviewed; ``include_pending`` adds the pre-selected picks."""
    return [
        r
        for r in records
        if r.approval.decision == "approve"
        and (include_pending or r.approval.user_review == "done")
    ]


def load(
    catalog_dir: Path,
    photos_dir: Path,
    database_url: str,
    dry_run: bool,
    *,
    include_pending: bool = False,
) -> int:
    """Make ``vehicle_photo`` exactly the publishable, stored and verified records.

    By default only photos a maintainer approved or reviewed are published; ``include_pending``
    adds the pre-selected picks for development and screenshots.
    """
    records = read_photos(catalog_dir / PHOTOS_FILE, _series_ids(catalog_dir))
    problems = file_problems(photos_dir, records)
    if problems:
        sys.stderr.write("\n".join(problems) + "\n")
        return 1
    rows = publishable(records, include_pending=include_pending)
    waiting = len(publishable(records, include_pending=True)) - len(rows)
    with psycopg.connect(database_url, application_name="gerlines-catalog-photos") as conn:
        written = upsert_photos(conn, rows)
        if dry_run:
            conn.rollback()
    _print(
        {
            "photos": len(rows),
            "left_out_waiting_for_user_review": waiting,
            "written": written,
            "committed": not dry_run,
        }
    )
    return 0


_COLUMNS = (
    "photo_id", "series_id", "rank", "file_title", "page_url", "author", "author_url", "licence",
    "licence_name", "licence_url", "attribution_required", "focus_x", "focus_y", "mime",
    "small_width", "small_height", "small_sha256", "large_width", "large_height", "large_sha256",
    "approved_by", "approved_at", "user_review",
)  # fmt: skip


def _row(record: PhotoRecord) -> tuple:
    files = {f.width_class: f for f in record.files}
    small, large = files[330], files[960]
    return (
        record.photo_id, record.series_id, record.rank, record.file_title, str(record.page_url),
        record.author, str(record.author_url) if record.author_url else None, record.licence,
        record.licence_name, str(record.licence_url) if record.licence_url else None,
        record.attribution_required, record.focus[0], record.focus[1], record.mime,
        small.width, small.height, small.sha256, large.width, large.height, large.sha256,
        record.approval.by, record.approval.at, record.approval.user_review,
    )  # fmt: skip


def upsert_photos(conn: psycopg.Connection, records: list[PhotoRecord]) -> int:
    columns = ", ".join(_COLUMNS)
    placeholders = ", ".join(["%s"] * len(_COLUMNS))
    updates = ", ".join(f"{c} = excluded.{c}" for c in _COLUMNS[1:])
    current = ", ".join(f"vehicle_photo.{c}" for c in _COLUMNS[1:])
    incoming = ", ".join(f"excluded.{c}" for c in _COLUMNS[1:])
    written = 0
    with conn.cursor() as cursor:
        cursor.execute(
            "DELETE FROM vehicle_photo WHERE NOT (photo_id = ANY(%s))",
            ([r.photo_id for r in records],),
        )
        written += cursor.rowcount
        cursor.execute("SET CONSTRAINTS vehicle_photo_series_rank_key DEFERRED")
        for record in records:
            cursor.execute(
                f"INSERT INTO vehicle_photo ({columns}) VALUES ({placeholders})"  # noqa: S608
                f" ON CONFLICT (photo_id) DO UPDATE SET {updates}"
                f" WHERE ({current}) IS DISTINCT FROM ({incoming})",
                _row(record),
            )
            written += cursor.rowcount
    return written
