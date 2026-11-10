import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
import yaml

from gerlines_catalog.cache import sha256_hex
from gerlines_catalog.photo_commands import CANDIDATES_FILE, check, decide, publishable
from gerlines_catalog.photos import (
    PHOTOS_FILE,
    PhotoError,
    PhotoRecord,
    StoredFile,
    file_problems,
    read_photos,
    stored_path,
    write_photos,
)

NOW = datetime(2026, 11, 8, 2, 30, tzinfo=UTC)


def candidate(title: str = "File:ICE 3 in Köln.jpg", **changes: object) -> dict:
    name = title.removeprefix("File:").replace(" ", "_")
    return {
        "series_id": "db-403",
        "file_title": title,
        "page_url": "https://commons.wikimedia.org/wiki/File:" + name.replace("ö", "%C3%B6"),
        "original_url": f"https://upload.wikimedia.org/wikipedia/commons/a/ab/{name}",
        "width": 4000,
        "height": 2667,
        "mime": "image/jpeg",
        "commons_sha1": "a" * 40,
        "licence": {
            "licence_id": "CC-BY-SA-4.0",
            "name": "CC BY-SA 4.0",
            "url": "https://creativecommons.org/licenses/by-sa/4.0",
            "attribution_required": True,
        },
        "credit": {"author": "Rail Fan", "author_url": None},
        "found_by": "wikidata-p18",
        "description": "",
        "assessments": [],
        "thumb_url": None,
        "score": 5.0,
        "retrieved_at": "2026-11-08T01:11:08+00:00",
        **changes,
    }


@pytest.fixture
def folders(catalog_copy: Path, tmp_path: Path) -> tuple[Path, Path]:
    photos = tmp_path / "photos"
    photos.mkdir()
    document = {
        "retrieved_at": "2026-11-08T02:00:00+00:00",
        "series": [
            {
                "series_id": "db-403",
                "candidates": [
                    candidate(),
                    candidate("File:ICE 3 Second.jpg"),
                    candidate("File:ICE 3 Third.jpg"),
                ],
            }
        ],
    }
    (photos / CANDIDATES_FILE).write_text(json.dumps(document))
    (catalog_copy / PHOTOS_FILE).unlink(missing_ok=True)
    return catalog_copy, photos


def approve(catalog: Path, photos: Path, title: str, decision: str = "approve") -> PhotoRecord:
    return decide(
        catalog, photos, series_id="db-403", file_title=title, decision=decision,
        reason="side view of a whole unit in daylight", by="pick:A5", now=lambda: NOW,
    )  # fmt: skip


def test_decisions_are_recorded_with_rank_and_credit(folders: tuple[Path, Path]) -> None:
    catalog, photos = folders
    first = approve(catalog, photos, "File:ICE 3 in Köln.jpg")
    second = approve(catalog, photos, "File:ICE 3 Second.jpg")
    assert (first.photo_id, first.rank, second.rank) == ("db-403-p1", 1, 2)
    assert first.approval.user_review == "pending"
    assert first.author == "Rail Fan"
    assert str(first.page_url) == "https://commons.wikimedia.org/wiki/File:ICE_3_in_K%C3%B6ln.jpg"
    with pytest.raises(PhotoError, match="already has 2 approved"):
        approve(catalog, photos, "File:ICE 3 Third.jpg")
    approve(catalog, photos, "File:ICE 3 in Köln.jpg", "reject")
    records = {r.photo_id: r for r in read_photos(catalog / PHOTOS_FILE)}
    assert records["db-403-p1"].rank is None
    assert records["db-403-p2"].rank == 1
    text = (catalog / PHOTOS_FILE).read_text()
    assert text.startswith("# Vehicle photos from Wikimedia Commons")


def test_the_users_decision_closes_the_review(folders: tuple[Path, Path]) -> None:
    catalog, photos = folders
    approve(catalog, photos, "File:ICE 3 in Köln.jpg")
    record = decide(
        catalog, photos, series_id="db-403", file_title="File:ICE 3 in Köln.jpg",
        decision="approve", reason="checked", by="user", focus=(0.5, 0.6), now=lambda: NOW,
    )  # fmt: skip
    assert record.approval.user_review == "done"
    assert record.focus == (0.5, 0.6)
    assert record.rank == 1


def test_concurrent_decisions_are_all_kept(
    folders: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    import time  # noqa: PLC0415
    from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415

    from gerlines_catalog import photo_commands  # noqa: PLC0415

    catalog, photos = folders
    slow_read = photo_commands.read_candidates

    def read_slowly(folder: Path) -> dict:
        time.sleep(0.05)
        return slow_read(folder)

    monkeypatch.setattr(photo_commands, "read_candidates", read_slowly)
    titles = ["File:ICE 3 in Köln.jpg", "File:ICE 3 Second.jpg", "File:ICE 3 Third.jpg"]
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda title: approve(catalog, photos, title, "reject"), titles))
    assert sorted(r.file_title for r in read_photos(catalog / PHOTOS_FILE)) == sorted(titles)


def test_a_failed_write_leaves_the_last_photos_file(
    folders: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog, photos = folders
    approve(catalog, photos, "File:ICE 3 in Köln.jpg")
    before = (catalog / PHOTOS_FILE).read_text()

    def broken(*_args: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(Path, "replace", broken)
    with pytest.raises(OSError, match="No space left"):
        approve(catalog, photos, "File:ICE 3 Second.jpg")
    assert (catalog / PHOTOS_FILE).read_text() == before
    assert sorted(p.name for p in catalog.iterdir() if p.name.startswith(PHOTOS_FILE)) == [
        PHOTOS_FILE
    ]


def test_unknown_candidates_and_series_are_refused(folders: tuple[Path, Path]) -> None:
    catalog, photos = folders
    with pytest.raises(PhotoError, match="not a candidate"):
        approve(catalog, photos, "File:Elsewhere.jpg")
    record = approve(catalog, photos, "File:ICE 3 in Köln.jpg")
    rows = yaml.safe_load((catalog / PHOTOS_FILE).read_text())
    rows[0]["series_id"] = "db-999"
    rows[0]["photo_id"] = "db-999-p1"
    (catalog / PHOTOS_FILE).write_text(yaml.safe_dump(rows))
    with pytest.raises(PhotoError, match="unknown series db-999"):
        read_photos(catalog / PHOTOS_FILE, {record.series_id})


def record(**changes: object) -> dict:
    base = {
        "photo_id": "db-403-p1",
        "series_id": "db-403",
        "rank": 1,
        "file_title": "File:ICE 3.jpg",
        "page_url": "https://commons.wikimedia.org/wiki/File:ICE_3.jpg",
        "original_url": "https://upload.wikimedia.org/wikipedia/commons/a/ab/ICE_3.jpg",
        "original_width": 4000,
        "original_height": 2667,
        "mime": "image/jpeg",
        "commons_sha1": "a" * 40,
        "author": "Rail Fan",
        "licence": "CC-BY-SA-4.0",
        "licence_name": "CC BY-SA 4.0",
        "licence_url": "https://creativecommons.org/licenses/by-sa/4.0",
        "attribution_required": True,
        "found_by": "wikidata-p18",
        "retrieved_at": "2026-11-08T02:00:00Z",
        "approval": {
            "decision": "approve",
            "by": "pick:A5",
            "at": "2026-11-08T02:30:00Z",
            "reason": "whole unit",
            "user_review": "pending",
        },
    }
    return {**base, **changes}


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"licence": "CC-BY-ND-4.0"}, "is not CC0, public domain, CC BY or CC BY-SA"),
        ({"licence": "GFDL-1.2"}, "is not CC0"),
        ({"licence_url": None}, "needs its link"),
        ({"page_url": "https://commons.wikimedia.org/wiki/File:Other.jpg"}, "Commons page"),
        ({"original_url": "https://example.org/a.jpg"}, "upload.wikimedia.org"),
        ({"rank": None}, "rank is given exactly"),
        ({"author_url": "http://example.org/user"}, "https"),
        ({"author": ""}, "at least 1 character"),
        ({"file_title": "File:ICE 3.svg"}, "pattern"),
        ({"approval": {**record()["approval"], "user_review": "done"}}, "waits for a maintainer"),
        ({"approval": {**record()["approval"], "by": "someone"}}, "pattern"),
    ],
)
def test_records_that_break_the_rules_are_refused(changes: dict, problem: str) -> None:
    with pytest.raises(ValueError, match=problem):
        PhotoRecord.model_validate(record(**changes))


def test_public_domain_needs_no_link() -> None:
    row = record(licence="LicenseRef-Public-Domain", licence_name="Public domain", licence_url=None)
    assert PhotoRecord.model_validate(row).licence_url is None


def store_copies(photos: Path, row: PhotoRecord) -> PhotoRecord:
    files = []
    for width in (330, 960):
        body = f"image {width}".encode()
        path = stored_path(photos, row, width)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        files.append(StoredFile(width_class=width, width=width, height=width * 2 // 3,
                                bytes=len(body), sha256=sha256_hex(body)))  # fmt: skip
    return row.model_copy(update={"files": files})


def test_the_check_proves_every_copy(tmp_path: Path) -> None:
    row = PhotoRecord.model_validate(record())
    assert file_problems(tmp_path, [row]) == ["db-403-p1: not stored at 330 and 960 px"]
    stored = store_copies(tmp_path, row)
    assert file_problems(tmp_path, [stored]) == []
    stored_path(tmp_path, stored, 960).write_bytes(b"swapped")
    assert file_problems(tmp_path, [stored]) == [
        "db-403-p1: db-403-p1-960.jpg differs from the recorded copy"
    ]
    stored_path(tmp_path, stored, 330).unlink()
    assert "db-403-p1: db-403-p1-330.jpg missing" in file_problems(tmp_path, [stored])


def test_check_command_counts_licences(folders: tuple[Path, Path], capsys) -> None:
    catalog, photos = folders
    row = store_copies(photos, PhotoRecord.model_validate(record()))
    write_photos(catalog / PHOTOS_FILE, [row])
    assert check(catalog, photos) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["licences"] == {"CC-BY-SA-4.0": 1}
    assert report["waiting_for_user_review"] == 1
    assert report["files"] == 2


def test_loading_photos_twice_writes_once_and_prunes(database_url: str, tmp_path: Path) -> None:
    import psycopg  # noqa: PLC0415

    from gerlines_catalog.load import load  # noqa: PLC0415
    from gerlines_catalog.photo_commands import upsert_photos  # noqa: PLC0415
    from gerlines_catalog.seeds import read_catalog  # noqa: PLC0415

    from .conftest import CATALOG  # noqa: PLC0415

    first = store_copies(tmp_path, PhotoRecord.model_validate(record()))
    second = store_copies(
        tmp_path,
        PhotoRecord.model_validate(record(photo_id="db-403-p2", rank=2, file_title="File:B.jpg",
                                          page_url="https://commons.wikimedia.org/wiki/File:B.jpg")),
    )  # fmt: skip
    with psycopg.connect(database_url) as conn:
        load(conn, read_catalog(CATALOG))
        assert upsert_photos(conn, [first, second]) == 2
        assert upsert_photos(conn, [first, second]) == 0
        swapped = [
            second.model_copy(update={"rank": 1}),
            first.model_copy(update={"rank": 2}),
        ]
        assert upsert_photos(conn, swapped) == 2
        assert upsert_photos(conn, [first]) == 2
        rows = conn.execute(
            "SELECT photo_id, rank, licence, user_review FROM vehicle_photo"
        ).fetchall()
    assert rows == [("db-403-p1", 1, "CC-BY-SA-4.0", "pending")]


def reviewed(**changes: object) -> dict:
    approval = {**record()["approval"], "by": "user", "user_review": "done"}
    return record(**{"approval": approval, **changes})


def test_only_photos_the_user_reviewed_are_published_by_default() -> None:
    pick = PhotoRecord.model_validate(record())
    user = PhotoRecord.model_validate(
        reviewed(photo_id="db-403-p2", rank=2, file_title="File:B.jpg",
                 page_url="https://commons.wikimedia.org/wiki/File:B.jpg"),
    )  # fmt: skip
    rejected = PhotoRecord.model_validate(
        reviewed(photo_id="db-403-p3", rank=None, file_title="File:C.jpg",
                 page_url="https://commons.wikimedia.org/wiki/File:C.jpg",
                 approval={**reviewed()["approval"], "decision": "reject"}),
    )  # fmt: skip
    assert publishable([pick, user, rejected], include_pending=False) == [user]
    assert publishable([pick, user, rejected], include_pending=True) == [pick, user]


def test_load_skips_pending_picks_unless_asked(
    folders: tuple[Path, Path], database_url: str, capsys
) -> None:
    import psycopg  # noqa: PLC0415

    from gerlines_catalog.load import load as load_catalog  # noqa: PLC0415
    from gerlines_catalog.photo_commands import load  # noqa: PLC0415
    from gerlines_catalog.seeds import read_catalog  # noqa: PLC0415

    catalog, photos = folders
    pick = store_copies(photos, PhotoRecord.model_validate(record()))
    user = store_copies(
        photos,
        PhotoRecord.model_validate(
            reviewed(photo_id="db-403-p2", rank=2, file_title="File:B.jpg",
                     page_url="https://commons.wikimedia.org/wiki/File:B.jpg"),
        ),
    )  # fmt: skip
    write_photos(catalog / PHOTOS_FILE, [pick, user])
    with psycopg.connect(database_url) as conn:
        load_catalog(conn, read_catalog(catalog))
    assert load(catalog, photos, database_url, dry_run=False) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["photos"] == 1
    assert report["left_out_waiting_for_user_review"] == 1
    with psycopg.connect(database_url) as conn:
        rows = conn.execute("SELECT photo_id FROM vehicle_photo ORDER BY photo_id").fetchall()
    assert rows == [("db-403-p2",)]
    assert load(catalog, photos, database_url, dry_run=False, include_pending=True) == 0
    assert json.loads(capsys.readouterr().out)["left_out_waiting_for_user_review"] == 0
    with psycopg.connect(database_url) as conn:
        rows = conn.execute("SELECT photo_id FROM vehicle_photo ORDER BY photo_id").fetchall()
    assert rows == [("db-403-p1",), ("db-403-p2",)]


def test_a_pick_waits_for_the_user_review() -> None:
    approval = {**record()["approval"], "user_review": "done"}
    with pytest.raises(ValueError, match="a pre-selected pick waits for a maintainer's review"):
        PhotoRecord.model_validate(record(approval=approval))


def test_the_old_reviewer_prefix_is_refused() -> None:
    approval = {**record()["approval"], "by": "agent:A5"}
    with pytest.raises(ValueError, match="by"):
        PhotoRecord.model_validate(record(approval=approval))


def test_migration_0097_renames_the_pick_prefix_both_ways(
    folders: tuple[Path, Path], database_url: str, capsys
) -> None:
    import psycopg  # noqa: PLC0415

    from gerlines_catalog.load import load as load_catalog  # noqa: PLC0415
    from gerlines_catalog.photo_commands import load  # noqa: PLC0415
    from gerlines_catalog.seeds import read_catalog  # noqa: PLC0415
    from gerlines_common import migration_statements  # noqa: PLC0415

    catalog, photos = folders
    pick = store_copies(photos, PhotoRecord.model_validate(record()))
    write_photos(catalog / PHOTOS_FILE, [pick])
    with psycopg.connect(database_url) as conn:
        load_catalog(conn, read_catalog(catalog))
    assert load(catalog, photos, database_url, dry_run=False, include_pending=True) == 0
    capsys.readouterr()
    migrations = Path(__file__).resolve().parents[3] / "packages" / "db" / "migrations"

    def run(name: str) -> str:
        with psycopg.connect(database_url, autocommit=True) as conn:
            for statement in migration_statements((migrations / name).read_text()):
                conn.execute(statement)
            return conn.execute("SELECT approved_by FROM vehicle_photo").fetchone()[0]

    assert run("0097_photo_pick_prefix.down.sql") == "agent:A5"
    assert run("0097_photo_pick_prefix.up.sql") == "pick:A5"
    with psycopg.connect(database_url) as conn, pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("UPDATE vehicle_photo SET approved_by = 'robot:A5'")
