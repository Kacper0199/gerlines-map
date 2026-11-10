import type {
  Delta,
  Head,
  Keyframe,
  ShapePack,
  ShapeRecord,
  StopRecord,
  TripRecord,
} from "../src/index.ts";

export const TIME_BASE = 1_793_000_000;

export function stop(
  arrival: number | null,
  departure: number | null,
  extra: Partial<StopRecord> = {},
): StopRecord {
  return { arrival, departure, cancelled: false, realtime: false, s: null, ...extra };
}

export function trip(key: number, extra: Partial<TripRecord> = {}): TripRecord {
  return {
    key,
    shapeId: "00112233445566aa",
    category: "rfast",
    realtime: true,
    cancelled: false,
    foreign: false,
    delay: 120,
    line: "RE 1",
    trainNumber: 4711,
    firstStop: 2,
    stops: [
      stop(TIME_BASE - 60, TIME_BASE),
      stop(TIME_BASE + 300, TIME_BASE + 360, { realtime: true }),
      stop(TIME_BASE + 900, null, { realtime: true }),
    ],
    ...extra,
  };
}

export const KEYFRAME: Keyframe = {
  kind: "keyframe",
  sequence: 1000,
  timetableVersion: 7,
  shapeEpoch: 0,
  timeBase: TIME_BASE,
  trips: [
    trip(30, {
      shapeId: "ffeeddccbbaa9988",
      category: "hsr",
      line: "ICE",
      trainNumber: 379,
      delay: null,
      realtime: false,
      firstStop: 0,
      stops: [
        stop(null, TIME_BASE + 30),
        stop(TIME_BASE + 1800, TIME_BASE + 1920, { cancelled: true }),
        stop(TIME_BASE + 4000, null),
      ],
    }),
    trip(10),
    trip(20, {
      line: "Zürich HB – Łódź",
      foreign: true,
      cancelled: true,
      trainNumber: null,
      stops: [
        stop(TIME_BASE - 200, TIME_BASE - 100, { s: 1000.25 }),
        stop(TIME_BASE + 400, TIME_BASE + 400, { s: 5230.5 }),
      ],
    }),
    trip(40, { line: null, category: "sbahn", shapeId: "00112233445566aa" }),
  ],
};

export const DELTA: Delta = {
  kind: "delta",
  sequence: 1001,
  baseSequence: 1000,
  timetableVersion: 7,
  shapeEpoch: 0,
  timeBase: TIME_BASE + 3,
  trips: [trip(10, { delay: 240 }), trip(50, { category: "night", line: "NJ" })],
  removed: [40, 20],
};

export const HEAD: Head = {
  kind: "head",
  sequence: 1001,
  timetableVersion: 7,
  timeBase: TIME_BASE + 4,
  keyframeSequence: 1000,
  oldestSequence: 900,
};

/** A 1.1 head with legend counts (section 0x61), given out of code order. */
export const HEAD_COUNTS: Head = {
  ...HEAD,
  counts: [
    { metric: "untracked", category: null, count: 41 },
    { metric: "running", category: null, count: 3012 },
    { metric: "running", category: "hsr", count: 212 },
    { metric: "untracked", category: "reg", count: 30 },
    { metric: "untracked", category: "sbahn", count: 11 },
    { metric: "cancelled", category: null, count: 0 },
    { metric: "realtime", category: null, count: 2718 },
  ],
};

export const PACK: ShapePack = {
  kind: "shapePack",
  timetableVersion: 7,
  shapeEpoch: 0,
  shapes: [
    {
      hash: "00112233445566aa".padEnd(64, "0"),
      number: null,
      x: [1_492_000.12, 1_492_100.5, 1_492_250],
      y: [6_894_000.01, 6_893_900, 6_893_800.99],
      z: [34.5, 35.25, 36],
      m: [0, 150.5, 312.4],
      length: 312.4,
      stops: [0, 150.5, 312.4],
      tunnels: [[20, 80.75]],
    },
    {
      hash: "ffeeddccbbaa9988".padEnd(64, "1"),
      number: null,
      x: [-20_037_508.34, -20_037_000],
      y: [20_037_508.34, 20_037_000],
      z: null,
      m: [0, 508.34],
      length: 508.34,
      stops: [],
      tunnels: [],
    },
  ],
};

export const KEYFRAME_NUMBERED: Keyframe = {
  ...KEYFRAME,
  shapeEpoch: 3,
  trips: KEYFRAME.trips.map((t) => ({
    ...t,
    shapeId: t.shapeId === "ffeeddccbbaa9988" ? 4021 : 17,
  })),
};

export const PACK_NUMBERED: ShapePack = {
  ...PACK,
  shapeEpoch: 3,
  shapes: PACK.shapes.map((shape, i) => ({ ...shape, number: [17, 4021][i] as number })),
};

export const PACK_STUBS: ShapePack = {
  ...PACK_NUMBERED,
  shapes: [
    {
      ...(PACK_NUMBERED.shapes[0] as ShapeRecord),
      stubs: {
        before: {
          x: [1_491_900.12, 1_491_800],
          y: [6_894_100.01, 6_894_250.5],
          d: [100.5, 250.75],
        },
        after: { x: [1_492_400], y: [6_893_700.99], d: [180.25] },
      },
    },
    { ...(PACK_NUMBERED.shapes[1] as ShapeRecord), stubs: { before: null, after: null } },
  ],
};

const MAX_U32 = 0xffffffff;
const MAX_I32 = 0x7fffffff;
const LATEST_START = TIME_BASE + MAX_I32;

/** Every field at the end of its range: keys, numbers, epoch, delays, start, run, dwell, arc. */
export const KEYFRAME_LIMITS: Keyframe = {
  kind: "keyframe",
  sequence: MAX_U32,
  timetableVersion: MAX_U32,
  shapeEpoch: MAX_U32,
  timeBase: TIME_BASE,
  trips: [
    trip(0, {
      shapeId: 0,
      category: "unknown",
      realtime: false,
      delay: -32_767,
      line: null,
      trainNumber: null,
      firstStop: 0,
      stops: [stop(0, 65_535, { realtime: true }), stop(131_070, null, { cancelled: true })],
    }),
    trip(MAX_U32, {
      shapeId: MAX_U32,
      category: "bus",
      cancelled: true,
      foreign: true,
      delay: 32_767,
      line: "X".repeat(300),
      trainNumber: MAX_U32,
      firstStop: 65_535,
      stops: [
        stop(LATEST_START, LATEST_START + 65_535, { s: 0 }),
        stop(LATEST_START + 131_070, null, { s: MAX_U32 / 100 }),
      ],
    }),
  ],
};

export const DELTA_REMOVALS: Delta = {
  ...DELTA,
  trips: [],
  removed: [MAX_U32, 0, 40],
};

/**
 * keyframe-basic with each trip's vehicle (FORMAT 1.3): a series and its units, an operator only,
 * nothing known, and a series named like a line, so the string table holds it once.
 */
export const KEYFRAME_VEHICLE: Keyframe = {
  ...KEYFRAME_NUMBERED,
  trips: KEYFRAME_NUMBERED.trips.map((t) => {
    switch (t.key) {
      case 30:
        return { ...t, series: "db-412", operator: "db-fernverkehr-ag", units: 2 };
      case 10:
        return { ...t, series: null, operator: "db-regio-ag-nrw", units: null };
      case 20:
        return { ...t, series: null, operator: null, units: null };
      default:
        return { ...t, line: "db-423", series: "db-423", operator: "s-bahn-muenchen", units: 1 };
    }
  }),
};

/** delta-basic with the vehicle of one trip, the other trip named with nothing known. */
export const DELTA_VEHICLE: Delta = {
  ...DELTA,
  trips: [
    trip(10, { delay: 240, series: "db-1440", operator: "db-regio-ag-nrw", units: 3 }),
    trip(50, { category: "night", line: "NJ", series: null, operator: null, units: null }),
  ],
};
