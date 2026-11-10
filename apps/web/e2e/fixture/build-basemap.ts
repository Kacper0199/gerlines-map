import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import { fromVectorTileJs } from "@maplibre/vt-pbf";
import { PbfReader } from "pbf";

const USAGE = `Usage: node e2e/fixture/build-basemap.ts --out <dir> [--tilejson <url>] [--dry-run]

Downloads the OpenFreeMap vector tiles the committed basemap holds, cuts them to the source layers and name
languages the GerLines style reads, and writes them gzipped to <out>/tiles/<z>/<x>/<y>.pbf together with a trimmed
tile description (<out>/tiles.json) and the glyph ranges of the one font the style uses (<out>/fonts/).
Requests carry the project User-Agent from APP_NAME and APP_CONTACT in the environment and run one at a time.
`;

const KEPT_LAYERS = new Set([
  "water",
  "waterway",
  "landuse",
  "landcover",
  "boundary",
  "building",
  "transportation",
  "transportation_name",
  "place",
  "water_name",
]);
const KEPT_NAMES = new Set([
  "name",
  "name_en",
  "name_de",
  "name:latin",
  "name:nonlatin",
  "name:en",
  "name:de",
  "name:pl",
]);

/** Frankfurt am Main, the centre of the live fixture. */
const CITY: [number, number] = [8.66, 50.11];
const GERMANY: [number, number, number, number] = [5.5, 47, 15.5, 55.2];
const NATIONAL_ZOOMS = [4, 5, 6];
const CITY_ZOOMS: ReadonlyArray<[number, number, number]> = [
  [10, 0.15, 0.1],
  [11, 0.12, 0.08],
  [12, 0.1, 0.06],
];
const NATIONAL_LAYERS = new Set(["water", "landcover", "boundary", "place", "water_name"]);

const GLYPH_RANGES = ["0-255", "256-511"];
const FONT = "Noto Sans Regular";

function tileOf(lon: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

export function planTiles(): Array<[number, number, number]> {
  const tiles: Array<[number, number, number]> = [];
  const cover = (zoom: number, west: number, south: number, east: number, north: number) => {
    const [x0, y1] = tileOf(west, south, zoom);
    const [x1, y0] = tileOf(east, north, zoom);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([zoom, x, y]);
  };
  for (const zoom of NATIONAL_ZOOMS) cover(zoom, ...GERMANY);
  for (const [zoom, lon, lat] of CITY_ZOOMS)
    cover(zoom, CITY[0] - lon, CITY[1] - lat, CITY[0] + lon, CITY[1] + lat);
  return tiles;
}

function cut(source: Uint8Array, zoom: number): Uint8Array {
  const tile = new VectorTile(new PbfReader(source));
  const layers: Record<string, unknown> = {};
  for (const [name, layer] of Object.entries(tile.layers)) {
    if (!(zoom <= 6 ? NATIONAL_LAYERS : KEPT_LAYERS).has(name)) continue;
    layers[name] = {
      version: layer.version,
      name,
      extent: layer.extent,
      length: layer.length,
      feature: (index: number) => {
        const feature = layer.feature(index);
        const properties = Object.fromEntries(
          Object.entries(feature.properties).filter(
            ([key]) => !key.startsWith("name") || KEPT_NAMES.has(key),
          ),
        );
        return {
          id: feature.id,
          type: feature.type,
          properties,
          extent: feature.extent,
          loadGeometry: () => feature.loadGeometry(),
        };
      },
    };
  }
  return fromVectorTileJs({ layers } as never);
}

async function download(url: string, userAgent: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, "Accept-Encoding": "gzip" },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    tilejson: { type: "string", default: "https://tiles.openfreemap.org/planet" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.out) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 2);
}
if (values["dry-run"]) {
  process.stdout.write(`${planTiles().length} tiles\n`);
  process.exit(0);
}

const contact = process.env.APP_CONTACT;
const app = process.env.APP_NAME;
if (!(app && contact)) throw new Error("APP_NAME and APP_CONTACT must be set");
const userAgent = `${app}/0.0.0 (+${contact})`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));

const description = await (
  await fetch(values.tilejson, { headers: { "User-Agent": userAgent } })
).json();
const template = description.tiles[0] as string;
rmSync(values.out, { recursive: true, force: true });
mkdirSync(values.out, { recursive: true });
writeFileSync(
  join(values.out, "tiles.json"),
  `${JSON.stringify({ tilejson: "3.0.0", name: description.name, description: description.description, version: description.version, attribution: description.attribution, bounds: [-180, -85.0511, 180, 85.0511], minzoom: 0, maxzoom: 12, source: template }, null, 1)}\n`,
);

let total = 0;
for (const [z, x, y] of planTiles()) {
  const url = template
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
  const bytes = gzipSync(cut(await download(url, userAgent), z), { level: 9 });
  const file = join(values.out, "tiles", String(z), String(x), `${y}.pbf`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  total += bytes.length;
  process.stdout.write(`${z}/${x}/${y} ${bytes.length}\n`);
  await pause();
}
for (const range of GLYPH_RANGES) {
  const url = `https://tiles.openfreemap.org/fonts/${encodeURIComponent(FONT)}/${range}.pbf`;
  const response = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const file = join(values.out, "fonts", FONT, `${range}.pbf`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
  await pause();
}
process.stdout.write(`total tile bytes ${total}\n`);
