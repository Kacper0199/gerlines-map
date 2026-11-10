import gzip
import json

from shapely import Point, box

from gerlines_geo_base.geojson import Provenance, encode, feature, feature_collection, sizes

PROVENANCE = Provenance(
    attribution="© GeoBasis-DE / BKG (2026)",
    licence="DL-DE-BY-2.0",
    note="Changed by GerLines",
    sources=("https://example.org/vg250.zip",),
)


def test_encodes_compact_utf8_with_provenance_members() -> None:
    collection = feature_collection(
        [feature(box(1, 2, 3, 4), {"name_de": "Thüringen"}, bbox=(1, 2, 3, 4))], PROVENANCE
    )

    data = encode(collection)

    assert b'", "' not in data
    assert b'": ' not in data
    assert b"], [" not in data
    assert data.endswith(b"\n")
    parsed = json.loads(data)
    assert parsed["type"] == "FeatureCollection"
    assert parsed["attribution"] == "© GeoBasis-DE / BKG (2026)"
    assert parsed["licence"] == "DL-DE-BY-2.0"
    assert parsed["note"] == "Changed by GerLines"
    assert parsed["sources"] == ["https://example.org/vg250.zip"]
    assert parsed["features"][0]["properties"] == {"name_de": "Thüringen"}
    assert parsed["features"][0]["bbox"] == [1, 2, 3, 4]
    assert "Thüringen".encode() in data


def test_writes_rounded_coordinates_without_float_noise() -> None:
    data = encode(feature_collection([feature(Point(13.4, 52.52), {})], PROVENANCE))

    assert b"[13.4,52.52]" in data


def test_sizes_reports_raw_and_deterministic_gzip_bytes() -> None:
    data = b'{"type":"FeatureCollection","features":[]}\n' * 50

    measured = sizes(data)

    assert measured["bytes"] == len(data)
    assert measured["gzip_bytes"] == len(gzip.compress(data, compresslevel=9, mtime=0))
    assert sizes(data) == measured
