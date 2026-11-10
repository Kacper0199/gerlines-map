"""Evaluation sample: trips through 20 hard corridors and a random national sample."""

import random
import re
from collections import defaultdict
from dataclasses import dataclass, field

from shapely import LineString, Point, box

NIGHT_NAME = re.compile(r"^(NJ|EN)\b|^\d+\s?N$")
SBAHN_NAME = re.compile(r"^(S|RS)\s?\d*$|^(S|RS)\s?\d+\w*$")


def category(route_type: int, short_name: str) -> str:
    """A coarse category for sampling and the wrong-track metric (the full rules are WP-2.1's)."""
    name = short_name.strip()
    if route_type == 109 or SBAHN_NAME.match(name):
        return "sbahn"
    if route_type == 101:
        return "hsr"
    if route_type == 102:
        return "night" if NIGHT_NAME.match(name) else "ld"
    return "reg"


@dataclass(frozen=True, slots=True)
class Corridor:
    name: str
    bbox: tuple[float, float, float, float]
    stop_pattern: str | None = None
    pairs: tuple[tuple[str, str], ...] = ()
    cross_border: bool = False


@dataclass(frozen=True, slots=True)
class TripStops:
    names: list[str]
    lonlat: list[tuple[float, float]] = field(default_factory=list)


def _crosses_box(stops: TripStops, area) -> bool:
    if any(area.contains(Point(p)) for p in stops.lonlat):
        return True
    return len(stops.lonlat) > 1 and LineString(stops.lonlat).intersects(area)


def serves_corridor(stops: TripStops, corridor: Corridor) -> bool:
    """A trip serves a corridor when it crosses the box (and stops at a matching stop where a
    pattern is set), or when it runs non-stop between the two stops of a corridor pair."""
    crosses = _crosses_box(stops, box(*corridor.bbox))
    if crosses and corridor.stop_pattern is None:
        return True
    if crosses and any(re.search(corridor.stop_pattern, name) for name in stops.names):
        return True
    for first, second in corridor.pairs:
        for a, b in zip(stops.names, stops.names[1:], strict=False):
            if re.search(first, a) and re.search(second, b):
                return True
            if re.search(second, a) and re.search(first, b):
                return True
    return False


def pick_corridor_trips(
    candidates: dict[str, tuple[str, str, bool]], per_category: int, rng: random.Random
) -> list[str]:
    """Up to ``per_category`` trips per category, one per stop pattern, flagged trips first.

    ``candidates`` maps trip id to (category, stop pattern key, flagged by stop_too_far_from_shape).
    """
    by_category: dict[str, list[str]] = defaultdict(list)
    for trip_id in sorted(candidates):
        by_category[candidates[trip_id][0]].append(trip_id)
    picked: list[str] = []
    for cat in sorted(by_category):
        trips = by_category[cat]
        rng.shuffle(trips)
        trips.sort(key=lambda t: not candidates[t][2])
        patterns: set[str] = set()
        count = 0
        for trip_id in trips:
            pattern = candidates[trip_id][1]
            if pattern in patterns:
                continue
            patterns.add(pattern)
            picked.append(trip_id)
            count += 1
            if count == per_category:
                break
    return picked


@dataclass(frozen=True, slots=True)
class Pattern:
    """One stop pattern of a route and direction on the sample day."""

    key: str
    category: str
    trips: tuple[str, ...]
    length_km: float

    @property
    def train_km(self) -> float:
        return self.length_km * len(self.trips)


def pps_sample(weights: dict[str, float], n: int, rng: random.Random) -> list[str]:
    """``n`` keys without replacement, each with probability growing with its weight.

    Efraimidis and Spirakis: key ``u ** (1 / w)``, take the largest. All keys when there are
    ``n`` or fewer; keys with weight 0 or less are never drawn.
    """
    positive = {k: w for k, w in sorted(weights.items()) if w > 0}
    if len(positive) <= n:
        return sorted(positive)
    keyed = sorted(positive, key=lambda k: rng.random() ** (1.0 / positive[k]), reverse=True)
    return sorted(keyed[:n])


def stratified_patterns(
    patterns: list[Pattern], per_category: int, rng: random.Random
) -> dict[str, list[Pattern]]:
    """Per category, ``per_category`` patterns drawn with probability by train-km."""
    by_category: dict[str, dict[str, Pattern]] = defaultdict(dict)
    for pattern in patterns:
        by_category[pattern.category][pattern.key] = pattern
    picked: dict[str, list[Pattern]] = {}
    for cat in sorted(by_category):
        group = by_category[cat]
        keys = pps_sample({k: p.train_km for k, p in group.items()}, per_category, rng)
        picked[cat] = [group[k] for k in keys]
    return picked


CORRIDORS: tuple[Corridor, ...] = (
    Corridor("koeln-hbf", (6.945, 50.935, 6.975, 50.948)),
    Corridor("hamburg-hbf", (9.995, 53.545, 10.015, 53.558)),
    Corridor(
        "frankfurt-sbahn-tunnel",
        (8.655, 50.104, 8.695, 50.116),
        stop_pattern=r"Taunusanlage|Hauptwache|Konstablerwache|Ostendstr",
    ),
    Corridor(
        "muenchen-stammstrecke",
        (11.535, 48.136, 11.595, 48.146),
        stop_pattern=r"Hackerbr|Karlsplatz|Marienplatz|Isartor|Rosenheimer Pl",
    ),
    Corridor("berlin-stadtbahn", (13.33, 52.505, 13.42, 52.525)),
    Corridor("geislinger-steige", (9.80, 48.58, 9.88, 48.64)),
    Corridor(
        "rhine-left",
        (7.55, 50.0, 7.80, 50.25),
        stop_pattern=r"Boppard|Oberwesel|Bacharach|St\.? ?Goar(?!s)|Spay|Brey",
        pairs=((r"^Mainz|^Bingen", r"^Koblenz Hauptbahnhof"),),
    ),
    Corridor("hamburg-elbe-bridges", (9.995, 53.505, 10.03, 53.54)),
    Corridor(
        "schwarzwaldbahn",
        (8.15, 48.08, 8.32, 48.20),
        stop_pattern=r"Triberg|Hornberg|Gutach|St\.? ?Georgen",
    ),
    Corridor(
        "leipzig-city-tunnel",
        (12.365, 51.325, 12.39, 51.348),
        stop_pattern=r"Markt|Leuschner|Bayerischer Bahnhof|MDR",
    ),
    Corridor(
        "stuttgart-sbahn-tunnel",
        (9.155, 48.765, 9.19, 48.787),
        stop_pattern=r"Stadtmitte|Feuersee|Schwabstr|Universit",
    ),
    Corridor("ruhr-duisburg-essen", (6.78, 51.42, 7.02, 51.46)),
    Corridor("dresden-hbf-neustadt", (13.72, 51.035, 13.76, 51.068)),
    Corridor("basel", (7.57, 47.54, 7.62, 47.58), cross_border=True),
    Corridor("aachen-border", (5.98, 50.74, 6.10, 50.80), cross_border=True),
    Corridor("salzburg-freilassing", (12.95, 47.78, 13.06, 47.86), cross_border=True),
    Corridor("kehl-strasbourg", (7.74, 48.565, 7.82, 48.59), cross_border=True),
    Corridor("goerlitz", (14.95, 51.13, 15.03, 51.17), cross_border=True),
    Corridor("frankfurt-oder", (14.50, 52.32, 14.62, 52.36), cross_border=True),
    Corridor("flensburg-padborg", (9.33, 54.76, 9.45, 54.86), cross_border=True),
)
