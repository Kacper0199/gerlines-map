import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrainDetail, TrainStop } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { composeDetail } from "./compose.ts";

const FIXTURE = join(
  import.meta.dirname,
  "../../../../services/live/src/detail/fixtures/ice-619-realtime.json",
);
const ICE = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { detail: TrainDetail }).detail;

function stop(
  index: number,
  [arrival, departure]: readonly [string | null, string | null],
  [arrivalDelay, departureDelay]: readonly [number | null, number | null],
): TrainStop {
  const shifted = (at: string | null, delay: number | null) =>
    at === null || delay === null ? null : new Date(Date.parse(at) + delay * 1000).toISOString();
  return {
    index,
    stopPlaceId: ICE.destination.stopPlaceId,
    name: `Stop ${index}`,
    scheduledArrival: arrival,
    scheduledDeparture: departure,
    predictedArrival: shifted(arrival, arrivalDelay),
    predictedDeparture: shifted(departure, departureDelay),
    arrivalDelaySeconds: arrivalDelay,
    departureDelaySeconds: departureDelay,
    platformScheduled: null,
    platformActual: null,
    cancelled: false,
    prediction: "explicit",
  };
}

const STOPS = [
  stop(0, [null, "2026-10-27T02:00:00.000Z"], [null, 0]),
  stop(1, ["2026-10-27T02:20:00.000Z", "2026-10-27T02:22:00.000Z"], [240, 300]),
  stop(2, ["2026-10-27T02:40:00.000Z", null], [180, null]),
];

function stored(fields: Partial<TrainDetail>): TrainDetail {
  return {
    ...ICE,
    asOf: "2026-10-27T02:24:00.000Z",
    stops: STOPS,
    progress: { lastPassedIndex: 1, nextIndex: 2 },
    forecast: null,
    delaySeconds: 300,
    delayBasis: "stop",
    currentDelaySeconds: 60,
    ...fields,
  };
}

function served(detail: TrainDetail, confirmed: string): TrainDetail | null {
  return composeDetail({ detail: JSON.stringify(detail), confirmed, feeds: {} });
}

describe("composeDetail head delay", () => {
  it("moves the head from the stop it stood at to the next stop's arrival once the train left", () => {
    const detail = served(stored({}), "2026-10-27T02:30:00.000Z");
    expect(detail?.progress).toEqual({ lastPassedIndex: 1, nextIndex: 2 });
    expect(detail?.delaySeconds).toBe(180);
    expect(detail?.delayBasis).toBe("stop");
    expect(detail?.delaySeconds).toBe(detail?.stops[2]?.arrivalDelaySeconds);
  });

  it("keeps the departure delay while the train still stands at the stop", () => {
    expect(served(stored({}), "2026-10-27T02:25:00.000Z")?.delaySeconds).toBe(300);
  });

  it("falls back to the stored tick delay, marked as the delay now", () => {
    const bare = STOPS.map((s) =>
      s.index === 2 ? stop(2, ["2026-10-27T02:40:00.000Z", null], [null, null]) : s,
    );
    const detail = served(stored({ stops: bare }), "2026-10-27T02:30:00.000Z");
    expect([detail?.delaySeconds, detail?.delayBasis]).toEqual([60, "current"]);
  });

  it("serves a detail an older writer stored with its delay as stored", () => {
    const { delayBasis: _, currentDelaySeconds: __, ...older } = stored({ delaySeconds: 420 });
    const detail = served(older as TrainDetail, "2026-10-27T02:30:00.000Z");
    expect(detail?.delaySeconds).toBe(420);
    expect(detail?.delayBasis).toBeUndefined();
  });
});
