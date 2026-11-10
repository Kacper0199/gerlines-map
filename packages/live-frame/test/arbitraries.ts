import fc from "fast-check";
import {
  CATEGORIES,
  type Delta,
  type Head,
  type Keyframe,
  type ShapePack,
  type ShapeRecord,
  type StopRecord,
  type TripRecord,
} from "../src/index.ts";

export const SEED = 20261025;
export const TIME_BASE = 1_793_000_000;

const SHAPE_IDS = ["0000000000000000", "00112233445566aa", "ffffffffffffffff", "0a0b0c0d0e0f1011"];
const LINES = ["ICE", "RE 1", "S 3", "Zürich HB – Łódź", "", "NJ 40470"];

const hex = (bytes: number) =>
  fc
    .uint8Array({ minLength: bytes, maxLength: bytes })
    .map((values) => Array.from(values, (v) => v.toString(16).padStart(2, "0")).join(""));

type NullMode = "none" | "arrival" | "departure";

interface StopPart {
  readonly run: number;
  readonly dwell: number;
  readonly nullMode: NullMode;
  readonly cancelled: boolean;
  readonly realtime: boolean;
  readonly arcStep: number;
}

const stopShape: fc.Arbitrary<StopPart> = fc.record({
  run: fc.integer({ min: 0, max: 65_535 }),
  dwell: fc.integer({ min: 0, max: 65_535 }),
  nullMode: fc.constantFrom<NullMode>("none", "none", "arrival", "departure"),
  cancelled: fc.boolean(),
  realtime: fc.boolean(),
  arcStep: fc.integer({ min: 0, max: 5_000_000 }),
});

function stopsFrom(start: number, parts: readonly StopPart[], explicit: boolean): StopRecord[] {
  let time = start;
  let arc = 0;
  return parts.map((part, j) => {
    const arrival = time + (j === 0 ? 0 : part.run);
    const departure = part.nullMode === "none" ? arrival + part.dwell : arrival;
    time = departure;
    arc += part.arcStep;
    return {
      arrival: part.nullMode === "arrival" ? null : arrival,
      departure: part.nullMode === "departure" ? null : departure,
      cancelled: part.cancelled,
      realtime: part.realtime,
      s: explicit ? arc / 100 : null,
    };
  });
}

const SHAPE_NUMBERS = [0, 1, 4021, 0xffffffff];

export const tripArb = (
  key: number,
  shapes: readonly (string | number)[],
): fc.Arbitrary<TripRecord> =>
  fc
    .record({
      shapeId: fc.constantFrom(...shapes),
      category: fc.constantFrom(...CATEGORIES),
      realtime: fc.boolean(),
      cancelled: fc.boolean(),
      foreign: fc.boolean(),
      delay: fc.option(fc.integer({ min: -32_767, max: 32_767 })),
      line: fc.option(fc.constantFrom(...LINES)),
      trainNumber: fc.option(fc.integer({ min: 1, max: 0xffffffff })),
      firstStop: fc.integer({ min: 0, max: 65_535 }),
      start: fc.integer({ min: -100_000, max: 100_000 }),
      explicit: fc.boolean(),
      parts: fc.array(stopShape, { minLength: 2, maxLength: 8 }),
    })
    .map(({ start, explicit, parts, ...rest }) => ({
      key,
      ...rest,
      stops: stopsFrom(TIME_BASE + start, parts, explicit),
    }));

const shapeEpochArb = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 0xffffffff }));

const tripsArb = (maxLength: number) =>
  fc
    .tuple(fc.uniqueArray(fc.integer({ min: 0, max: 0xffffffff }), { maxLength }), shapeEpochArb)
    .chain(([keys, shapeEpoch]) => {
      const shapes = shapeEpoch > 0 ? SHAPE_NUMBERS : SHAPE_IDS;
      const trips: fc.Arbitrary<TripRecord[]> = keys.length
        ? fc.tuple(...keys.map((key) => tripArb(key, shapes)))
        : fc.constant([]);
      return trips.map((list) => ({ shapeEpoch, trips: list }));
    });

const meta = {
  sequence: fc.integer({ min: 1, max: 0xffffffff }),
  timetableVersion: fc.integer({ min: 0, max: 0xffffffff }),
};

export const keyframeArb: fc.Arbitrary<Keyframe> = fc
  .record({ ...meta, shaped: tripsArb(12) })
  .map(({ shaped, ...frame }) => ({ kind: "keyframe", timeBase: TIME_BASE, ...frame, ...shaped }));

export const deltaArb: fc.Arbitrary<Delta> = fc
  .record({
    ...meta,
    sequence: fc.integer({ min: 2, max: 0xffffffff }),
    shaped: tripsArb(8),
    removed: fc.uniqueArray(fc.integer({ min: 0, max: 0xffffffff }), { maxLength: 8 }),
  })
  .map(({ shaped: { trips, shapeEpoch }, removed, sequence, timetableVersion }) => {
    const keys = new Set(trips.map((trip) => trip.key));
    return {
      kind: "delta",
      sequence,
      baseSequence: sequence - 1,
      timetableVersion,
      shapeEpoch,
      timeBase: TIME_BASE,
      trips,
      removed: removed.filter((key) => !keys.has(key)),
    };
  });

export const headArb: fc.Arbitrary<Head> = fc
  .record({
    ...meta,
    keyframeBack: fc.integer({ min: 0, max: 100 }),
    oldestBack: fc.integer({ min: 0, max: 1000 }),
  })
  .map(({ sequence, timetableVersion, keyframeBack, oldestBack }) => {
    const keyframeSequence = Math.max(1, sequence - keyframeBack);
    return {
      kind: "head",
      sequence,
      timetableVersion,
      timeBase: TIME_BASE,
      keyframeSequence,
      oldestSequence: Math.min(0xffffffff, Math.max(2, keyframeSequence + 1 - oldestBack)),
    };
  });

const LIMIT = 2_003_750_834;

const shapeArb: fc.Arbitrary<Omit<ShapeRecord, "hash" | "number">> = fc
  .record({
    origin: fc.tuple(
      fc.integer({ min: -LIMIT + 10_000_000, max: LIMIT - 10_000_000 }),
      fc.integer({ min: -LIMIT + 10_000_000, max: LIMIT - 10_000_000 }),
    ),
    steps: fc.array(
      fc.tuple(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
      ),
      { minLength: 1, maxLength: 40 },
    ),
    elevation: fc.boolean(),
    z: fc.array(fc.float({ noNaN: true, noDefaultInfinity: true, min: -500, max: 3000 }), {
      minLength: 41,
      maxLength: 41,
    }),
    length: fc.integer({ min: 0, max: 0xffffffff }),
    marks: fc.array(fc.integer({ min: 0, max: 0xffffffff }), { minLength: 39, maxLength: 39 }),
    cuts: fc.uniqueArray(fc.integer({ min: 0, max: 0xffffffff }), { maxLength: 8 }),
    stops: fc.array(fc.integer({ min: 0, max: 0xffffffff }), { maxLength: 8 }),
  })
  .map(({ origin, steps, elevation, z, length, marks, cuts, stops }) => {
    const x = [origin[0]];
    const y = [origin[1]];
    for (const [dx, dy] of steps) {
      x.push((x.at(-1) as number) + dx);
      y.push((y.at(-1) as number) + dy);
    }
    const spans = cuts
      .filter((cut) => cut <= length)
      .sort((a, b) => a - b)
      .slice(0, cuts.length - (cuts.length % 2));
    const tunnels: [number, number][] = [];
    for (let k = 0; k + 1 < spans.length; k += 2) {
      tunnels.push([(spans[k] as number) / 100, (spans[k + 1] as number) / 100]);
    }
    return {
      x: x.map((cm) => cm / 100),
      y: y.map((cm) => cm / 100),
      z: elevation ? z.slice(0, x.length) : null,
      m: [
        0,
        ...marks
          .slice(0, x.length - 2)
          .map((mark) => mark % (length + 1))
          .sort((a, b) => a - b),
        length,
      ].map((cm) => cm / 100),
      length: length / 100,
      stops: stops
        .filter((s) => s <= length)
        .sort((a, b) => a - b)
        .map((cm) => cm / 100),
      tunnels,
    };
  });

export const packArb: fc.Arbitrary<ShapePack> = fc
  .record({
    timetableVersion: meta.timetableVersion,
    hashes: fc.uniqueArray(hex(32), { maxLength: 4 }),
    shapeEpoch: shapeEpochArb,
    numbers: fc.uniqueArray(fc.integer({ min: 0, max: 0xffffffff }), {
      minLength: 4,
      maxLength: 4,
    }),
  })
  .chain(({ timetableVersion, hashes, shapeEpoch, numbers }) =>
    fc.tuple(...hashes.map(() => shapeArb)).map((shapes) => ({
      kind: "shapePack" as const,
      timetableVersion,
      shapeEpoch,
      shapes: shapes.map((shape, i) => ({
        hash: hashes[i] as string,
        number: shapeEpoch > 0 ? (numbers[i] as number) : null,
        ...shape,
      })),
    })),
  );
