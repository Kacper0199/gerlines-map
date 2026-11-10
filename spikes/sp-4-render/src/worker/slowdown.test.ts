import { describe, expect, it } from "vitest";
import { busyWait, slowdownWaitMs } from "./slowdown.ts";

describe("slowdownWaitMs", () => {
  it("waits (slowdown - 1) times the measured first pass", () => {
    expect(slowdownWaitMs(4.8, 4)).toBeCloseTo(14.4);
    expect(slowdownWaitMs(2, 2)).toBe(2);
  });

  it("does not wait without a slowdown or without a measurement", () => {
    expect(slowdownWaitMs(5, 1)).toBe(0);
    expect(slowdownWaitMs(5, 0.5)).toBe(0);
    expect(slowdownWaitMs(-1, 4)).toBe(0);
    expect(slowdownWaitMs(Number.NaN, 4)).toBe(0);
  });
});

describe("busyWait", () => {
  it("spins until the clock passes the deadline", () => {
    let clock = 100;
    const reads: number[] = [];
    busyWait(5, () => {
      reads.push(clock);
      clock += 1;
      return clock - 1;
    });
    expect(reads.length).toBeGreaterThanOrEqual(6);
    expect(clock - 100).toBeGreaterThanOrEqual(5);
  });

  it("returns at once for a zero duration", () => {
    let reads = 0;
    busyWait(0, () => {
      reads++;
      return 10;
    });
    expect(reads).toBe(2);
  });
});
