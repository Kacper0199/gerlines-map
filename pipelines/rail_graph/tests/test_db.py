import os
import struct

import numpy as np
import pytest

from gerlines_rail_graph.db import flat_spans, linestring_zm_wkb, load, stub_stage_rows
from gerlines_rail_graph.store import ShapeStore
from gerlines_rail_graph.stubs import STUB_VERSION

DB_URL = os.environ.get("GERLINES_RAIL_GRAPH_TEST_DATABASE_URL")


def test_wkb_is_iso_linestring_zm_little_endian():
    coords = np.array([[13.0, 52.0, 34.5, 0.0], [13.001, 52.0, 35.0, 68.6]])

    wkb = linestring_zm_wkb(coords)

    order, kind, count = struct.unpack_from("<BII", wkb)
    assert (order, kind, count) == (1, 3002, 2)
    assert np.frombuffer(wkb[9:], dtype="<f8").reshape(-1, 4).tolist() == coords.tolist()


def test_spans_are_flat_pairs():
    assert flat_spans([[1.0, 2.5], [10.0, 20.0]]) == "{1.000,2.500,10.000,20.000}"
    assert flat_spans([]) == "{}"


def shape(length: float) -> np.ndarray:
    return np.array([[13.0, 52.0, 30.0, 0.0], [13.001, 52.0, 31.0, length]])


def meta(pid: str, shape_hash: str, method: str, qa_status: str, length: float) -> dict:
    return {
        "pattern_id": pid,
        "shape_hash": shape_hash,
        "method": method,
        "qa_status": qa_status,
        "length_m": length,
        "stop_arc_m": [0.0, length],
        "tunnel_spans": [],
        "bridge_spans": [[10.0, 20.0]],
    }


ROW = {"has_shape": True, "detour": 0.95, "detour_low": 1.0, "stop_m": [3.0, 4.0]}


@pytest.fixture
def conn():
    if not DB_URL:
        pytest.skip("GERLINES_RAIL_GRAPH_TEST_DATABASE_URL not set (a migrated database)")
    import psycopg  # noqa: PLC0415

    with psycopg.connect(DB_URL) as connection, connection.transaction(force_rollback=True):
        yield connection


def test_load_keeps_one_row_per_shape_and_facts_per_pattern(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT feed_version_id, trip_pattern_id::text FROM trip_pattern"
            " ORDER BY feed_version_id, trip_pattern_id LIMIT 3"
        )
        found = cur.fetchall()
    if len(found) < 3:
        pytest.skip("the database holds fewer than three trip patterns")
    version = found[0][0]
    p1, p2, p3 = (pid for _, pid in found)
    shared, straight = "a" * 64, "b" * 64
    shapes = ShapeStore.from_mapping({p1: shape(68.6), p2: shape(68.6), p3: shape(68.6)}, dims=4)
    metas = [
        meta(p1, shared, "motis", "pass", 68.6),
        meta(p2, shared, "motis", "pass", 68.6),
        meta(p3, straight, "straight", "unmeasured", 68.6),
    ]
    verdicts = {"motis": "pass", "pfaedle": "fail"}
    choice = {
        p1: {"group_method": "motis", "verdicts": verdicts, "stop_misfits": {}, "flags": []},
        p2: {
            "group_method": "pfaedle",
            "verdicts": verdicts,
            "stop_misfits": {},
            "flags": ["other_method_than_group", "floor_by_lower_bound"],
        },
        p3: {"group_method": "motis", "verdicts": {}, "stop_misfits": {}, "flags": ["unmeasured"]},
    }
    rows = {p1: {"motis": {**ROW, "detour": 1.0}}, p2: {"motis": ROW}, p3: {}}

    first = load(conn, version, shapes, metas, choice, rows, {"feed": "x"}, "dem")
    second = load(conn, version, shapes, metas[:2], choice, rows, {"feed": "x"}, "dem")

    assert first == {"shapes_inserted": 2, "links": 3}
    assert second == {"shapes_inserted": 0, "links": 2}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT trip_pattern_id::text, shape_hash, group_method, review_flags,"
            " metrics->>'detour', metrics->>'detour_low' FROM trip_pattern_shape"
            " WHERE feed_version_id = %s AND shape_hash = %s ORDER BY trip_pattern_id",
            (version, shared),
        )
        links = cur.fetchall()
        cur.execute(
            "SELECT shape_hash, method, qa_status, bridge_spans FROM shape_pattern"
            " WHERE shape_hash IN (%s, %s) ORDER BY shape_hash",
            (shared, straight),
        )
        stored = cur.fetchall()
    assert links == [
        (p1, shared, "motis", [], "1.0", "1.0"),
        (p2, shared, "pfaedle", ["other_method_than_group", "floor_by_lower_bound"], "0.95", "1.0"),
    ]
    assert stored == [
        (shared, "motis", "pass", [10.0, 20.0]),
        (straight, "straight", "unmeasured", [10.0, 20.0]),
    ]


def stub_side(
    length: float, end: str = "buffer", start: float = 13.0, step: float = -0.0005
) -> dict:
    if length == 0:
        return {"lonlatz": [[start, 52.0, 30.0]], "dist": [0.0], "length_m": 0.0, "end": "no_track"}
    return {
        "lonlatz": [[start + k * step, 52.0, 30.0] for k in range(3)],
        "dist": [0.0, length / 2, length],
        "length_m": length,
        "end": end,
    }


def test_stub_stage_rows_keep_sides_with_track_and_put_the_distance_in_m():
    rows = stub_stage_rows(
        [{"shape_hash": "a" * 64, "before": stub_side(68.5), "after": stub_side(0)}]
    )

    assert len(rows) == 1
    shape_hash, side, wkb_hex, length, end = rows[0]
    assert (shape_hash, side, length, end) == ("a" * 64, "before", 68.5, "buffer")
    coords = np.frombuffer(bytes.fromhex(wkb_hex)[9:], dtype="<f8").reshape(-1, 4)
    assert coords[:, 3].tolist() == [0.0, 34.25, 68.5]
    assert coords[:, 2].tolist() == [30.0, 30.0, 30.0]


def stub_fixture(conn, hash_: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT feed_version_id, trip_pattern_id::text FROM trip_pattern"
            " ORDER BY feed_version_id, trip_pattern_id LIMIT 1"
        )
        found = cur.fetchall()
        cur.execute("SELECT to_regclass('shape_stub') IS NOT NULL")
        has_table = cur.fetchone()[0]
    if not found or not has_table:
        pytest.skip("the database holds no trip pattern or no shape_stub table (migration 0065)")
    version, pid = found[0]
    shapes = ShapeStore.from_mapping({pid: shape(68.6)}, dims=4)
    metas = [meta(pid, hash_, "motis", "pass", 68.6)]
    choice = {pid: {"group_method": "motis", "verdicts": {}, "stop_misfits": {}, "flags": []}}
    rows = {pid: {"motis": ROW}}
    return version, shapes, metas, choice, rows


def stored_stubs(conn, hash_: str) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT st.side, st.length_m, st.end_reason, st.stub_version, st.licence,"
            " ST_NPoints(st.geom), ST_M(ST_EndPoint(st.geom))"
            " FROM shape_stub st JOIN shape_pattern s USING (shape_no) WHERE s.shape_hash = %s"
            " ORDER BY st.side",
            (hash_,),
        )
        return cur.fetchall()


def test_load_writes_stubs_of_loaded_shapes_once_and_replaces_changed_ones(conn):
    hash_ = "c" * 64
    version, shapes, metas, choice, rows = stub_fixture(conn, hash_)
    stubs = [{"shape_hash": hash_, "before": stub_side(68.5), "after": stub_side(0)}]
    unknown = [{"shape_hash": "d" * 64, "before": stub_side(10.0), "after": stub_side(10.0)}]

    first = load(conn, version, shapes, metas, choice, rows, {}, "dem", stubs + unknown)
    second = load(conn, version, shapes, metas, choice, rows, {}, "dem", stubs)
    changed = [{**stubs[0], "before": stub_side(40.0, "limit")}]
    third = load(conn, version, shapes, metas, choice, rows, {}, "dem", changed, restub=True)
    both = [{**stubs[0], "after": stub_side(20.0, start=13.001, step=0.0005)}]
    fourth = load(conn, version, shapes, metas, choice, rows, {}, "dem", both, restub=True)
    fifth = load(conn, version, shapes, metas, choice, rows, {}, "dem", changed, restub=True)
    off = [{**changed[0], "after": stub_side(20.0, start=13.0011, step=0.0005)}]
    sixth = load(conn, version, shapes, metas, choice, rows, {}, "dem", off, restub=True)

    assert (first["stubs_written"], first["stubs_without_shape"]) == (1, 1)
    assert (second["stubs_written"], second["stubs_without_shape"]) == (0, 0)
    assert third["stubs_written"] == 1
    assert (fourth["stubs_written"], fourth["stubs_removed"]) == (2, 0)
    assert (fifth["stubs_written"], fifth["stubs_removed"]) == (1, 1)
    assert (sixth["stubs_written"], sixth["stubs_refused_start"]) == (0, 1)
    assert stored_stubs(conn, hash_) == [
        ("before", 40.0, "limit", STUB_VERSION, "ODbL-1.0", 3, 40.0)
    ]


def test_a_shape_loaded_earlier_keeps_its_stored_stubs_unless_restubbed(conn):
    hash_ = "e" * 64
    version, shapes, metas, choice, rows = stub_fixture(conn, hash_)
    stubs = [{"shape_hash": hash_, "before": stub_side(68.5), "after": stub_side(0)}]
    newer = [
        {
            "shape_hash": hash_,
            "before": stub_side(40.0, "limit"),
            "after": stub_side(20.0, start=13.001, step=0.0005),
        }
    ]
    first = load(conn, version, shapes, metas, choice, rows, {}, "dem", stubs)
    stored = stored_stubs(conn, hash_)

    kept = load(conn, version, shapes, metas, choice, rows, {}, "dem", newer)
    after_kept = stored_stubs(conn, hash_)
    restubbed = load(conn, version, shapes, metas, choice, rows, {}, "dem", newer, restub=True)

    assert (first["stubs_written"], first["stubs_kept"]) == (1, 0)
    assert stored == [("before", 68.5, "buffer", STUB_VERSION, "ODbL-1.0", 3, 68.5)]
    assert (kept["stubs_written"], kept["stubs_removed"], kept["stubs_kept"]) == (0, 0, 2)
    assert after_kept == stored
    assert (restubbed["stubs_written"], restubbed["stubs_kept"]) == (2, 0)
    assert [(r[0], r[1], r[2]) for r in stored_stubs(conn, hash_)] == [
        ("after", 20.0, "buffer"),
        ("before", 40.0, "limit"),
    ]


def test_a_merge_load_replaces_only_the_loaded_patterns(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT feed_version_id, trip_pattern_id::text FROM trip_pattern"
            " ORDER BY feed_version_id, trip_pattern_id LIMIT 2"
        )
        found = cur.fetchall()
    if len(found) < 2:
        pytest.skip("the database holds fewer than two trip patterns")
    version = found[0][0]
    p1, p2 = (pid for _, pid in found)
    shapes = ShapeStore.from_mapping({p1: shape(68.6), p2: shape(68.6)}, dims=4)
    metas = [
        meta(p1, "c" * 64, "pfaedle", "pass", 68.6),
        meta(p2, "d" * 64, "pfaedle", "pass", 68.6),
    ]
    entry = {"group_method": "pfaedle", "verdicts": {}, "stop_misfits": {}, "flags": []}
    choice = {p1: entry, p2: entry}
    rows = {p1: {"pfaedle": ROW}, p2: {"pfaedle": ROW}}
    with conn.cursor() as cur:
        cur.execute("DELETE FROM trip_pattern_shape WHERE feed_version_id = %s", (version,))
    load(conn, version, shapes, metas, choice, rows, {}, "dem")
    merged = load(conn, version, shapes, metas[1:], choice, rows, {}, "dem", replace_all=False)
    assert merged == {"shapes_inserted": 0, "links": 2}

    def links():
        with conn.cursor() as cur:
            cur.execute(
                "SELECT trip_pattern_id::text, shape_hash, metrics FROM trip_pattern_shape"
                " WHERE feed_version_id = %s ORDER BY trip_pattern_id",
                (version,),
            )
            return cur.fetchall()

    first = links()
    assert [(pid, h) for pid, h, _ in first] == [(p1, "c" * 64), (p2, "d" * 64)]
    load(conn, version, shapes, metas[1:], choice, rows, {}, "dem", replace_all=False)
    assert links() == first
