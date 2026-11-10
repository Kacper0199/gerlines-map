"""Reversals at stops compared across patterns: a review report, not a gate.

A movement is (stop place, the two neighbouring stop places unordered). A shape reverses at a
stop when a windowed U-turn lies within ``REVERSAL_NEAR_M`` along the line of the stop's arc.
Over all chosen track shapes, a movement where some shapes reverse and others run through is
disputed: the same two neighbours at the same station leave a train one choice.

Rule 0 (neighbour direction): when the stops before and after lie on the same side (the
directions to them within ``SAME_SIDE_DEG``), a run-through is impossible and the through
shapes are the faults. Opposite neighbours decide nothing: a terminus such as Frankfurt (Main)
Hbf is reached from one side and left to the other. Rule 2 (track end): otherwise the
reversals are real when most turns lie at a buffer stop found along the arriving heading within
``BUFFER_SEARCH_M`` on track at most ``BUFFER_SNAP_M`` beside the turn; else the station is a
through station for that movement and the reversals are the faults. Each turn records the OSM
way it snapped to, the buffer node and the gap, so a snap onto a neighbouring platform track
can be checked.
"""

from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass

import numpy as np

from gerlines_rail_graph.spurs import arc, u_turns

REVERSAL_NEAR_M = 300.0
BUFFER_SEARCH_M = 150.0
BUFFER_SNAP_M = 2.0
SAME_SIDE_DEG = 60.0
HEADING_BACK_M = 30.0


@dataclass(frozen=True, slots=True)
class Call:
    pattern_id: str
    movement: tuple[str, str, str]
    reverses: bool
    neighbour_deg: float
    apex: np.ndarray | None = None
    heading: np.ndarray | None = None


def place(stop_id: str) -> str:
    """The stop place of a DHID stop point (its first three parts)."""
    return ":".join(stop_id.split(":")[:3])


def neighbour_angle(before: np.ndarray, at: np.ndarray, after: np.ndarray) -> float:
    """Degrees between the directions from ``at`` to the stop before and to the stop after."""
    a, b = np.asarray(before) - at, np.asarray(after) - at
    norms = float(np.linalg.norm(a) * np.linalg.norm(b))
    if norms == 0:
        return 180.0
    return float(np.degrees(np.arccos(np.clip(float(a @ b) / norms, -1.0, 1.0))))


def stop_calls(
    pattern_id: str, stop_ids: list[str], stops_xy: np.ndarray, line_xy: np.ndarray, arcs
) -> list[Call]:
    """One call per inner stop of a shape (EPSG:25832), with the nearest U-turn's apex and the
    heading into it when the shape reverses there."""
    line_xy = np.asarray(line_xy, dtype=float)
    cum = arc(line_xy)
    turns = np.asarray(u_turns(line_xy), dtype=float)

    def point(t: float) -> np.ndarray:
        return np.array([np.interp(t, cum, line_xy[:, 0]), np.interp(t, cum, line_xy[:, 1])])

    out = []
    for k in range(1, len(stop_ids) - 1):
        a, s, b = place(stop_ids[k - 1]), place(stop_ids[k]), place(stop_ids[k + 1])
        angle = neighbour_angle(stops_xy[k - 1], stops_xy[k], stops_xy[k + 1])
        near = np.abs(turns - arcs[k]) if len(turns) else np.zeros(0)
        movement = (s, *sorted((a, b)))
        if len(near) and float(near.min()) <= REVERSAL_NEAR_M:
            t = float(turns[int(np.argmin(near))])
            apex = point(t)
            out.append(
                Call(pattern_id, movement, True, angle, apex, apex - point(t - HEADING_BACK_M))
            )
        else:
            out.append(Call(pattern_id, movement, False, angle))
    return out


def disputed(calls: Iterable[Call]) -> dict[tuple, list[Call]]:
    """Movements where some calls reverse and others run through."""
    groups: dict[tuple, list[Call]] = defaultdict(list)
    for call in calls:
        groups[call.movement].append(call)
    return {
        key: group
        for key, group in groups.items()
        if any(c.reverses for c in group) and not all(c.reverses for c in group)
    }


BufferTest = Callable[[np.ndarray, np.ndarray], Mapping]


def decide(group: list[Call], at_buffer: BufferTest) -> dict:
    """The verdict for one disputed movement: which side is the fault, by which rule, whether
    the two rules agree, the turns' track evidence and the fault patterns."""
    rev = [c for c in group if c.reverses]
    thru = [c for c in group if not c.reverses]
    angle = float(np.median([c.neighbour_deg for c in group]))
    rule0 = "reverse" if angle < SAME_SIDE_DEG else None
    turns = [{"pattern_id": c.pattern_id, **at_buffer(c.apex, c.heading)} for c in rev]
    share = sum(t["at_buffer"] for t in turns) / len(turns)
    rule2 = "reverse" if share >= 0.5 else "through"
    verdict = rule0 or rule2
    faults = thru if verdict == "reverse" else rev
    return {
        "movement": list(group[0].movement),
        "reversing": len(rev),
        "through": len(thru),
        "neighbour_deg": round(angle, 1),
        "rule0": rule0,
        "rule2": rule2,
        "verdict": verdict,
        "rule": "0" if rule0 else "2",
        "rules_agree": rule0 is None or rule0 == rule2,
        "turns": turns,
        "fault_patterns": sorted({c.pattern_id for c in faults}),
    }


def walker_buffer_test(walker) -> BufferTest:
    """Rule 2's track end test on a ``TrackWalker``."""

    def test(apex: np.ndarray, heading: np.ndarray) -> dict:
        norm = float(np.hypot(*heading))
        stub = walker.walk(
            apex,
            heading / norm if norm > 0 else heading,
            BUFFER_SEARCH_M,
            max_gap_m=BUFFER_SNAP_M,
            min_m=0.0,
            start_deg=None,
        )
        return {
            "at_buffer": stub.end == "buffer",
            "way_id": stub.way_id,
            "buffer_node": stub.end_node if stub.end == "buffer" else -1,
            "gap_m": round(stub.gap_m, 2) if np.isfinite(stub.gap_m) else None,
        }

    return test


def report(decisions: list[dict]) -> dict:
    """Totals of a run: disputed movements, verdicts by rule, disagreements, fault patterns."""
    faults = sorted({p for d in decisions for p in d["fault_patterns"]})
    return {
        "disputed_movements": len(decisions),
        "by_rule": {r: sum(d["rule"] == r for d in decisions) for r in ("0", "2")},
        "rules_disagree": sum(not d["rules_agree"] for d in decisions),
        "fault_patterns": len(faults),
    }
