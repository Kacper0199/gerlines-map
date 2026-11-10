import { describe, expect, it } from "vitest";
import { cubicBezier, easeOutDesign } from "./easing.ts";

describe("cubicBezier", () => {
  it("is linear for the linear control points", () => {
    const linear = cubicBezier(0, 0, 1, 1);

    for (const t of [0.1, 0.25, 0.5, 0.9]) {
      expect(linear(t)).toBeCloseTo(t, 5);
    }
  });

  it("matches the CSS ease curve at known points", () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);

    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
  });

  it("starts and ends exactly and rises monotonically for the design ease out", () => {
    expect(easeOutDesign(0)).toBe(0);
    expect(easeOutDesign(1)).toBe(1);
    let previous = 0;
    for (let step = 1; step <= 100; step += 1) {
      const value = easeOutDesign(step / 100);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(easeOutDesign(0.3)).toBeGreaterThan(0.6);
  });
});
