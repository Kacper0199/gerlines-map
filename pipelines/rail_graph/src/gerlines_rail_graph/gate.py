"""Proposed WP-2.2 shape QA gate and the method choice per route and direction, on per-trip rows.

A row is the per-trip metrics dict written by ``evaluate`` (``per-trip.json``).
"""

from collections.abc import Mapping, Sequence
from enum import StrEnum

DETOUR_MIN = 0.97
DETOUR_MAX = 1.10
ON_RAIL_MIN = 0.98
BEELINE_MAX_M = 1000.0
PRIMARY = "motis"
SECONDARY = "pfaedle"


class Verdict(StrEnum):
    PASS = "pass"  # noqa: S105
    FAIL = "fail"
    UNMEASURED = "unmeasured"


def verdict(row: Mapping, *, strict: bool = False) -> Verdict:
    """Fail on any geometry fault; unmeasured when nothing inside Germany could be checked.

    Faults: no shape, a leg running backwards through the stops, legs that were measured but
    none routed, a beeline, too little length on track, a trip shorter than 0.97 times the lower
    bound of any real route (``detour_low``) or longer than 1.10 times the strict reference path,
    a leg of 2 km or more over 1.3 times its strict path, a leg over 300 m plus 5 % longer, or a
    hairpin or U-turn (a reversal over 60 m, ``spurs.u_turns``) that is no reversal at a stop or
    curated station once spurs are cut (``spurs``).
    Turns the spur cut removed (``turn_cuts``) and legs spliced from the strict-turn run
    (``spliced``) are no fault but a review flag; with ``strict`` they fail, so a shape without
    a repair is chosen first and a repaired one never moves its group (D-048).
    """
    if not row["has_shape"]:
        return Verdict.FAIL
    on_rail = row["on_rail"]
    detour = row["detour"]
    detour_low = row.get("detour_low", detour)
    faults = (
        row["legs_backwards"] > 0,
        row["legs"] > 0 and row["legs_routed"] == 0,
        row["beeline_m"] > BEELINE_MAX_M,
        on_rail is not None and on_rail < ON_RAIL_MIN,
        detour_low is not None and detour_low < DETOUR_MIN,
        detour is not None and detour > DETOUR_MAX,
        bool(row["legs_over_1_3"]),
        bool(row["legs_extra_over_300m"]),
        row.get("hairpins", 0) > 0,
        row.get("u_turns_off_stop", 0) > 0,
        strict and repaired(row),
    )
    if any(faults):
        return Verdict.FAIL
    if on_rail is None or row["legs_routed"] == 0:
        return Verdict.UNMEASURED
    return Verdict.PASS


STOP_LIMIT_M = 80.0


def turn_cut(row: Mapping) -> bool:
    """The spur cut removed turns the matcher made away from any stop (D-048)."""
    return row.get("turn_cuts", 0) > 0


def repaired(row: Mapping) -> bool:
    """A cut turn, or legs spliced from the strict-turn pfaedle run: such a shape
    passes but is chosen after shapes without a repair and never moves its group."""
    return turn_cut(row) or bool(row.get("spliced"))


def stop_misfits(row: Mapping, other: Mapping | None) -> list[int]:
    """Stops over 80 m from this shape that the other method's shape keeps within 80 m.

    A stop far from both shapes is a stop-data question and flags the stop, not the shape
    (D-028); only a stop the other method fits counts against this shape. A shape with an
    unexplained turn, or whose turns were cut, is no evidence: it often reaches a stop
    by running out to it and back.
    """
    if (
        other is None
        or not other.get("has_shape")
        or other.get("hairpins", 0) > 0
        or other.get("u_turns_off_stop", 0) > 0
        or repaired(other)
    ):
        return []
    mine, theirs = row.get("stop_m") or [], other.get("stop_m") or []
    if len(mine) != len(theirs):
        return []
    return [i for i, (a, b) in enumerate(zip(mine, theirs, strict=True)) if a > STOP_LIMIT_M >= b]


def verdict_against(row: Mapping, other: Mapping | None, *, strict: bool = False) -> Verdict:
    """``verdict`` plus D-028's stop rule: a stop the other method fits fails this shape."""
    result = verdict(row, strict=strict)
    if result == Verdict.PASS and stop_misfits(row, other):
        return Verdict.FAIL
    return result


def other_method(method: str) -> str:
    return SECONDARY if method == PRIMARY else PRIMARY


def needs_secondary(rows: Mapping[str, Mapping]) -> bool:
    """The primary shape is not trusted: it fails (stop rule included, a cut turn too) or runs
    off-relation."""
    primary = rows[PRIMARY]
    return verdict_against(primary, rows.get(SECONDARY), strict=True) == Verdict.FAIL or bool(
        primary["off_relation_runs"]
    )


def counts_for_choice(rows: Mapping[str, Mapping]) -> bool:
    """A pattern MOTIS could not be asked about (no service day in the router window) does not
    decide its group: it says nothing about the primary method's quality."""
    return rows[PRIMARY].get("has_shape", False) or not rows.get("motis_unasked", False)


def choose_group(rows: Sequence[Mapping[str, Mapping]]) -> str:
    """One method for all trips of a route and direction, so a line never jumps between tracks.

    MOTIS unless a pattern of the group needs the secondary method and pfaedle passes on every
    pattern where MOTIS does not, without a cut turn. A pattern whose shape of the group's
    method fails takes the other method's passing shape (D-037, see ``trip_outcome``).
    """
    switch = [r for r in rows if counts_for_choice(r) and needs_secondary(r)]
    if switch and all(
        verdict_against(r[SECONDARY], r[PRIMARY], strict=True) == Verdict.PASS for r in switch
    ):
        return SECONDARY
    return PRIMARY


LOW_QUALITY = "low_quality"
UNMEASURED = "unmeasured"


def trip_outcome(row: Mapping[str, Mapping], method: str) -> str:
    """The pattern's shape method, or the state of its straight fallback (DELFI is never chosen).

    The group's ``method`` when its shape passes; otherwise the other method when that shape
    passes, its stop rule judged against the group method's shape (D-037). A shape whose turns
    were cut comes only after both shapes without a cut turn (D-048). With neither passing,
    ``unmeasured`` when every shape there is could not be measured (D-028's third state, mostly
    trips abroad) and ``low_quality`` when a shape failed or none exists.
    """
    other = other_method(method)
    for strict in (True, False):
        for m in (method, other):
            if verdict_against(row[m], row.get(other_method(m)), strict=strict) == Verdict.PASS:
                return m
    shaped = [
        verdict_against(row[m], row.get(other_method(m)))
        for m in (method, other)
        if row[m].get("has_shape")
    ]
    if shaped and all(v == Verdict.UNMEASURED for v in shaped):
        return UNMEASURED
    return LOW_QUALITY


def floor_by_lower_bound(row: Mapping) -> bool:
    """The shape clears the 0.97 detour floor only against the lower bound, not the strict path."""
    detour, detour_low = row.get("detour"), row.get("detour_low")
    return detour is not None and detour_low is not None and detour < DETOUR_MIN <= detour_low
