import { describe, expect, it } from "vitest";
import {
  PatternInterner,
  type PatternRow,
  passThroughOf,
  patternOf,
  type TripRow,
} from "./runs.ts";

const row = (stopArcs: number[], qaStatus = "pass"): PatternRow => ({
  trip_pattern_id: "1",
  stop_places: stopArcs.map((_, i) => `place-${i}`),
  shape_no: 7,
  shape_hash: "ab".repeat(32),
  length_m: 1000,
  end_m: 1000,
  stop_arc_m: stopArcs,
  qa_status: qaStatus,
});

describe("patternOf", () => {
  it("draws a passing shape whose stop arcs never fall", () => {
    expect(patternOf(row([0, 400, 400, 1000])).gap).toBeNull();
  });

  it("marks a shape whose stop arcs fall as low quality", () => {
    expect(patternOf(row([0, 500, 300, 1000])).gap).toBe("low_quality");
  });

  it("keeps the QA status of other shapes", () => {
    expect(patternOf(row([0, 1000], "unmeasured")).gap).toBe("unmeasured");
    expect(patternOf(row([0, 1000], "fail")).gap).toBe("low_quality");
  });
});

describe("PatternInterner", () => {
  it("shares stop place strings and the shape of one hash between patterns", () => {
    const interner = new PatternInterner();
    const a = patternOf(row([0, 1000]), interner);
    const b = patternOf({ ...row([0, 1000]), trip_pattern_id: "2" }, interner);
    expect(b.shape).toBe(a.shape);
    expect(b.stopPlaces[0]).toBe(a.stopPlaces[0]);
  });
});

describe("passThroughOf", () => {
  const trip = (arrivals: number[], departures: number[]): TripRow => ({
    trip_key: "t",
    trip_pattern_id: "1",
    short_name: "RB 20",
    category_code: "reg",
    is_foreign: false,
    line: "RB20",
    operator_id: null,
    arrivals,
    departures,
    pickups: [0, 1, 0],
    drop_offs: [0, 1, 0],
  });

  it("passes through a no-service stop without a dwell", () => {
    expect(Array.from(passThroughOf(trip([0, 60, 120], [0, 60, 120])))).toEqual([0, 1, 0]);
  });

  it("stands at a no-service stop with a scheduled dwell (a reversal)", () => {
    expect(Array.from(passThroughOf(trip([0, 60, 300], [0, 180, 300])))).toEqual([0, 0, 0]);
  });
});
