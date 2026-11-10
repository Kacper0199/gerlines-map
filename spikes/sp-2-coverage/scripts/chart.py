"""Chart of live coverage by category: all runs (DELFI, gtfs.de) and runs at the IRIS stations (plus IRIS).

Usage: python -I chart.py <results-dir> <window label>
Writes ``coverage-by-category.png`` (300 dpi) into the results directory. Palette: dataviz reference slots 1 to 3,
validated all-pairs in light mode; values are labelled on every bar because slot 3 is below 3:1 contrast.
"""

import csv
import sys
from pathlib import Path

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt

SURFACE = "#fcfcfb"
TEXT = "#0b0b0b"
TEXT_2 = "#52514e"
GRID = "#e4e3df"
SERIES = {
    "DELFI GTFS-RT": "#2a78d6",
    "gtfs.de realtime": "#eb6834",
    "IRIS (DB Timetables)": "#1baf7a",
}
ORDER = ["hsr", "ld", "night", "rfast", "reg", "sbahn"]


def rows(path: Path) -> dict[str, dict[str, str]]:
    with path.open() as handle:
        return {row["category"]: row for row in csv.DictReader(handle)}


def panel(ax, data, columns, count_key, title):
    cats = [c for c in ORDER if c in data]
    height = 0.8 / len(columns)
    for i, (label, key) in enumerate(columns):
        values = [float(data[c][key]) for c in cats]
        ys = [j + (i - (len(columns) - 1) / 2) * height for j in range(len(cats))]
        ax.barh(ys, values, height=height - 0.03, color=SERIES[label], label=label, zorder=2)
        for y, v in zip(ys, values, strict=True):
            ax.text(v + 1, y, f"{v:.0f} %", va="center", ha="left", fontsize=7, color=TEXT_2)
    ax.set_yticks(range(len(cats)))
    ax.set_yticklabels(
        [f"{c}  (n={int(data[c][count_key]):,})" for c in cats], fontsize=8, color=TEXT
    )
    ax.invert_yaxis()
    ax.set_xlim(0, 112)
    ax.set_xticks([0, 25, 50, 75, 100])
    ax.set_xticklabels(["0 %", "25 %", "50 %", "75 %", "100 %"], fontsize=8, color=TEXT_2)
    ax.set_xlabel("share of train runs with live data in the window", fontsize=8, color=TEXT_2)
    ax.grid(axis="x", color=GRID, linewidth=0.8, zorder=0)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(length=0)
    ax.set_title(title, fontsize=9, color=TEXT, loc="left")
    ax.set_facecolor(SURFACE)


def main() -> None:
    results, window = Path(sys.argv[1]), sys.argv[2]
    by_cat = rows(results / "by_category.csv")
    iris = rows(results / "iris_scope.csv")
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.6), facecolor=SURFACE)
    panel(
        axes[0],
        by_cat,
        [("DELFI GTFS-RT", "live_mirror"), ("gtfs.de realtime", "live_gtfsde")],
        "runs",
        "All DELFI train runs in the window",
    )
    panel(
        axes[1],
        iris,
        [
            ("DELFI GTFS-RT", "live_mirror"),
            ("gtfs.de realtime", "live_gtfsde"),
            ("IRIS (DB Timetables)", "live_iris"),
        ],
        "runs_at_iris_stations",
        "Runs calling at the 20 sampled IRIS stations",
    )
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in SERIES.values()]
    fig.legend(
        handles,
        list(SERIES),
        loc="upper center",
        bbox_to_anchor=(0.5, 1.0),
        ncol=3,
        frameon=False,
        fontsize=8,
    )
    fig.suptitle(
        f"Live realtime coverage of German train runs by category, {window}",
        fontsize=11,
        color=TEXT,
        y=1.08,
    )
    fig.text(
        0.01,
        -0.07,
        "Sources: DELFI GTFS and GTFS-RT (DELFI e.V., Mobilithek and traines.eu mirror), gtfs.de (CC BY-SA 4.0), "
        "DB Timetables (CC BY 4.0, Deutsche Bahn). Categories by GerLines rules (D-025).\n"
        "IRIS sbahn is low because S-Bahn platforms are separate IRIS stations that were not sampled.",
        fontsize=6.5,
        color=TEXT_2,
    )
    fig.tight_layout()
    fig.savefig(
        results / "coverage-by-category.png", dpi=300, bbox_inches="tight", facecolor=SURFACE
    )


if __name__ == "__main__":
    main()
