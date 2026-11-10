import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import {
  decodeDelta,
  decodeKeyframe,
  decodeShapePack,
  encodeDelta,
  encodeHead,
  encodeKeyframe,
  encodeShapePack,
  frameToObject,
  type Keyframe,
  shapePackToObject,
} from "../src/index.ts";
import { gtfsSample, motisShapePack } from "./gtfs-sample.ts";
import { syntheticDelta, syntheticKeyframe } from "./synthetic.ts";

const HELP = `Usage: node scripts/sizes.ts [--gtfs <dir>] [--motis-shapes <file> --motis-trip <id>] [--out <file>]

Measures encoded sizes (raw, gzip 9, brotli 5 and 11) and Node decode times of keyframes for 3,000
and 15,000 trips, deltas, the head and a shape pack. Synthetic trips always; with --gtfs the trips
running at 08:00 in a GTFS feed (calendars ignored); with --motis-shapes a real long shape.`;

const { values } = parseArgs({
  options: {
    gtfs: { type: "string" },
    "motis-shapes": { type: "string" },
    "motis-trip": { type: "string", default: "3448697036" },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const TIME_BASE = Date.UTC(2026, 9, 27, 7, 0, 0) / 1000;

interface Row {
  readonly name: string;
  readonly detail: string;
  readonly raw: number;
  readonly gzip9: number;
  readonly brotli5: number;
  readonly brotli11: number;
  readonly decodeP50?: number;
  readonly objectP50?: number;
}

function brotli(bytes: Uint8Array, quality: number): number {
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length;
}

function median(run: () => unknown, times = 31): number {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

function row(
  name: string,
  detail: string,
  bytes: Uint8Array,
  decode?: () => unknown,
  toObject?: () => unknown,
): Row {
  return {
    name,
    detail,
    raw: bytes.length,
    gzip9: gzipSync(bytes, { level: 9 }).length,
    brotli5: brotli(bytes, 5),
    brotli11: brotli(bytes, 11),
    ...(decode ? { decodeP50: median(decode) } : {}),
    ...(toObject ? { objectP50: median(toObject, 11) } : {}),
  };
}

function describe(frame: Keyframe): string {
  const stops = frame.trips.reduce((sum, trip) => sum + trip.stops.length, 0);
  const shapes = new Set(frame.trips.map((trip) => trip.shapeId)).size;
  const lines = new Set(frame.trips.map((trip) => trip.line)).size;
  return `${frame.trips.length} trips, ${(stops / frame.trips.length).toFixed(1)} plan stops per trip, ${shapes} shapes, ${lines} lines`;
}

function keyframeRows(label: string, frame: Keyframe): Row[] {
  const bytes = encodeKeyframe(frame);
  const rows = [
    row(
      `keyframe ${label}`,
      describe(frame),
      bytes,
      () => decodeKeyframe(bytes),
      () => frameToObject(decodeKeyframe(bytes)),
    ),
  ];
  for (const share of [0.1, 0.3]) {
    const delta = encodeDelta(syntheticDelta(frame, { share, churn: 0.005, seed: 99 }));
    rows.push(
      row(
        `delta ${label}, ${share * 100} % changed`,
        "changed plans whole, 0.5 % ended and 0.5 % new trips",
        delta,
        () => decodeDelta(delta),
      ),
    );
  }
  return rows;
}

const rows: Row[] = [];
const FORMS = [
  [false, "hash ids"],
  [true, "shape numbers"],
] as const;
for (const trips of [3000, 15000]) {
  for (const [numbered, form] of FORMS) {
    const frame = syntheticKeyframe({ trips, seed: 20261025, timeBase: TIME_BASE, numbered });
    rows.push(...keyframeRows(`synthetic ${trips}, ${form}`, frame));
  }
}
if (values.gtfs) {
  const sample = await gtfsSample(values.gtfs, 8 * 3600, TIME_BASE);
  process.stdout.write(`GTFS: ${sample.running} trips running at 08:00 after folding repeats\n`);
  for (const trips of [3000, 15000].filter((count) => count <= sample.running)) {
    for (const [numbered, form] of FORMS) {
      rows.push(
        ...keyframeRows(`GTFS ${trips}, ${form}`, sample.keyframe(trips, 20261025, numbered)),
      );
    }
  }
}
rows.push(
  row(
    "head",
    "three sequences",
    encodeHead({
      kind: "head",
      sequence: 1001,
      timetableVersion: 1,
      timeBase: TIME_BASE,
      keyframeSequence: 1000,
      oldestSequence: 900,
    }),
  ),
);
if (values["motis-shapes"]) {
  for (const elevation of [false, true]) {
    const pack = motisShapePack(values["motis-shapes"], values["motis-trip"], 24, elevation);
    const bytes = encodeShapePack(pack);
    const shape = pack.shapes[0];
    rows.push(
      row(
        `shape pack MOTIS trip ${values["motis-trip"]}${elevation ? " with z" : ""}`,
        `${shape?.x.length} vertices, ${((shape?.length ?? 0) / 1000).toFixed(0)} km, 24 stops`,
        bytes,
        () => decodeShapePack(bytes),
        () => shapePackToObject(decodeShapePack(bytes)),
      ),
    );
  }
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const ms = (value: number | undefined) => (value === undefined ? "" : value.toFixed(2));
const table = [
  "| Object | Content | Raw KB | gzip 9 KB | brotli 5 KB | brotli 11 KB | decode ms p50 | to objects ms p50 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| ${r.name} | ${r.detail} | ${kb(r.raw)} | ${kb(r.gzip9)} | ${kb(r.brotli5)} | ${kb(r.brotli11)} | ${ms(r.decodeP50)} | ${ms(r.objectP50)} |`,
  ),
].join("\n");
process.stdout.write(`${table}\n\nNode ${process.version}, ${new Date().toISOString()}\n`);
if (values.out) writeFileSync(values.out, `${JSON.stringify(rows, null, 2)}\n`);
