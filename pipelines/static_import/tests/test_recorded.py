import hashlib
import json
from pathlib import Path

import pytest

from gerlines_static_import.download import read_sidecar
from gerlines_static_import.load import describe_input, published_on
from gerlines_static_import.recorded import (
    RecordedFeedError,
    recorded_feeds,
    stage_recorded,
)

SHARING = "https://www.opendata-oepnv.de/ht/de/datensaetze/sharing?x=1"


def feed_url(monday: str) -> str:
    return (
        "https://www.opendata-oepnv.de/fileadmin/datasets/delfi/"
        f"{monday.replace('-', '')}_fahrplaene_gesamtdeutschland_gtfs.zip"
    )


def record(root: Path, day: str, stamp: str, monday: str, body: bytes) -> Path:
    """One stored DELFI static fetch as the recorder writes it, with the redirect before it."""
    folder = root / "delfi-gtfs" / day
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{stamp}Z-delfi-gtfs.zip"
    (folder / name).write_bytes(body)
    lines = [
        {"type": "fetch", "url": SHARING, "status": 303, "outcome": "redirect"},
        {
            "type": "fetch",
            "url": feed_url(monday),
            "method": "GET",
            "observedAt": f"{day}T19:02:33.008Z",
            "status": 200,
            "headers": {"etag": '"abc"', "last-modified": "Mon, 02 Nov 2026 08:35:14 GMT"},
            "outcome": "stored",
            "sha256": hashlib.sha256(body).hexdigest(),
            "bytes": len(body),
            "object": {"key": f"delfi-gtfs/{day}/{name}", "file": f"delfi-gtfs/{day}/{name}"},
        },
    ]
    with (folder / "day.jsonl").open("a") as out:
        for line in lines:
            out.write(json.dumps(line) + "\n")
    return folder / name


def not_modified(root: Path, day: str, monday: str) -> None:
    folder = root / "delfi-gtfs" / day
    folder.mkdir(parents=True, exist_ok=True)
    line = {"type": "fetch", "url": feed_url(monday), "status": 304, "outcome": "not-modified"}
    (folder / "day.jsonl").write_text(json.dumps(line) + "\n")


@pytest.fixture
def recordings(tmp_path: Path) -> Path:
    root = tmp_path / "recordings"
    record(root, "2026-10-25", "100210", "2026-10-19", b"week-19")
    not_modified(root, "2026-10-26", "2026-10-19")
    record(root, "2026-10-27", "183649", "2026-10-26", b"week-26")
    record(root, "2026-11-05", "190233", "2026-11-02", b"week-02")
    not_modified(root, "2026-11-06", "2026-11-02")
    return root


def test_lists_every_stored_feed_by_its_monday(recordings: Path) -> None:
    feeds = recorded_feeds(recordings)
    assert [f.monday for f in feeds] == ["2026-10-19", "2026-10-26", "2026-11-02"]
    newest = feeds[-1]
    assert newest.path == recordings / "delfi-gtfs/2026-11-05/190233Z-delfi-gtfs.zip"
    assert newest.url == feed_url("2026-11-02")
    assert newest.observed_at == "2026-11-05T19:02:33.008Z"
    assert newest.sha256 == hashlib.sha256(b"week-02").hexdigest()


def test_the_same_monday_stored_twice_keeps_the_first_fetch(recordings: Path) -> None:
    record(recordings, "2026-11-07", "080000", "2026-11-02", b"week-02")
    feeds = recorded_feeds(recordings)
    assert [f.monday for f in feeds] == ["2026-10-19", "2026-10-26", "2026-11-02"]
    assert feeds[-1].observed_at.startswith("2026-11-05")


def test_a_monday_republished_with_other_bytes_takes_the_newest_file(recordings: Path) -> None:
    record(recordings, "2026-11-07", "080000", "2026-11-02", b"week-02-fixed")
    newest = recorded_feeds(recordings)[-1]
    assert newest.sha256 == hashlib.sha256(b"week-02-fixed").hexdigest()
    assert newest.path.name == "080000Z-delfi-gtfs.zip"


def test_stages_the_newest_feed_under_its_monday_with_a_sidecar(
    recordings: Path, tmp_path: Path
) -> None:
    inputs = tmp_path / "inputs"
    result = stage_recorded(recordings, inputs)
    target = inputs / "delfi" / "2026-11-02" / "delfi-gtfs.zip"
    assert result.path == target
    assert not result.reused
    assert target.read_bytes() == b"week-02"
    assert (
        target.stat().st_ino
        == (recordings / "delfi-gtfs/2026-11-05/190233Z-delfi-gtfs.zip").stat().st_ino
    )
    sidecar = read_sidecar(target)
    assert sidecar is not None
    assert sidecar["url"] == feed_url("2026-11-02")
    assert sidecar["fetched_at"] == "2026-11-05T19:02:33.008Z"
    assert sidecar["sha256"] == hashlib.sha256(b"week-02").hexdigest()
    assert sidecar["recorded_object"] == "delfi-gtfs/2026-11-05/190233Z-delfi-gtfs.zip"
    assert sidecar["licence"] == "CC-BY-4.0"
    assert published_on(describe_input(target)).isoformat() == "2026-11-02"


def test_stages_a_chosen_monday_and_reuses_an_intact_copy(recordings: Path, tmp_path: Path) -> None:
    inputs = tmp_path / "inputs"
    first = stage_recorded(recordings, inputs, monday="2026-10-26")
    again = stage_recorded(recordings, inputs, monday="2026-10-26")
    assert first.path == inputs / "delfi" / "2026-10-26" / "delfi-gtfs.zip"
    assert again.reused


def test_refuses_a_recording_whose_bytes_no_longer_match(recordings: Path, tmp_path: Path) -> None:
    (recordings / "delfi-gtfs/2026-11-05/190233Z-delfi-gtfs.zip").write_bytes(b"truncated")
    with pytest.raises(RecordedFeedError, match="sha256"):
        stage_recorded(recordings, tmp_path / "inputs")


def test_refuses_an_unknown_monday(recordings: Path, tmp_path: Path) -> None:
    with pytest.raises(RecordedFeedError, match="2026-11-09"):
        stage_recorded(recordings, tmp_path / "inputs", monday="2026-11-09")


def test_refuses_to_overwrite_another_file_at_the_target(recordings: Path, tmp_path: Path) -> None:
    target = tmp_path / "inputs" / "delfi" / "2026-11-02" / "delfi-gtfs.zip"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"something else")
    with pytest.raises(RecordedFeedError, match="already holds"):
        stage_recorded(recordings, tmp_path / "inputs")
