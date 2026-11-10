import { describe, expect, it } from "vitest";
import type { TrainStop } from "./train-detail.ts";
import { headDelay, laterProgress, progressAt, servedProgress } from "./train-progress.ts";

function stop(index: number, arrival: string | null, departure: string | null): TrainStop {
  return {
    index,
    stopPlaceId: "6f1c2a1e-1a52-4c8e-9a3b-0d6a2f4c1b01",
    name: `Stop ${index}`,
    scheduledArrival: arrival,
    scheduledDeparture: departure,
    predictedArrival: null,
    predictedDeparture: null,
    arrivalDelaySeconds: null,
    departureDelaySeconds: null,
    platformScheduled: null,
    platformActual: null,
    cancelled: false,
    prediction: null,
  };
}

const stops = [
  stop(0, null, "2026-10-27T02:10:00Z"),
  stop(1, "2026-10-27T02:20:00Z", "2026-10-27T02:22:00Z"),
  stop(2, "2026-10-27T02:34:00Z", "2026-10-27T02:39:00Z"),
  stop(3, "2026-10-27T03:38:00Z", null),
];

describe("servedProgress", () => {
  it("moves on with the served time when the stored progress is behind", () => {
    const stored = { lastPassedIndex: 0, nextIndex: 1 };
    expect(servedProgress(stored, stops, Date.parse("2026-10-27T02:35:00Z"))).toEqual({
      lastPassedIndex: 2,
      nextIndex: 3,
    });
  });

  it("keeps the engine's progress when it is ahead of the source's times", () => {
    const stored = { lastPassedIndex: 2, nextIndex: 3 };
    const at = Date.parse("2026-10-27T02:29:00Z");
    expect(progressAt(stops, at)).toEqual({ lastPassedIndex: 1, nextIndex: 2 });
    expect(servedProgress(stored, stops, at)).toEqual(stored);
  });

  it("never steps back when a forecast moves a reached stop later", () => {
    const stored = { lastPassedIndex: 3, nextIndex: null };
    expect(servedProgress(stored, stops, Date.parse("2026-10-27T03:30:00Z"))).toEqual(stored);
  });

  it("never names a cancelled stop as the next one", () => {
    const shortTurned = stops.map((entry) =>
      entry.index >= 2 ? { ...entry, cancelled: true } : entry,
    );
    const at = Date.parse("2026-10-27T02:25:00Z");
    expect(servedProgress({ lastPassedIndex: 1, nextIndex: 3 }, shortTurned, at)).toEqual({
      lastPassedIndex: 1,
      nextIndex: null,
    });
    const skipped = stops.map((entry) =>
      entry.index === 2 ? { ...entry, cancelled: true } : entry,
    );
    expect(servedProgress({ lastPassedIndex: 1, nextIndex: 2 }, skipped, at)).toEqual({
      lastPassedIndex: 1,
      nextIndex: 3,
    });
  });

  it("ranks no stop reached below any stop reached", () => {
    const none = { lastPassedIndex: null, nextIndex: 0 };
    const first = { lastPassedIndex: 0, nextIndex: 1 };
    expect(laterProgress(none, first)).toBe(first);
    expect(laterProgress(first, none)).toBe(first);
    expect(laterProgress(first, { lastPassedIndex: 0, nextIndex: 2 })).toBe(first);
  });
});

describe("headDelay", () => {
  const P = "2026-10-27T02:20:00Z";
  const delayed = (
    base: TrainStop,
    arrival: number | null,
    departure: number | null,
  ): TrainStop => ({
    ...base,
    arrivalDelaySeconds: arrival,
    departureDelaySeconds: departure,
    predictedArrival: base.scheduledArrival,
    predictedDeparture: base.scheduledDeparture,
  });
  const run = [
    delayed(stops[0] as TrainStop, null, 60),
    delayed(stops[1] as TrainStop, 240, 300),
    delayed(stops[2] as TrainStop, 180, 180),
    delayed(stops[3] as TrainStop, -60, null),
  ];
  const head = (
    progress: { lastPassedIndex: number | null; nextIndex: number | null },
    at: string,
    list: readonly TrainStop[] = run,
    current: number | null = 60,
  ) => headDelay({ stops: list, progress, asOf: Date.parse(at), realtime: true, current });

  it("takes the departure delay while the train stands at a stop", () => {
    expect(head({ lastPassedIndex: 1, nextIndex: 2 }, "2026-10-27T02:21:00Z")).toEqual({
      delaySeconds: 300,
      delayBasis: "stop",
    });
  });

  it("takes the next stop's arrival delay once the train has left", () => {
    expect(head({ lastPassedIndex: 1, nextIndex: 2 }, "2026-10-27T02:23:00Z")).toEqual({
      delaySeconds: 180,
      delayBasis: "stop",
    });
  });

  it("keeps a negative delay and a delay of zero as the stop's", () => {
    expect(head({ lastPassedIndex: 2, nextIndex: 3 }, "2026-10-27T03:00:00Z")).toEqual({
      delaySeconds: -60,
      delayBasis: "stop",
    });
    const zero = run.map((stop) => (stop.index === 2 ? delayed(stop, 0, 0) : stop));
    expect(head({ lastPassedIndex: 1, nextIndex: 2 }, "2026-10-27T02:30:00Z", zero)).toEqual({
      delaySeconds: 0,
      delayBasis: "stop",
    });
  });

  it("takes the last stop's arrival delay at the end of the run", () => {
    expect(head({ lastPassedIndex: 3, nextIndex: null }, "2026-10-27T03:40:00Z")).toEqual({
      delaySeconds: -60,
      delayBasis: "stop",
    });
  });

  it("never reads a cancelled stop as the stop passed", () => {
    const cancelled = run.map((stop) =>
      stop.index === 1
        ? { ...stop, cancelled: true, arrivalDelaySeconds: null, departureDelaySeconds: null }
        : stop,
    );
    expect(head({ lastPassedIndex: 1, nextIndex: 2 }, P, cancelled)).toEqual({
      delaySeconds: 180,
      delayBasis: "stop",
    });
  });

  it("falls back to the current delay, marked so, and to nothing without one", () => {
    const bare = run.map((stop) => (stop.index === 2 ? delayed(stop, null, null) : stop));
    expect(head({ lastPassedIndex: 1, nextIndex: 2 }, "2026-10-27T02:30:00Z", bare)).toEqual({
      delaySeconds: 60,
      delayBasis: "current",
    });
    expect(head({ lastPassedIndex: 1, nextIndex: 2 }, "2026-10-27T02:30:00Z", bare, null)).toEqual({
      delaySeconds: null,
      delayBasis: null,
    });
  });

  it("reads no stop delay without realtime", () => {
    const progress = { lastPassedIndex: 1, nextIndex: 2 };
    const asOf = Date.parse("2026-10-27T02:30:00Z");
    expect(headDelay({ stops: run, progress, asOf, realtime: false, current: 60 })).toEqual({
      delaySeconds: 60,
      delayBasis: "current",
    });
  });
});
