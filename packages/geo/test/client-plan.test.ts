import { describe, expect, it } from "vitest";
import {
  dynamicsFor,
  FRAME_CATEGORIES,
  type MotionStop,
  motionPlanOf,
} from "../src/client-plan.ts";
import { buildMotionPlan } from "../src/plan.ts";
import { CATEGORY_DYNAMICS } from "../src/profile.ts";

const stop = (s: number, arrival: number, departure: number, cancelled = false): MotionStop => ({
  s,
  arrival,
  departure,
  cancelled,
});

describe("dynamicsFor", () => {
  it("uses the kernel dynamics of every category the kernel knows", () => {
    for (const category of ["hsr", "ld", "night", "rfast", "reg", "sbahn"] as const) {
      expect(dynamicsFor(category)).toBe(CATEGORY_DYNAMICS[category]);
    }
  });

  it("falls back to regional dynamics for the other frame categories", () => {
    for (const category of ["unknown", "urban", "bus"] as const) {
      expect(dynamicsFor(category)).toBe(CATEGORY_DYNAMICS.reg);
    }
  });

  it("covers every frame category", () => {
    expect(FRAME_CATEGORIES).toHaveLength(9);
    for (const category of FRAME_CATEGORIES)
      expect(dynamicsFor(category).maxSpeed).toBeGreaterThan(0);
  });
});

describe("motionPlanOf", () => {
  const stops = [stop(0, 1000, 1000), stop(12_000, 1400, 1460, true), stop(30_000, 1900, 1900)];

  it("leaves cancelled stops out", () => {
    const plan = motionPlanOf(stops, "reg", 30_000);
    const expected = buildMotionPlan({
      stops: [
        { s: 0, arrival: 1000, departure: 1000 },
        { s: 30_000, arrival: 1900, departure: 1900 },
      ],
      dynamics: CATEGORY_DYNAMICS.reg,
      shapeLength: 30_000,
    });
    expect(plan?.legs).toEqual(expected.legs);
  });

  it("is null when fewer than two served stops remain", () => {
    expect(
      motionPlanOf([stops[0] as MotionStop, stops[1] as MotionStop], "hsr", 30_000),
    ).toBeNull();
    expect(motionPlanOf([], "hsr", 30_000)).toBeNull();
  });

  it("uses the dynamics of the category", () => {
    const served = [stop(0, 1000, 1000), stop(60_000, 2500, 2500)];
    const hsr = motionPlanOf(served, "hsr", 60_000);
    const bus = motionPlanOf(served, "bus", 60_000);
    const reg = motionPlanOf(served, "reg", 60_000);
    expect(bus?.legs).toEqual(reg?.legs);
    expect(hsr?.legs).not.toEqual(reg?.legs);
  });
});
