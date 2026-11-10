import { describe, expect, it } from "vitest";
import { percentile, summarize } from "./stats.ts";

describe("percentile", () => {
  it("interpolates between neighbours", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 1)).toBe(40);
  });

  it("is NaN for an empty sample", () => {
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe("summarize", () => {
  it("sorts its input and reports the tail", () => {
    const summary = summarize([16.7, 16.6, 50, 16.7, 16.8]);
    expect(summary.count).toBe(5);
    expect(summary.p50).toBeCloseTo(16.7);
    expect(summary.max).toBe(50);
    expect(summary.p95).toBeGreaterThan(30);
  });
});
