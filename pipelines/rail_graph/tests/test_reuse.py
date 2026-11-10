import os

import pytest

from gerlines_rail_graph.reuse import (
    ROUTER_NOT_REIMPORTED,
    NewPattern,
    OldLink,
    match_patterns,
    restrict,
    reuse_key,
    without_router,
)


def places_of(stops: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(s.split(":")[0] for s in stops)


def new(  # noqa: PLR0913
    pid: str,
    category: str = "reg",
    stops: tuple[str, ...] = ("a", "b", "c"),
    *,
    route: str | None = None,
    shape_key: str | None = None,
    line: str | None = None,
) -> NewPattern:
    return NewPattern(pid, category, stops, places_of(stops), route, shape_key, line)


def old(  # noqa: PLR0913
    pid: str,
    shape: str,
    *,
    version: int = 1,
    category: str = "reg",
    stops: tuple[str, ...] = ("a", "b", "c"),
    qa: str = "pass",
    method: str = "pfaedle",
    route: str | None = None,
    shape_key: str | None = None,
    line: str | None = None,
) -> OldLink:
    return OldLink(
        version, pid, category, stops, places_of(stops), shape, qa, method, route, shape_key, line
    )


def test_key_depends_on_category_and_stop_order():
    assert reuse_key("reg", ("a", "b")) == reuse_key("reg", ("a", "b"))
    assert reuse_key("reg", ("a", "b")) != reuse_key("reg", ("b", "a"))
    assert reuse_key("reg", ("a", "b")) != reuse_key("sbahn", ("a", "b"))
    assert reuse_key("reg", ("a", "bc")) != reuse_key("reg", ("ab", "c"))


def test_the_same_pattern_id_wins_over_a_pattern_with_the_same_stops():
    matches, unmatched = match_patterns([new("p1")], [old("q9", "s-other"), old("p1", "s-same")])
    assert unmatched == []
    assert [(m.pattern_id, m.link.shape_hash, m.how) for m in matches] == [
        ("p1", "s-same", "same_pattern")
    ]


def test_same_stops_and_category_reuse_another_patterns_shape():
    matches, unmatched = match_patterns(
        [new("p2"), new("p3", stops=("a", "c")), new("p4", category="sbahn")],
        [old("q1", "s1")],
    )
    assert [(m.pattern_id, m.link.shape_hash, m.how) for m in matches] == [
        ("p2", "s1", "same_stops")
    ]
    assert unmatched == ["p3", "p4"]


def test_same_stop_places_on_other_platforms_come_last():
    links = [old("q1", "s-places", stops=("a:1", "b:2", "c:1"))]
    matches, unmatched = match_patterns(
        [new("p1", stops=("a:2", "b:2", "c:1")), new("p2", stops=("a:2", "c:1"))], links
    )
    assert [(m.pattern_id, m.link.shape_hash, m.how) for m in matches] == [
        ("p1", "s-places", "same_places")
    ]
    assert unmatched == ["p2"]
    stops_first, _ = match_patterns(
        [new("p1", stops=("a:2", "b:2", "c:1"))],
        [*links, old("q2", "s-stops", stops=("a:2", "b:2", "c:1"))],
    )
    assert stops_first[0].how == "same_stops"


def test_a_passing_shape_is_preferred_then_the_newest_version():
    links = [
        old("q1", "s-fail", version=3, qa="low_quality"),
        old("q2", "s-old", version=1),
        old("q3", "s-new", version=2),
    ]
    matches, _ = match_patterns([new("p1")], links)
    assert matches[0].link.shape_hash == "s-new"


def test_straight_and_low_quality_shapes_are_built_again_not_reused():
    links = [
        old("q1", "s-low", qa="low_quality", method="straight"),
        old("q2", "s-unmeasured", stops=("a", "b", "d"), qa="unmeasured", method="straight"),
        old("q3", "s-straight-pass", stops=("a", "e"), method="straight"),
        old("p4", "s-fail", stops=("x", "y"), qa="fail"),
    ]
    counts: dict = {}
    matches, unmatched = match_patterns(
        [
            new("p1"),
            new("p2", stops=("a", "b", "d")),
            new("p3", stops=("a", "e")),
            new("p4", stops=("x", "y")),
            new("p5", stops=("z", "y")),
        ],
        links,
        counts=counts,
    )
    assert matches == []
    assert unmatched == ["p1", "p2", "p3", "p4", "p5"]
    assert counts["not_reused_quality"] == 4


def test_a_stop_key_collision_prefers_the_same_shape_key_then_route_then_line():
    links = [
        old("q1", "s-rank", version=2),
        old("q2", "s-line", line="RE 7"),
        old("q3", "s-route", route="r-9", line="RE 7"),
        old("q4", "s-shape", shape_key="sh-1"),
    ]
    p = new("p1", route="r-9", shape_key="sh-1", line="RE 7")
    counts: dict = {}
    matches, _ = match_patterns([p], links, counts=counts)
    assert matches[0].link.shape_hash == "s-shape"
    assert counts["collisions"] == {"same_stops": 1, "same_places": 0}
    assert counts["decided_by"] == {"shape_key": 1, "route_key": 0, "line": 0, "rank": 0}
    by_route, _ = match_patterns([new("p1", route="r-9", line="RE 7")], links)
    assert by_route[0].link.shape_hash == "s-route"
    by_line, _ = match_patterns([new("p1", line="RE 7")], links)
    assert by_line[0].link.shape_hash == "s-line"
    by_rank, _ = match_patterns([new("p1", line="RE 1")], links)
    assert by_rank[0].link.shape_hash == "s-rank"


def test_decided_by_names_the_key_that_separates_the_winner_not_one_every_candidate_shares():
    links = [
        old("q1", "s-other-line", shape_key="sh-1", route="r-9", line="RE 1"),
        old("q2", "s-line", version=0, shape_key="sh-1", route="r-9", line="RE 7"),
        old("q3", "s-line", shape_key="sh-2", route="r-1", line="RE 7"),
    ]
    p = new("p1", route="r-9", shape_key="sh-1", line="RE 7")
    counts: dict = {}
    matches, _ = match_patterns([p], links, counts=counts)
    assert matches[0].link.trip_pattern_id == "q2"
    assert counts["decided_by"] == {"shape_key": 0, "route_key": 0, "line": 1, "rank": 0}
    shared = [old("q1", "s-old", shape_key="sh-1"), old("q2", "s-new", version=2, shape_key="sh-1")]
    counts = {}
    matches, _ = match_patterns([new("p1", shape_key="sh-1")], shared, counts=counts)
    assert matches[0].link.shape_hash == "s-new"
    assert counts["decided_by"] == {"shape_key": 0, "route_key": 0, "line": 0, "rank": 1}


def test_missing_keys_never_count_as_equal():
    links = [old("q1", "s-none"), old("q2", "s-new", version=2, route="r-2")]
    counts: dict = {}
    matches, _ = match_patterns([new("p1")], links, counts=counts)
    assert matches[0].link.shape_hash == "s-new"
    assert counts["decided_by"]["rank"] == 1


def test_one_shape_under_several_old_patterns_is_no_collision():
    counts: dict = {}
    match_patterns([new("p1")], [old("q1", "s1"), old("q2", "s1", route="r")], counts=counts)
    assert counts["collisions"] == {"same_stops": 0, "same_places": 0}


def test_choice_does_not_depend_on_input_order():
    links = [old("q2", "s2"), old("q1", "s1")]
    first, _ = match_patterns([new("p1")], links)
    second, _ = match_patterns([new("p1")], list(reversed(links)))
    assert first[0].link == second[0].link
    assert first[0].link.trip_pattern_id == "q1"


class P:
    def __init__(self, pattern_id: str, rep_trip: str) -> None:
        self.pattern_id = pattern_id
        self.rep_trip = rep_trip


def test_restrict_keeps_listed_patterns_and_refuses_unknown_ids():
    patterns = [P("p1", "t1"), P("p2", "t2"), P("p3", "t3")]
    assert [p.pattern_id for p in restrict(patterns, ["p3", "p1"])] == ["p1", "p3"]
    with pytest.raises(SystemExit, match="p9"):
        restrict(patterns, ["p1", "p9"])


def test_without_router_gives_every_pattern_no_motis_shape():
    shapes, how, summary = without_router([P("p1", "t1"), P("p2", "t2")])
    assert shapes == {"p1": None, "p2": None}
    assert set(how.values()) == {ROUTER_NOT_REIMPORTED}
    assert summary == {"patterns": 2, "with_shape": 0, "reasons": {ROUTER_NOT_REIMPORTED: 2}}


DB_URL = os.environ.get("GERLINES_RAIL_GRAPH_TEST_DATABASE_URL")


def copy_version(cur, source: int, patterns: list[str]) -> int:
    """A new loaded version holding copies of ``patterns`` of ``source`` (routes and stops)."""
    cur.execute(
        "INSERT INTO feed_version (source_id, raw_object_id, published_on, sha256,"
        " category_codes, status, ingest_run_id, loaded_at)"
        " SELECT source_id, raw_object_id, published_on + 7, repeat('e', 64),"
        " category_codes, 'loaded', ingest_run_id, now() FROM feed_version"
        " WHERE feed_version_id = %s RETURNING feed_version_id",
        (source,),
    )
    target = cur.fetchone()[0]
    route_columns = (
        "route_key, agency_key, operator_id, short_name, long_name,"
        " gtfs_route_type, category_code, category_rule, is_foreign"
    )
    cur.execute(
        f"INSERT INTO route (feed_version_id, {route_columns})"  # noqa: S608
        f" SELECT %s, {route_columns} FROM route WHERE feed_version_id = %s AND route_key IN"
        " (SELECT route_key FROM trip_pattern WHERE feed_version_id = %s"
        "  AND trip_pattern_id = ANY(%s::uuid[]))",
        (target, source, source, patterns),
    )
    for table, columns in (
        ("trip_pattern", "trip_pattern_id, route_key, shape_key, stop_count"),
        ("trip_pattern_stop", "trip_pattern_id, stop_index, stop_point_id"),
    ):
        cur.execute(
            f"INSERT INTO {table} (feed_version_id, {columns})"  # noqa: S608
            f" SELECT %s, {columns} FROM {table}"
            " WHERE feed_version_id = %s AND trip_pattern_id = ANY(%s::uuid[])",
            (target, source, patterns),
        )
    return target


@pytest.fixture
def linked():
    """A rolled-back connection, the first linked version and 200 of its passing patterns, each
    gated with every stop within 30 m."""
    if not DB_URL:
        pytest.skip("GERLINES_RAIL_GRAPH_TEST_DATABASE_URL not set (a migrated database)")
    import psycopg  # noqa: PLC0415

    with psycopg.connect(DB_URL) as conn, conn.transaction(force_rollback=True):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT l.feed_version_id, l.trip_pattern_id::text FROM trip_pattern_shape l"
                " JOIN shape_pattern s USING (shape_hash)"
                " WHERE s.qa_status = 'pass' AND (l.metrics->>'max_stop_m')::float < 30"
                " AND l.feed_version_id = (SELECT min(feed_version_id) FROM trip_pattern_shape)"
                " ORDER BY l.trip_pattern_id LIMIT 200"
            )
            rows = cur.fetchall()
        if len(rows) < 2:
            pytest.skip("the database holds too few linked patterns")
        yield conn, rows[0][0], [pid for _, pid in rows]


@pytest.mark.db
def test_reuse_links_patterns_of_a_new_version_in_the_database(linked):
    from gerlines_rail_graph.reuse import reuse_shapes  # noqa: PLC0415

    conn, source, patterns = linked
    with conn.cursor() as cur:
        target = copy_version(cur, source, patterns)
    report = reuse_shapes(conn, target, [source], max_stop_m=80.0)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*), count(*) FILTER (WHERE metrics ? 'reused_from')"
            " FROM trip_pattern_shape WHERE feed_version_id = %s",
            (target,),
        )
        links, reused = cur.fetchone()
    assert report["patterns"] == len(patterns)
    assert report["reused"]["same_pattern"] == links == reused == len(patterns)
    assert report["new_patterns"] == 0


@pytest.mark.db
def test_reuse_refuses_a_shape_whose_stop_moved_150_m(linked):
    from gerlines_rail_graph.reuse import reuse_shapes  # noqa: PLC0415

    conn, source, patterns = linked
    moved = patterns[0]
    with conn.cursor() as cur:
        target = copy_version(cur, source, patterns)
        cur.execute(
            "UPDATE stop_point SET geom = ST_Project(geom::geography, 150, radians(90))::geometry"
            " WHERE stop_point_id = (SELECT stop_point_id FROM trip_pattern_stop"
            " WHERE feed_version_id = %s AND trip_pattern_id = %s AND stop_index = 1)",
            (target, moved),
        )
    report = reuse_shapes(conn, target, [source], max_stop_m=80.0)
    assert moved in report["new_pattern_ids"]
    assert report["stop_moved"] >= 1
    assert report["inserted"] == len(patterns) - report["new_patterns"]


GATED_FAR_SQL = {
    True: "UPDATE trip_pattern_shape SET metrics = jsonb_set(metrics, '{max_stop_m}', '200')"
    " WHERE feed_version_id = %s AND trip_pattern_id = %s",
    False: "UPDATE trip_pattern_shape"
    " SET metrics = jsonb_set(metrics - 'stop_m', '{max_stop_m}', '200')"
    " WHERE feed_version_id = %s AND trip_pattern_id = %s",
}


def _gate_one_stop_far_and_move_another(cur, source, target, pattern, *, per_stop):
    """The old link says one stop was gated at 200 m; stop 1 of the new pattern moves 120 m."""
    cur.execute(GATED_FAR_SQL[per_stop], (source, pattern))
    cur.execute(
        "UPDATE stop_point SET geom = ST_Project(geom::geography, 120, radians(90))::geometry"
        " WHERE stop_point_id = (SELECT stop_point_id FROM trip_pattern_stop"
        " WHERE feed_version_id = %s AND trip_pattern_id = %s AND stop_index = 1)",
        (target, pattern),
    )


@pytest.mark.db
def test_reuse_compares_each_stop_with_its_own_gated_distance(linked):
    from gerlines_rail_graph.reuse import reuse_shapes  # noqa: PLC0415

    conn, source, patterns = linked
    moved = patterns[0]
    with conn.cursor() as cur:
        target = copy_version(cur, source, patterns)
        _gate_one_stop_far_and_move_another(cur, source, target, moved, per_stop=True)
    report = reuse_shapes(conn, target, [source], max_stop_m=80.0)
    assert moved in report["new_pattern_ids"]


@pytest.mark.db
def test_reuse_falls_back_to_the_worst_gated_stop_without_a_distance_per_stop(linked):
    from gerlines_rail_graph.reuse import reuse_shapes  # noqa: PLC0415

    conn, source, patterns = linked
    moved = patterns[0]
    with conn.cursor() as cur:
        target = copy_version(cur, source, patterns)
        _gate_one_stop_far_and_move_another(cur, source, target, moved, per_stop=False)
    report = reuse_shapes(conn, target, [source], max_stop_m=80.0)
    assert moved not in report["new_pattern_ids"]


@pytest.mark.db
def test_reused_links_record_todays_worst_stop_distance(linked):
    from gerlines_rail_graph.reuse import reuse_shapes  # noqa: PLC0415

    conn, source, patterns = linked
    moved = patterns[0]
    with conn.cursor() as cur:
        target = copy_version(cur, source, patterns)
        cur.execute(
            "UPDATE stop_point SET geom = ST_Project(geom::geography, 50, radians(90))::geometry"
            " WHERE stop_point_id = (SELECT stop_point_id FROM trip_pattern_stop"
            " WHERE feed_version_id = %s AND trip_pattern_id = %s AND stop_index = 1)",
            (target, moved),
        )
    reuse_shapes(conn, target, [source], max_stop_m=80.0)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT trip_pattern_id::text, (metrics->'reused_from'->>'worst_m')::float,"
            " (metrics->>'max_stop_m')::float FROM trip_pattern_shape"
            " WHERE feed_version_id = %s",
            (target,),
        )
        rows = {pid: (worst, gated) for pid, worst, gated in cur.fetchall()}
    assert all(worst is not None for worst, _ in rows.values())
    assert rows[moved][0] > 25
    assert rows[moved][0] > rows[moved][1]
    assert sum(abs(w - g) < 1.0 for pid, (w, g) in rows.items() if pid != moved) >= 0.9 * (
        len(rows) - 1
    )


@pytest.mark.db
def test_reuse_builds_again_a_pattern_whose_old_shape_is_straight(linked):
    from gerlines_rail_graph.reuse import reuse_shapes  # noqa: PLC0415

    conn, source, patterns = linked
    straight = patterns[0]
    with conn.cursor() as cur:
        target = copy_version(cur, source, patterns)
        cur.execute(
            "SELECT shape_hash FROM trip_pattern_shape"
            " WHERE feed_version_id = %s AND trip_pattern_id = %s",
            (source, straight),
        )
        (shape_hash,) = cur.fetchone()
        cur.execute(
            "UPDATE shape_pattern SET method = 'straight', qa_status = 'low_quality'"
            " WHERE shape_hash = %s",
            (shape_hash,),
        )
        cur.execute(
            "SELECT trip_pattern_id::text FROM trip_pattern_shape"
            " WHERE feed_version_id = %s AND shape_hash = %s",
            (source, shape_hash),
        )
        sharing = {r[0] for r in cur.fetchall()} & set(patterns)
    report = reuse_shapes(conn, target, [source], max_stop_m=80.0)
    assert straight in report["new_pattern_ids"]
    assert report["not_reused_quality"] >= len(sharing)


@pytest.mark.db
def test_reuse_refuses_a_target_version_that_is_not_loaded(linked):
    from gerlines_rail_graph.reuse import reuse_shapes  # noqa: PLC0415

    conn, source, patterns = linked
    with conn.cursor() as cur:
        target = copy_version(cur, source, patterns[:2])
        cur.execute(
            "UPDATE feed_version SET status = 'loading', loaded_at = NULL"
            " WHERE feed_version_id = %s",
            (target,),
        )
    with pytest.raises(SystemExit, match="not loaded"):
        reuse_shapes(conn, target, [source])
