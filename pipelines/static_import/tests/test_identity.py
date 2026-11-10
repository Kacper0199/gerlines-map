from pathlib import Path
from uuid import UUID

import pytest

from gerlines_static_import.categories import TRAIN_CATEGORIES
from gerlines_static_import.identity import (
    Override,
    OverrideError,
    StoredPlace,
    identity_tokens,
    read_overrides,
    resolve_identity,
    write_identity_review,
)
from gerlines_static_import.ids import canonical_id
from gerlines_static_import.load import LoadOptions, run_load
from gerlines_static_import.stops import (
    KnownIds,
    StopModel,
    StopRow,
    assign_canonical_ids,
    build_model,
)

SOURCE = "delfi-gtfs"


def row(stop_id: str, name: str, lat: float, lon: float) -> StopRow:
    return StopRow(stop_id, name, lat, lon, 0, "", "")


def feed(*rows: StopRow) -> StopModel:
    model = build_model({r.stop_id: r for r in rows}, [r.stop_id for r in rows])
    assign_canonical_ids(model, SOURCE, KnownIds())
    return model


def stored(  # noqa: PLR0913
    key: str,
    name: str,
    lat: float,
    lon: float,
    *,
    dhid: str | None = None,
    ifopt: str | None = None,
    eva: int | None = None,
) -> StoredPlace:
    natural = f"dhid:{dhid}" if dhid else f"ifopt:{ifopt}" if ifopt else f"{SOURCE}:{key}"
    return StoredPlace(
        stop_place_id=canonical_id("stop_place", natural),
        name=name,
        lat=lat,
        lon=lon,
        dhid=dhid,
        ifopt=ifopt,
        eva=eva,
        keys=(key,),
    )


def place_of(model: StopModel, point_key: str) -> UUID | None:
    return model.place_of_point(point_key).canonical


WEISSENSTEIN = stored(
    "de:08231:3996", "Weißenstein Bahnhof", 48.865207, 8.676399, dhid="de:08231:3996", eva=8004801
)
KARLSRUHE_WEST = stored(
    "de:08212:6005", "Karlsruhe Westbahnhof", 49.001618, 8.363105, dhid="de:08212:6005"
)
GOETTINGEN = stored(
    "de:03159:33817", "Göttingen", 51.536700, 9.925800, dhid="de:03159:33817", eva=8000128
)
RIEHEN = stored("ch:23005:826", "Riehen", 47.583330, 7.649720, ifopt="ch:23005:826")
BASEL_BAD = stored("ch:23005:6", "Basel Bad Bf", 47.567288, 7.607805, ifopt="ch:23005:6")
KLOSTERMANSFELD = stored("000008010204", "Gleis 1", 51.580000, 11.490000, eva=8010204)


def test_a_renumbered_dhid_at_the_same_point_keeps_the_stored_place() -> None:
    model = feed(row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399))
    result = resolve_identity(model, [WEISSENSTEIN], [], source_id=SOURCE)
    assert place_of(model, "de:08231:332") == WEISSENSTEIN.stop_place_id
    [match] = result.matches
    assert (match.kind, match.action, match.change) == (
        "name_distance",
        "reused",
        "dhid_renumbered",
    )
    assert match.distance_m == 0.0


def test_a_renumbered_dhid_61_m_away_keeps_the_stored_place() -> None:
    model = feed(row("de:08212:6017", "Karlsruhe Westbahnhof", 49.002159, 8.362951))
    resolve_identity(model, [KARLSRUHE_WEST], [], source_id=SOURCE)
    assert place_of(model, "de:08212:6017") == KARLSRUHE_WEST.stop_place_id


def test_a_dhid_under_another_district_key_is_the_same_station() -> None:
    model = feed(row("de:03152:33817", "Göttingen", 51.536815, 9.926072))
    result = resolve_identity(model, [GOETTINGEN], [], source_id=SOURCE)
    assert place_of(model, "de:03152:33817") == GOETTINGEN.stop_place_id
    assert [(m.kind, m.change) for m in result.matches] == [("dhid_district", "dhid_district")]


def test_a_dhid_district_twin_250_m_away_and_named_alike_is_still_matched() -> None:
    model = feed(row("de:03152:33817", "Göttingen", 51.5390, 9.9258))
    resolve_identity(model, [GOETTINGEN], [], source_id=SOURCE)
    assert place_of(model, "de:03152:33817") == GOETTINGEN.stop_place_id


def test_district_twins_in_one_feed_fold_into_one_place() -> None:
    model = feed(
        row("de:03152:33817", "Göttingen", 51.536815, 9.926072),
        row("de:03152:33817::1", "Göttingen", 51.536683, 9.926424),
        row("de:03159:33817::5", "Göttingen", 51.536711, 9.926303),
        row("de:03159:33817::6", "Göttingen", 51.536539, 9.925908),
    )
    result = resolve_identity(model, [], [], source_id=SOURCE)
    assert set(model.places) == {"de:03152:33817"}
    assert model.merged == {"de:03159:33817": "de:03152:33817"}
    assert place_of(model, "de:03159:33817::5") == place_of(model, "de:03152:33817::1")
    assert [(m.kind, m.action, m.key) for m in result.matches] == [
        ("dhid_district", "folded", "de:03159:33817")
    ]


def test_a_district_twin_fold_keeps_the_stored_identity_of_either_place() -> None:
    model = feed(
        row("de:03152:33817", "Göttingen", 51.536815, 9.926072),
        row("de:03159:33817::5", "Göttingen", 51.536711, 9.926303),
    )
    model.places["de:03159:33817"].canonical = GOETTINGEN.stop_place_id
    resolve_identity(model, [GOETTINGEN], [], source_id=SOURCE)
    assert place_of(model, "de:03159:33817::5") == GOETTINGEN.stop_place_id
    assert place_of(model, "de:03152:33817") == GOETTINGEN.stop_place_id


def test_a_reissued_ifopt_keeps_the_stored_place() -> None:
    model = feed(row("ch:1:sloid:16764", "Riehen", 47.583330, 7.649720))
    result = resolve_identity(model, [RIEHEN], [], source_id=SOURCE)
    assert place_of(model, "ch:1:sloid:16764") == RIEHEN.stop_place_id
    assert result.matches[0].change == "ifopt_reissued"


def test_bahnhof_in_one_name_only_still_names_the_same_station() -> None:
    niederholz = stored("ch:23005:827", "Riehen Niederholz", 47.5732, 7.6420, ifopt="ch:23005:827")
    model = feed(row("ch:1:sloid:17010", "Riehen Bahnhof Niederholz", 47.5732, 7.6420))
    resolve_identity(model, [niederholz], [], source_id=SOURCE)
    assert place_of(model, "ch:1:sloid:17010") == niederholz.stop_place_id


def test_an_eva_number_both_keys_carry_matches_whatever_the_names() -> None:
    model = feed(row("de:15087:8010204", "Klostermansfeld Randsiedlung", 51.580000, 11.490000))
    result = resolve_identity(model, [KLOSTERMANSFELD], [], source_id=SOURCE)
    assert place_of(model, "de:15087:8010204") == KLOSTERMANSFELD.stop_place_id
    assert (result.matches[0].kind, result.matches[0].change) == ("eva", "id_assigned")


def test_an_eva_number_of_the_spatial_join_alone_is_no_key() -> None:
    model = feed(row("de:13072:295", "Güstrow, ZOB", 53.7945, 12.1760))
    model.places["de:13072:295"].eva = 8010153
    station = stored(
        "de:13072:2295", "Güstrow Bahnhof", 53.7940, 12.1760, dhid="de:13072:2295", eva=8010153
    )
    result = resolve_identity(model, [station], [], source_id=SOURCE)
    assert place_of(model, "de:13072:295") != station.stop_place_id
    assert result.matches == []


def test_a_lone_place_that_gained_a_dhid_keeps_its_identity() -> None:
    lone = stored("000000000005_G", "Bernburg (Saale) Paradies", 51.7930, 11.7370)
    model = feed(row("de:15089:6464", "Bernburg (Saale) Paradies", 51.7930, 11.7370))
    result = resolve_identity(model, [lone], [], source_id=SOURCE)
    assert place_of(model, "de:15089:6464") == lone.stop_place_id
    assert result.matches[0].change == "id_assigned"


def test_a_stored_place_another_place_of_the_feed_holds_is_never_taken() -> None:
    model = feed(
        row("ch:23005:6", "Basel Bad Bf (FlixTrain)", 47.567793, 7.606924),
        row("ch:1:sloid:90", "Basel Bad Bf", 47.567288, 7.607805),
    )
    model.places["ch:23005:6"].canonical = BASEL_BAD.stop_place_id
    result = resolve_identity(model, [BASEL_BAD], [], source_id=SOURCE)
    assert place_of(model, "ch:1:sloid:90") != BASEL_BAD.stop_place_id
    [match] = result.matches
    assert (match.action, match.key, match.note) == (
        "refused",
        "ch:1:sloid:90",
        "held by ch:23005:6",
    )


def test_an_override_folds_a_split_station_into_the_stored_place() -> None:
    model = feed(
        row("ch:23005:6", "Basel Bad Bf (FlixTrain)", 47.567793, 7.606924),
        row("ch:1:sloid:90", "Basel Bad Bf", 47.567288, 7.607805),
    )
    model.places["ch:23005:6"].canonical = BASEL_BAD.stop_place_id
    override = Override(
        "ch:1:sloid:90", "ch:23005:6", "same", "one station, FlixTrain stop split off"
    )
    result = resolve_identity(model, [BASEL_BAD], [override], source_id=SOURCE)
    assert set(model.places) == {"ch:1:sloid:90"}
    assert model.places["ch:1:sloid:90"].canonical == BASEL_BAD.stop_place_id
    assert place_of(model, "ch:23005:6") == BASEL_BAD.stop_place_id
    assert model.merged == {"ch:23005:6": "ch:1:sloid:90"}
    assert [(m.kind, m.action) for m in result.matches] == [("override", "folded")]


def test_an_override_names_the_stored_place_by_uuid_or_dhid() -> None:
    model = feed(row("de:08212:6017", "Karlsruhe-Mühlburg", 49.0100, 8.3600))
    by_dhid = Override("de:08212:6017", "de:08212:6005", "same", "reviewed")
    resolve_identity(model, [KARLSRUHE_WEST], [by_dhid], source_id=SOURCE)
    assert place_of(model, "de:08212:6017") == KARLSRUHE_WEST.stop_place_id
    model = feed(row("de:08212:6017", "Karlsruhe-Mühlburg", 49.0100, 8.3600))
    by_id = Override("de:08212:6017", str(KARLSRUHE_WEST.stop_place_id), "same", "reviewed")
    resolve_identity(model, [KARLSRUHE_WEST], [by_id], source_id=SOURCE)
    assert place_of(model, "de:08212:6017") == KARLSRUHE_WEST.stop_place_id


def test_a_separate_override_keeps_a_matching_pair_apart() -> None:
    model = feed(row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399))
    override = Override("de:08231:332", "de:08231:3996", "separate", "reviewed")
    result = resolve_identity(model, [WEISSENSTEIN], [override], source_id=SOURCE)
    assert place_of(model, "de:08231:332") != WEISSENSTEIN.stop_place_id
    assert [(m.action, m.note) for m in result.matches] == [("refused", "separate by override")]


def test_a_separate_override_undoes_a_merge_an_earlier_load_made() -> None:
    model = feed(row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399))
    model.places["de:08231:332"].canonical = WEISSENSTEIN.stop_place_id
    override = Override("de:08231:332", "de:08231:3996", "separate", "reviewed")
    result = resolve_identity(model, [WEISSENSTEIN], [override], source_id=SOURCE)
    assert place_of(model, "de:08231:332") == canonical_id("stop_place", "dhid:de:08231:332")
    assert [(m.action, m.kind, m.note) for m in result.matches] == [
        ("separated", "override", "own identity again"),
        ("refused", "name_distance", "separate by override"),
    ]
    assert result.counts()["separated"] == 1


def test_an_override_naming_no_stored_place_is_an_error() -> None:
    model = feed(row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399))
    with pytest.raises(OverrideError, match="no stored stop place de:99999:1"):
        resolve_identity(
            model, [], [Override("de:08231:332", "de:99999:1", "same", "x")], source_id=SOURCE
        )


@pytest.mark.parametrize(
    ("old", "new", "metres"),
    [
        ("Frankfurt (Main) Hbf", "Frankfurt (Main) Hbf tief", 0),
        ("Güstrow Bahnhof", "Güstrow, ZOB", 57),
        ("Karlsruhe Hbf", "Karlsruhe West", 40),
        ("Leipzig Nord", "Leipzig Süd", 10),
        ("Basel Bad Bf", "Basel Bad Bf (FlixTrain)", 87),
        ("Steinerne Renne", "Wernigerode Wdh_Sr 006", 20),
        ("Weißenstein Bahnhof", "Weißenstein Bahnhof", 130),
    ],
)
def test_different_stations_are_never_merged(old: str, new: str, metres: float) -> None:
    other = stored("de:01001:1", old, 50.0, 8.0, dhid="de:01001:1")
    model = feed(row("de:01001:2", new, 50.0 + metres / 111_320, 8.0))
    result = resolve_identity(model, [other], [], source_id=SOURCE)
    assert place_of(model, "de:01001:2") != other.stop_place_id
    assert result.matches == []


def test_a_district_twin_with_another_name_is_not_matched() -> None:
    other = stored("de:03159:100", "Göttingen", 51.5367, 9.9258, dhid="de:03159:100")
    model = feed(row("de:03152:100", "Rosdorf", 51.5367, 9.9258))
    resolve_identity(model, [other], [], source_id=SOURCE)
    assert place_of(model, "de:03152:100") != other.stop_place_id


def test_one_stored_place_goes_to_the_nearer_of_two_new_places() -> None:
    model = feed(
        row("de:08231:900", "Weißenstein Bahnhof", 48.865500, 8.676399),
        row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399),
    )
    result = resolve_identity(model, [WEISSENSTEIN], [], source_id=SOURCE)
    assert place_of(model, "de:08231:332") == WEISSENSTEIN.stop_place_id
    assert place_of(model, "de:08231:900") != WEISSENSTEIN.stop_place_id
    assert sorted((m.key, m.action) for m in result.matches) == [
        ("de:08231:332", "reused"),
        ("de:08231:900", "refused"),
    ]


def test_a_place_already_known_keeps_its_id() -> None:
    model = feed(row("de:08231:3996", "Weißenstein Bahnhof", 48.865207, 8.676399))
    assert place_of(model, "de:08231:3996") == WEISSENSTEIN.stop_place_id
    result = resolve_identity(model, [WEISSENSTEIN], [], source_id=SOURCE)
    assert result.matches == []


def test_identity_tokens_ignore_bahnhof_and_case_but_keep_qualifiers() -> None:
    assert identity_tokens("Riehen Bahnhof Niederholz") == identity_tokens("riehen niederholz")
    assert identity_tokens("Mühlheim Hbf") == identity_tokens("Muehlheim Hauptbahnhof")
    assert identity_tokens("Güstrow, ZOB") != identity_tokens("Güstrow Bahnhof")
    assert identity_tokens("Berlin Hbf (tief)") != identity_tokens("Berlin Hbf")


def test_counts_and_review_rows(tmp_path: Path) -> None:
    model = feed(
        row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399),
        row("ch:1:sloid:16764", "Riehen", 47.583330, 7.649720),
    )
    result = resolve_identity(model, [WEISSENSTEIN, RIEHEN], [], source_id=SOURCE)
    assert result.counts() == {
        "reused": 2,
        "folded": 0,
        "refused": 0,
        "separated": 0,
        "review": 0,
        "skipped": 0,
        "by_kind": {"name_distance": 2},
        "by_change": {"dhid_renumbered": 1, "ifopt_reissued": 1},
    }
    path = tmp_path / "place-identity.csv"
    write_identity_review(path, result.matches)
    lines = path.read_text().splitlines()
    assert lines[0].startswith("action,kind,change,key,name,stop_place_id,stored_keys")
    assert len(lines) == 3


def test_read_overrides(tmp_path: Path) -> None:
    path = tmp_path / "overrides.csv"
    path.write_text(
        "key,stored,decision,reason\n"
        "ch:1:sloid:90,ch:23005:6,same,FlixTrain stop split off\n"
        "de:08231:332,de:08231:3996,separate,reviewed\n"
    )
    assert read_overrides(path) == [
        Override("ch:1:sloid:90", "ch:23005:6", "same", "FlixTrain stop split off"),
        Override("de:08231:332", "de:08231:3996", "separate", "reviewed"),
    ]
    assert read_overrides(None) == []
    with pytest.raises(OverrideError, match="does not exist"):
        read_overrides(tmp_path / "missing.csv")
    path.write_text("key,stored,decision,reason\nx,y,merge,\n")
    with pytest.raises(OverrideError, match="line 2"):
        read_overrides(path)


def test_an_old_key_back_next_to_its_new_key_folds_into_one_place() -> None:
    model = feed(
        row("de:08231:3996", "Weißenstein Bahnhof", 48.865207, 8.676399),
        row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399),
    )
    model.places["de:08231:3996"].canonical = WEISSENSTEIN.stop_place_id
    model.places["de:08231:332"].canonical = WEISSENSTEIN.stop_place_id
    result = resolve_identity(model, [WEISSENSTEIN], [], source_id=SOURCE)
    assert set(model.places) == {"de:08231:332"}
    assert model.merged == {"de:08231:3996": "de:08231:332"}
    assert place_of(model, "de:08231:3996") == WEISSENSTEIN.stop_place_id
    assert [(m.action, m.kind, m.key) for m in result.matches] == [
        ("folded", "same_identity", "de:08231:3996")
    ]
    assert result.counts()["by_kind"] == {"same_identity": 1}


def test_twins_that_were_both_stored_places_fold_with_a_review_row() -> None:
    other = stored(
        "de:03152:33817", "Göttingen", 51.536815, 9.926072, dhid="de:03152:33817", eva=8000128
    )
    model = feed(
        row("de:03152:33817", "Göttingen", 51.536815, 9.926072),
        row("de:03152:33817::1", "Göttingen", 51.536683, 9.926424),
        row("de:03159:33817::5", "Göttingen", 51.536711, 9.926303),
    )
    model.places["de:03152:33817"].canonical = other.stop_place_id
    model.places["de:03159:33817"].canonical = GOETTINGEN.stop_place_id
    result = resolve_identity(model, [GOETTINGEN, other], [], source_id=SOURCE)
    assert set(model.places) == {"de:03152:33817"}
    assert [(m.action, m.kind, m.key, m.stop_place_id) for m in result.matches] == [
        ("folded", "dhid_district", "de:03159:33817", other.stop_place_id),
        ("review", "dhid_district", "de:03159:33817", GOETTINGEN.stop_place_id),
    ]
    assert "both stored" in result.matches[1].note
    assert result.counts()["review"] == 1


def test_an_override_whose_key_is_not_in_the_feed_is_listed_as_skipped(tmp_path: Path) -> None:
    model = feed(row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399))
    override = Override("de:08231:999", "de:08231:3996", "separate", "old row")
    result = resolve_identity(model, [WEISSENSTEIN], [override], source_id=SOURCE)
    skipped = [m for m in result.matches if m.action == "skipped"]
    assert [(m.kind, m.key, m.stop_place_id, m.note) for m in skipped] == [
        ("override", "de:08231:999", WEISSENSTEIN.stop_place_id, "separate: key not in this feed")
    ]
    assert result.counts()["skipped"] == 1
    path = tmp_path / "place-identity.csv"
    write_identity_review(path, result.matches)
    assert "skipped,override,,de:08231:999,," in path.read_text()


def test_an_override_naming_an_unknown_place_for_a_key_not_in_the_feed_is_skipped() -> None:
    model = feed(row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399))
    override = Override("de:08231:999", "de:99999:1", "same", "typo")
    result = resolve_identity(model, [WEISSENSTEIN], [override], source_id=SOURCE)
    [skipped] = [m for m in result.matches if m.action == "skipped"]
    assert (skipped.stop_place_id, skipped.note) == (
        None,
        "same: key not in this feed, no stored stop place de:99999:1",
    )


@pytest.mark.parametrize(
    ("old", "new"),
    [("Weißenstein Bf", "Weißenstein Bahnhof"), ("Weißenstein", "Weißenstein Bf")],
)
def test_a_name_match_on_bahnhof_or_bf_alone_gets_a_review_row(old: str, new: str) -> None:
    other = stored("de:08231:3996", old, 48.865207, 8.676399, dhid="de:08231:3996")
    model = feed(row("de:08231:332", new, 48.865207, 8.676399))
    result = resolve_identity(model, [other], [], source_id=SOURCE)
    assert place_of(model, "de:08231:332") == other.stop_place_id
    assert [(m.action, m.kind) for m in result.matches] == [
        ("reused", "name_distance"),
        ("review", "name_distance"),
    ]
    assert "Bahnhof or Bf" in result.matches[1].note


def test_the_same_name_needs_no_review_row() -> None:
    model = feed(row("de:08231:332", "Weißenstein Bahnhof", 48.865207, 8.676399))
    result = resolve_identity(model, [WEISSENSTEIN], [], source_id=SOURCE)
    assert [m.action for m in result.matches] == ["reused"]


def test_load_stops_before_the_database_when_the_given_overrides_file_is_missing(
    tmp_path: Path,
) -> None:
    feed_path = tmp_path / "delfi-gtfs.zip"
    feed_path.write_bytes(b"not read")
    options = LoadOptions(
        feed_path=feed_path,
        database_url="postgresql://nobody@127.0.0.1:1/none",
        categories=TRAIN_CATEGORIES,
        data_root=tmp_path,
        place_overrides=tmp_path / "place-identity-overrides.csv.typo",
    )
    with pytest.raises(OverrideError, match="does not exist"):
        run_load(options)
