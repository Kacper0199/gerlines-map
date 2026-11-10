import psycopg
import pytest

from gerlines_rollups.spec import DELAY, GAIN, SPEED, Bins, bin_of, member_order, source_rank


@pytest.mark.parametrize(
    ("bins", "value", "expected"),
    [
        (DELAY, -1801, None),
        (DELAY, -1800, 0),
        (DELAY, -301, 0),
        (DELAY, -300, 1),
        (DELAY, -1, 1),
        (DELAY, 0, 2),
        (DELAY, 359, 7),
        (DELAY, 360, 8),
        (DELAY, 959, 17),
        (DELAY, 960, 18),
        (DELAY, 3599, 26),
        (DELAY, 3600, 27),
        (DELAY, 7200, 29),
        (DELAY, None, None),
        (GAIN, -100_000, 0),
        (GAIN, -600, 1),
        (GAIN, -300, 2),
        (GAIN, -1, 6),
        (GAIN, 0, 7),
        (GAIN, 599, 16),
        (GAIN, 600, 17),
        (GAIN, 3600, 20),
        (SPEED, -0.1, None),
        (SPEED, 0, 0),
        (SPEED, 9.99, 0),
        (SPEED, 299.9, 29),
        (SPEED, 300, 30),
    ],
)
def test_bin_edges(bins: Bins, value: float | None, expected: int | None) -> None:
    assert bin_of(bins, value) == expected


def test_bin_counts() -> None:
    assert (DELAY.count, GAIN.count, SPEED.count) == (30, 21, 31)


@pytest.mark.parametrize(
    ("category", "order"),
    [
        (
            "hsr",
            [
                "db-iris",
                "gtfsde-rt",
                "delfi-gtfs-rt",
                "vbb-gtfs-rt",
                "cz-czptt-gtfs-rt",
            ],
        ),
        ("ld", ["db-iris", "gtfsde-rt", "mobilithek-delfi-gtfs-rt", "vbn-gtfs-rt"]),
        (
            "reg",
            [
                "delfi-gtfs-rt",
                "gtfsde-rt",
                "vbb-gtfs-rt",
                "fr-sncf-gtfs-rt",
                "db-iris",
            ],
        ),
        (None, ["delfi-gtfs-rt-deincr", "gtfsde-rt", "vbn-gtfs-rt", "pl-pkpic-gtfs-rt"]),
    ],
)
def test_source_rank_follows_d041(category: str | None, order: list[str]) -> None:
    ranks = [source_rank(category, source) for source in order]
    assert ranks == sorted(ranks)
    assert len(set(ranks)) == len(ranks)


def test_spec_matches_the_database_bins_and_ranks(database_url: str) -> None:
    with psycopg.connect(database_url) as conn:
        for bins in (DELAY, GAIN, SPEED):
            rows = conn.execute(
                "SELECT bin, lower_value, upper_value FROM stat_bin WHERE kind = %s ORDER BY bin",
                (bins.kind,),
            ).fetchall()
            assert len(rows) == bins.count
            uppers = [upper for _, _, upper in rows]
            assert uppers == [*bins.edges, None]
            assert rows[0][1] == bins.lowest
        sources = [
            "db-iris",
            "db-iris-fchg-1",
            "gtfsde-rt",
            "mobilithek-delfi-gtfs-rt",
            "delfi-gtfs-rt",
            "delfi-gtfs-rt-deincr",
            "vbb-gtfs-rt",
            "ch-otd-gtfs-rt",
        ]
        for category in ("hsr", "ld", "reg", "sbahn", None):
            for source in sources:
                (rank, member) = conn.execute(
                    "SELECT stat_source_rank(%s, %s), stat_source_member_order(%s)",
                    (category, source, source),
                ).fetchone()
                assert rank == source_rank(category, source), (category, source)
                assert member == member_order(source), source


def test_iris_is_matched_by_its_exact_id() -> None:
    assert source_rank("ld", "db-iris") == 0
    assert source_rank("ld", "db-iris-fchg-1") == source_rank("ld", "cz-czptt-gtfs-rt")


def test_delfi_members_follow_d041_item_2() -> None:
    order = ["mobilithek-delfi-gtfs-rt", "delfi-gtfs-rt", "delfi-gtfs-rt-deincr"]
    assert [member_order(source) for source in order] == [0, 1, 2]


def test_live_final_beats_carried_final_of_a_better_source(database_url: str) -> None:
    with psycopg.connect(database_url) as conn:
        keys = conn.execute(
            """SELECT stat_source_key('reg', 'delfi-gtfs-rt', 'carried'),
                      stat_source_key('reg', 'gtfsde-rt', 'live'),
                      stat_source_key('reg', 'mobilithek-delfi-gtfs-rt', 'live'),
                      stat_source_key('reg', 'delfi-gtfs-rt', NULL)"""
        ).fetchone()
    carried_delfi, live_gtfsde, live_mobilithek, open_delfi = keys
    assert live_gtfsde < carried_delfi
    assert live_mobilithek < open_delfi < live_gtfsde
