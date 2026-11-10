"""Build every output from the verified downloads and write a reproducible build report."""

import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import shapely
from pyproj import Transformer
from shapely import Point
from shapely.geometry.base import BaseGeometry

from gerlines_geo_base.context import (
    Country,
    Neighbour,
    RailLine,
    border_crossings,
    nearby_countries,
)
from gerlines_geo_base.download import read_sidecar, source_path
from gerlines_geo_base.geojson import Json, Provenance, encode, feature, feature_collection, sizes
from gerlines_geo_base.geometry import (
    core_parts,
    is_rfc7946_oriented,
    label_point,
    outward_bbox,
    round_coordinates,
    simplify_coverage,
    world_minus,
)
from gerlines_geo_base.readers import (
    Land,
    Names,
    read_ne_countries,
    read_ne_railroads,
    read_ne_state_names,
    read_vg250_laender,
)
from gerlines_geo_base.sources import (
    ALL_SOURCES,
    BKG_ATTRIBUTION,
    BKG_CHANGE_NOTE,
    NATURAL_EARTH_ATTRIBUTION,
    NE_COUNTRIES,
    NE_RAILROADS,
    NE_STATES,
    VG250,
)

PROJECTED_CRS = 25832
GEOGRAPHIC_CRS = 4326
LABEL_PRECISION = 100.0
POINT_DECIMALS = 4
NEIGHBOUR_MAX_DISTANCE = 100_000.0
NEIGHBOUR_LABEL_BAND = 120_000.0
CROSSING_MAX_GAP = 10_000.0
CROSSING_MERGE = 3_000.0
FIT_MAX_GAP = 40_000.0
FIT_MIN_SHARE = 0.1
RAILROAD_WINDOW = (4.5, 46.5, 16.5, 56.0)

ARS_TO_ISO = {
    "01": "DE-SH",
    "02": "DE-HH",
    "03": "DE-NI",
    "04": "DE-HB",
    "05": "DE-NW",
    "06": "DE-HE",
    "07": "DE-RP",
    "08": "DE-BW",
    "09": "DE-BY",
    "10": "DE-SL",
    "11": "DE-BE",
    "12": "DE-BB",
    "13": "DE-MV",
    "14": "DE-SN",
    "15": "DE-ST",
    "16": "DE-TH",
}


@dataclass(frozen=True, slots=True)
class Level:
    name: str
    tolerance: float
    decimals: int
    min_part_area: float
    keep: tuple[str, ...]
    use: str


KEPT_ISLANDS = {
    "Helgoland": (7.8857, 54.1818),
    "Helgoland Düne": (7.9131, 54.1867),
    "Neuwerk": (8.4965, 53.9165),
}

NATIONAL = Level(
    "national",
    300.0,
    3,
    5_000_000.0,
    tuple(KEPT_ISLANDS),
    "germany-outline, germany-mask, laender",
)
FOCUS = Level("focus", 100.0, 4, 500_000.0, (), "laender-masks")


class BuildError(RuntimeError):
    """An output failed one of the checks the build runs before writing."""


_TO_WGS84 = Transformer.from_crs(PROJECTED_CRS, GEOGRAPHIC_CRS, always_xy=True)
_TO_PROJECTED = Transformer.from_crs(GEOGRAPHIC_CRS, PROJECTED_CRS, always_xy=True)


def _transform(geometry: BaseGeometry, transformer: Transformer) -> BaseGeometry:
    def apply(xy: np.ndarray) -> np.ndarray:
        x, y = transformer.transform(xy[:, 0], xy[:, 1])
        return np.column_stack([x, y])

    return shapely.transform(geometry, apply)


def to_wgs84(geometry: BaseGeometry) -> BaseGeometry:
    return _transform(geometry, _TO_WGS84)


def to_projected(geometry: BaseGeometry) -> BaseGeometry:
    return _transform(geometry, _TO_PROJECTED)


def _point(point: Point) -> Point:
    return round_coordinates(to_wgs84(point), POINT_DECIMALS)


def _oriented(geometry: BaseGeometry) -> BaseGeometry:
    return shapely.orient_polygons(geometry, exterior_cw=False)


def _kept_points(laender: Sequence[Land], level: Level) -> list[Point]:
    points = []
    for name in level.keep:
        point = to_projected(Point(KEPT_ISLANDS[name]))
        if not any(land.geometry.contains(point) for land in laender):
            msg = f"{level.name}: the kept island point {name} lies in no Land"
            raise BuildError(msg)
        points.append(point)
    return points


def _level_geometries(laender: Sequence[Land], level: Level) -> tuple[list, list]:
    projected = simplify_coverage(
        [land.geometry for land in laender],
        level.tolerance,
        level.min_part_area,
        _kept_points(laender, level),
    )
    geographic = [_oriented(round_coordinates(to_wgs84(g), level.decimals)) for g in projected]
    if not all(shapely.is_valid(geographic)):
        msg = f"{level.name}: a Land polygon is invalid after rounding"
        raise BuildError(msg)
    if not shapely.coverage_is_valid(np.array(geographic, dtype=object)):
        msg = f"{level.name}: the Länder no longer form a coverage after rounding"
        raise BuildError(msg)
    return projected, geographic


def _land_names(laender: Sequence[Land], ne_names: dict[str, Names]) -> list[Names]:
    result = []
    for land in laender:
        code = ARS_TO_ISO[land.ars]
        names = ne_names.get(land.name_de)
        if names is None or names.code != code:
            msg = f"Natural Earth has no admin 1 entry {code} named {land.name_de}"
            raise BuildError(msg)
        result.append(Names(code, names.name_en, land.name_de, names.name_pl))
    return result


def _labels(
    projected_focus: Sequence[BaseGeometry], checks: Sequence[Sequence[BaseGeometry]]
) -> list[Point]:
    labels = []
    for index, geometry in enumerate(projected_focus):
        point = _point(label_point(geometry, LABEL_PRECISION))
        if not all(shapely.contains(level[index], point) for level in checks):
            msg = f"label point {point} of Land {index} falls outside its polygon"
            raise BuildError(msg)
        labels.append(point)
    return labels


def _fit_bounds(projected: BaseGeometry, geographic: BaseGeometry) -> dict[str, float]:
    core = to_wgs84(core_parts(projected, FIT_MAX_GAP, FIT_MIN_SHARE))
    west, south, east, north = outward_bbox(core, POINT_DECIMALS)
    full_west, full_south, full_east, full_north = outward_bbox(geographic, POINT_DECIMALS)
    return {
        "fit_west": max(west, full_west),
        "fit_south": max(south, full_south),
        "fit_east": min(east, full_east),
        "fit_north": min(north, full_north),
    }


def _provenance_bkg(*extra_sources: str) -> Provenance:
    return Provenance(
        attribution=BKG_ATTRIBUTION,
        licence="DL-DE-BY-2.0 (https://www.govdata.de/dl-de/by-2-0)",
        note=BKG_CHANGE_NOTE,
        sources=(VG250.url, *extra_sources),
    )


def _provenance_ne(*urls: str) -> Provenance:
    return Provenance(
        attribution=NATURAL_EARTH_ATTRIBUTION,
        licence="Public domain (https://www.naturalearthdata.com/about/terms-of-use/)",
        note="Selected and reprojected by GerLines, coordinates rounded",
        sources=urls,
    )


def _neighbour_feature(neighbour: Neighbour) -> Json:
    country = neighbour.country
    return feature(
        _point(neighbour.label),
        {
            "code": country.code,
            "name_en": country.name_en,
            "name_de": country.name_de,
            "name_pl": country.name_pl,
            "shares_border": neighbour.shares_border,
            "distance_km": round(neighbour.distance / 1000),
        },
    )


def _countries(data_dir: Path) -> tuple[Names, list[Country]]:
    shapes = read_ne_countries(source_path(NE_COUNTRIES, data_dir))
    germany = next(s.names for s in shapes if s.names.code == "DE")
    window = shapely.box(-10.0, 40.0, 30.0, 62.0)
    countries = [
        Country(
            s.names.code,
            s.names.name_en,
            s.names.name_de,
            s.names.name_pl,
            to_projected(shapely.intersection(s.geometry, window)),
        )
        for s in shapes
        if s.names.code != "DE" and s.geometry.intersects(window)
    ]
    return germany, countries


def build_all(data_dir: Path, out_dir: Path, report_path: Path) -> dict[str, Any]:
    sidecars = {source.key: asdict(read_sidecar(source, data_dir)) for source in ALL_SOURCES}
    laender = read_vg250_laender(source_path(VG250, data_dir))
    names = _land_names(laender, read_ne_state_names(source_path(NE_STATES, data_dir), "DEU"))
    national_projected, national = _level_geometries(laender, NATIONAL)
    focus_projected, focus = _level_geometries(laender, FOCUS)
    labels = _labels(focus_projected, [national, focus])

    outline = _oriented(shapely.coverage_union_all(np.array(national, dtype=object)))
    germany_names, countries = _countries(data_dir)
    germany_projected = shapely.coverage_union_all(np.array(national_projected, dtype=object))
    neighbours = nearby_countries(
        germany_projected, countries, NEIGHBOUR_MAX_DISTANCE, NEIGHBOUR_LABEL_BAND
    )
    railroads = read_ne_railroads(source_path(NE_RAILROADS, data_dir), RAILROAD_WINDOW)
    crossings = border_crossings(
        germany_projected,
        [RailLine(r.source_id, to_projected(r.geometry)) for r in railroads],
        [n.country for n in neighbours],
        CROSSING_MAX_GAP,
        CROSSING_MERGE,
    )

    names_source = NE_STATES.url
    outputs: dict[str, bytes] = {
        "germany-outline.geojson": encode(
            feature_collection(
                [
                    feature(
                        outline,
                        {
                            "code": "DE",
                            "name_en": germany_names.name_en,
                            "name_de": germany_names.name_de,
                            "name_pl": germany_names.name_pl,
                        },
                        outward_bbox(outline, NATIONAL.decimals),
                    )
                ],
                _provenance_bkg(NE_COUNTRIES.url),
            )
        ),
        "germany-mask.geojson": encode(
            feature_collection(
                [feature(world_minus(outline), {"role": "outside-germany"})], _provenance_bkg()
            )
        ),
        "laender.geojson": encode(
            feature_collection(
                [
                    feature(
                        geometry,
                        {
                            "code": land_names.code,
                            "ars": land.ars,
                            "name_en": land_names.name_en,
                            "name_de": land_names.name_de,
                            "name_pl": land_names.name_pl,
                            "label_lon": label.x,
                            "label_lat": label.y,
                            **_fit_bounds(projected, focus_geometry),
                        },
                        outward_bbox(focus_geometry, POINT_DECIMALS),
                    )
                    for land, land_names, geometry, focus_geometry, projected, label in zip(
                        laender, names, national, focus, focus_projected, labels, strict=True
                    )
                ],
                _provenance_bkg(names_source),
            )
        ),
        "neighbours.geojson": encode(
            feature_collection(
                [_neighbour_feature(n) for n in neighbours], _provenance_ne(NE_COUNTRIES.url)
            )
        ),
        "border-crossings.geojson": encode(
            feature_collection(
                [
                    feature(
                        _point(c.point),
                        {
                            "country": c.country,
                            "line": None,
                            "source": "Natural Earth railroads",
                            "source_id": c.source_id,
                        },
                    )
                    for c in crossings
                ],
                _provenance_ne(NE_RAILROADS.url, NE_COUNTRIES.url),
            )
        ),
    }
    for land_names, geometry, projected in zip(names, focus, focus_projected, strict=True):
        mask = world_minus(geometry)
        if not mask.is_valid or not is_rfc7946_oriented(mask):
            msg = f"the focus mask of {land_names.code} is invalid"
            raise BuildError(msg)
        outputs[f"laender-masks/{land_names.code}.geojson"] = encode(
            feature_collection(
                [
                    feature(
                        mask,
                        {
                            "role": "outside-land",
                            "code": land_names.code,
                            "name_en": land_names.name_en,
                            "name_de": land_names.name_de,
                            "name_pl": land_names.name_pl,
                            **_fit_bounds(projected, geometry),
                        },
                        outward_bbox(geometry, POINT_DECIMALS),
                    )
                ],
                _provenance_bkg(names_source),
            )
        )

    for name, data in outputs.items():
        target = out_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    report = {
        "sources": sidecars,
        "levels": [asdict(level) | {"keep": ", ".join(level.keep)} for level in (NATIONAL, FOCUS)],
        "parameters": {
            "projected_crs": f"EPSG:{PROJECTED_CRS}",
            "land_area_classes": "VG250 GF 3 and 4 (land without and with structure)",
            "label_precision_m": LABEL_PRECISION,
            "point_decimals": POINT_DECIMALS,
            "neighbour_max_distance_m": NEIGHBOUR_MAX_DISTANCE,
            "neighbour_label_band_m": NEIGHBOUR_LABEL_BAND,
            "crossing_max_gap_m": CROSSING_MAX_GAP,
            "crossing_merge_m": CROSSING_MERGE,
            "fit_max_gap_m": FIT_MAX_GAP,
            "fit_min_share": FIT_MIN_SHARE,
        },
        "counts": {
            "laender": len(laender),
            "national_vertices": int(shapely.get_num_coordinates(national).sum()),
            "focus_vertices": int(shapely.get_num_coordinates(focus).sum()),
            "outline_parts": int(shapely.get_num_geometries(outline)),
            "neighbours": len(neighbours),
            "border_crossings": len(crossings),
        },
        "outputs": {name: sizes(data) for name, data in sorted(outputs.items())},
    }
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", "utf-8")
    return report
