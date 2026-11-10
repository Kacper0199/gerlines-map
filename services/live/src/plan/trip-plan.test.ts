import { describe, expect, it } from "vitest";
import type { StaticRun } from "../model.ts";
import type { ForecastRow, SourceView } from "../realtime/store.ts";
import { placesWithin, type SameStation } from "./place-rows.ts";
import {
  buildPlan,
  createPlanStats,
  type LivePlan,
  motionOfPlan,
  mustEmit,
  nextWake,
  type PlanOutcome,
  placeHoldPoints,
  targetOf,
  tripRecordOf,
} from "./trip-plan.ts";

const T = 1_793_000_000;
const PLACES = ["p0", "p1", "p2", "p3"];

function run(extra: Partial<StaticRun> = {}): StaticRun {
  return {
    instanceId: "00000000-0000-5000-8000-000000000001",
    serviceDate: "2026-10-25",
    feedVersionId: 1,
    tripKey: "t1",
    category: "reg",
    categoryCode: "reg",
    foreign: false,
    line: "RE 1",
    trainNumber: 4711,
    shortName: "4711",
    operatorId: null,
    patternId: "p",
    stopPlaces: PLACES,
    arrivals: Float64Array.from([T - 60, T + 600, T + 1500, T + 2400]),
    departures: Float64Array.from([T, T + 660, T + 1560, T + 2400]),
    passThrough: new Uint8Array(4),
    shape: {
      shapeNo: 17,
      hash: "ab".repeat(32),
      length: 60_000,
      stopArcs: Float64Array.from([1000, 16_000, 32_000, 50_000]),
      qaStatus: "pass",
    },
    gap: null,
    ...extra,
  };
}

function row(stopIndex: number, delay: number, extra: Partial<ForecastRow> = {}): ForecastRow {
  const r = run();
  return {
    instanceId: r.instanceId,
    serviceDate: r.serviceDate,
    stopIndex,
    sourceId: "delfi-gtfs-rt",
    observedAt: T,
    predictedArrival: (r.arrivals[stopIndex] as number) + delay,
    predictedDeparture: (r.departures[stopIndex] as number) + delay,
    arrivalDelay: delay,
    departureDelay: delay,
    cancelled: false,
    explicit: true,
    stopPlaceId: PLACES[stopIndex] as string,
    ...extra,
  };
}

function source(rows: ForecastRow[]): SourceView {
  return {
    sourceId: "delfi-gtfs-rt",
    firstSeen: T,
    lastSeen: T,
    stops: new Map(rows.map((r) => [r.stopIndex, r])),
  };
}

function plan(outcome: PlanOutcome): LivePlan {
  if (outcome.kind !== "plan") throw new Error(`expected a plan, got ${outcome.kind}`);
  return outcome.plan;
}

function build(
  now: number,
  published: LivePlan | null,
  rows: ForecastRow[] = [],
  extra: Partial<StaticRun> = {},
  holdRule = true,
  sameStation?: SameStation,
) {
  const r = run(extra);
  const stats = createPlanStats();
  const outcome = buildPlan({
    run: r,
    source: rows.length ? source(rows) : undefined,
    now,
    published,
    publishedMotion: published ? motionOfPlan(published, r) : null,
    holdRule,
    stats,
    sameStation,
  });
  return { outcome, stats, run: r };
}

describe("buildPlan", () => {
  it("plans a timetable-only trip from its origin before departure", () => {
    const p = plan(build(T - 300, null).outcome);
    expect(p.stops.map((s) => s.stopIndex)).toEqual([0, 1, 2, 3]);
    expect(p.realtime).toBe(false);
    expect(p.delay).toBeNull();
    expect(p.stops[0]).toMatchObject({ arrival: T - 60, departure: T, s: 1000 });
  });

  it("drops stops behind the train once it departs and freezes the departed stop", () => {
    const first = plan(build(T - 300, null).outcome);
    const second = plan(build(T + 700, first).outcome);
    expect(second.stops.map((s) => s.stopIndex)).toEqual([1, 2, 3]);
    expect(mustEmit(first, second)).toBe(true);
  });

  it("takes predictions, sets the realtime flag and the delay at the next stop", () => {
    const p = plan(
      build(T - 300, null, [row(0, 0), row(1, 120), row(2, 120), row(3, 120)]).outcome,
    );
    expect(p.realtime).toBe(true);
    expect(p.delay).toBe(0);
    expect(p.stops[1]).toMatchObject({ arrival: T + 720, realtime: true });
  });

  it("holds at the approach when a delay arrives mid-leg, keeping the target in place", () => {
    const published = plan(build(T - 300, null).outcome);
    const now = T + 300;
    const {
      outcome,
      run: r,
      stats,
    } = build(now, published, [row(1, 240), row(2, 240), row(3, 240)]);
    const next = plan(outcome);
    expect(stats.holds.hold).toBe(1);
    expect(next.stops.map((s) => s.stopIndex)).toEqual([0, -1, 1, 2, 3]);
    const before = targetOf(motionOfPlan(published, r) as never, now);
    const after = targetOf(motionOfPlan(next, r) as never, now);
    expect(Math.abs(after - before)).toBeLessThan(0.01);
    const record = tripRecordOf(5, r, next);
    expect(record.stops.every((stop) => stop.s !== null)).toBe(true);
    expect(record.firstStop).toBe(0);
  });

  it("refits with a plain plan when the hold rule is off or the train is early", () => {
    const published = plan(build(T - 300, null).outcome);
    const off = build(T + 300, published, [row(1, 240)], {}, false);
    expect(plan(off.outcome).stops.map((s) => s.stopIndex)).toEqual([0, 1, 2, 3]);
    expect(off.stats.holds.refit).toBe(1);
    const early = build(T + 300, published, [row(1, -120)]);
    expect(plan(early.outcome).stops[1]?.arrival).toBe(T + 480);
    expect(early.stats.holds.refit).toBe(1);
  });

  it("keeps the published leg for changes under 15 s", () => {
    const published = plan(build(T - 300, null).outcome);
    const next = plan(build(T + 300, published, [row(1, 10), row(2, 10), row(3, 10)]).outcome);
    expect(next.stops[1]?.arrival).toBe(T + 600);
    expect(mustEmit(published, next)).toBe(true);
    const quiet = plan(build(T + 300, published, [row(1, 10, { explicit: false })]).outcome);
    expect(quiet.realtime).toBe(true);
  });

  it("keeps a cancelled stop with an interpolated pass time", () => {
    const p = plan(build(T - 300, null, [row(2, 0, { cancelled: true })]).outcome);
    const stop = p.stops[2];
    expect(stop?.cancelled).toBe(true);
    const share = (32_000 - 16_000) / (50_000 - 16_000);
    expect(stop?.arrival).toBe(Math.round(T + 660 + share * (T + 2400 - (T + 660))));
    expect(stop?.departure).toBe(stop?.arrival);
  });

  it("treats a trip whose every stop is cancelled as cancelled", () => {
    const rows = [0, 1, 2, 3].map((j) => row(j, 0, { cancelled: true }));
    expect(build(T - 300, null, rows).outcome.kind).toBe("cancelled");
  });

  it("repairs predictions that go backwards and counts them", () => {
    const { outcome, stats } = build(T - 300, null, [
      row(1, 0, { predictedArrival: T + 600, predictedDeparture: T + 590 }),
    ]);
    const p = plan(outcome);
    expect(p.stops[1]?.departure).toBeGreaterThanOrEqual(p.stops[1]?.arrival as number);
    expect(stats.repairs).toBeGreaterThan(0);
  });

  it("ignores a prediction for another stop place at another planned time", () => {
    const { outcome, stats } = build(T - 300, null, [
      row(1, 300, { stopPlaceId: "elsewhere", arrivalDelay: 240, departureDelay: 240 }),
    ]);
    expect(plan(outcome).stops[1]?.arrival).toBe(T + 600);
    expect(stats.placeMismatches).toBe(1);
  });

  it("takes a prediction for a renamed stop place at the same planned time", () => {
    const { outcome, stats } = build(T - 300, null, [row(1, 300, { stopPlaceId: "renamed" })]);
    expect(plan(outcome).stops[1]?.arrival).toBe(T + 900);
    expect(stats).toMatchObject({ placeMismatches: 0, placesRealigned: 1, placesRenamed: 1 });
  });

  it("takes a renamed stop place 60 m from the stop and drops one 2 km away", () => {
    const sameStation = placesWithin(
      new Map([
        ["p1", { lon: 8, lat: 50 }],
        ["near", { lon: 8, lat: 50.00054 }],
        ["far", { lon: 8, lat: 50.018 }],
      ]),
    );
    const renamed = (place: string) =>
      build(T - 300, null, [row(1, 300, { stopPlaceId: place })], {}, true, sameStation);
    const near = renamed("near");
    expect(plan(near.outcome).stops[1]?.arrival).toBe(T + 900);
    expect(near.stats).toMatchObject({ placeMismatches: 0, placesRealigned: 1, placesRenamed: 1 });
    const far = renamed("far");
    expect(plan(far.outcome).stops[1]?.arrival).toBe(T + 600);
    expect(far.stats).toMatchObject({ placeMismatches: 1, placesRealigned: 0, placesRenamed: 0 });
    const unknown = renamed("unknown");
    expect(unknown.stats).toMatchObject({ placeMismatches: 1, placesRenamed: 0 });
  });

  it("aligns an inserted stop before a repeated place by planned time", () => {
    const loop = { stopPlaces: ["a", "b", "b", "c"] };
    const times = [T - 60, T + 600, T + 1500, T + 2400];
    const at = (j: number, place: string, planned: number, delay: number) =>
      row(j, 0, {
        stopIndex: j,
        stopPlaceId: place,
        predictedArrival: planned + delay,
        predictedDeparture: planned + delay,
        arrivalDelay: delay,
        departureDelay: delay,
      });
    const rows = [
      at(0, "a", T - 60, 0),
      at(1, "x", T + 300, 60),
      at(2, "b", times[1] as number, 120),
      at(3, "b", times[2] as number, 180),
      at(4, "c", times[3] as number, 240),
    ];
    const { outcome, stats } = build(T - 300, null, rows, {
      ...loop,
      arrivals: Float64Array.from(times),
      departures: Float64Array.from(times),
    });
    const stops = plan(outcome).stops;
    expect(stops.map((s) => s.arrival - (times[s.stopIndex] as number))).toEqual([
      0, 120, 180, 240,
    ]);
    expect(stats).toMatchObject({ placeMismatches: 1, placesRealigned: 3 });
  });

  it("places predictions folded on another timetable version by their stop places", () => {
    const at = (place: string, j: number, delay: number) =>
      row(j, 0, {
        stopPlaceId: place,
        predictedArrival: (run().arrivals[PLACES.indexOf(place)] as number) + delay,
        predictedDeparture: (run().departures[PLACES.indexOf(place)] as number) + delay,
        arrivalDelay: delay,
        departureDelay: delay,
      });
    const { outcome, stats } = build(T - 300, null, [
      at("p0", 0, 0),
      at("p2", 1, 300),
      at("p3", 2, 300),
    ]);
    const stops = plan(outcome).stops;
    expect(stops[1]?.arrival).toBe(T + 600);
    expect(stops[2]?.arrival).toBe(T + 1500 + 300);
    expect(stops[3]?.arrival).toBe(T + 2400 + 300);
    expect(stats.placeMismatches).toBe(0);
    expect(stats.placesRealigned).toBe(2);
  });

  it("skips a stop the other version has and this run lacks, and counts only that row", () => {
    const rows = [
      row(0, 0),
      row(1, 0, { stopPlaceId: "added", predictedArrival: T + 300, predictedDeparture: T + 330 }),
      row(2, 0, {
        stopPlaceId: "p1",
        predictedArrival: T + 600 + 120,
        predictedDeparture: T + 660 + 120,
      }),
    ];
    const { outcome, stats } = build(T - 300, null, rows);
    expect(plan(outcome).stops[1]?.arrival).toBe(T + 720);
    expect(stats.placeMismatches).toBe(1);
    expect(stats.placesRealigned).toBe(1);
  });

  it("keeps the order of a repeated stop place when realigning, and drops rows without a place", () => {
    const loop = { stopPlaces: ["a", "b", "c", "b"] };
    const rows = [
      row(1, 0, { stopPlaceId: "a", predictedArrival: T - 60, predictedDeparture: T }),
      row(2, 0, { stopPlaceId: "b", predictedArrival: T + 720, predictedDeparture: T + 780 }),
      row(3, 0, {
        stopPlaceId: "b",
        predictedArrival: T + 2400 + 200,
        predictedDeparture: T + 2400 + 200,
      }),
      row(0, 900, { stopPlaceId: null }),
    ];
    const { outcome, stats } = build(T - 300, null, rows, loop);
    const stops = plan(outcome).stops;
    expect(stops[0]).toMatchObject({ arrival: T - 60, departure: T });
    expect(stops[1]?.arrival).toBe(T + 720);
    expect(stops[3]?.arrival).toBe(T + 2400 + 200);
    expect(stats.placeMismatches).toBe(1);
    expect(stats.placesRealigned).toBe(2);
  });

  it("puts a ring trip's last row on its last visit, never on the origin", () => {
    const ring = { stopPlaces: ["s", "a", "b", "s"] };
    const final = row(3, 0, {
      stopIndex: 4,
      stopPlaceId: "s",
      predictedArrival: T + 2400 + 300,
      predictedDeparture: T + 2400 + 300,
      arrivalDelay: 300,
      departureDelay: 300,
    });
    const { outcome, stats } = build(T - 300, null, [final], ring);
    const stops = plan(outcome).stops;
    expect(stops[0]).toMatchObject({ arrival: T - 60, departure: T });
    expect(stops[3]?.arrival).toBe(T + 2400 + 300);
    expect(stats.placesRealigned).toBe(1);
    expect(stats.placeMismatches).toBe(0);
  });

  it("puts sparse rows of a loop trip on the visit nearest their shifted index", () => {
    const loop = { stopPlaces: ["a", "b", "c", "b"] };
    const second = row(3, 0, {
      stopIndex: 4,
      stopPlaceId: "b",
      predictedArrival: T + 2400 + 120,
      predictedDeparture: T + 2400 + 120,
      arrivalDelay: 120,
      departureDelay: 120,
    });
    const { outcome, stats } = build(T - 300, null, [second], loop);
    const stops = plan(outcome).stops;
    expect(stops[1]).toMatchObject({ arrival: T + 600, departure: T + 660 });
    expect(stops[3]?.arrival).toBe(T + 2400 + 120);
    expect(stats.placesRealigned).toBe(1);
  });

  it("drops a row equally near two visits of its place instead of guessing", () => {
    const loop = { stopPlaces: ["b", "a", "b", "c"] };
    const { outcome, stats } = build(T - 300, null, [row(1, 600, { stopPlaceId: "b" })], loop);
    const stops = plan(outcome).stops;
    expect(stops[0]?.departure).toBe(T);
    expect(stops[2]?.arrival).toBe(T + 1500);
    expect(stats.placeMismatches).toBe(1);
  });

  it("drops one stray row of a same-version source and keeps the others by index", () => {
    const rows = [
      row(0, 0),
      row(1, 120),
      row(2, 120, { stopPlaceId: "p3" }),
      row(3, 300, { stopPlaceId: null }),
    ];
    const { outcome, stats } = build(T - 300, null, rows);
    const stops = plan(outcome).stops;
    expect(stops[2]?.arrival).toBe(T + 1500 + 120);
    expect(stops[3]?.arrival).toBe(T + 2400 + 300);
    expect(stats.placeMismatches).toBe(1);
    expect(stats.placesRealigned).toBe(0);
  });

  it("takes rows of the same version by index, also at a repeated stop place", () => {
    const loop = { stopPlaces: ["a", "b", "c", "b"] };
    const { outcome, stats } = build(T - 300, null, [row(3, 200, { stopPlaceId: "b" })], loop);
    expect(plan(outcome).stops[3]?.arrival).toBe(T + 2400 + 200);
    expect(plan(outcome).stops[1]?.arrival).toBe(T + 600);
    expect(stats.placesRealigned).toBe(0);
  });

  it("ends 30 s after the last arrival", () => {
    const published = plan(build(T + 2000, null).outcome);
    expect(build(T + 2400 + 29, published).outcome.kind).toBe("plan");
    expect(build(T + 2400 + 30, published).outcome.kind).toBe("ended");
  });

  it("wakes at the next departure", () => {
    const p = plan(build(T - 300, null).outcome);
    expect(nextWake(p, T - 300)).toBe(T);
    expect(nextWake(p, T + 1600)).toBe(T + 2430);
  });
});

describe("placeHoldPoints", () => {
  const station = (stopIndex: number, s: number) => ({ stopIndex, s });
  const hold = (s: number) => ({ stopIndex: -1, s });

  it("keeps stations in stop order even when their arcs fall", () => {
    const out = placeHoldPoints([station(0, 0), station(1, 500), station(2, 300), station(3, 900)]);
    expect(out.map((d) => d.stopIndex)).toEqual([0, 1, 2, 3]);
  });

  it("places a hold point by arc among the stations, ties keep their place", () => {
    const out = placeHoldPoints([station(4, 100), station(5, 400), hold(300), station(6, 800)]);
    expect(out.map((d) => [d.stopIndex, d.s])).toEqual([
      [4, 100],
      [-1, 300],
      [5, 400],
      [6, 800],
    ]);
    const tie = placeHoldPoints([station(4, 100), hold(400), station(5, 400)]);
    expect(tie.map((d) => d.stopIndex)).toEqual([4, -1, 5]);
  });
});

describe("mustEmit", () => {
  it("ignores moves under 15 s and emits from 15 s", () => {
    const base = plan(build(T - 300, null).outcome);
    const shift = (seconds: number): LivePlan => ({
      ...base,
      stops: base.stops.map((stop, i) =>
        i === 2
          ? { ...stop, arrival: stop.arrival + seconds, departure: stop.departure + seconds }
          : stop,
      ),
    });
    expect(mustEmit(base, shift(14))).toBe(false);
    expect(mustEmit(base, shift(15))).toBe(true);
    expect(mustEmit(base, { ...base, delay: 20 })).toBe(true);
  });
});
