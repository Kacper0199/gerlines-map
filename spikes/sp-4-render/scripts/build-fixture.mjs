import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  decodePolyline,
  encodePolyline,
  polylineLengthMetres,
  simplifyPolyline,
} from "../src/polyline.ts";

const sourcePath = process.argv[2];
if (!sourcePath) {
  process.stderr.write(
    "usage: node scripts/build-fixture.mjs <absolute path to map-trips-de.json.gz>\n",
  );
  process.exit(1);
}

const SIMPLIFY_TOLERANCE_METRES = 2;
const MIN_AVERAGE_SPEED = 2;
const MAX_AVERAGE_SPEED = 90;
const GERMANY_BOX = { minLat: 47.2, maxLat: 55.1, minLon: 5.8, maxLon: 15.1 };
const LICENSED_FEEDS = new Set(["de-DELFI", "de-VBB", "de-KVV", "de-VBN"]);
const CATEGORY_BY_MODE = {
  HIGHSPEED_RAIL: "hsr",
  LONG_DISTANCE: "ld",
  NIGHT_RAIL: "ld",
  METRO: "sbahn",
};

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, "../fixtures/rail-segments.json.gz");

const insideGermany = (stop) =>
  stop.lat >= GERMANY_BOX.minLat &&
  stop.lat <= GERMANY_BOX.maxLat &&
  stop.lon >= GERMANY_BOX.minLon &&
  stop.lon <= GERMANY_BOX.maxLon;

const feedOf = (tripId) => /_([a-z]{2}-[^_]+)_/.exec(tripId)?.[1] ?? "";

function categoryOf(item) {
  const mapped = CATEGORY_BY_MODE[item.mode];
  if (mapped) return mapped;
  const line = item.trips?.[0]?.routeShortName ?? "";
  return /^(RE|IRE|MEX|RS|FEX|HLX)/.test(line) ? "rfast" : "reg";
}

const items = Object.values(JSON.parse(gunzipSync(readFileSync(sourcePath)).toString()));
const seen = new Set();
const segments = [];
let rawPoints = 0;
let keptPoints = 0;

for (const item of items) {
  const category = CATEGORY_BY_MODE[item.mode] ?? (item.mode === "REGIONAL_RAIL" ? "reg" : null);
  if (!category || !(insideGermany(item.from) || insideGermany(item.to))) continue;
  const durationSeconds = (Date.parse(item.arrival) - Date.parse(item.departure)) / 1000;
  if (!(durationSeconds >= 60)) continue;
  if (!LICENSED_FEEDS.has(feedOf(item.trips?.[0]?.tripId ?? ""))) continue;
  const decoded = decodePolyline(item.polyline);
  if (decoded.length < 4) continue;
  rawPoints += decoded.length / 2;
  const simplified = simplifyPolyline(decoded, SIMPLIFY_TOLERANCE_METRES);
  keptPoints += simplified.length / 2;
  const lengthMetres = polylineLengthMetres(simplified);
  const averageSpeed = lengthMetres / durationSeconds;
  if (averageSpeed < MIN_AVERAGE_SPEED || averageSpeed > MAX_AVERAGE_SPEED) continue;
  const polyline = encodePolyline(simplified);
  const key = `${item.mode}|${polyline}|${durationSeconds}`;
  if (seen.has(key)) continue;
  seen.add(key);
  segments.push({
    c: categoryOf(item),
    d: durationSeconds,
    l: Math.round(lengthMetres),
    p: polyline,
  });
}

const fixture = {
  source: "Transitous /api/v1/map/trips, Germany bbox, zoom 8",
  capturedAt: "2026-10-23T19:34:00Z",
  note: "Rail segments of the DELFI, VBB, KVV and VBN feeds only, average speed between 2 and 90 m/s. Polylines simplified to 2 m. c is the DESIGN.md category, d the realtime-adjusted duration in seconds, l the polyline length in metres, p a Google encoded polyline with precision 5.",
  segments,
};
writeFileSync(outputPath, gzipSync(`${JSON.stringify(fixture)}\n`, { level: 9 }));
process.stdout.write(
  `${segments.length} segments, ${rawPoints} raw points, ${keptPoints} kept points, written to ${outputPath}\n`,
);
