"""Read the downloaded archives with pyogrio (GDAL), straight from the zip files."""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyogrio
import shapely
from shapely.geometry.base import BaseGeometry

VG250_GPKG = "vg250_ebenen_0101/DE_VG250.gpkg"
LAND_AREA_CLASSES = (3, 4)


@dataclass(frozen=True, slots=True)
class Land:
    ars: str
    name_de: str
    geometry: BaseGeometry


@dataclass(frozen=True, slots=True)
class Names:
    code: str
    name_en: str
    name_de: str
    name_pl: str


@dataclass(frozen=True, slots=True)
class NamedShape:
    names: Names
    geometry: BaseGeometry


@dataclass(frozen=True, slots=True)
class Railroad:
    source_id: str
    geometry: BaseGeometry


def _read(
    path: str, layer: str | None = None, where: str | None = None, bbox: tuple | None = None
) -> tuple[list[str], list[np.ndarray], np.ndarray]:
    meta, _, wkb, fields = pyogrio.raw.read(path, layer=layer, where=where, bbox=bbox)
    return list(meta["fields"]), list(fields), shapely.from_wkb(wkb)


def _column(names: list[str], fields: list[np.ndarray]) -> Callable[[str], np.ndarray]:
    return lambda name: fields[names.index(name)]


def read_vg250_laender(archive: Path) -> list[Land]:
    """The 16 Länder as land areas (VG250 GF 3 and 4) in EPSG:25832, one geometry each."""
    names, fields, geometries = _read(f"/vsizip/{archive}/{VG250_GPKG}", layer="vg250_lan")
    column = _column(names, fields)
    is_land = np.isin(column("GF"), LAND_AREA_CLASSES)
    ars = column("ARS")
    result = []
    for code in sorted(set(ars[is_land])):
        selected = is_land & (ars == code)
        name = str(column("GEN")[selected][0])
        result.append(Land(str(code), name, shapely.coverage_union_all(geometries[selected])))
    return result


def read_ne_state_names(archive: Path, country: str) -> dict[str, Names]:
    """Natural Earth admin 1 names keyed by the local name, for one ISO 3166-1 alpha 3 code."""
    path = f"/vsizip/{archive}/ne_10m_admin_1_states_provinces.shp"
    names, fields, _ = _read(path, where=f"adm0_a3 = '{country}'")
    column = _column(names, fields)
    return {
        str(local): Names(str(code), str(en), str(de), str(pl))
        for local, code, en, de, pl in zip(
            column("name"),
            column("iso_3166_2"),
            column("name_en"),
            column("name_de"),
            column("name_pl"),
            strict=True,
        )
    }


def read_ne_countries(archive: Path) -> list[NamedShape]:
    """Natural Earth admin 0 countries in EPSG:4326: ISO 3166-1 alpha 2, short English name."""
    names, fields, geometries = _read(f"/vsizip/{archive}/ne_10m_admin_0_countries.shp")
    column = _column(names, fields)
    return [
        NamedShape(Names(str(code), str(en), str(de), str(pl)), geometry)
        for code, en, de, pl, geometry in zip(
            column("ISO_A2_EH"),
            column("NAME"),
            column("NAME_DE"),
            column("NAME_PL"),
            geometries,
            strict=True,
        )
    ]


def read_ne_railroads(archive: Path, bbox: tuple[float, float, float, float]) -> list[Railroad]:
    """Natural Earth railroads inside ``bbox`` (EPSG:4326), train ferries left out."""
    path = f"/vsizip/{archive}/ne_10m_railroads.shp"
    names, fields, geometries = _read(path, bbox=bbox)
    column = _column(names, fields)
    return [
        Railroad(str(source_id), geometry)
        for source_id, kind, geometry in zip(
            column("rwdb_rr_id"), column("featurecla"), geometries, strict=True
        )
        if kind == "Railroad"
    ]
