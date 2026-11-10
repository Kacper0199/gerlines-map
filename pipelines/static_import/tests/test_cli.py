import argparse
import csv
import hashlib
import json
from pathlib import Path

import pytest

from gerlines_static_import.categories import Category
from gerlines_static_import.cli import (
    MissingDatabaseError,
    database_url,
    main,
    parse_categories,
)


def test_parses_category_sets() -> None:
    assert parse_categories("hsr, ld") == frozenset({Category.HSR, Category.LD})
    with pytest.raises(argparse.ArgumentTypeError, match="unknown category"):
        parse_categories("hsr,tram")


def test_load_needs_an_explicit_database_url() -> None:
    assert database_url({"DATABASE_URL": "postgresql://u@h:1/d"}) == "postgresql://u@h:1/d"
    with pytest.raises(MissingDatabaseError, match="DATABASE_URL"):
        database_url({"POSTGRES_DB": "gerlines"})
    with pytest.raises(MissingDatabaseError):
        database_url({"DATABASE_URL": "  "})


def test_inventory_lists_combinations_and_passes_without_fallbacks(
    mini_feed: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "inventory.csv"
    assert main(["inventory", str(mini_feed), "--out", str(out)]) == 0
    with out.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert {row["category"] for row in rows} == {"hsr", "rfast", "night", "bus"}
    assert "0 by fallback" in capsys.readouterr().out


def test_enrich_and_subset_write_their_reports(mini_feed: Path, data_root: Path) -> None:
    assert main(["--data", str(data_root), "enrich", str(mini_feed)]) == 0
    assert main(["--data", str(data_root), "subset", str(mini_feed), "--categories", "night"]) == 0
    out = data_root / "static" / "2026-10-19"
    assert (out / "delfi-gtfs-enriched.zip").is_file()
    report = json.loads((out / "delfi-gtfs-trains-report.json").read_text())
    assert report["rows"]["trips.txt"] == 1


def test_subset_takes_a_trip_list(mini_feed: Path, data_root: Path, tmp_path: Path) -> None:
    trips = tmp_path / "trips.txt"
    trips.write_text("t2\n\nt3\n")
    argv = ["--data", str(data_root), "subset", str(mini_feed), "--trips", str(trips)]
    assert main([*argv, "--name", "new-patterns.zip"]) == 0
    report = json.loads(
        (data_root / "static" / "2026-10-19" / "new-patterns-report.json").read_text()
    )
    assert report["rows"]["trips.txt"] == 2


def test_stage_recorded_links_the_newest_feed(
    data_root: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    day = data_root / "recordings" / "delfi-gtfs" / "2026-11-05"
    day.mkdir(parents=True)
    (day / "190233Z-delfi-gtfs.zip").write_bytes(b"feed")
    url = "https://www.opendata-oepnv.de/fileadmin/datasets/delfi/20261102_fahrplaene_gesamtdeutschland_gtfs.zip"
    line = {
        "outcome": "stored",
        "url": url,
        "observedAt": "2026-11-05T19:02:33.008Z",
        "sha256": hashlib.sha256(b"feed").hexdigest(),
        "bytes": 4,
        "object": {"key": "delfi-gtfs/2026-11-05/190233Z-delfi-gtfs.zip"},
    }
    (day / "day.jsonl").write_text(json.dumps(line) + "\n")
    assert main(["--data", str(data_root), "stage-recorded"]) == 0
    assert (
        data_root / "inputs" / "delfi" / "2026-11-02" / "delfi-gtfs.zip"
    ).read_bytes() == b"feed"
    assert "staged 2026-11-02" in capsys.readouterr().out


def test_load_command_writes_the_report(
    mini_feed: Path,
    mini_mirror: Path,
    outline_path: Path,
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_root = mini_feed.parents[3]
    monkeypatch.setenv("DATABASE_URL", database_url)
    args = ["--data", str(data_root), "load", str(mini_feed), "--eva", str(mini_mirror)]
    code = main([*args, "--outline", str(outline_path)])
    assert code == 0
    report = json.loads((data_root / "static" / "2026-10-19" / "load-report.json").read_text())
    assert report["stored"]["trips"] == {"hsr": 2, "rfast": 1, "night": 1}
    assert (data_root / "static" / "2026-10-19" / "eva-review.csv").is_file()
