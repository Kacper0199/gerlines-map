import { describe, expect, it } from "vitest";
import { DrawCounter, mapDrawsPerSecondOf } from "./draws.ts";

describe("DrawCounter", () => {
  it("counts draws inside the window and converts them to a rate", () => {
    const counter = new DrawCounter();
    counter.note();
    counter.start(1000);
    for (let i = 0; i < 20; i++) counter.note();
    const result = counter.stop(2000);
    expect(result.mapDraws).toBe(20);
    expect(result.mapDrawsPerSecond).toBe(20);
  });

  it("ignores draws after stop and restarts from zero", () => {
    const counter = new DrawCounter();
    counter.start(0);
    counter.note();
    counter.stop(500);
    counter.note();
    counter.start(500);
    counter.note();
    counter.note();
    expect(counter.stop(1500).mapDraws).toBe(2);
  });

  it("reports zero draws for an empty window and survives a zero-length one", () => {
    const counter = new DrawCounter();
    counter.start(100);
    expect(counter.stop(100).mapDrawsPerSecond).toBe(0);
  });
});

describe("mapDrawsPerSecondOf", () => {
  it("prefers the counted rate", () => {
    expect(
      mapDrawsPerSecondOf({ probe: { windowMs: 30000, mapDrawsPerSecond: 55.5 }, gpuSamples: 1 }),
    ).toBe(55.5);
  });

  it("falls back to GPU samples per second for results recorded before the counter existed", () => {
    expect(mapDrawsPerSecondOf({ probe: { windowMs: 30002 }, gpuSamples: 900 })).toBeCloseTo(30, 1);
  });

  it("is null when neither source exists", () => {
    expect(mapDrawsPerSecondOf({ probe: { windowMs: 30000 } })).toBeNull();
    expect(mapDrawsPerSecondOf({ probe: { windowMs: 30000 }, gpuSamples: 0 })).toBeNull();
  });
});
