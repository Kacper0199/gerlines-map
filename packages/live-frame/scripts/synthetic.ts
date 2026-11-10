import type { Category, Delta, Keyframe, StopRecord, TripRecord } from "../src/index.ts";

/** Stops per trip in the 2026-10-19 DELFI train feed (pfaedle output, 143,788 trips, mean 14.2). */
const STOP_COUNT_HISTOGRAM: readonly [number, number][] = [
  [2, 3383],
  [3, 5196],
  [4, 5522],
  [5, 7059],
  [6, 7432],
  [7, 9125],
  [8, 7732],
  [9, 8346],
  [10, 8300],
  [11, 7500],
  [12, 6558],
  [13, 7283],
  [14, 4945],
  [15, 4857],
  [16, 4157],
  [17, 4170],
  [18, 4273],
  [19, 3104],
  [20, 3639],
  [21, 2919],
  [22, 2270],
  [23, 3398],
  [24, 2208],
  [25, 2257],
  [26, 1704],
  [27, 2222],
  [28, 3390],
  [29, 1307],
  [30, 2614],
  [31, 1019],
  [32, 572],
  [33, 338],
  [34, 590],
  [35, 477],
  [36, 234],
  [37, 300],
  [38, 510],
  [39, 229],
  [40, 104],
  [42, 161],
  [43, 215],
  [45, 217],
  [48, 1242],
  [55, 130],
  [73, 22],
];

interface CategoryProfile {
  readonly category: Category;
  readonly share: number;
  readonly run: readonly [number, number];
  readonly dwell: readonly [number, number];
  readonly lines: number;
  readonly prefix: string;
}

const PROFILES: readonly CategoryProfile[] = [
  { category: "sbahn", share: 0.3, run: [80, 240], dwell: [20, 60], lines: 140, prefix: "S" },
  { category: "reg", share: 0.36, run: [100, 420], dwell: [0, 60], lines: 600, prefix: "RB" },
  { category: "rfast", share: 0.2, run: [180, 960], dwell: [30, 120], lines: 300, prefix: "RE" },
  { category: "ld", share: 0.06, run: [600, 3600], dwell: [60, 240], lines: 60, prefix: "IC" },
  { category: "hsr", share: 0.07, run: [900, 4200], dwell: [60, 300], lines: 1, prefix: "ICE" },
  { category: "night", share: 0.01, run: [1200, 7200], dwell: [120, 900], lines: 20, prefix: "NJ" },
];

/** Mulberry32: a small seeded generator so every run measures the same frames. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function integer(next: () => number, [min, max]: readonly [number, number]): number {
  return min + Math.floor(next() * (max - min + 1));
}

function pick<T>(next: () => number, weighted: readonly (readonly [T, number])[]): T {
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let target = next() * total;
  for (const [value, weight] of weighted) {
    target -= weight;
    if (target < 0) return value;
  }
  return (weighted.at(-1) as readonly [T, number])[0];
}

function delayOf(next: () => number): number {
  const u = next();
  if (u < 0.55) return 0;
  if (u < 0.85) return 60 * integer(next, [1, 5]);
  return integer(next, [30, 1800]);
}

function hex(next: () => number, bytes: number): string {
  let out = "";
  for (let i = 0; i < bytes; i++) out += integer(next, [0, 255]).toString(16).padStart(2, "0");
  return out;
}

export interface SyntheticOptions {
  readonly trips: number;
  readonly seed: number;
  readonly timeBase: number;
  readonly shapesPerTrip?: number;
  /** Name shapes by number (up to 40,000) instead of a hash prefix. */
  readonly numbered?: boolean;
}

function syntheticStops(
  next: () => number,
  profile: CategoryProfile,
  timeBase: number,
  delay: number,
  realtime: boolean,
): { stops: StopRecord[]; firstStop: number } {
  const total = pick(next, STOP_COUNT_HISTOGRAM);
  const firstStop = Math.floor(next() * (total - 1));
  const remaining = total - firstStop;
  let time = timeBase - integer(next, profile.run) + delay;
  const stops: StopRecord[] = [];
  for (let j = 0; j < remaining; j++) {
    const arrival = j === 0 ? time : time + integer(next, profile.run);
    const departure = arrival + integer(next, profile.dwell);
    time = departure;
    stops.push({
      arrival: j === 0 && firstStop === 0 ? null : arrival,
      departure: j === remaining - 1 ? null : departure,
      cancelled: next() < 0.005,
      realtime: realtime && j > 0,
      s: null,
    });
  }
  return { stops, firstStop };
}

/** A keyframe of synthetic trips with realistic stop counts, run times, dwells and delays. */
export function syntheticKeyframe(options: SyntheticOptions): Keyframe {
  const next = random(options.seed);
  const shapeIds = Array.from(
    { length: Math.max(1, Math.round(options.trips * (options.shapesPerTrip ?? 0.6))) },
    (): string | number => (options.numbered ? integer(next, [1, 40_000]) : hex(next, 8)),
  );
  let key = 1_000_000;
  const trips: TripRecord[] = [];
  for (let i = 0; i < options.trips; i++) {
    key += integer(next, [1, 6]);
    const profile = pick(
      next,
      PROFILES.map((p) => [p, p.share] as const),
    );
    const realtime = next() < 0.75;
    const delay = realtime ? delayOf(next) : 0;
    const { stops, firstStop } = syntheticStops(next, profile, options.timeBase, delay, realtime);
    const lineNumber = integer(next, [1, profile.lines]);
    trips.push({
      key,
      shapeId: shapeIds[integer(next, [0, shapeIds.length - 1])] as string | number,
      category: profile.category,
      realtime,
      cancelled: next() < 0.003,
      foreign: next() < 0.03,
      delay: realtime ? delay : null,
      line: profile.lines === 1 ? profile.prefix : `${profile.prefix} ${lineNumber}`,
      trainNumber: integer(next, [1, 99_999]),
      firstStop,
      stops,
    });
  }
  return {
    kind: "keyframe",
    sequence: 1,
    timetableVersion: 1,
    shapeEpoch: options.numbered ? 1 : 0,
    timeBase: options.timeBase,
    trips,
  };
}

function shifted(trip: TripRecord, seconds: number): TripRecord {
  return {
    ...trip,
    realtime: true,
    delay: (trip.delay ?? 0) + seconds,
    stops: trip.stops.map((stop, j) =>
      j === 0
        ? stop
        : {
            ...stop,
            realtime: true,
            arrival: stop.arrival === null ? null : stop.arrival + seconds,
            departure: stop.departure === null ? null : stop.departure + seconds,
          },
    ),
  };
}

/**
 * A delta after `keyframe`: `share` of the trips get a new prediction (every stop after the first
 * moves by 30 to 240 s), and `churn` of the trips end or start.
 */
export function syntheticDelta(
  keyframe: Keyframe,
  options: { share: number; churn: number; seed: number },
): Delta {
  const next = random(options.seed);
  const trips: TripRecord[] = [];
  const removed: number[] = [];
  for (const trip of keyframe.trips) {
    const u = next();
    if (u < options.churn) removed.push(trip.key);
    else if (u < options.churn + options.share) trips.push(shifted(trip, integer(next, [30, 240])));
  }
  const fresh = syntheticKeyframe({
    trips: Math.round(keyframe.trips.length * options.churn),
    seed: options.seed + 1,
    numbered: typeof keyframe.trips[0]?.shapeId === "number",
    timeBase: keyframe.timeBase,
  }).trips.map((trip, i) => ({ ...trip, key: 0x7f000000 + i }));
  return {
    kind: "delta",
    sequence: keyframe.sequence + 1,
    baseSequence: keyframe.sequence,
    timetableVersion: keyframe.timetableVersion,
    shapeEpoch: keyframe.shapeEpoch,
    timeBase: keyframe.timeBase + 5,
    trips: [...trips, ...fresh],
    removed,
  };
}
