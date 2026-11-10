"""Markdown tables of evaluation results, as quoted in the verification file."""

METHODS = ("pfaedle", "motis", "delfi")

COLUMNS = (
    "Group",
    "Method",
    "Trips",
    "Missing",
    "Stop p50 m",
    "Stop p95 m",
    "Stop max m",
    "Trips stop > 80 m",
    "On rail %",
    "Beeline %",
    "Trips beeline > 1 km",
    "Detour p50",
    "Detour p95",
    "Worst leg extra p95 m",
    "Legs > 1.3",
    "Legs extra > 300 m",
    "Backward legs",
    "Off-relation runs",
    "Trips with a run",
    "Train-km share with a run %",
)


def _f(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{100 * value:.1f}"


def row(group: str, method: str, r: dict) -> str:
    stops = r["stop_m"]
    cells = [
        group,
        method,
        str(r["trips"]),
        str(r["missing_shape"]),
        _f(stops["p50"]),
        _f(stops["p95"]),
        _f(stops["max"], 0),
        str(r["trips_stop_over_80m"]),
        _pct(r["on_rail_share"]),
        _pct(r["beeline_share"]),
        str(r["trips_beeline_over_1km"]),
        _f(r["detour"]["p50"], 3),
        _f(r["detour"]["p95"], 3),
        _f(r["worst_leg_extra_m"]["p95"], 0),
        str(r["legs_over_1_3"]),
        str(r["legs_extra_over_300m"]),
        str(r["legs_backwards"]),
        str(r["off_relation_runs"]),
        str(r["trips_off_relation_run"]),
        _pct(r["train_km_share_off_relation_run"]),
    ]
    return "| " + " | ".join(cells) + " |"


def table(results: dict, groups: list[str]) -> str:
    header = "| " + " | ".join(COLUMNS) + " |"
    rule = "| --- | --- |" + " ---: |" * (len(COLUMNS) - 2)
    rows = [
        row(group, method, results[group][method])
        for group in groups
        for method in METHODS
        if method in results.get(group, {})
    ]
    return "\n".join([header, rule, *rows])
