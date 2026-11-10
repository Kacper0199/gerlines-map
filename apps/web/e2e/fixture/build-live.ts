import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CATEGORIES,
  type Category,
  decodeKeyframe,
  decodeShapePack,
  encodeHead,
  encodeKeyframe,
  frameToObject,
  type HeadCount,
  type Keyframe,
  peekHeader,
  shapePolyline,
} from "@gerlines/live-frame";

const USAGE = `Usage: node e2e/fixture/build-live.ts --render <dir> --packs <dir> --at <ISO> --out <dir> [options]

Cuts the committed live fixture from a finished render: the keyframe nearest to --at, reduced to the trains that are
within --radius-km of --centre at that time and whose shape is at most --max-shape-km long (plus the trips named with
--include), the head that names it, and the shape packs of the kept trains copied byte for byte.

  --render <dir>        a render written by "live render" (holds k/<sequence>.bin)
  --packs <dir>         the pack directory of the render's shape epoch (holds s/<epoch>/<number>.bin)
  --at <ISO>            the instant to cut at
  --out <dir>           where head, k/ and s/ are written (replaced)
  --centre <lon,lat>    default 8.66,50.11 (Frankfurt am Main)
  --radius-km <n>       default 20
  --max-shape-km <n>    default 80
  --include <key>       keep this trip key as well (repeatable)
`;

const EARTH_RADIUS_M = 6378137;

function mercator(lon: number, lat: number): [number, number] {
  return [
    (EARTH_RADIUS_M * lon * Math.PI) / 180,
    EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  ];
}

function lonLat(x: number, y: number): [number, number] {
  return [
    (x / EARTH_RADIUS_M) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI),
  ];
}

function pointAt(shape: ReturnType<typeof shapePolyline>, arc: number): [number, number] {
  let k = 0;
  while (k < shape.s.length - 1 && (shape.s[k + 1] as number) < arc) k++;
  const span = Math.max(1e-6, (shape.s[k + 1] as number) - (shape.s[k] as number));
  const f = Math.min(1, Math.max(0, (arc - (shape.s[k] as number)) / span));
  const x = (shape.x[k] as number) + ((shape.x[k + 1] as number) - (shape.x[k] as number)) * f;
  const y = (shape.y[k] as number) + ((shape.y[k + 1] as number) - (shape.y[k] as number)) * f;
  return lonLat(x, y);
}

/** The stop a trip halts at over the whole of [from, to], with its position, or null. */
function dwellingAt(
  trip: Keyframe["trips"][number],
  shape: ReturnType<typeof shapePolyline>,
  from: number,
  to: number,
): { stopIndex: number; lon: number; lat: number } | null {
  for (let j = 0; j < trip.stops.length; j++) {
    const stop = trip.stops[j];
    if (!stop || stop.cancelled || stop.arrival === null || stop.departure === null) continue;
    const arc = shape.stops[trip.firstStop + j];
    if (arc === undefined || stop.arrival > from || stop.departure < to) continue;
    const [lon, lat] = pointAt(shape, arc);
    return { stopIndex: j, lon, lat };
  }
  return null;
}

function nearestKeyframe(directory: string, at: number): { file: string; timeBase: number } {
  let best: { file: string; timeBase: number } | undefined;
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".bin"))) {
    const { timeBase } = peekHeader(new Uint8Array(readFileSync(join(directory, file))));
    if (!best || Math.abs(timeBase - at) < Math.abs(best.timeBase - at)) best = { file, timeBase };
  }
  if (!best) throw new Error(`no keyframe in ${directory}`);
  return best;
}

type Stops = Keyframe["trips"][number]["stops"];

function arrivalOf(stop: Stops[number]): number {
  return stop.arrival ?? stop.departure ?? 0;
}

function departureOf(stop: Stops[number]): number {
  return stop.departure ?? stop.arrival ?? 0;
}

function arcAt(stops: Stops, arcs: readonly number[], time: number): number | null {
  for (let j = 0; j < stops.length; j++) {
    const stop = stops[j];
    if (!stop) continue;
    if (time >= arrivalOf(stop) && time <= departureOf(stop)) return arcs[j] ?? null;
    const next = stops[j + 1];
    if (next && time > departureOf(stop) && time < arrivalOf(next)) {
      const from = arcs[j] ?? 0;
      const to = arcs[j + 1] ?? from;
      return (
        from +
        ((to - from) * (time - departureOf(stop))) /
          Math.max(1, arrivalOf(next) - departureOf(stop))
      );
    }
  }
  return null;
}

function metresFrom(
  shape: ReturnType<typeof shapePolyline>,
  arc: number,
  centre: [number, number],
  latitude: number,
): number {
  let k = 0;
  while (k < shape.s.length - 1 && (shape.s[k + 1] as number) < arc) k++;
  const span = Math.max(1e-6, (shape.s[k + 1] as number) - (shape.s[k] as number));
  const f = Math.min(1, Math.max(0, (arc - (shape.s[k] as number)) / span));
  const x = (shape.x[k] as number) + ((shape.x[k + 1] as number) - (shape.x[k] as number)) * f;
  const y = (shape.y[k] as number) + ((shape.y[k + 1] as number) - (shape.y[k] as number)) * f;
  return Math.hypot(x - centre[0], y - centre[1]) * Math.cos((latitude * Math.PI) / 180);
}

/** The counts the cut knows: the trains it holds. Untracked and cancelled trips are not in a cut, so their rows are left out. */
function headCounts(trips: Keyframe["trips"]): HeadCount[] {
  const counts: HeadCount[] = [];
  const metrics: Array<[HeadCount["metric"], (trip: Keyframe["trips"][number]) => boolean]> = [
    ["running", () => true],
    ["realtime", (trip) => trip.realtime],
  ];
  for (const [metric, applies] of metrics) {
    const matching = trips.filter(applies);
    counts.push({ metric, category: null, count: matching.length });
    for (const category of CATEGORIES) {
      const count = matching.filter((trip) => trip.category === category).length;
      if (count > 0) counts.push({ metric, category: category as Category, count });
    }
  }
  return counts;
}

const { values } = parseArgs({
  options: {
    render: { type: "string" },
    packs: { type: "string" },
    at: { type: "string" },
    out: { type: "string" },
    centre: { type: "string", default: "8.66,50.11" },
    "radius-km": { type: "string", default: "20" },
    "max-shape-km": { type: "string", default: "80" },
    include: { type: "string", multiple: true, default: [] },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !(values.render && values.packs && values.at && values.out)) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 2);
}

const [lon = 0, lat = 0] = (values.centre as string).split(",").map(Number);
const centre = mercator(lon, lat);
const radiusM = Number(values["radius-km"]) * 1000;
const maxShapeM = Number(values["max-shape-km"]) * 1000;
const included = new Set((values.include as string[]).map(Number));
const at = Date.parse(values.at) / 1000;

const picked = nearestKeyframe(join(values.render, "k"), at);
const keyframe = frameToObject(
  decodeKeyframe(new Uint8Array(readFileSync(join(values.render, "k", picked.file)))),
) as Keyframe;
const probe = keyframe.timeBase + 0.5;

const kept: Keyframe["trips"][number][] = [];
const dwelling = new Map<number, ReturnType<typeof dwellingAt>>();
for (const trip of keyframe.trips) {
  const pack = join(values.packs, "s", String(keyframe.shapeEpoch), `${trip.shapeId}.bin`);
  const shape = shapePolyline(decodeShapePack(new Uint8Array(readFileSync(pack))), 0);
  if (included.has(trip.key)) {
    kept.push(trip);
    dwelling.set(trip.key, dwellingAt(trip, shape, keyframe.timeBase - 20, keyframe.timeBase + 20));
    continue;
  }
  if (shape.length > maxShapeM || trip.cancelled) continue;
  const arcs = trip.stops.map((_, j) => shape.stops[trip.firstStop + j] as number);
  const arc = arcAt(trip.stops, arcs, probe);
  if (arc !== null && metresFrom(shape, arc, centre, lat) <= radiusM) {
    kept.push(trip);
    dwelling.set(trip.key, dwellingAt(trip, shape, keyframe.timeBase - 20, keyframe.timeBase + 20));
  }
}

const out = values.out;
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "k"), { recursive: true });
mkdirSync(join(out, "s", String(keyframe.shapeEpoch)), { recursive: true });

const reduced: Keyframe = { ...keyframe, trips: kept };
writeFileSync(join(out, "k", `${keyframe.sequence}.bin`), encodeKeyframe(reduced));
writeFileSync(
  join(out, "head"),
  encodeHead({
    kind: "head",
    sequence: keyframe.sequence,
    timetableVersion: keyframe.timetableVersion,
    timeBase: keyframe.timeBase,
    keyframeSequence: keyframe.sequence,
    oldestSequence: keyframe.sequence + 1,
    counts: headCounts(kept),
  }),
);
for (const shapeId of new Set(kept.map((trip) => trip.shapeId))) {
  copyFileSync(
    join(values.packs, "s", String(keyframe.shapeEpoch), `${shapeId}.bin`),
    join(out, "s", String(keyframe.shapeEpoch), `${shapeId}.bin`),
  );
}
writeFileSync(
  join(out, "trips.json"),
  `${JSON.stringify(
    kept.map((trip) => ({
      key: trip.key,
      line: trip.line,
      trainNumber: trip.trainNumber,
      category: trip.category,
      delay: trip.delay,
      dwelling: dwelling.get(trip.key) ?? null,
    })),
    null,
    1,
  )}\n`,
);
process.stdout.write(
  `${JSON.stringify({ sequence: keyframe.sequence, timeBase: keyframe.timeBase, at: new Date(keyframe.timeBase * 1000).toISOString(), epoch: keyframe.shapeEpoch, trips: kept.length, shapes: new Set(kept.map((t) => t.shapeId)).size })}\n`,
);
