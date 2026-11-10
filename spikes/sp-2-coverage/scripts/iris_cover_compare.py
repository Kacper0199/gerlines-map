"""Compares a recomputed greedy IRIS cover with the cover the recorder polls.

Usage: python -I iris_cover_compare.py <iris-station-cover-gap60.txt> <stations.ts> [--first 50]

Reads the ``stations:`` line of ``iris_station_cover.py`` and the ``role: "cover"`` and ``role: "meta"``
entries of ``IRIS_LONG_DISTANCE_COVER``. Prints the stations kept, added and dropped among the first ``--first``,
the new cover stations whose meta EVAs still have to be looked up (Bahn-Vorhersage ``meta_evas``), and the
request rate of the new set at full changes every 3 minutes and one plan an hour per EVA.
"""

import argparse
import re
from pathlib import Path

ENTRY = re.compile(r'\{\s*eva:\s*(\d{7}),\s*label:\s*"([^"]*)",\s*role:\s*"(cover|meta)"\s*\}')
CEILING_PER_MINUTE = 41


def current_cover(stations_ts: str) -> tuple[list[int], dict[int, list[int]], dict[int, str]]:
    body = stations_ts.split("IRIS_LONG_DISTANCE_COVER", 1)[1].split("];", 1)[0]
    cover: list[int] = []
    metas: dict[int, list[int]] = {}
    labels: dict[int, str] = {}
    for eva, label, role in ENTRY.findall(body):
        labels[int(eva)] = label
        if role == "cover":
            cover.append(int(eva))
            metas[int(eva)] = []
        elif cover:
            metas[cover[-1]].append(int(eva))
    return cover, metas, labels


NO_STATIONS = "no stations: line in the cover output"


def recomputed(text: str) -> list[int]:
    for line in text.splitlines():
        if line.startswith("stations:"):
            return [int(value) for value in line.split(":", 1)[1].split(",") if value.strip()]
    raise SystemExit(NO_STATIONS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("cover", type=Path)
    parser.add_argument("stations", type=Path)
    parser.add_argument("--first", type=int, default=50)
    args = parser.parse_args()
    old, metas, labels = current_cover(args.stations.read_text(encoding="utf-8"))
    new = recomputed(args.cover.read_text(encoding="utf-8"))[: args.first]
    kept = [eva for eva in new if eva in old]
    added = [eva for eva in new if eva not in old]
    dropped = [eva for eva in old if eva not in new]
    meta_count = sum(len(metas.get(eva, [])) for eva in kept)
    evas = len(new) + meta_count
    rate = evas * (1 / 3 + 1 / 60)
    print(
        f"first {args.first} of the recomputed cover against the {len(old)} cover stations polled now"
    )
    print(f"kept {len(kept)}, added {len(added)}, dropped {len(dropped)}")
    print("added (look up their meta EVAs):", ",".join(str(eva) for eva in added) or "none")
    print(
        "dropped:",
        ",".join(f"{eva} {labels.get(eva, '')}".strip() for eva in dropped) or "none",
    )
    print(
        f"EVAs polled with the kept stations' meta EVAs: {evas} (meta of added stations not counted), "
        f"{rate:.2f} requests a minute of {CEILING_PER_MINUTE}"
    )


if __name__ == "__main__":
    main()
