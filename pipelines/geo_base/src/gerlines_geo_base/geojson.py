"""Compact GeoJSON (RFC 7946) with provenance members on each FeatureCollection."""

import gzip
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry

Json = dict[str, Any]


@dataclass(frozen=True, slots=True)
class Provenance:
    attribution: str
    licence: str
    note: str
    sources: Sequence[str]


def feature(
    geometry: BaseGeometry,
    properties: Mapping[str, object],
    bbox: tuple[float, float, float, float] | None = None,
) -> Json:
    result: Json = {"type": "Feature", "properties": dict(properties)}
    if bbox is not None:
        result["bbox"] = list(bbox)
    result["geometry"] = mapping(geometry)
    return result


def feature_collection(features: Sequence[Json], provenance: Provenance) -> Json:
    return {
        "type": "FeatureCollection",
        "attribution": provenance.attribution,
        "licence": provenance.licence,
        "note": provenance.note,
        "sources": list(provenance.sources),
        "features": list(features),
    }


def encode(collection: Json) -> bytes:
    text = json.dumps(collection, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return (text + "\n").encode("utf-8")


def sizes(data: bytes) -> dict[str, int]:
    return {"bytes": len(data), "gzip_bytes": len(gzip.compress(data, compresslevel=9, mtime=0))}
