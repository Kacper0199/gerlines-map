"""Elevation from the Mapterhorn DEM: z12 Terrarium WebP tiles, cached, sampled bilinearly.

Mapterhorn (https://mapterhorn.com) serves 512 px Terrarium-encoded WebP tiles at
``https://tiles.mapterhorn.com/{z}/{x}/{y}.webp``. Its German data comes from the Länder survey
offices under CC BY 4.0, DL-DE BY 2.0 and DL-DE Zero 2.0 (https://mapterhorn.com/attribution),
attribution "© Mapterhorn" plus those sources. Only tiles under shape vertices are used and kept
under ``data/rail_graph/dem/<z>/<x>/<y>.webp``. They come first from a local PMTiles extract of
Mapterhorn's ``planet.pmtiles`` (the bulk access documented at https://mapterhorn.com/data-access)
and only when missing there from the tile endpoint, one at a time with a pause.
"""

import http.client
import io
import json
import math
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path

import numpy as np
from PIL import Image
from pmtiles.reader import MmapSource, Reader

ZOOM = 12
TILE_PX = 512
TILE_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
PLANET_URL = "https://download.mapterhorn.com/planet.pmtiles"
SOURCE_NOTE = (
    "Mapterhorn terrain tiles z12 (https://mapterhorn.com/attribution): German Länder DGM under "
    "CC BY 4.0, DL-DE BY 2.0 and DL-DE Zero 2.0; other countries per that page"
)
SOURCES_ALL = "https://download.mapterhorn.com/attribution.json"
GERMAN_SOURCES = (
    ("debayern", "Bayerische Vermessungsverwaltung", "CC-BY-4.0"),
    (
        "deberlin",
        "Senatsverwaltung für Stadtentwicklung, Bauen und Wohnen Berlin",
        "DL-DE-ZERO-2.0",
    ),
    ("debrandenburg", "GeoBasis-DE / LGB", "DL-DE-BY-2.0"),
    ("debremen", "Landesamt GeoInformation Bremen", "CC-BY-4.0"),
    ("debw", "LGL, www.lgl-bw.de, dl-de/by-2-0", "DL-DE-BY-2.0"),
    ("debw025", "LGL, www.lgl-bw.de, dl-de/by-2-0", "DL-DE-BY-2.0"),
    (
        "dehamburg",
        "Freie und Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung (LGV)",
        "DL-DE-BY-2.0",
    ),
    (
        "dehessen",
        "Hessisches Ministerium für Umwelt, Klimaschutz, Landwirtschaft und Verbraucherschutz",
        "DL-DE-ZERO-2.0",
    ),
    ("demv", "© GeoBasis-DE/M-V 2025", "CC-BY-4.0"),
    (
        "deniedersachsen",
        "Landesamt für Geoinformation und Landesvermessung Niedersachsen (LGLN)",
        "CC-BY-4.0",
    ),
    ("denrw", "Ministerium des Innern des Landes Nordrhein-Westfalen", "DL-DE-ZERO-2.0"),
    ("derlp", "©GeoBasis-DE / LVermGeoRP 2025", "DL-DE-BY-2.0"),
    ("desaarland", "GeoBasis DE/LVGL-SL 2025", "DL-DE-BY-2.0"),
    ("desachsen", "GeoSN, dl-de/by-2-0", "DL-DE-BY-2.0"),
    (
        "desachsenanhalt",
        "Landesamt für Vermessung und Geoinformation Sachsen-Anhalt (LVermGeo)",
        "DL-DE-BY-2.0",
    ),
    ("desh", "© GeoBasis-DE/LVermGeo SH/CC BY 4.0", "CC-BY-4.0"),
    ("dethueringen", "© GDI-Th", "DL-DE-BY-2.0"),
)


def pixel_xy(lon: np.ndarray, lat: np.ndarray, zoom: int = ZOOM) -> tuple[np.ndarray, np.ndarray]:
    """Global Web Mercator pixel coordinates (pixel centres at .5) at ``zoom``."""
    scale = TILE_PX * 2**zoom
    lat_rad = np.radians(np.asarray(lat, dtype=float))
    x = (np.asarray(lon, dtype=float) + 180.0) / 360.0 * scale
    y = (1.0 - np.log(np.tan(lat_rad) + 1.0 / np.cos(lat_rad)) / math.pi) / 2.0 * scale
    return x, y


def terrarium(rgb: np.ndarray) -> np.ndarray:
    """Metres from Terrarium RGB: R * 256 + G + B / 256 - 32768."""
    rgb = rgb.astype(np.float32)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def decode_tile(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as image:
        return terrarium(np.asarray(image.convert("RGB")))


def tiles_for(lon: np.ndarray, lat: np.ndarray, zoom: int = ZOOM) -> set[tuple[int, int]]:
    """Every tile any bilinear sample at these points reads (the four pixels around each)."""
    x, y = pixel_xy(lon, lat, zoom)
    tiles: set[tuple[int, int]] = set()
    for dx in (-0.5, 0.5):
        for dy in (-0.5, 0.5):
            tx = np.floor((x + dx) / TILE_PX).astype(np.int64)
            ty = np.floor((y + dy) / TILE_PX).astype(np.int64)
            tiles.update(zip(tx.tolist(), ty.tolist(), strict=True))
    return tiles


class TileCache:
    """Tiles on disk, fetched once; decoded tiles kept in a small LRU in memory."""

    def __init__(  # noqa: PLR0913
        self,
        root: Path,
        user_agent: str,
        *,
        zoom: int = ZOOM,
        pause_s: float = 0.2,
        keep: int = 64,
        opener: Callable[[urllib.request.Request], bytes] | None = None,
        archive: Callable[[int, int, int], bytes | None] | None = None,
    ) -> None:
        self.root = root
        self.zoom = zoom
        self.user_agent = user_agent
        self.pause_s = pause_s
        self.keep = keep
        self.fetched = 0
        self.from_archive = 0
        self._archive = archive
        self._last = 0.0
        self._decoded: OrderedDict[tuple[int, int], np.ndarray] = OrderedDict()
        self._open = opener or _download

    def path(self, x: int, y: int) -> Path:
        return self.root / str(self.zoom) / str(x) / f"{y}.webp"

    def _store(self, x: int, y: int, data: bytes) -> None:
        target = self.path(x, y)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".partial")
        partial.write_bytes(data)
        partial.replace(target)

    def ensure(self, tiles: Iterable[tuple[int, int]], log=print) -> int:
        """Takes the missing tiles from the archive, fetches the rest one by one; returns how
        many were fetched."""
        missing = sorted(t for t in tiles if not self.path(*t).exists())
        if self._archive is not None:
            remaining = []
            for x, y in missing:
                data = self._archive(self.zoom, x, y)
                if data is None:
                    remaining.append((x, y))
                else:
                    self._store(x, y, data)
                    self.from_archive += 1
            missing = remaining
        for k, (x, y) in enumerate(missing, start=1):
            wait = self.pause_s - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            url = TILE_URL.format(z=self.zoom, x=x, y=y)
            request = urllib.request.Request(  # noqa: S310
                url, headers={"User-Agent": self.user_agent}
            )
            data = self._open(request)
            self._last = time.monotonic()
            self._store(x, y, data)
            self.fetched += 1
            if k % 250 == 0:
                log(json.dumps({"dem_tiles_fetched": k, "of": len(missing)}))
        return len(missing)

    def tile(self, x: int, y: int) -> np.ndarray:
        key = (x, y)
        if key in self._decoded:
            self._decoded.move_to_end(key)
            return self._decoded[key]
        heights = decode_tile(self.path(x, y).read_bytes())
        self._decoded[key] = heights
        if len(self._decoded) > self.keep:
            self._decoded.popitem(last=False)
        return heights

    def pixel(self, px: np.ndarray, py: np.ndarray) -> np.ndarray:
        """Heights at integer global pixels, reading each tile once."""
        tx, ty = px // TILE_PX, py // TILE_PX
        out = np.empty(len(px), dtype=np.float64)
        keys = tx * (1 << 32) + ty
        for key in np.unique(keys):
            sel = keys == key
            heights = self.tile(int(tx[sel][0]), int(ty[sel][0]))
            out[sel] = heights[py[sel] % TILE_PX, px[sel] % TILE_PX]
        return out

    def sample(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        """Bilinear height at each point from the four surrounding pixel centres."""
        x, y = pixel_xy(lon, lat, self.zoom)
        x0 = np.floor(x - 0.5).astype(np.int64)
        y0 = np.floor(y - 0.5).astype(np.int64)
        fx = (x - 0.5) - x0
        fy = (y - 0.5) - y0
        h00 = self.pixel(x0, y0)
        h10 = self.pixel(x0 + 1, y0)
        h01 = self.pixel(x0, y0 + 1)
        h11 = self.pixel(x0 + 1, y0 + 1)
        top = h00 * (1 - fx) + h10 * fx
        bottom = h01 * (1 - fx) + h11 * fx
        return top * (1 - fy) + bottom * fy


RETRIES = 5


def _download(request: urllib.request.Request) -> bytes:
    """The tile body, retried with backoff when a response arrives cut short."""
    if not request.full_url.startswith("https://tiles.mapterhorn.com/"):
        msg = f"refusing a DEM URL outside Mapterhorn: {request.full_url}"
        raise ValueError(msg)
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
                expected = response.headers.get("Content-Length")
                body = response.read()
            if expected is None or len(body) == int(expected):
                return body
        except (http.client.IncompleteRead, urllib.error.URLError, TimeoutError):
            if attempt == RETRIES - 1:
                raise
        time.sleep(2**attempt)
    msg = f"no complete response for {request.full_url} after {RETRIES} attempts"
    raise OSError(msg)


def sample_sorted(cache: TileCache, lonlat: np.ndarray) -> np.ndarray:
    """Heights for many points, visiting them tile by tile so each tile is decoded once."""
    x, y = pixel_xy(lonlat[:, 0], lonlat[:, 1], cache.zoom)
    order = np.lexsort((np.floor(y / TILE_PX), np.floor(x / TILE_PX)))
    out = np.empty(len(lonlat))
    step = 200_000
    for start in range(0, len(order), step):
        chunk = order[start : start + step]
        out[chunk] = cache.sample(lonlat[chunk, 0], lonlat[chunk, 1])
    return out


class ArchiveLookup:
    """Tile lookup in an open PMTiles archive; None for a tile it lacks."""

    def __init__(self, handle) -> None:
        self._handle = handle
        self._reader = Reader(MmapSource(handle))

    def __call__(self, z: int, x: int, y: int) -> bytes | None:
        return self._reader.get(z, x, y)

    @property
    def closed(self) -> bool:
        return self._handle.closed


@contextmanager
def pmtiles_archive(path: Path) -> Iterator[ArchiveLookup]:
    """A local PMTiles archive, memory-mapped while the block runs and closed after it."""
    with path.open("rb") as handle:
        yield ArchiveLookup(handle)


def archive_record(path: Path, sha256: str) -> dict:
    """Provenance of a PMTiles extract: its file, hash, bounds and zooms."""
    with path.open("rb") as handle:
        header = Reader(MmapSource(handle)).header()
    return {
        "file": path.name,
        "extracted_from": PLANET_URL,
        "sha256": sha256,
        "bbox": [header[k] / 1e7 for k in ("min_lon_e7", "min_lat_e7", "max_lon_e7", "max_lat_e7")],
        "zooms": [header["min_zoom"], header["max_zoom"]],
    }


def write_sidecar(  # noqa: PLR0913
    root: Path,
    tiles: int,
    fetched: int,
    user_agent_name: str,
    *,
    from_archive: int = 0,
    archive: Mapping | None = None,
) -> None:
    sidecar = root / "sidecar.json"
    previous = json.loads(sidecar.read_text()) if sidecar.exists() else {}
    record = {
        "source": "Mapterhorn",
        "archive": archive or previous.get("archive"),
        "url_template": TILE_URL,
        "zoom": ZOOM,
        "encoding": "terrarium",
        "tile_px": TILE_PX,
        "attribution": "© Mapterhorn (https://mapterhorn.com/attribution)",
        "licences": SOURCE_NOTE,
        "sources_germany": [
            {"name": name, "producer": producer, "licence": licence}
            for name, producer, licence in GERMAN_SOURCES
        ],
        "sources_all": SOURCES_ALL,
        "tiles_on_disk": tiles,
        "fetches": [
            *previous.get("fetches", []),
            {
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "fetched": fetched,
                "from_archive": from_archive,
                "client": user_agent_name,
            },
        ],
    }
    sidecar.write_text(json.dumps(record, indent=1))
