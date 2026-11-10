import { type Delta, encodeDelta, type StopRecord } from "@gerlines/live-frame";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { StaticRun } from "../model.ts";
import type { ForecastRow, SourceView } from "../realtime/store.ts";
import {
  buildPlan,
  createPlanStats,
  type LivePlan,
  motionOfPlan,
  mustEmit,
  type PlanOutcome,
  type PlanStats,
  type PlanStopState,
  targetOf,
  tripRecordOf,
} from "./trip-plan.ts";

const T = 1_793_947_000;
const KEY = 26_724_253;

function staticRun(
  arrivals: readonly number[],
  departures: readonly number[],
  arcs: readonly number[],
  passThrough: readonly number[] = arrivals.map(() => 0),
): StaticRun {
  return {
    instanceId: "00000000-0000-5000-8000-000000026724",
    serviceDate: "2026-11-06",
    feedVersionId: 2,
    tripKey: "t26724253",
    category: "reg",
    categoryCode: "reg",
    foreign: false,
    line: "RB 1",
    trainNumber: 4711,
    shortName: "4711",
    operatorId: null,
    patternId: "p",
    stopPlaces: arrivals.map((_, j) => `p${j}`),
    arrivals: Float64Array.from(arrivals),
    departures: Float64Array.from(departures),
    passThrough: Uint8Array.from(passThrough),
    shape: {
      shapeNo: 17,
      hash: "ab".repeat(32),
      length: 80_000,
      stopArcs: Float64Array.from(arcs),
      qaStatus: "pass",
    },
    gap: null,
  };
}

interface RowSpec {
  readonly stopIndex: number;
  readonly arrival: number | null;
  readonly departure: number | null;
  readonly cancelled: boolean;
}

function forecast(run: StaticRun, spec: RowSpec): ForecastRow {
  const j = spec.stopIndex;
  return {
    instanceId: run.instanceId,
    serviceDate: run.serviceDate,
    stopIndex: j,
    sourceId: "delfi-gtfs-rt",
    observedAt: T,
    predictedArrival: spec.arrival,
    predictedDeparture: spec.departure,
    arrivalDelay: spec.arrival === null ? null : spec.arrival - (run.arrivals[j] as number),
    departureDelay: spec.departure === null ? null : spec.departure - (run.departures[j] as number),
    cancelled: spec.cancelled,
    explicit: !spec.cancelled,
    stopPlaceId: run.stopPlaces[j] as string,
  };
}

function sourceOf(run: StaticRun, specs: readonly RowSpec[]): SourceView | undefined {
  if (specs.length === 0) return undefined;
  return {
    sourceId: "delfi-gtfs-rt",
    firstSeen: T,
    lastSeen: T,
    stops: new Map(specs.map((spec) => [spec.stopIndex, forecast(run, spec)])),
  };
}

function plan(
  run: StaticRun,
  now: number,
  published: LivePlan | null,
  specs: readonly RowSpec[],
  holdRule = true,
  stats: PlanStats = createPlanStats(),
): PlanOutcome {
  return buildPlan({
    run,
    source: sourceOf(run, specs),
    now,
    published,
    publishedMotion: published ? motionOfPlan(published, run) : null,
    holdRule,
    stats,
  });
}

function backwards(stops: readonly StopRecord[]): string[] {
  const faults: string[] = [];
  let left: number | undefined;
  stops.forEach((stop, j) => {
    const arrival = stop.arrival ?? stop.departure;
    const departure = stop.departure ?? stop.arrival;
    if (arrival === null || departure === null) {
      faults.push(`stop ${j} has no time`);
      return;
    }
    if (departure < arrival) faults.push(`stop ${j} departs before it arrives`);
    if (left !== undefined && arrival < left)
      faults.push(`stop ${j} arrives ${left - arrival} s before stop ${j - 1} departs`);
    left = departure;
  });
  return faults;
}

function passTimesOutside(stops: readonly PlanStopState[]): string[] {
  const faults: string[] = [];
  stops.forEach((stop, i) => {
    if (!stop.cancelled) return;
    const before = stops.slice(0, i).findLast((candidate) => !candidate.cancelled);
    const after = stops.slice(i + 1).find((candidate) => !candidate.cancelled);
    if (!before || !after) return;
    if (stop.arrival < before.departure || stop.departure > after.arrival)
      faults.push(
        `stop ${i} passes at ${stop.arrival}, outside ${before.departure} to ${after.arrival}`,
      );
  });
  return faults;
}

function encode(record: ReturnType<typeof tripRecordOf>, now: number): Uint8Array {
  const delta: Delta = {
    kind: "delta",
    sequence: 2,
    baseSequence: 1,
    timetableVersion: 2,
    shapeEpoch: 1,
    timeBase: now,
    trips: [record],
    removed: [],
  };
  return encodeDelta(delta);
}

describe("cancelled stops ahead of the first served stop", () => {
  const run = staticRun(
    [T + 680, T + 710, T + 800, T + 860, T + 1500],
    [T + 680, T + 740, T + 800, T + 900, T + 1500],
    [0, 4_000, 9_000, 14_000, 40_000],
  );
  const cancelledHead: RowSpec[] = [
    { stopIndex: 0, arrival: T + 680, departure: T + 680, cancelled: true },
    { stopIndex: 1, arrival: T + 710, departure: T + 740, cancelled: true },
    { stopIndex: 2, arrival: T + 800, departure: T + 800, cancelled: true },
    { stopIndex: 3, arrival: T + 771, departure: T + 830, cancelled: false },
    { stopIndex: 4, arrival: T + 1440, departure: T + 1440, cancelled: false },
  ];

  it("gives trip 26724253 a stop list the frame encoder accepts and counts the cap", () => {
    const published = plan(run, T + 300, null, []);
    if (published.kind !== "plan") throw new Error(published.kind);
    const stats = createPlanStats();
    const next = plan(run, T + 360, published.plan, cancelledHead, true, stats);
    if (next.kind !== "plan") throw new Error(next.kind);
    const record = tripRecordOf(KEY, run, next.plan);
    expect(backwards(record.stops)).toEqual([]);
    expect(() => encode(record, T + 360)).not.toThrow();
    expect(stats.cancelledCapped).toBe(1);
  });

  it("keeps the cancelled stops flagged, served times untouched and scheduled times where they fit", () => {
    const published = plan(run, T + 300, null, []);
    if (published.kind !== "plan") throw new Error(published.kind);
    const next = plan(run, T + 360, published.plan, cancelledHead);
    if (next.kind !== "plan") throw new Error(next.kind);
    expect(next.plan.stops.map((stop) => [stop.stopIndex, stop.cancelled])).toEqual([
      [0, true],
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ]);
    const times = next.plan.stops.map((stop) => [stop.arrival - T, stop.departure - T]);
    expect(times).toEqual([
      [680, 680],
      [710, 740],
      [771, 771],
      [771, 830],
      [1440, 1440],
    ]);
  });
});

interface Scenario {
  readonly arrivals: number[];
  readonly departures: number[];
  readonly arcs: number[];
  readonly passThrough: number[];
  readonly snapshots: RowSpec[][];
  readonly times: number[];
}

const rowOffset = fc.option(fc.integer({ min: -900, max: 1_800 }));

function scenario(arcStep: fc.Arbitrary<number>): fc.Arbitrary<Scenario> {
  return fc
    .integer({ min: 2, max: 9 })
    .chain((n) =>
      fc.record({
        runs: fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3_600 })), {
          minLength: n,
          maxLength: n,
        }),
        dwells: fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3_600 })), {
          minLength: n,
          maxLength: n,
        }),
        arcSteps: fc.array(arcStep, { minLength: n, maxLength: n }),
        passThrough: fc.array(fc.constantFrom(0, 0, 0, 1), { minLength: n, maxLength: n }),
        rows: fc.array(
          fc.array(
            fc.option(
              fc.record({ arrival: rowOffset, departure: rowOffset, cancelled: fc.boolean() }),
            ),
            { minLength: n, maxLength: n },
          ),
          { minLength: 1, maxLength: 4 },
        ),
        times: fc.array(fc.integer({ min: -600, max: 40_000 }), { minLength: 2, maxLength: 5 }),
      }),
    )
    .map(({ runs, dwells, arcSteps, passThrough, rows, times }) => {
      const arrivals: number[] = [];
      const departures: number[] = [];
      const arcs: number[] = [];
      let t = T;
      let s = 0;
      runs.forEach((runTime, j) => {
        t += j === 0 ? 0 : runTime;
        arrivals.push(t);
        t += j === 0 || j === runs.length - 1 ? 0 : (dwells[j] as number);
        departures.push(t);
        s = j === 0 ? 0 : Math.max(0, s + (arcSteps[j] as number));
        arcs.push(Math.min(s, 80_000));
      });
      const snapshots = rows.map((pick) =>
        pick.flatMap((row, j) =>
          row === null
            ? []
            : [
                {
                  stopIndex: j,
                  arrival: row.arrival === null ? null : (arrivals[j] as number) + row.arrival,
                  departure:
                    row.departure === null ? null : (departures[j] as number) + row.departure,
                  cancelled: row.cancelled,
                },
              ],
        ),
      );
      return {
        arrivals,
        departures,
        arcs,
        passThrough,
        snapshots,
        times: [...times].sort((a, b) => a - b).map((dt) => T + dt),
      };
    });
}

function replan(sc: Scenario, holdRule: boolean, check: (plan: LivePlan, now: number) => void) {
  const run = staticRun(sc.arrivals, sc.departures, sc.arcs, sc.passThrough);
  let published: LivePlan | null = null;
  sc.times.forEach((now, i) => {
    const rows = sc.snapshots[Math.min(i, sc.snapshots.length - 1)] as RowSpec[];
    const outcome = plan(run, now, published, rows, holdRule);
    if (outcome.kind !== "plan") {
      published = null;
      return;
    }
    const record = tripRecordOf(KEY, run, outcome.plan);
    expect(backwards(record.stops)).toEqual([]);
    expect(() => encode(record, now)).not.toThrow();
    check(outcome.plan, now);
    published = outcome.plan;
  });
}

describe("the stop list given to the encoder (property)", () => {
  it("never runs backwards for any mix of cancelled, pass-through and live stops", () => {
    fc.assert(
      fc.property(scenario(fc.integer({ min: 0, max: 15_000 })), (sc) => {
        replan(sc, true, () => {});
      }),
      { numRuns: 3_000 },
    );
  });

  it("keeps a pass time between its served neighbours when stop arcs fall (hold rule off)", () => {
    fc.assert(
      fc.property(scenario(fc.integer({ min: -3_000, max: 15_000 })), (sc) => {
        replan(sc, false, (p) => {
          expect(passTimesOutside(p.stops)).toEqual([]);
        });
      }),
      { numRuns: 2_000 },
    );
  });
});

const SET_BACK_TOLERANCE_M = 0.01;

/**
 * Faults of a replan against the plan it replaces: a stop passed while cancelled served again, a
 * reached served stop's times moved, or the target at now behind the last reached served stop (or
 * behind the published target, when a schedule faster than the train left that one lagging).
 */
function setBack(run: StaticRun, published: LivePlan, next: LivePlan, now: number): string[] {
  const faults: string[] = [];
  let reached = Number.NEGATIVE_INFINITY;
  for (const before of published.stops) {
    if (before.stopIndex < 0 || before.arrival > now) continue;
    const after = next.stops.find((stop) => stop.stopIndex === before.stopIndex);
    faults.push(...reachedStopFaults(before, after, now));
    if (!before.cancelled) reached = Math.max(reached, before.s);
  }
  const motion = motionOfPlan(next, run);
  const drawn = motionOfPlan(published, run);
  if (motion && drawn && reached > Number.NEGATIVE_INFINITY) {
    const floor = Math.min(reached, targetOf(drawn, now));
    const target = targetOf(motion, now);
    if (target < floor - SET_BACK_TOLERANCE_M)
      faults.push(`target ${target} behind ${floor}, reached ${reached}`);
  }
  return faults;
}

function reachedStopFaults(
  before: PlanStopState,
  after: PlanStopState | undefined,
  now: number,
): string[] {
  if (!after) return [];
  const j = before.stopIndex;
  if (after.cancelled !== before.cancelled)
    return [`stop ${j} passed changes from cancelled ${before.cancelled}`];
  if (before.cancelled) return [];
  const faults: string[] = [];
  if (after.arrival !== before.arrival)
    faults.push(`stop ${j} reached at ${before.arrival} moves to ${after.arrival}`);
  if (before.departure <= now && after.departure !== before.departure)
    faults.push(`stop ${j} left at ${before.departure} moves to ${after.departure}`);
  return faults;
}

function targetAt(run: StaticRun, p: LivePlan, now: number): number {
  const motion = motionOfPlan(p, run);
  if (!motion) throw new Error("no motion plan");
  return targetOf(motion, now);
}

function stopOf(p: LivePlan, stopIndex: number): PlanStopState {
  const stop = p.stops.find((candidate) => candidate.stopIndex === stopIndex);
  if (!stop) throw new Error(`no stop ${stopIndex}`);
  return stop;
}

function planned(outcome: PlanOutcome): LivePlan {
  if (outcome.kind !== "plan") throw new Error(outcome.kind);
  return outcome.plan;
}

describe("a stop passed while cancelled stays passed when served again (D-071)", () => {
  const inner = staticRun(
    [T, T + 600, T + 1200, T + 1800],
    [T + 60, T + 600, T + 1260, T + 1800],
    [0, 10_000, 20_000, 30_000],
  );
  const innerCancelled: RowSpec[] = [
    { stopIndex: 1, arrival: T + 600, departure: T + 600, cancelled: true },
  ];

  it("case B: keeps an inner stop cancelled at its pass time and the train where it was", () => {
    const published = planned(plan(inner, T + 30, null, innerCancelled));
    expect(stopOf(published, 1)).toMatchObject({ cancelled: true, arrival: T + 630 });
    const now = T + 700;
    const next = planned(
      plan(inner, now, published, [
        { stopIndex: 1, arrival: T + 760, departure: T + 790, cancelled: false },
        { stopIndex: 2, arrival: T + 1300, departure: T + 1360, cancelled: false },
      ]),
    );
    expect(stopOf(next, 1)).toMatchObject({
      cancelled: true,
      arrival: T + 630,
      departure: T + 630,
    });
    expect(stopOf(next, 2)).toMatchObject({ cancelled: false, arrival: T + 1300 });
    expect(targetAt(inner, next, now)).toBeGreaterThanOrEqual(targetAt(inner, published, now) - 1);
    expect(setBack(inner, published, next, now)).toEqual([]);
  });

  it("case B2: a source time already behind now changes nothing either, and nothing re-emits", () => {
    const published = planned(plan(inner, T + 30, null, innerCancelled));
    const now = T + 700;
    const rows: RowSpec[] = [
      { stopIndex: 1, arrival: T + 680, departure: T + 690, cancelled: false },
      { stopIndex: 2, arrival: T + 1300, departure: T + 1360, cancelled: false },
    ];
    const next = planned(plan(inner, now, published, rows));
    expect(stopOf(next, 1)).toMatchObject({ cancelled: true, arrival: T + 630 });
    expect(targetAt(inner, next, now)).toBeGreaterThanOrEqual(targetAt(inner, published, now) - 1);
    const again = planned(plan(inner, now + 20, next, rows));
    expect(mustEmit(next, again)).toBe(false);
  });

  it("case A: a head stop capped at 771 stays cancelled and the reached stop keeps 771", () => {
    const run = staticRun(
      [T + 680, T + 710, T + 800, T + 860, T + 1500],
      [T + 680, T + 740, T + 800, T + 900, T + 1500],
      [0, 4_000, 9_000, 14_000, 40_000],
    );
    const first = planned(plan(run, T + 300, null, []));
    const capped = planned(
      plan(run, T + 360, first, [
        { stopIndex: 0, arrival: T + 680, departure: T + 680, cancelled: true },
        { stopIndex: 1, arrival: T + 710, departure: T + 740, cancelled: true },
        { stopIndex: 2, arrival: T + 800, departure: T + 800, cancelled: true },
        { stopIndex: 3, arrival: T + 771, departure: T + 830, cancelled: false },
        { stopIndex: 4, arrival: T + 1440, departure: T + 1440, cancelled: false },
      ]),
    );
    expect(stopOf(capped, 2)).toMatchObject({ cancelled: true, arrival: T + 771 });
    const now = T + 780;
    const next = planned(
      plan(run, now, capped, [
        { stopIndex: 0, arrival: T + 680, departure: T + 680, cancelled: true },
        { stopIndex: 1, arrival: T + 710, departure: T + 740, cancelled: true },
        { stopIndex: 2, arrival: T + 790, departure: T + 800, cancelled: false },
        { stopIndex: 3, arrival: T + 850, departure: T + 880, cancelled: false },
        { stopIndex: 4, arrival: T + 1440, departure: T + 1440, cancelled: false },
      ]),
    );
    expect(stopOf(next, 2)).toMatchObject({ cancelled: true, arrival: T + 771 });
    expect(stopOf(next, 3)).toMatchObject({ cancelled: false, arrival: T + 771 });
    expect(targetAt(run, next, now)).toBeGreaterThanOrEqual(14_000 - 1e-6);
    const record = tripRecordOf(KEY, run, next);
    expect(backwards(record.stops)).toEqual([]);
    expect(() => encode(record, now)).not.toThrow();
  });

  it("case C: a served stop reached and dwelling keeps 1200 when the stop before it is served again", () => {
    const run = staticRun(
      [T, T + 600, T + 1200, T + 1800],
      [T + 60, T + 600, T + 1500, T + 1800],
      [0, 10_000, 20_000, 30_000],
    );
    const published = planned(plan(run, T + 30, null, innerCancelled));
    const now = T + 1300;
    expect(targetAt(run, published, now)).toBeCloseTo(20_000, 3);
    const next = planned(
      plan(run, now, published, [
        { stopIndex: 1, arrival: T + 1310, departure: T + 1320, cancelled: false },
        { stopIndex: 2, arrival: T + 1400, departure: T + 1500, cancelled: false },
      ]),
    );
    expect(stopOf(next, 1).cancelled).toBe(true);
    expect(stopOf(next, 2)).toMatchObject({ cancelled: false, arrival: T + 1200 });
    expect(targetAt(run, next, now)).toBeCloseTo(20_000, 3);
    expect(setBack(run, published, next, now)).toEqual([]);
  });

  it("case E: a served stop the train is dwelling at stays served when the source cancels it", () => {
    const run = staticRun(
      [T, T + 600, T + 1200, T + 1800],
      [T + 60, T + 900, T + 1260, T + 1800],
      [0, 10_000, 20_000, 30_000],
    );
    const published = planned(plan(run, T + 30, null, []));
    const now = T + 700;
    expect(targetAt(run, published, now)).toBeCloseTo(10_000, 3);
    const next = planned(
      plan(run, now, published, [
        { stopIndex: 1, arrival: null, departure: null, cancelled: true },
        { stopIndex: 2, arrival: T + 1200, departure: T + 1260, cancelled: false },
      ]),
    );
    expect(stopOf(next, 1)).toMatchObject({ cancelled: false, arrival: T + 600 });
    expect(targetAt(run, next, now)).toBeCloseTo(10_000, 3);
    expect(setBack(run, published, next, now)).toEqual([]);
  });

  it("case D: a stop still cancelled keeps its passed pass time when the next stop is delayed", () => {
    const rows: RowSpec[] = [
      { stopIndex: 1, arrival: T + 600, departure: T + 600, cancelled: true },
      { stopIndex: 2, arrival: T + 1800, departure: T + 1860, cancelled: false },
    ];
    for (const holdRule of [false, true]) {
      const published = planned(plan(inner, T + 30, null, innerCancelled, holdRule));
      const now = T + 700;
      const next = planned(plan(inner, now, published, rows, holdRule));
      expect(stopOf(next, 1)).toMatchObject({
        cancelled: true,
        arrival: T + 630,
        departure: T + 630,
      });
      const record = tripRecordOf(KEY, inner, next);
      expect(backwards(record.stops)).toEqual([]);
    }
  });

  it("keeps a passed pass time of a stop still cancelled, so the plan does not move with now", () => {
    const run = staticRun(
      [T + 680, T + 710, T + 800, T + 860, T + 1500],
      [T + 680, T + 740, T + 800, T + 900, T + 1500],
      [0, 4_000, 9_000, 14_000, 40_000],
    );
    const rows: RowSpec[] = [
      { stopIndex: 0, arrival: T + 680, departure: T + 680, cancelled: true },
      { stopIndex: 1, arrival: T + 710, departure: T + 740, cancelled: true },
      { stopIndex: 2, arrival: T + 800, departure: T + 800, cancelled: true },
      { stopIndex: 3, arrival: T + 771, departure: T + 830, cancelled: false },
      { stopIndex: 4, arrival: T + 1440, departure: T + 1440, cancelled: false },
    ];
    const first = plan(run, T + 300, null, []);
    if (first.kind !== "plan") throw new Error(first.kind);
    const capped = plan(run, T + 360, first.plan, rows);
    if (capped.kind !== "plan") throw new Error(capped.kind);
    const later = plan(run, T + 700, capped.plan, rows);
    if (later.kind !== "plan") throw new Error(later.kind);
    expect(later.plan.stops).toEqual(capped.plan.stops);
    expect(mustEmit(capped.plan, later.plan)).toBe(false);
  });

  it("never moves a reached served stop nor sets the train back (property)", () => {
    fc.assert(
      fc.property(scenario(fc.integer({ min: 0, max: 15_000 })), (sc) => {
        const run = staticRun(sc.arrivals, sc.departures, sc.arcs, sc.passThrough);
        let published: LivePlan | null = null;
        sc.times.forEach((now, i) => {
          const rows = sc.snapshots[Math.min(i, sc.snapshots.length - 1)] as RowSpec[];
          const outcome = plan(run, now, published, rows);
          if (outcome.kind !== "plan") {
            published = null;
            return;
          }
          if (published) expect(setBack(run, published, outcome.plan, now)).toEqual([]);
          published = outcome.plan;
        });
      }),
      { numRuns: 3_000 },
    );
  });

  it("never sets the train back when a stop just behind a reached stop is served again (property)", () => {
    const uncancel = fc.integer({ min: 3, max: 8 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        runs: fc.array(fc.integer({ min: 60, max: 1_800 }), { minLength: n, maxLength: n }),
        dwells: fc.array(fc.integer({ min: 0, max: 600 }), { minLength: n, maxLength: n }),
        k: fc.integer({ min: 0, max: n - 2 }),
        source: fc.record({ arrival: rowOffset, departure: rowOffset }),
        laterDelay: fc.integer({ min: -300, max: 1_800 }),
        at: fc.integer({ min: -120, max: 900 }),
        holdRule: fc.boolean(),
      }),
    );
    fc.assert(
      fc.property(uncancel, (u) => checkUncancel(u)),
      { numRuns: 3_000 },
    );
  });
});

interface Uncancel {
  readonly n: number;
  readonly runs: readonly number[];
  readonly dwells: readonly number[];
  readonly k: number;
  readonly source: { readonly arrival: number | null; readonly departure: number | null };
  readonly laterDelay: number;
  readonly at: number;
  readonly holdRule: boolean;
}

function uncancelRun(u: Uncancel): { run: StaticRun; arrivals: number[]; departures: number[] } {
  const arrivals: number[] = [];
  const departures: number[] = [];
  let t = T;
  u.runs.forEach((runTime, j) => {
    t += j === 0 ? 0 : runTime;
    arrivals.push(t);
    t += j === 0 || j === u.n - 1 ? 0 : (u.dwells[j] as number);
    departures.push(t);
  });
  const run = staticRun(
    arrivals,
    departures,
    arrivals.map((_, j) => j * 5_000),
  );
  return { run, arrivals, departures };
}

/** Cancels stop k, then serves it again once the train has reached stop k + 1 (or about then). */
function checkUncancel(u: Uncancel): void {
  const { run, arrivals, departures } = uncancelRun(u);
  const k = u.k;
  const offset = (base: number, delta: number | null) => (delta === null ? null : base + delta);
  const before: RowSpec[] = [
    {
      stopIndex: k,
      arrival: arrivals[k] as number,
      departure: departures[k] as number,
      cancelled: true,
    },
  ];
  const after: RowSpec[] = [
    {
      stopIndex: k,
      arrival: offset(arrivals[k] as number, u.source.arrival),
      departure: offset(departures[k] as number, u.source.departure),
      cancelled: false,
    },
    {
      stopIndex: k + 1,
      arrival: (arrivals[k + 1] as number) + u.laterDelay,
      departure: (departures[k + 1] as number) + u.laterDelay,
      cancelled: false,
    },
  ];
  const published = plan(run, T - 300, null, before, u.holdRule);
  if (published.kind !== "plan") return;
  const now = (arrivals[k + 1] as number) + u.at;
  const steps = [arrivals[k + 1] as number, now].filter((x) => x > T - 300).sort((a, b) => a - b);
  let current = published.plan;
  for (const step of steps) {
    const outcome = plan(run, step, current, step === now ? after : before, u.holdRule);
    if (outcome.kind !== "plan") return;
    expect(setBack(run, current, outcome.plan, step)).toEqual([]);
    expect(backwards(tripRecordOf(KEY, run, outcome.plan).stops)).toEqual([]);
    current = outcome.plan;
  }
}
