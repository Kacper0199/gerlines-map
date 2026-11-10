"""Gate and choice over every pattern, review flags, and the QA report for gate G2.

Per route and direction group one method (``gate.choose_group``); per pattern the outcome
(``gate.trip_outcome``): the group's method, the other method when the group's method fails and
the other passes (D-037), ``unmeasured`` when nothing could be measured, or ``low_quality``.
Pass rates count patterns and train-km of the reference week, per category and for domestic and
cross-border patterns apart, with the three states on all patterns and on patterns running in
the reference week.
"""

from collections import defaultdict
from collections.abc import Mapping, Sequence

from gerlines_rail_graph.gate import (
    LOW_QUALITY,
    PRIMARY,
    SECONDARY,
    STOP_LIMIT_M,
    UNMEASURED,
    choose_group,
    floor_by_lower_bound,
    stop_misfits,
    trip_outcome,
    turn_cut,
    verdict_against,
)
from gerlines_rail_graph.patterns import Pattern

FALLBACKS = (LOW_QUALITY, UNMEASURED)
STATES = ("pass", LOW_QUALITY, UNMEASURED)


def pattern_rows(pattern: Pattern, rows: Mapping[str, Mapping], spliced: bool = False) -> dict:
    """The per-method rows of a pattern plus whether MOTIS could be asked at all; a pfaedle
    candidate with spliced legs is marked, so like a cut turn it never moves its group."""
    out = {**rows, "motis_unasked": pattern.rep_date is None}
    if spliced:
        out[SECONDARY] = {**rows[SECONDARY], "spliced": True}
    return out


OUTSIDE_SLACK_M = 1.0


def measured_in_part(row: Mapping) -> bool:
    """Some stops or some shape length lie outside the measured area. Rows written before
    ``stops_outside`` existed count as partly measured, as every cross-border row then was."""
    if "stops_outside" not in row:
        return True
    return row["stops_outside"] > 0 or row["length_m"] - row["covered_m"] > OUTSIDE_SLACK_M


def review_flags(
    pattern: Pattern,
    rows: Mapping,
    outcome: str,
    group_method: str,
    spliced: frozenset[str] = frozenset(),
) -> list[str]:
    """Reasons to look at a pattern again; none of them rejects a shape.
    ``spliced``: patterns whose pfaedle candidate has legs from the strict-turn run."""
    flags = []
    if outcome in FALLBACKS:
        flags.append(outcome)
        return flags
    chosen = rows[outcome]
    if chosen["off_relation_runs"]:
        flags.append("off_relation_run")
    if turn_cut(chosen):
        flags.append("turn_cut")
    if outcome == SECONDARY and pattern.pattern_id in spliced:
        flags.append("pfaedle_spliced")
    if chosen.get("reversal_stop_m", 0.0) > STOP_LIMIT_M:
        flags.append("stop_on_reversal")
    if any(d > STOP_LIMIT_M for d in chosen.get("stop_m") or []):
        flags.append("stop_over_80m")
    if outcome != group_method:
        flags.append("other_method_than_group")
    if floor_by_lower_bound(chosen):
        flags.append("floor_by_lower_bound")
    if pattern.scope == "cross_border" and measured_in_part(chosen):
        flags.append("cross_border_unmeasured_abroad")
    return flags


def choose_all(
    patterns: Sequence[Pattern],
    rows: Mapping[str, Mapping],
    spliced: frozenset[str] = frozenset(),
) -> dict[str, dict]:
    """Outcome, group method, verdicts and flags per pattern id."""
    groups: dict[str, list[Pattern]] = defaultdict(list)
    for pattern in patterns:
        groups[pattern.group].append(pattern)
    out: dict[str, dict] = {}
    for members in groups.values():
        full = {
            p.pattern_id: pattern_rows(p, rows[p.pattern_id], p.pattern_id in spliced)
            for p in members
        }
        method = choose_group(list(full.values()))
        for pattern in members:
            r = full[pattern.pattern_id]
            outcome = trip_outcome(r, method)
            out[pattern.pattern_id] = {
                "outcome": outcome,
                "group_method": method,
                "verdicts": {
                    PRIMARY: verdict_against(r[PRIMARY], r.get(SECONDARY)).value,
                    SECONDARY: verdict_against(r[SECONDARY], r.get(PRIMARY)).value,
                },
                "stop_misfits": {
                    PRIMARY: stop_misfits(r[PRIMARY], r.get(SECONDARY)),
                    SECONDARY: stop_misfits(r[SECONDARY], r.get(PRIMARY)),
                },
                "flags": review_flags(pattern, r, outcome, method, spliced),
            }
    return out


def _share(part: float, whole: float) -> float | None:
    return round(part / whole, 4) if whole else None


def state_of(outcome: str) -> str:
    return outcome if outcome in FALLBACKS else "pass"


def qa_report(patterns: Sequence[Pattern], choice: Mapping[str, Mapping]) -> dict:
    """Pass rates of patterns and train-km per category and scope, the three states on all
    patterns and on patterns running in the reference week, and outcome and flag counts."""
    cells: dict[str, dict] = defaultdict(
        lambda: {
            "patterns": 0,
            "train_km_week": 0.0,
            "pass_train_km_week": 0.0,
            "patterns_running": 0,
            "states": dict.fromkeys(STATES, 0),
            "states_running": dict.fromkeys(STATES, 0),
            "outcome": defaultdict(int),
            "flags": defaultdict(int),
        }
    )
    for pattern in patterns:
        entry = choice[pattern.pattern_id]
        state = state_of(entry["outcome"])
        passed = state == "pass"
        for key in (
            f"{pattern.category}:{pattern.scope}",
            f"all:{pattern.scope}",
            "all:all",
        ):
            cell = cells[key]
            cell["patterns"] += 1
            cell["states"][state] += 1
            cell["train_km_week"] += pattern.train_km_week
            cell["pass_train_km_week"] += pattern.train_km_week if passed else 0.0
            if pattern.trip_days_week:
                cell["patterns_running"] += 1
                cell["states_running"][state] += 1
            cell["outcome"][entry["outcome"]] += 1
            for flag in entry["flags"]:
                cell["flags"][flag] += 1
    report = {}
    for key in sorted(cells):
        cell = cells[key]
        report[key] = {
            "patterns": cell["patterns"],
            "pass": cell["states"]["pass"],
            "pass_rate_patterns": _share(cell["states"]["pass"], cell["patterns"]),
            "patterns_running_in_week": cell["patterns_running"],
            "pass_rate_running_patterns": _share(
                cell["states_running"]["pass"], cell["patterns_running"]
            ),
            "states": cell["states"],
            "states_running": cell["states_running"],
            "train_km_week": round(cell["train_km_week"]),
            "pass_rate_train_km": _share(cell["pass_train_km_week"], cell["train_km_week"]),
            "outcome": dict(cell["outcome"]),
            "flags": dict(cell["flags"]),
        }
    groups = {p.group for p in patterns}
    on_secondary = {p.group for p in patterns if choice[p.pattern_id]["group_method"] == SECONDARY}
    report["groups"] = {"route_direction_groups": len(groups), "on_pfaedle": len(on_secondary)}
    return report
