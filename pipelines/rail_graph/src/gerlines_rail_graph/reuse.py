"""Shapes of a new feed version taken from earlier versions (weekly rollover).

A trip pattern of the new version reuses an earlier version's shape when it is the same pattern
(same content id: route, stops and DELFI shape key), else when it calls at the same stop points in
the same order with the same category, else at the same stop places (other platforms, same
stations). Stop points and places have canonical ids that stay across versions, so the keys survive
DELFI renumbering its routes and shapes (the 2026-11-02 feed changed every pattern id). A reuse is
refused when a stop of the new pattern now stands more than ``max_stop_m`` from the point at its
stop arc on the old shape and more than ``WORSE_STOP_M`` beyond the distance that same stop was
gated with (``metrics.stop_m`` of the old link by stop index; ``metrics.max_stop_m`` when the list
does not have one entry per stop). Stop points are one table that each load overwrites with the
newest coordinates, so the old pattern's stops cannot serve as the baseline. Such a pattern is
built like a new one, and so is a pattern whose old shape is a straight fallback or did not pass
the gate, so new OSM data or a reimported MOTIS get another try. When several old shapes share a
stop key, the one of the same DELFI shape key wins, then the same route key, then the same line
name, then the gate ranking. Reused links record today's worst stop distance (``worst_m`` in
``reused_from``) beside the metrics copied from the old link. Only the patterns left over go
through pfaedle and the gate.
"""

import hashlib
import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

DEFAULT_MAX_STOP_M = 80.0
WORSE_STOP_M = 20.0
ROUTER_NOT_REIMPORTED = "router_not_reimported"
_QA_RANK = {"pass": 0, "fail": 1, "unmeasured": 2, "low_quality": 3}


@dataclass(frozen=True, slots=True)
class NewPattern:
    pattern_id: str
    category: str
    stops: tuple[str, ...]
    places: tuple[str, ...]
    route_key: str | None = None
    shape_key: str | None = None
    line: str | None = None


@dataclass(frozen=True, slots=True)
class OldLink:
    feed_version_id: int
    trip_pattern_id: str
    category: str
    stops: tuple[str, ...]
    places: tuple[str, ...]
    shape_hash: str
    qa_status: str
    method: str = "pfaedle"
    route_key: str | None = None
    shape_key: str | None = None
    line: str | None = None


@dataclass(frozen=True, slots=True)
class Match:
    pattern_id: str
    link: OldLink
    how: str


def restrict(patterns: Sequence, only: Iterable[str]) -> list:
    """The patterns named in ``only`` (a new-pattern list from ``reuse``), in their order."""
    wanted = set(only)
    known = {p.pattern_id for p in patterns}
    missing = sorted(wanted - known)
    if missing:
        msg = f"{len(missing)} listed patterns are not in this feed version, first {missing[0]}"
        raise SystemExit(msg)
    return [p for p in patterns if p.pattern_id in wanted]


def without_router(patterns: Sequence) -> tuple[dict[str, None], dict[str, str], dict]:
    """The ``fetch-motis`` result while MOTIS still serves the previous feed: no MOTIS shape for
    any pattern, so the gate chooses among pfaedle and the straight fallback."""
    shapes = {p.pattern_id: None for p in patterns}
    how = dict.fromkeys(shapes, ROUTER_NOT_REIMPORTED)
    summary = {
        "patterns": len(shapes),
        "with_shape": 0,
        "reasons": {ROUTER_NOT_REIMPORTED: len(shapes)} if shapes else {},
    }
    return shapes, how, summary


def reuse_key(category: str, stops: Sequence[str]) -> str:
    """Category and ordered stop points, unambiguous for any id text."""
    payload = json.dumps([category, list(stops)], separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _preference(link: OldLink) -> tuple:
    return (_QA_RANK.get(link.qa_status, 9), -link.feed_version_id, link.trip_pattern_id)


def reusable(link: OldLink) -> bool:
    """A passing shape matched on rails; straight fallbacks and failed shapes are built again."""
    return link.qa_status == "pass" and link.method != "straight"


def _same(a: str | None, b: str | None) -> bool:
    return a is not None and a == b


_DECIDERS = ("shape_key", "route_key", "line")


def _closeness(pattern: NewPattern, link: OldLink) -> tuple[bool, ...]:
    return tuple(not _same(getattr(pattern, key), getattr(link, key)) for key in _DECIDERS)


def _decider(pattern: NewPattern, best: OldLink, rivals: list[OldLink]) -> str:
    """The first key on which the winner is close and a rival with another shape, tied with it on
    every key before, is not; ``rank`` when no key separates them."""
    near = _closeness(pattern, best)
    tied = [_closeness(pattern, link) for link in rivals]
    for index, key in enumerate(_DECIDERS):
        if not near[index] and any(far[index] for far in tied):
            return key
        tied = [far for far in tied if far[index] == near[index]]
    return "rank"


def _choose(pattern: NewPattern, candidates: list[OldLink]) -> tuple[OldLink, str | None]:
    """The candidate closest to the pattern by shape key, route key, line, then the gate ranking,
    and what decided when the candidates hold more than one shape (None otherwise)."""
    best = min(candidates, key=lambda link: (*_closeness(pattern, link), *_preference(link)))
    rivals = [link for link in candidates if link.shape_hash != best.shape_hash]
    if not rivals:
        return best, None
    return best, _decider(pattern, best, rivals)


def match_patterns(
    patterns: Iterable[NewPattern], links: Iterable[OldLink], *, counts: dict | None = None
) -> tuple[list[Match], list[str]]:
    """The old link each new pattern reuses (same pattern id, else same stop points, else same
    stop places) and the patterns left without one. ``counts`` receives the patterns left over
    only because their old shapes are not reusable (``not_reused_quality``), the matches whose
    stop key held more than one shape (``collisions`` per tier) and what decided those."""
    by_pattern: dict[str, OldLink] = {}
    by_stops: dict[str, list[OldLink]] = {}
    by_places: dict[str, list[OldLink]] = {}
    refused: set[tuple[str, str]] = set()
    for link in links:
        keys = (
            ("pattern", link.trip_pattern_id),
            ("stops", reuse_key(link.category, link.stops)),
            ("places", reuse_key(link.category, link.places)),
        )
        if not reusable(link):
            refused.update(keys)
            continue
        held = by_pattern.get(link.trip_pattern_id)
        if held is None or _preference(link) < _preference(held):
            by_pattern[link.trip_pattern_id] = link
        by_stops.setdefault(keys[1][1], []).append(link)
        by_places.setdefault(keys[2][1], []).append(link)
    tally = {
        "not_reused_quality": 0,
        "collisions": {"same_stops": 0, "same_places": 0},
        "decided_by": dict.fromkeys((*_DECIDERS, "rank"), 0),
    }
    matches: list[Match] = []
    unmatched: list[str] = []
    for pattern in sorted(patterns, key=lambda p: p.pattern_id):
        same = by_pattern.get(pattern.pattern_id)
        if same is not None and same.stops == pattern.stops and same.category == pattern.category:
            matches.append(Match(pattern.pattern_id, same, "same_pattern"))
            continue
        stops_key = reuse_key(pattern.category, pattern.stops)
        places_key = reuse_key(pattern.category, pattern.places)
        for how, index, key in (
            ("same_stops", by_stops, stops_key),
            ("same_places", by_places, places_key),
        ):
            found = index.get(key)
            if found:
                link, decided = _choose(pattern, found)
                matches.append(Match(pattern.pattern_id, link, how))
                if decided is not None:
                    tally["collisions"][how] += 1
                    tally["decided_by"][decided] += 1
                break
        else:
            unmatched.append(pattern.pattern_id)
            if {
                ("pattern", pattern.pattern_id),
                ("stops", stops_key),
                ("places", places_key),
            } & refused:
                tally["not_reused_quality"] += 1
    if counts is not None:
        counts.update(tally)
    return matches, unmatched


PATTERNS_SQL = """
SELECT tp.feed_version_id, tp.trip_pattern_id::text, r.category_code,
       tp.route_key, tp.shape_key, r.short_name,
       array_agg(ps.stop_point_id::text ORDER BY ps.stop_index) AS stops,
       array_agg(sp.stop_place_id::text ORDER BY ps.stop_index) AS places
  FROM trip_pattern tp
  JOIN route r ON r.feed_version_id = tp.feed_version_id AND r.route_key = tp.route_key
  JOIN trip_pattern_stop ps
    ON ps.feed_version_id = tp.feed_version_id AND ps.trip_pattern_id = tp.trip_pattern_id
  JOIN stop_point sp ON sp.stop_point_id = ps.stop_point_id
 WHERE tp.feed_version_id = ANY(%s)
 GROUP BY 1, 2, 3, 4, 5, 6
"""

LINKS_SQL = """
SELECT link.feed_version_id, link.trip_pattern_id::text, link.shape_hash, s.qa_status, s.method
  FROM trip_pattern_shape link
  JOIN shape_pattern s ON s.shape_hash = link.shape_hash
 WHERE link.feed_version_id = ANY(%s)
"""

STAGE_SQL = """
CREATE TEMP TABLE reuse_stage (
  trip_pattern_id uuid PRIMARY KEY, source_version integer, source_pattern uuid, how text,
  worst_m double precision
) ON COMMIT DROP
"""

DRIFT_SQL = """
SELECT trip_pattern_id::text,
       max(now_m - greatest(%(max_stop_m)s, gated_m + %(worse_m)s)) AS excess_m,
       max(now_m) AS worst_m,
       bool_or(now_m IS NULL) AS unplaced
  FROM (
SELECT st.trip_pattern_id,
       ST_Distance(sp.geom::geography, ST_Force2D(ST_GeometryN(at_arc, 1))::geography) AS now_m,
       CASE WHEN jsonb_typeof(link.metrics->'stop_m') = 'array'
                 AND jsonb_array_length(link.metrics->'stop_m') = tp.stop_count
            THEN (link.metrics->'stop_m'->>ps.stop_index)::double precision
            ELSE coalesce((link.metrics->>'max_stop_m')::double precision, 0)
       END AS gated_m
  FROM reuse_stage st
  JOIN trip_pattern tp
    ON tp.feed_version_id = %(target)s AND tp.trip_pattern_id = st.trip_pattern_id
  JOIN trip_pattern_shape link
    ON link.feed_version_id = st.source_version AND link.trip_pattern_id = st.source_pattern
  JOIN shape_pattern s ON s.shape_hash = link.shape_hash
  JOIN trip_pattern_stop ps
    ON ps.feed_version_id = %(target)s AND ps.trip_pattern_id = st.trip_pattern_id
  JOIN stop_point sp ON sp.stop_point_id = ps.stop_point_id
  CROSS JOIN LATERAL (
    SELECT ST_LocateAlong(s.geom, s.stop_arc_m[ps.stop_index + 1]) AS located
  ) found
  CROSS JOIN LATERAL (
    SELECT CASE WHEN ST_IsEmpty(found.located) THEN NULL ELSE found.located END AS at_arc
  ) arc
) placed
 GROUP BY 1
"""

WORST_SQL = """
UPDATE reuse_stage st SET worst_m = d.worst_m
  FROM unnest(%s::uuid[], %s::double precision[]) AS d(trip_pattern_id, worst_m)
 WHERE st.trip_pattern_id = d.trip_pattern_id
"""

INSERT_SQL = """
INSERT INTO trip_pattern_shape (feed_version_id, trip_pattern_id, shape_hash, group_method,
  candidate_verdicts, metrics, review_flags)
SELECT %s, st.trip_pattern_id, link.shape_hash, link.group_method, link.candidate_verdicts,
       link.metrics || jsonb_build_object('reused_from', jsonb_build_object(
         'feed_version_id', st.source_version,
         'trip_pattern_id', st.source_pattern,
         'how', st.how,
         'worst_m', round(st.worst_m::numeric, 1))),
       link.review_flags
  FROM reuse_stage st
  JOIN trip_pattern_shape link
    ON link.feed_version_id = st.source_version AND link.trip_pattern_id = st.source_pattern
 WHERE st.trip_pattern_id = ANY(%s::uuid[])
ON CONFLICT (feed_version_id, trip_pattern_id) DO NOTHING
"""


def reuse_shapes(
    conn, target: int, sources: Sequence[int], *, max_stop_m: float = DEFAULT_MAX_STOP_M
) -> dict:
    """Links the target version's patterns to earlier shapes in one transaction; returns counts
    and ``new_pattern_ids`` (the patterns still without a shape, to be built)."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT status FROM feed_version WHERE feed_version_id = %s", (target,))
        status = cur.fetchone()
        if status is None or status[0] != "loaded":
            msg = f"feed version {target} is not loaded; run reuse after its static load"
            raise SystemExit(msg)
        cur.execute(PATTERNS_SQL, ([target, *sources],))
        rows = cur.fetchall()
        cur.execute(LINKS_SQL, (list(sources),))
        shapes = {(v, p): (h, q, m) for v, p, h, q, m in cur.fetchall()}
        cur.execute(
            "SELECT trip_pattern_id::text FROM trip_pattern_shape WHERE feed_version_id = %s",
            (target,),
        )
        already = {r[0] for r in cur.fetchall()}
        new = [
            NewPattern(pid, category, tuple(stops), tuple(places), route, shape_key, line)
            for version, pid, category, route, shape_key, line, stops, places in rows
            if version == target and pid not in already
        ]
        old = [
            OldLink(
                version,
                pid,
                category,
                tuple(stops),
                tuple(places),
                *shapes[(version, pid)],
                route,
                shape_key,
                line,
            )
            for version, pid, category, route, shape_key, line, stops, places in rows
            if version != target and (version, pid) in shapes
        ]
        counts: dict = {}
        matches, unmatched = match_patterns(new, old, counts=counts)
        cur.execute("DROP TABLE IF EXISTS pg_temp.reuse_stage")
        cur.execute(STAGE_SQL)
        with cur.copy(
            "COPY reuse_stage (trip_pattern_id, source_version, source_pattern, how) FROM STDIN"
        ) as copy:
            for m in matches:
                copy.write_row(
                    (m.pattern_id, m.link.feed_version_id, m.link.trip_pattern_id, m.how)
                )
        cur.execute(
            DRIFT_SQL, {"target": target, "max_stop_m": max_stop_m, "worse_m": WORSE_STOP_M}
        )
        drift = {pid: (excess, worst, unplaced) for pid, excess, worst, unplaced in cur.fetchall()}
        kept = [
            m
            for m in matches
            if m.pattern_id in drift
            and not drift[m.pattern_id][2]
            and drift[m.pattern_id][0] is not None
            and drift[m.pattern_id][0] <= 0
        ]
        moved = sorted({m.pattern_id for m in matches} - {m.pattern_id for m in kept})
        cur.execute(
            WORST_SQL,
            ([m.pattern_id for m in kept], [drift[m.pattern_id][1] for m in kept]),
        )
        cur.execute(INSERT_SQL, (target, [m.pattern_id for m in kept]))
        inserted = cur.rowcount
    worst = [drift[m.pattern_id][1] for m in kept]
    by_how: dict[str, int] = {"same_pattern": 0, "same_stops": 0, "same_places": 0}
    for m in kept:
        by_how[m.how] += 1
    by_category: dict[str, dict[str, int]] = {}
    category_of = {p.pattern_id: p.category for p in new}
    kept_ids = {m.pattern_id for m in kept}
    for pid, category in category_of.items():
        entry = by_category.setdefault(category, {"patterns": 0, "reused": 0})
        entry["patterns"] += 1
        entry["reused"] += pid in kept_ids
    new_ids = sorted(set(unmatched) | set(moved))
    return {
        "target": target,
        "sources": list(sources),
        "patterns": len(new) + len(already),
        "already_linked": len(already),
        "reused": by_how,
        "inserted": inserted,
        "stop_moved": len(moved),
        "not_reused_quality": counts["not_reused_quality"],
        "collisions": counts["collisions"],
        "decided_by": counts["decided_by"],
        "max_stop_m": max_stop_m,
        "reused_worst_stop_m_max": round(max(worst), 1) if worst else None,
        "new_patterns": len(new_ids),
        "by_category": dict(sorted(by_category.items())),
        "new_pattern_ids": new_ids,
    }
