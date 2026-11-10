"""Vehicle photos: the reviewed records of ``catalog/photos.yaml`` and their local copies.

A record names one Commons file for one series with its full credit (author, licence, links)
and the approval decision (who, when, approve or reject, why). Approved files are stored in
``data/photos/<series_id>/<photo_id>-<width>.<ext>`` at the standard Commons thumbnail widths
330 and 960; the record keeps the SHA-256 of each copy, so the API and the check can prove that
a served file is the one that was approved. The images themselves are never committed.
"""

import hashlib
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import Field, HttpUrl, ValidationError, field_validator, model_validator

from gerlines_catalog.commons import ACCEPTED_MIMES, PUBLIC_DOMAIN, STORED_WIDTHS, page_url
from gerlines_catalog.models import Slug, Strict, Text

PHOTOS_FILE = "photos.yaml"
ALLOWED_LICENCE = re.compile(
    rf"^(CC0-1\.0|{re.escape(PUBLIC_DOMAIN)}|CC-BY(-SA)?-\d\.\d(-[A-Z]{{2,3}})?)$"
)
REVIEWER = re.compile(r"^(user|pick:[A-Za-z0-9.-]{1,40})$")
MAX_APPROVED_PER_SERIES = 2
HEADER = """\
# Vehicle photos from Wikimedia Commons, one record per reviewed file (WP-6.3). Written by
# `gerlines-catalog photos` and the review tool (tools/photo-review); edit decisions there.
# Facts about each file (author, licence, links) come from the Commons API at retrieved_at;
# files stay under their own licence, named per record. Approved files are stored outside git
# in data/photos/ at 330 and 960 px, with the SHA-256 of each copy in files.
"""


class PhotoError(ValueError):
    """The photo records are invalid; ``problems`` lists every finding."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__(f"{len(problems)} problem(s) in {PHOTOS_FILE}:\n" + "\n".join(problems))
        self.problems = problems


Fraction = Annotated[float, Field(ge=0, le=1)]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class Approval(Strict):
    decision: Literal["approve", "reject"]
    by: Annotated[str, Field(pattern=REVIEWER.pattern)]
    at: datetime
    reason: Text
    user_review: Literal["pending", "done"]

    @model_validator(mode="after")
    def _picks_wait_for_the_user(self) -> "Approval":
        if self.by.startswith("pick:") and self.user_review != "pending":
            msg = "a pre-selected pick waits for a maintainer's review"
            raise ValueError(msg)
        if self.by == "user" and self.user_review != "done":
            msg = "a decision by a maintainer is the review"
            raise ValueError(msg)
        return self


class StoredFile(Strict):
    width_class: Literal[330, 960]
    width: Annotated[int, Field(ge=16, le=960)]
    height: Annotated[int, Field(ge=16, le=4000)]
    bytes: Annotated[int, Field(gt=0, le=5_000_000)]
    sha256: Sha256


class PhotoRecord(Strict):
    photo_id: Slug
    series_id: Slug
    rank: Annotated[int, Field(ge=1, le=MAX_APPROVED_PER_SERIES)] | None = None
    file_title: Annotated[
        str, Field(pattern=r"^File:[^|#<>\[\]{}]+\.(?i:jpe?g|png)$", max_length=240)
    ]
    page_url: HttpUrl
    original_url: HttpUrl
    original_width: Annotated[int, Field(ge=960)]
    original_height: Annotated[int, Field(gt=0)]
    mime: Literal["image/jpeg", "image/png"]
    commons_sha1: Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]
    author: Annotated[str, Field(min_length=1, max_length=200)]
    author_url: HttpUrl | None = None
    licence: Text
    licence_name: Text
    licence_url: HttpUrl | None = None
    attribution_required: bool
    found_by: Literal["wikidata-p18", "commons-category"]
    retrieved_at: datetime
    focus: tuple[Fraction, Fraction] = (0.5, 0.5)
    approval: Approval
    files: list[StoredFile] = Field(default_factory=list)

    @field_validator("page_url", "original_url", "author_url", "licence_url")
    @classmethod
    def _https(cls, url: HttpUrl | None) -> HttpUrl | None:
        if url is not None and url.scheme != "https":
            msg = "links must use https"
            raise ValueError(msg)
        return url

    @model_validator(mode="after")
    def _consistent(self) -> "PhotoRecord":
        problems: list[str] = []
        if not ALLOWED_LICENCE.match(self.licence):
            problems.append(f"licence {self.licence} is not CC0, public domain, CC BY or CC BY-SA")
        if self.licence.startswith("CC-BY") and self.licence_url is None:
            problems.append("a CC BY licence needs its link")
        if str(self.page_url) != page_url(self.file_title):
            problems.append("page_url is not the Commons page of file_title")
        if self.original_url.host != "upload.wikimedia.org":
            problems.append("original_url is not on upload.wikimedia.org")
        approved = self.approval.decision == "approve"
        if approved != (self.rank is not None):
            problems.append("rank is given exactly for approved photos")
        if not approved and self.files:
            problems.append("a rejected photo has no stored files")
        classes = [f.width_class for f in self.files]
        if len(classes) != len(set(classes)):
            problems.append("a width class is stored twice")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    @property
    def extension(self) -> str:
        return ACCEPTED_MIMES[self.mime]

    def file_name(self, width_class: int) -> str:
        return f"{self.photo_id}-{width_class}.{self.extension}"

    def stored(self) -> bool:
        return sorted(f.width_class for f in self.files) == list(STORED_WIDTHS)


def read_photos(path: Path, series_ids: set[str] | None = None) -> list[PhotoRecord]:
    """Parse and check ``photos.yaml``; raise ``PhotoError`` with every problem."""
    if not path.is_file():
        return []
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    problems: list[str] = []
    if not isinstance(raw, list):
        raise PhotoError([f"{PHOTOS_FILE}: expected a list of records"])
    records: list[PhotoRecord] = []
    for index, row in enumerate(raw):
        try:
            records.append(PhotoRecord.model_validate(row))
        except ValidationError as error:
            for item in error.errors():
                where = ".".join(str(part) for part in item["loc"]) or "record"
                problems.append(f"{PHOTOS_FILE}[{index}] {where}: {item['msg']}")
    problems += record_problems(records, series_ids)
    if problems:
        raise PhotoError(problems)
    return records


def record_problems(records: list[PhotoRecord], series_ids: set[str] | None) -> list[str]:
    problems: list[str] = []
    seen_ids: set[str] = set()
    seen_files: set[tuple[str, str]] = set()
    ranks: dict[str, list[int]] = {}
    for record in records:
        if record.photo_id in seen_ids:
            problems.append(f"photo {record.photo_id} appears twice")
        seen_ids.add(record.photo_id)
        key = (record.series_id, record.file_title)
        if key in seen_files:
            problems.append(f"{record.file_title} is reviewed twice for {record.series_id}")
        seen_files.add(key)
        if series_ids is not None and record.series_id not in series_ids:
            problems.append(f"photo {record.photo_id}: unknown series {record.series_id}")
        if not record.photo_id.startswith(f"{record.series_id}-"):
            problems.append(f"photo {record.photo_id} does not start with its series id")
        if record.rank is not None:
            ranks.setdefault(record.series_id, []).append(record.rank)
    for series_id, given in ranks.items():
        if sorted(given) != list(range(1, len(given) + 1)):
            problems.append(f"{series_id}: approved ranks must be 1 to {len(given)}, got {given}")
    return problems


def write_photos(path: Path, records: list[PhotoRecord]) -> None:
    rows = [
        record.model_dump(mode="json", exclude_none=True)
        for record in sorted(records, key=lambda r: (r.series_id, r.rank or 99, r.photo_id))
    ]
    for row in rows:
        row["focus"] = list(row["focus"])
    text = yaml.safe_dump(rows, allow_unicode=True, sort_keys=False, width=100)
    handle, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    temporary = Path(name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(HEADER + text)
            out.flush()
            os.fsync(out.fileno())
        temporary.chmod(0o644)
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def next_photo_id(records: list[PhotoRecord], series_id: str) -> str:
    used = {r.photo_id for r in records}
    number = 1
    while f"{series_id}-p{number}" in used:
        number += 1
    return f"{series_id}-p{number}"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stored_path(photos_dir: Path, record: PhotoRecord, width_class: int) -> Path:
    return photos_dir / record.series_id / record.file_name(width_class)


def file_problems(photos_dir: Path, records: list[PhotoRecord]) -> list[str]:
    """Every approved record has both copies on disk with the recorded SHA-256 and credit."""
    problems: list[str] = []
    for record in records:
        if record.approval.decision != "approve":
            continue
        name = record.photo_id
        if not record.author.strip() or not record.licence or not str(record.page_url):
            problems.append(f"{name}: credit incomplete")
        if not record.stored():
            problems.append(f"{name}: not stored at {' and '.join(map(str, STORED_WIDTHS))} px")
        for stored in record.files:
            path = stored_path(photos_dir, record, stored.width_class)
            if not path.is_file():
                problems.append(f"{name}: {path.name} missing")
            elif path.stat().st_size != stored.bytes or sha256_file(path) != stored.sha256:
                problems.append(f"{name}: {path.name} differs from the recorded copy")
    return problems
