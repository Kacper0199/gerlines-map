"""Build the places file of search: the 16 Länder and every German municipality.

Sources (licences in docs/data-sources.md):
- BKG VG250 `vg250_pk` (one point per municipality at its seat, decimal degrees), DL-DE-BY-2.0;
- the Länder of `apps/web/public/geo/laender.geojson` (BKG VG250 with Natural Earth names);
- Natural Earth populated places for English and Polish names of larger towns (public domain).

Run from apps/api, with the Natural Earth archive from NATURAL_EARTH_URL (its sha256 is checked):
  uv run --project ../../pipelines/geo_base python scripts/build_places.py \
    --gpkg <DE_VG250.gpkg> --laender ../web/public/geo/laender.geojson \
    --natural-earth <ne_10m_populated_places.zip> --out ../../data/search/places-de.tsv
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sqlite3
from pathlib import Path

import shapely
from pyogrio.raw import read as read_layer

NATURAL_EARTH_URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places.zip"
NATURAL_EARTH_VERSION = "5.1.2"
NATURAL_EARTH_SHA256 = "cd149186f03d2603e0410da399b980a4357d0ac32d3a2305a49ed3dffcc41d7b"


class ArchiveMismatchError(SystemExit):
    def __init__(self, archive: Path, digest: str) -> None:
        super().__init__(
            f"{archive} has sha256 {digest}, expected {NATURAL_EARTH_SHA256} "
            f"(Natural Earth {NATURAL_EARTH_VERSION} from {NATURAL_EARTH_URL})"
        )


def natural_earth_layer(archive: Path) -> str:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != NATURAL_EARTH_SHA256:
        raise ArchiveMismatchError(archive, digest)
    return f"/vsizip/{archive}/ne_10m_populated_places.shp"


COLUMNS = [
    "id",
    "type",
    "name_en",
    "name_de",
    "name_pl",
    "region_en",
    "region_de",
    "region_pl",
    "land_code",
    "lon",
    "lat",
    "west",
    "south",
    "east",
    "north",
    "rank",
]
MATCH_KM = 15.0


def distance_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return 6371.0 * math.hypot(x, y)


def read_laender(path: Path) -> dict[str, dict[str, str | float]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {feature["properties"]["ars"]: feature["properties"] for feature in data["features"]}


def read_exonyms(path: str) -> list[dict[str, object]]:
    columns = ["ADM0_A3", "NAME", "NAME_DE", "NAME_EN", "NAME_PL"]
    meta, _ids, geometry, fields = read_layer(path, columns=columns)
    values = dict(zip(meta["fields"], fields, strict=True))
    rows = []
    for i, point in enumerate(shapely.from_wkb(geometry)):
        if values["ADM0_A3"][i] != "DEU":
            continue
        name = values["NAME"][i]
        rows.append(
            {
                "de": values["NAME_DE"][i] or name,
                "en": values["NAME_EN"][i] or name,
                "pl": values["NAME_PL"][i] or values["NAME_EN"][i] or name,
                "lon": point.x,
                "lat": point.y,
            }
        )
    return rows


def exonym_of(name: str, lon: float, lat: float, exonyms: list[dict[str, object]]) -> dict | None:
    for entry in exonyms:
        if entry["de"] != name:
            continue
        if distance_km(lon, lat, float(entry["lon"]), float(entry["lat"])) <= MATCH_KM:
            return entry
    return None


def rank_of(bez: str, bem: str) -> int:
    if bem == "kreisfrei":
        return 2
    return 1 if "Stadt" in bez else 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gpkg", type=Path, required=True)
    parser.add_argument("--laender", type=Path, required=True)
    parser.add_argument("--natural-earth", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    laender = read_laender(args.laender)
    exonyms = read_exonyms(natural_earth_layer(args.natural_earth))
    rows: list[list[str]] = [
        [
            f"land:{land['code']}",
            "land",
            str(land["name_en"]),
            str(land["name_de"]),
            str(land["name_pl"]),
            "",
            "",
            "",
            str(land["code"]),
            str(land["label_lon"]),
            str(land["label_lat"]),
            str(land["fit_west"]),
            str(land["fit_south"]),
            str(land["fit_east"]),
            str(land["fit_north"]),
            "3",
        ]
        for land in sorted(laender.values(), key=lambda land: str(land["code"]))
    ]
    named = 0
    with sqlite3.connect(f"file:{args.gpkg}?mode=ro", uri=True) as db:
        query = "SELECT AGS, GEN, BEZ, BEM, LON_DEZ, LAT_DEZ FROM vg250_pk ORDER BY AGS"
        for ags, gen, bez, bem, lon, lat in db.execute(query):
            land = laender[ags[:2]]
            if gen == land["name_de"] and ags[2:5] == "000":
                continue
            exonym = exonym_of(gen, lon, lat, exonyms)
            named += exonym is not None
            rows.append(
                [
                    f"town:{ags}",
                    "town",
                    str(exonym["en"]) if exonym else gen,
                    gen,
                    str(exonym["pl"]) if exonym else gen,
                    str(land["name_en"]),
                    str(land["name_de"]),
                    str(land["name_pl"]),
                    "",
                    f"{lon:.5f}",
                    f"{lat:.5f}",
                    "",
                    "",
                    "",
                    "",
                    str(rank_of(bez or "", bem or "")),
                ]
            )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(
            handle, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_NONE, quotechar=None
        )
        writer.writerow(COLUMNS)
        writer.writerows(rows)
    summary = f"{len(rows)} places ({len(laender)} Länder, {named} with Natural Earth names)"
    print(f"{summary} to {args.out}")


if __name__ == "__main__":
    main()
