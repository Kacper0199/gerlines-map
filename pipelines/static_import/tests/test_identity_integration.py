"""Two real weekly feeds, cut to a few trains each, keep one stop place per station.

The fixtures are the 2026-10-19 and 2026-11-02 DELFI feeds cut by trip: each train keeps the stop
at a station that changed its id between the two and the stops next to it, with the real rows.
"""

import csv
import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import psycopg
import pytest

from gerlines_static_import.categories import TRAIN_CATEGORIES
from gerlines_static_import.load import LoadOptions, run_load

from .conftest import write_zip

FIXTURES = Path(__file__).parent / "fixtures"
SAME_STATION = [
    ("Karlsruhe Westbahnhof", "de:08212:6005_G", "de:08212:6017"),
    ("Weißenstein Bahnhof", "de:08231:3996", "de:08231:332"),
    ("Göttingen platform 4", "de:03152:33817::1", "de:03152:33817"),
    ("Göttingen platform 8", "de:03159:33817::8", "de:03152:33817"),
    ("Speele platform 2", "de:03152:85676::1", "de:03152:85676"),
    ("Speele platform 3", "de:03159:85676::3", "de:03152:85676"),
    ("Riehen", "ch:23005:826", "ch:1:sloid:16764"),
    ("Bernburg (Saale) Paradies", "000000000005_G", "de:15089:6464:1:01"),
    ("Klostermansfeld Randsiedlung", "000008010204", "de:15087:8010204:1:01"),
]

ONLY_IN_THE_NEW_CUT = {"Basel SBB", "Karlsruhe Hauptbahnhof", "Lenglern", "Lüssow"}


def members(name: str) -> dict[str, str]:
    found: dict[str, list[str]] = {}
    current: list[str] = []
    for line in (FIXTURES / name).read_text(encoding="utf-8").splitlines(keepends=True):
        if line.startswith("### "):
            current = found.setdefault(line[4:].strip(), [])
        else:
            current.append(line)
    return {member: "".join(lines) for member, lines in found.items()}


@pytest.fixture
def feeds(data_root: Path) -> tuple[Path, Path]:
    old, new = (
        write_zip(
            data_root / "inputs" / "delfi" / day / "delfi-gtfs.zip",
            members(f"delfi-{day}-rollover.gtfs.txt"),
        )
        for day in ("2026-10-19", "2026-11-02")
    )
    return old, new


@pytest.fixture
def options(
    feeds: tuple[Path, Path], data_root: Path, database_url: str, outline_path: Path
) -> LoadOptions:
    return LoadOptions(
        feed_path=feeds[0],
        database_url=database_url,
        categories=TRAIN_CATEGORIES,
        data_root=data_root,
        report_dir=data_root / "static" / "2026-10-19",
        outline_path=outline_path,
    )


def second(options: LoadOptions, feeds: tuple[Path, Path], **changes: object) -> LoadOptions:
    return replace(
        options,
        feed_path=feeds[1],
        report_dir=options.data_root / "static" / "2026-11-02",
        **changes,
    )


def place_of(conn: psycopg.Connection, point_key: str) -> UUID:
    row = conn.execute(
        """
        SELECT sp.stop_place_id
          FROM id_map m JOIN stop_point sp ON sp.stop_point_id = m.canonical_id
         WHERE m.source_id = 'delfi-gtfs' AND m.entity = 'stop_point' AND m.source_key = %s
        """,
        (point_key,),
    ).fetchone()
    assert row is not None, point_key
    return row[0]


def places_by_version(conn: psycopg.Connection) -> dict[int, set[UUID]]:
    found: dict[int, set[UUID]] = {}
    for version, place in conn.execute(
        """
        SELECT DISTINCT tps.feed_version_id, sp.stop_place_id
          FROM trip_pattern_stop tps JOIN stop_point sp USING (stop_point_id)
        """
    ):
        found.setdefault(version, set()).add(place)
    return found


def test_a_station_keeps_its_stop_place_across_the_rollover(
    options: LoadOptions, feeds: tuple[Path, Path]
) -> None:
    run_load(options)
    report = run_load(second(options, feeds))
    with psycopg.connect(options.database_url) as conn:
        for station, old, new in SAME_STATION:
            assert place_of(conn, old) == place_of(conn, new), station
        assert place_of(conn, "ch:1:sloid:90") != place_of(conn, "ch:23005:6_G_G")
        assert place_of(conn, "de:13072:295:1:9") != place_of(conn, "de:13072:2295:4:4")
        versions = places_by_version(conn)
        new_names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM stop_place WHERE stop_place_id = ANY(%s)",
                (list(versions[2] - versions[1]),),
            )
        }
    assert new_names == {"Basel Bad Bf", "Güstrow, ZOB"} | ONLY_IN_THE_NEW_CUT
    identity = report["stops"]["identity"]
    assert (identity["reused"], identity["folded"], identity["refused"]) == (8, 0, 1)
    assert identity["by_kind"] == {"eva": 2, "name_distance": 6}
    assert identity["by_change"] == {"dhid_renumbered": 2, "id_assigned": 4, "ifopt_reissued": 2}
    with (options.data_root / "static" / "2026-11-02" / "place-identity.csv").open() as handle:
        review = list(csv.DictReader(handle))
    assert {(r["action"], r["key"]) for r in review} >= {
        ("reused", "de:08212:6017"),
        ("refused", "ch:1:sloid:90"),
    }
    first = json.loads(
        (options.data_root / "static" / "2026-10-19" / "load-report.json").read_text()
    )
    assert first["stops"]["identity"]["folded"] == 2


def test_an_override_joins_the_station_split_in_the_new_feed(
    options: LoadOptions, feeds: tuple[Path, Path], tmp_path: Path
) -> None:
    overrides = tmp_path / "overrides.csv"
    overrides.write_text(
        "key,stored,decision,reason\n"
        "ch:1:sloid:90,ch:23005:6,same,one place for DB trains and FlixTrain in 2026-10-19\n"
    )
    run_load(options)
    run_load(second(options, feeds, place_overrides=overrides))
    with psycopg.connect(options.database_url) as conn:
        basel = place_of(conn, "ch:23005:6_G_G")
        assert place_of(conn, "ch:1:sloid:90") == basel
        assert place_of(conn, "ch:23005:6") == basel
        assert conn.execute(
            "SELECT name FROM stop_place WHERE stop_place_id = %s", (basel,)
        ).fetchone() == ("Basel Bad Bf",)


def test_loading_the_new_feed_again_gives_the_same_places(
    options: LoadOptions, feeds: tuple[Path, Path]
) -> None:
    run_load(options)
    run_load(second(options, feeds))
    with psycopg.connect(options.database_url) as conn:
        before = places_by_version(conn)
    run_load(second(options, feeds))
    with psycopg.connect(options.database_url) as conn:
        assert places_by_version(conn) == before


def third(data_root: Path) -> Path:
    """The 2026-11-02 cut with one more train that calls at the old Weißenstein key 3996."""
    found = members("delfi-2026-11-02-rollover.gtfs.txt")
    found["stops.txt"] += (
        "de:08231:3996,,Weißenstein Bahnhof,,48.865207000000,8.676399000000,0,,0,,\n"
    )
    found["trips.txt"] += (
        'de:nvbw:90T74_:_100,988,9999999999,"Nagold Stadtmitte, Bf",017962,1,,79825,0,0\n'
    )
    found["stop_times.txt"] += (
        "9999999999,de:08231:3991,2,0,0,,22:56:00,22:56:00\n"
        "9999999999,de:08231:3996,3,0,0,,22:59:00,22:59:00\n"
        "9999999999,de:08235:9000:1:1,4,0,0,,23:05:00,23:05:00\n"
    )
    return write_zip(data_root / "inputs" / "delfi" / "2026-11-09" / "delfi-gtfs.zip", found)


def test_an_old_key_next_to_its_new_key_folds_into_one_place(
    options: LoadOptions, feeds: tuple[Path, Path]
) -> None:
    run_load(options)
    run_load(second(options, feeds))
    report = run_load(
        replace(
            options,
            feed_path=third(options.data_root),
            report_dir=options.data_root / "static" / "2026-11-09",
        )
    )
    with psycopg.connect(options.database_url) as conn:
        assert place_of(conn, "de:08231:3996") == place_of(conn, "de:08231:332")
    with (options.data_root / "static" / "2026-11-09" / "place-identity.csv").open() as handle:
        review = list(csv.DictReader(handle))
    assert [
        (r["action"], r["kind"]) for r in review if r["key"] in {"de:08231:3996", "de:08231:332"}
    ] == [("folded", "same_identity")]
    assert report["stops"]["identity"]["by_kind"].get("same_identity") == 1


def test_separate_after_an_assigned_dhid_gives_the_place_its_own_identity(
    options: LoadOptions, feeds: tuple[Path, Path], tmp_path: Path
) -> None:
    run_load(options)
    run_load(second(options, feeds))
    overrides = tmp_path / "overrides.csv"
    overrides.write_text(
        "key,stored,decision,reason\nde:15087:8010204,000008010204,separate,test\n"
    )
    report = run_load(second(options, feeds, place_overrides=overrides))
    with psycopg.connect(options.database_url) as conn:
        old = place_of(conn, "000008010204")
        new = place_of(conn, "de:15087:8010204:1:01")
        assert old != new
        assert conn.execute(
            "SELECT dhid FROM stop_place WHERE stop_place_id = %s", (old,)
        ).fetchone() == (None,)
        assert conn.execute(
            "SELECT dhid FROM stop_place WHERE stop_place_id = %s", (new,)
        ).fetchone() == ("de:15087:8010204",)
    assert report["stops"]["identity"]["separated"] == 1
    assert report["stops"]["identity"]["ids_released"] == 1


def test_a_separated_key_maps_to_its_own_place_and_stays_apart(
    options: LoadOptions, feeds: tuple[Path, Path], tmp_path: Path
) -> None:
    run_load(options)
    run_load(second(options, feeds))
    overrides = tmp_path / "overrides.csv"
    overrides.write_text("key,stored,decision,reason\nde:08231:332,de:08231:3996,separate,test\n")
    separate = run_load(second(options, feeds, place_overrides=overrides))
    assert separate["stops"]["identity"]["keys_remapped"] == 1
    with psycopg.connect(options.database_url) as conn:
        separated = place_of(conn, "de:08231:332")
        assert separated != place_of(conn, "de:08231:3996")
        assert conn.execute(
            "SELECT canonical_id FROM id_map WHERE source_id = 'delfi-gtfs'"
            " AND entity = 'stop_place' AND source_key = 'de:08231:332'"
        ).fetchone() == (separated,)
    report = run_load(second(options, feeds))
    with psycopg.connect(options.database_url) as conn:
        assert place_of(conn, "de:08231:332") == separated
    assert report["stops"]["id_map_conflicts"]["stop_place"] == 0
