"""Loading final shapes into ``shape_pattern``, linking them in ``trip_pattern_shape`` and their
track stubs into ``shape_stub``.

One transaction per feed version. Shapes are content-addressed and never deleted here, so a
shape keeps its ``shape_no`` across feed versions; the links of the version are replaced. A
shape row holds only what its hash covers; the gate metrics and review flags belong to each
pattern and sit on its link, because patterns sharing a shape can differ in both.
"""

import json
import struct
from collections.abc import Mapping, Sequence

import numpy as np

from gerlines_rail_graph.build import STRAIGHT, source_note
from gerlines_rail_graph.stubs import STUB_LICENCE, STUB_SOURCE_NOTE, STUB_VERSION

WKB_LINESTRING_ZM = 3002
LICENCE = {"motis": "ODbL-1.0", "pfaedle": "ODbL-1.0", STRAIGHT: "CC-BY-4.0"}


def linestring_zm_wkb(coords: np.ndarray) -> bytes:
    """ISO WKB (little endian) of a LineString ZM from (x, y, z, m) rows."""
    coords = np.ascontiguousarray(coords, dtype="<f8")
    return struct.pack("<BII", 1, WKB_LINESTRING_ZM, len(coords)) + coords.tobytes()


def flat_spans(spans: Sequence[Sequence[float]]) -> str:
    return "{" + ",".join(f"{v:.3f}" for span in spans for v in span) + "}"


def float_array(values: Sequence[float]) -> str:
    return "{" + ",".join(f"{v:.3f}" for v in values) + "}"


def text_array(values: Sequence[str]) -> str:
    return "{" + ",".join(json.dumps(v) for v in values) + "}"


STAGE_SQL = """
CREATE TEMP TABLE shape_stage (
  shape_hash text, wkb text, length_m double precision, stop_arc_m double precision[],
  method text, qa_status text, tunnel_spans double precision[], bridge_spans double precision[],
  elevation_source text, source_note text, licence text, provenance jsonb
) ON COMMIT DROP
"""

INSERT_SQL = """
INSERT INTO shape_pattern (shape_hash, geom, length_m, stop_arc_m, method, qa_status,
  tunnel_spans, bridge_spans, elevation_source, source_note, licence, provenance)
SELECT DISTINCT ON (shape_hash) shape_hash, ST_SetSRID(ST_GeomFromWKB(decode(wkb, 'hex')), 4326),
  length_m, stop_arc_m, method, qa_status, tunnel_spans, bridge_spans, elevation_source,
  source_note, licence, provenance
FROM shape_stage ORDER BY shape_hash
ON CONFLICT (shape_hash) DO NOTHING
"""


STUB_STAGE_SQL = """
CREATE TEMP TABLE stub_stage (
  shape_hash text, side text, wkb text, length_m double precision, end_reason text
) ON COMMIT DROP
"""

STUB_START_TOLERANCE_M = 1.0

STUB_REFUSE_START_SQL = """
DELETE FROM stub_stage g USING shape_pattern s
 WHERE g.shape_hash = s.shape_hash
   AND NOT ST_DWithin(
     ST_Force2D(ST_StartPoint(ST_GeomFromWKB(decode(g.wkb, 'hex'), 4326)))::geography,
     ST_Force2D(CASE g.side WHEN 'before' THEN ST_StartPoint(s.geom)
                ELSE ST_EndPoint(s.geom) END)::geography,
     %(tolerance)s)
"""

NEW_SHAPES_SQL = """
CREATE TEMP TABLE new_shapes ON COMMIT DROP AS
SELECT DISTINCT g.shape_hash FROM shape_stage g
 WHERE NOT EXISTS (SELECT 1 FROM shape_pattern s WHERE s.shape_hash = g.shape_hash)
"""

STUB_KEEP_SQL = """
DELETE FROM stub_stage g
 WHERE EXISTS (SELECT 1 FROM shape_pattern s WHERE s.shape_hash = g.shape_hash)
   AND NOT EXISTS (SELECT 1 FROM new_shapes n WHERE n.shape_hash = g.shape_hash)
"""

STUB_KEEP_HASHES_SQL = """
DELETE FROM stub_hashes h
 WHERE NOT EXISTS (SELECT 1 FROM new_shapes n WHERE n.shape_hash = h.shape_hash)
"""

STUB_DELETE_SQL = """
DELETE FROM shape_stub st USING shape_pattern s
 WHERE st.shape_no = s.shape_no
   AND s.shape_hash IN (SELECT DISTINCT shape_hash FROM stub_hashes)
   AND NOT EXISTS (SELECT 1 FROM stub_stage g
                    WHERE g.shape_hash = s.shape_hash AND g.side = st.side)
"""

STUB_INSERT_SQL = """
INSERT INTO shape_stub (shape_no, side, geom, length_m, end_reason, stub_version, source_note,
  licence, provenance)
SELECT s.shape_no, g.side, ST_SetSRID(ST_GeomFromWKB(decode(g.wkb, 'hex')), 4326), g.length_m,
  g.end_reason, %(version)s, %(note)s, %(licence)s, %(provenance)s
FROM stub_stage g JOIN shape_pattern s USING (shape_hash)
ORDER BY s.shape_no, g.side
ON CONFLICT (shape_no, side) DO UPDATE SET geom = EXCLUDED.geom, length_m = EXCLUDED.length_m,
  end_reason = EXCLUDED.end_reason, stub_version = EXCLUDED.stub_version,
  source_note = EXCLUDED.source_note, licence = EXCLUDED.licence,
  provenance = EXCLUDED.provenance, created_at = now()
WHERE shape_stub.stub_version <> EXCLUDED.stub_version
   OR shape_stub.end_reason <> EXCLUDED.end_reason
   OR ST_AsEWKB(shape_stub.geom) <> ST_AsEWKB(EXCLUDED.geom)
"""


def stub_stage_rows(stubs: Sequence[Mapping]) -> list[tuple]:
    """(shape_hash, side, WKB hex, length, end) per stub side that has track (two or more
    points); M is the distance from the shape's end vertex."""
    out = []
    for row in stubs:
        for side in ("before", "after"):
            stub = row[side]
            if len(stub["dist"]) < 2 or stub["length_m"] <= 0:
                continue
            coords = np.column_stack([np.asarray(stub["lonlatz"], dtype=float), stub["dist"]])
            out.append(
                (
                    row["shape_hash"],
                    side,
                    linestring_zm_wkb(coords).hex(),
                    stub["length_m"],
                    stub["end"],
                )
            )
    return out


def _load_stubs(cur, stubs: Sequence[Mapping], provenance: Mapping, *, restub: bool) -> dict:
    """Writes the stubs of shapes present in ``shape_pattern``; a side the new rows leave
    without track loses its old row, as does a side whose stub starts more than
    ``STUB_START_TOLERANCE_M`` from the shape's end vertex. Without ``restub`` only the shapes
    this load inserted get stubs: a shape loaded earlier may sit in a published pack, so its
    stored stubs stay as they are. Counts: written (new or changed), removed,
    shape hashes unknown, refused for their start, staged sides kept from an earlier load."""
    cur.execute("DROP TABLE IF EXISTS pg_temp.stub_stage")
    cur.execute("DROP TABLE IF EXISTS pg_temp.stub_hashes")
    cur.execute(STUB_STAGE_SQL)
    cur.execute("CREATE TEMP TABLE stub_hashes (shape_hash text) ON COMMIT DROP")
    with cur.copy("COPY stub_hashes (shape_hash) FROM STDIN") as copy:
        for row in stubs:
            copy.write_row((row["shape_hash"],))
    with cur.copy(
        "COPY stub_stage (shape_hash, side, wkb, length_m, end_reason) FROM STDIN"
    ) as copy:
        for staged in stub_stage_rows(stubs):
            copy.write_row(staged)
    cur.execute(
        "SELECT count(DISTINCT h.shape_hash) FROM stub_hashes h"
        " WHERE NOT EXISTS (SELECT 1 FROM shape_pattern s WHERE s.shape_hash = h.shape_hash)"
    )
    unknown = cur.fetchone()[0]
    kept = 0
    if not restub:
        cur.execute(STUB_KEEP_SQL)
        kept = cur.rowcount
        cur.execute(STUB_KEEP_HASHES_SQL)
    cur.execute(STUB_REFUSE_START_SQL, {"tolerance": STUB_START_TOLERANCE_M})
    refused = cur.rowcount
    cur.execute(STUB_DELETE_SQL)
    removed = cur.rowcount
    cur.execute(
        STUB_INSERT_SQL,
        {
            "version": STUB_VERSION,
            "note": STUB_SOURCE_NOTE,
            "licence": STUB_LICENCE,
            "provenance": json.dumps({**provenance, "stub_version": STUB_VERSION}),
        },
    )
    return {
        "stubs_written": cur.rowcount,
        "stubs_removed": removed,
        "stubs_without_shape": unknown,
        "stubs_refused_start": refused,
        "stubs_kept": kept,
    }


def load(  # noqa: PLR0913, PLR0917
    conn,
    feed_version_id: int,
    shapes,
    metas: Sequence[Mapping],
    choice: Mapping[str, Mapping],
    rows: Mapping[str, Mapping],
    provenance: Mapping,
    elevation_source: str,
    stubs: Sequence[Mapping] | None = None,
    *,
    replace_all: bool = True,
    restub: bool = False,
) -> dict:
    """Upserts every shape and replaces the version's links (with ``replace_all=False`` only the
    links of the loaded patterns, so shapes reused from earlier versions stay) and, when ``stubs``
    is given, writes the track stubs of the shapes it inserted (with ``restub`` of every shape);
    returns counts."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS pg_temp.shape_stage")
        cur.execute(STAGE_SQL)
        with cur.copy(
            "COPY shape_stage (shape_hash, wkb, length_m, stop_arc_m, method, qa_status,"
            " tunnel_spans, bridge_spans, elevation_source, source_note, licence, provenance)"
            " FROM STDIN"
        ) as copy:
            for meta in metas:
                copy.write_row(
                    (
                        meta["shape_hash"],
                        linestring_zm_wkb(shapes.get(meta["pattern_id"])).hex(),
                        meta["length_m"],
                        float_array(meta["stop_arc_m"]),
                        meta["method"],
                        meta["qa_status"],
                        flat_spans(meta["tunnel_spans"]),
                        flat_spans(meta["bridge_spans"]),
                        elevation_source,
                        source_note(meta["method"]),
                        LICENCE[meta["method"]],
                        json.dumps(provenance),
                    )
                )
        cur.execute("DROP TABLE IF EXISTS pg_temp.new_shapes")
        cur.execute(NEW_SHAPES_SQL)
        cur.execute(INSERT_SQL)
        inserted = cur.rowcount
        if replace_all:
            cur.execute(
                "DELETE FROM trip_pattern_shape WHERE feed_version_id = %s", (feed_version_id,)
            )
        else:
            cur.execute(
                "DELETE FROM trip_pattern_shape WHERE feed_version_id = %s"
                " AND trip_pattern_id = ANY(%s::uuid[])",
                (feed_version_id, [m["pattern_id"] for m in metas]),
            )
        with cur.copy(
            "COPY trip_pattern_shape (feed_version_id, trip_pattern_id, shape_hash, group_method,"
            " candidate_verdicts, metrics, review_flags) FROM STDIN"
        ) as copy:
            for meta in metas:
                pid = meta["pattern_id"]
                entry = choice[pid]
                chosen = rows[pid].get(meta["method"]) if meta["method"] != STRAIGHT else None
                copy.write_row(
                    (
                        feed_version_id,
                        pid,
                        meta["shape_hash"],
                        entry["group_method"],
                        json.dumps(entry["verdicts"]),
                        json.dumps(_metrics(chosen, entry)),
                        text_array(entry["flags"]),
                    )
                )
        cur.execute(
            "SELECT count(*) FROM trip_pattern_shape WHERE feed_version_id = %s", (feed_version_id,)
        )
        links = cur.fetchone()[0]
        counts = {"shapes_inserted": inserted, "links": links}
        if stubs is not None:
            counts |= _load_stubs(cur, stubs, provenance, restub=restub)
    return counts


def _metrics(row: Mapping | None, entry: Mapping) -> dict:
    """The gate figures of the chosen candidate, without bulky per-run coordinates."""
    out: dict = {"verdicts": entry["verdicts"], "stop_misfits": entry["stop_misfits"]}
    if row is None:
        return out
    keep = (
        "on_rail",
        "detour",
        "detour_low",
        "beeline_m",
        "worst_leg",
        "worst_extra_m",
        "legs",
        "legs_routed",
        "max_stop_m",
        "off_relation_m",
        "covered_m",
        "stop_m",
        "hairpins",
        "reversals",
        "spur_cuts",
        "spur_removed_m",
        "turn_cuts",
        "reversal_stop_m",
        "u_turns_off_stop",
    )
    out.update({k: row.get(k) for k in keep})
    out["off_relation_runs"] = len(row.get("off_relation_runs") or [])
    return out
