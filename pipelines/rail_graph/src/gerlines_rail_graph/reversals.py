"""Stations where trains reverse without a passenger stop, for the lower bound of a leg.

A real route may turn back at a junction only where a train does: at its own stops, which are
the ends of every leg, and at the curated stations in ``reversal_stations.csv``, each with the
source that shows trains reversing there without letting passengers on or off. Every other
junction keeps the turn limit, so the lower bound stays close to the strict path and cannot
hide a shape that cuts a corner through a station throat.

The list is empty for the 2026-10-19 feed: of the 88 stop pairs whose lower bound a mid-leg
reversal shortens by more than 2 %, both methods' shapes agree on such a shorter route for six,
and none is a real reversal. Würzburg to Erfurt and Halle turn at Schweinfurt Hbf onto the
non-electrified line to Meiningen, which ICE trains cannot run on (they run via Bamberg).
"""

import csv
from dataclasses import dataclass
from pathlib import Path

import numpy as np

REVERSALS_FILE = Path(__file__).with_name("reversal_stations.csv")
GERMANY_BBOX = (5.5, 47.0, 15.5, 55.2)


@dataclass(frozen=True, slots=True)
class ReversalStation:
    name: str
    lon: float
    lat: float
    evidence: str
    source: str


def load_reversal_stations(path: Path = REVERSALS_FILE) -> list[ReversalStation]:
    with path.open(newline="", encoding="utf-8") as handle:
        rows = [r for r in csv.DictReader(handle) if not r["name"].startswith("#")]
    return [
        ReversalStation(r["name"], float(r["lon"]), float(r["lat"]), r["evidence"], r["source"])
        for r in rows
    ]


def reversal_points(path: Path = REVERSALS_FILE) -> np.ndarray:
    """The curated stations in EPSG:25832."""
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415

    stations = load_reversal_stations(path)
    if not stations:
        return np.zeros((0, 2))
    return to_xy(np.array([s.lon for s in stations]), np.array([s.lat for s in stations]))
