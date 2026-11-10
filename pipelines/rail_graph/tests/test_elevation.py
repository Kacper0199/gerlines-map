import io
import json
import re

import numpy as np
import pytest
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

from gerlines_rail_graph.elevation import (
    TILE_PX,
    TileCache,
    archive_record,
    decode_tile,
    pixel_xy,
    pmtiles_archive,
    sample_sorted,
    terrarium,
    tiles_for,
    write_sidecar,
)


def encode(heights: np.ndarray) -> bytes:
    value = heights.astype(np.float64) + 32768.0
    r = np.floor(value / 256.0)
    g = np.floor(value - r * 256.0)
    b = np.round((value - r * 256.0 - g) * 256.0)
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    out = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(out, format="WEBP", lossless=True)
    return out.getvalue()


def test_pixel_coordinates_follow_web_mercator():
    x, y = pixel_xy(np.array([0.0, -180.0]), np.array([0.0, 0.0]), zoom=0)

    assert x.tolist() == [256.0, 0.0]
    assert y[0] == pytest.approx(256.0)


def test_terrarium_decodes_known_heights_and_round_trips_through_webp():
    heights = np.array([[0.0, 100.5], [-10.25, 2962.0]])
    rgb = np.zeros((2, 2, 3))
    value = heights + 32768.0
    rgb[..., 0] = np.floor(value / 256)
    rgb[..., 1] = np.floor(value - rgb[..., 0] * 256)
    rgb[..., 2] = (value - rgb[..., 0] * 256 - rgb[..., 1]) * 256

    assert terrarium(rgb).tolist() == heights.tolist()
    assert decode_tile(encode(heights)).tolist() == heights.tolist()


def test_the_cache_fetches_each_missing_tile_once_with_the_user_agent(tmp_path):
    seen = []
    tile = encode(np.full((TILE_PX, TILE_PX), 100.0))

    def opener(request):
        seen.append((request.full_url, request.get_header("User-agent")))
        return tile

    cache = TileCache(tmp_path, "GerLines/0.1.0 (+test)", pause_s=0.0, opener=opener)

    assert cache.ensure({(2200, 1343), (2201, 1343)}) == 2
    assert cache.ensure({(2200, 1343)}) == 0
    assert seen == [
        ("https://tiles.mapterhorn.com/12/2200/1343.webp", "GerLines/0.1.0 (+test)"),
        ("https://tiles.mapterhorn.com/12/2201/1343.webp", "GerLines/0.1.0 (+test)"),
    ]


def test_bilinear_sampling_reads_across_tile_borders(tmp_path):
    ramp = np.tile(np.arange(TILE_PX, dtype=np.float64), (TILE_PX, 1))
    tiles = {(10, 10): ramp, (11, 10): ramp + TILE_PX}

    def opener(request):
        found = re.search(r"/(\d+)/(\d+)\.webp$", request.full_url)
        return encode(tiles[(int(found.group(1)), int(found.group(2)))])

    cache = TileCache(tmp_path, "ua", zoom=5, pause_s=0.0, opener=opener)
    cache.ensure(tiles)
    scale = TILE_PX * 2**5
    lon = np.array([(10 * TILE_PX + 100.5) / scale * 360 - 180, (11 * TILE_PX) / scale * 360 - 180])
    lat_px = 10 * TILE_PX + 200.5
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * lat_px / scale))))
    lats = np.array([lat, lat])

    heights = sample_sorted(cache, np.column_stack([lon, lats]))

    assert heights[0] == pytest.approx(100.0, abs=1e-3)
    assert heights[1] == pytest.approx(511.5, abs=1e-3)
    assert {(10, 10), (11, 10)} <= tiles_for(lon, lats, 5)


def write_archive(path, tiles: dict[tuple[int, int, int], bytes]) -> None:
    with path.open("wb") as handle:
        writer = Writer(handle)
        for (z, x, y), data in sorted(tiles.items(), key=lambda t: zxy_to_tileid(*t[0])):
            writer.write_tile(zxy_to_tileid(z, x, y), data)
        writer.finalize(
            {
                "tile_type": TileType.WEBP,
                "tile_compression": Compression.NONE,
                "min_lon_e7": 55_000_000,
                "min_lat_e7": 470_000_000,
                "max_lon_e7": 155_000_000,
                "max_lat_e7": 552_000_000,
            },
            {"attribution": "test"},
        )


def test_tiles_come_from_the_archive_first_and_the_endpoint_only_for_the_rest(tmp_path):
    in_archive = encode(np.full((TILE_PX, TILE_PX), 250.0))
    archive = tmp_path / "extract.pmtiles"
    write_archive(archive, {(12, 2200, 1343): in_archive})
    seen = []

    def opener(request):
        seen.append(request.full_url)
        return encode(np.full((TILE_PX, TILE_PX), 7.0))

    with pmtiles_archive(archive) as lookup:
        cache = TileCache(tmp_path / "dem", "ua", pause_s=0.0, opener=opener, archive=lookup)
        fetched = cache.ensure({(2200, 1343), (2201, 1343)})

    assert lookup.closed
    assert fetched == 1
    assert cache.from_archive == 1
    assert seen == ["https://tiles.mapterhorn.com/12/2201/1343.webp"]
    assert cache.path(2200, 1343).read_bytes() == in_archive
    assert cache.tile(2200, 1343)[0, 0] == pytest.approx(250.0)


def test_the_archive_record_names_its_source_bounds_and_zooms(tmp_path):
    archive = tmp_path / "extract.pmtiles"
    write_archive(archive, {(12, 2200, 1343): encode(np.zeros((TILE_PX, TILE_PX)))})

    record = archive_record(archive, "ab" * 32)

    assert record["extracted_from"] == "https://download.mapterhorn.com/planet.pmtiles"
    assert record["bbox"] == pytest.approx([5.5, 47.0, 15.5, 55.2])
    assert record["zooms"] == [12, 12]


def test_the_sidecar_names_every_german_source_with_its_producer_and_licence(tmp_path):
    write_sidecar(tmp_path, 10, 2, "GerLines/0.1.0")

    sidecar = json.loads((tmp_path / "sidecar.json").read_text())

    names = [s["name"] for s in sidecar["sources_germany"]]
    assert len(names) == 17
    assert {"debayern", "debw", "debw025", "denrw", "dethueringen"} <= set(names)
    assert all(s["producer"] and s["licence"] for s in sidecar["sources_germany"])
    assert sidecar["sources_all"] == "https://download.mapterhorn.com/attribution.json"
