import { describe, expect, it } from "vitest";
import { ARCHITECTURE_THRESHOLDS, tierPlan } from "./lod.ts";

const tiersAt = (zoom: number) =>
  tierPlan(zoom, ARCHITECTURE_THRESHOLDS).map((entry) => entry.tier);

describe("tierPlan", () => {
  it("shows one tier away from the thresholds", () => {
    expect(tiersAt(6)).toEqual(["dots"]);
    expect(tiersAt(11)).toEqual(["icons"]);
    expect(tiersAt(13.5)).toEqual(["slices"]);
    expect(tiersAt(16)).toEqual(["cars"]);
  });

  it("crossfades over half a zoom level around a threshold", () => {
    expect(tiersAt(9)).toEqual(["dots", "icons"]);
    const plan = tierPlan(9, ARCHITECTURE_THRESHOLDS);
    expect(plan[0]?.opacity).toBeCloseTo(0.5);
    expect(plan[1]?.opacity).toBeCloseTo(0.5);
    expect(tiersAt(8.74)).toEqual(["dots"]);
    expect(tiersAt(9.26)).toEqual(["icons"]);
  });

  it("switches hard at the threshold when the crossfade is zero", () => {
    const hard = { ...ARCHITECTURE_THRESHOLDS, crossfadeZoom: 0 };
    const plan = (zoom: number) => tierPlan(zoom, hard);
    expect(plan(8.99)).toEqual([{ tier: "dots", opacity: 1 }]);
    expect(plan(9)).toEqual([{ tier: "icons", opacity: 1 }]);
    expect(plan(12.5)).toEqual([{ tier: "slices", opacity: 1 }]);
    expect(plan(14.5)).toEqual([{ tier: "cars", opacity: 1 }]);
  });

  it("never produces NaN opacities, even for a zero or negative crossfade", () => {
    for (const crossfadeZoom of [0, -1]) {
      const thresholds = { ...ARCHITECTURE_THRESHOLDS, crossfadeZoom };
      for (const zoom of [0, 8.99, 9, 9.01, 12.5, 14.5, 20]) {
        const plan = tierPlan(zoom, thresholds);
        expect(plan.length).toBe(1);
        for (const entry of plan) expect(Number.isNaN(entry.opacity)).toBe(false);
      }
    }
  });
});
