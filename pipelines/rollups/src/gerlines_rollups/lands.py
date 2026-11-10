"""Land areas from BKG VG250 into ``land_area``, then every stop place assigned a Land."""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import psycopg
import pyogrio
import shapely

from gerlines_geo_base.readers import VG250_GPKG

VG250_ARCHIVE = Path("geo") / "bkg-vg250" / "vg250_01-01.utm32s.gpkg.ebenen.zip"
ATTRIBUTION_SUFFIX = ", DL-DE BY 2.0, changed"


@dataclass(frozen=True, slots=True)
class AreaSource:
    url: str
    sha256: str
    edition: str
    licence: str
    attribution: str


@dataclass(frozen=True, slots=True)
class Area:
    ars: str
    wkb: bytes


def read_sidecar(archive: Path) -> AreaSource:
    """The provenance JSON written next to the archive by ``geo-base download``."""
    meta = json.loads(archive.with_name(archive.name + ".json").read_text())
    return AreaSource(
        url=meta["url"],
        sha256=meta["sha256"],
        edition=meta["edition"],
        licence=meta["licence"],
        attribution=meta["attribution"] + ATTRIBUTION_SUFFIX,
    )


def read_areas(archive: Path) -> list[Area]:
    """The 16 Länder in EPSG:25832, full resolution, land and water (VG250 GF 1 to 4).

    Water counts because stations on moles, piers and harbour edges (Norddeich Mole, Dagebüll Mole,
    Lindau Insel) can lie beyond VG250's generalised coastline; the sea and lake parts of a Land
    carry its ARS in VG250.
    """
    meta, _, wkb, fields = pyogrio.raw.read(f"/vsizip/{archive}/{VG250_GPKG}", layer="vg250_lan")
    names = list(meta["fields"])
    ars = fields[names.index("ARS")]
    geometries = shapely.from_wkb(wkb)
    return [
        Area(str(code), shapely.to_wkb(shapely.union_all(geometries[ars == code])))
        for code in sorted(set(np.asarray(ars).tolist()))
    ]


@dataclass(frozen=True, slots=True)
class LoadReport:
    areas: int
    changed_places: int
    by_method: dict[str, int]
    by_land: dict[str, int]

    def as_dict(self) -> dict:
        return {
            "areas": self.areas,
            "changed_places": self.changed_places,
            "by_method": self.by_method,
            "by_land": self.by_land,
        }


def load_areas(conn: psycopg.Connection, areas: Iterable[Area], source: AreaSource) -> LoadReport:
    """Replace ``land_area`` and reassign every stop place, in one transaction."""
    areas = list(areas)
    with conn.transaction(), conn.cursor() as cur:
        codes = dict(
            cur.execute("SELECT ars, land_code FROM land WHERE ars IS NOT NULL").fetchall()
        )
        unknown = sorted({area.ars for area in areas} - codes.keys())
        if unknown or len(areas) != len(codes):
            msg = f"expected one area for each of the {len(codes)} Länder, unknown ARS {unknown}"
            raise ValueError(msg)
        cur.execute("DELETE FROM land_area")
        cur.executemany(
            """INSERT INTO land_area (land_code, geom, edition, source_url, source_sha256, licence,
                                      attribution)
               VALUES (%s,
                       ST_Multi(ST_CollectionExtract(ST_MakeValid(
                         ST_GeomFromWKB(%s, 25832)), 3)),
                       %s, %s, %s, %s, %s)""",
            [
                (
                    codes[area.ars],
                    area.wkb,
                    source.edition,
                    source.url,
                    source.sha256,
                    source.licence,
                    source.attribution,
                )
                for area in areas
            ],
        )
        (changed,) = cur.execute("SELECT assign_stop_place_lands()").fetchone()
        by_method = dict(
            cur.execute(
                "SELECT method, count(*) FROM stop_place_land GROUP BY 1 ORDER BY 1"
            ).fetchall()
        )
        by_land = dict(
            cur.execute(
                "SELECT coalesce(land_code, 'none'), count(*) FROM stop_place_land"
                " GROUP BY 1 ORDER BY 1"
            ).fetchall()
        )
    return LoadReport(len(areas), changed, by_method, by_land)
