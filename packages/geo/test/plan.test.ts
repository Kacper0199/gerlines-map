import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildMotionPlan,
  createTargetState,
  evaluatePlan,
  type MotionPlan,
  type PlanStop,
  planSpeed,
} from "../src/plan.ts";
import type { TrainDynamics } from "../src/profile.ts";
import { PROPERTY_SEED } from "./arbitraries.ts";

const RE: TrainDynamics = { maxSpeed: 44.4, acceleration: 0.7, deceleration: 0.8 };

const THREE_STOPS: PlanStop[] = [
  { s: 0, departure: 1000 },
  { s: 8000, arrival: 1400, departure: 1460 },
  { s: 20_000, arrival: 2000 },
];

function targetAt(plan: MotionPlan, t: number, hint = 0) {
  const state = createTargetState();
  state.leg = hint;
  evaluatePlan(plan, t, state);
  return { ...state };
}

describe("buildMotionPlan", () => {
  it("creates one leg per pair of consecutive stops", () => {
    const plan = buildMotionPlan({ stops: THREE_STOPS, dynamics: RE });
    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[1]?.tDep).toBe(1460);
    expect(plan.legs[1]?.s1).toBe(20_000);
    expect(plan.adjustments).toBe(0);
  });

  it("applies a per-leg speed limit", () => {
    const plan = buildMotionPlan({
      stops: THREE_STOPS,
      dynamics: RE,
      legSpeedLimits: [21, undefined],
    });
    expect(plan.legs[0]?.cruiseSpeed).toBeCloseTo(21, 9);
    expect(plan.legs[1]?.cruiseSpeed).toBeCloseTo(23.604, 3);
  });

  it("treats a speed limit that is not finite and above 0 as missing and counts it", () => {
    const reference = buildMotionPlan({ stops: THREE_STOPS, dynamics: RE });
    for (const bad of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const plan = buildMotionPlan({
        stops: THREE_STOPS,
        dynamics: RE,
        legSpeedLimits: [bad, bad],
      });
      expect(plan.legs).toEqual(reference.legs);
      expect(plan.adjustments).toBe(2);
      const t = targetAt(plan, 1700);
      expect(Number.isFinite(t.s) && Number.isFinite(t.v)).toBe(true);
    }
  });

  it("clamps stop arc lengths to [0, shapeLength] and counts each clamp", () => {
    const plan = buildMotionPlan({
      stops: [
        { s: -5, departure: 1000 },
        { s: 8000, arrival: 1400, departure: 1460 },
        { s: 20_015, arrival: 2000 },
      ],
      dynamics: RE,
      shapeLength: 20_000,
    });
    expect(plan.legs[0]?.s0).toBe(0);
    expect(plan.legs[1]?.s1).toBe(20_000);
    expect(plan.adjustments).toBe(2);
    expect(() =>
      buildMotionPlan({ stops: THREE_STOPS, dynamics: RE, shapeLength: Number.NaN }),
    ).toThrow(RangeError);
  });

  it("fills a missing arrival or departure from the other time of the stop", () => {
    const plan = buildMotionPlan({
      stops: [
        { s: 0, departure: 0 },
        { s: 1000, departure: 120 },
        { s: 3000, arrival: 300 },
      ],
      dynamics: RE,
    });
    expect(plan.legs[0]?.tArr).toBe(120);
    expect(plan.legs[1]?.tDep).toBe(120);
  });

  it("repairs decreasing arc lengths and times that run backwards, and counts the repairs", () => {
    const plan = buildMotionPlan({
      stops: [
        { s: 0, departure: 100 },
        { s: -50, arrival: 90, departure: 80 },
        { s: 5000, arrival: 400 },
      ],
      dynamics: RE,
    });
    expect(plan.legs[0]?.s1).toBe(0);
    expect(plan.legs[0]?.tArr).toBe(101);
    expect(plan.legs[1]?.tDep).toBe(101);
    expect(plan.adjustments).toBe(3);
  });

  it("raises an arc length below the previous stop's to it", () => {
    const plan = buildMotionPlan({
      stops: [
        { s: 1000, departure: 0 },
        { s: 900, arrival: 100, departure: 160 },
        { s: 5000, arrival: 600 },
      ],
      dynamics: RE,
    });
    expect(plan.legs[0]?.s1).toBe(1000);
    expect(plan.adjustments).toBe(1);
  });

  it("moves an arrival later when the leg is faster than the train can run", () => {
    const plan = buildMotionPlan({
      stops: [
        { s: 0, departure: 0 },
        { s: 40_000, arrival: 60, departure: 120 },
        { s: 41_000, arrival: 400 },
      ],
      dynamics: RE,
    });
    const leg = plan.legs[0];
    const floorCoefficient = (1 / (2 * 0.7) + 1 / (2 * 0.8)) * (0.8 / 1.0);
    const feasible = 40_000 / RE.maxSpeed + floorCoefficient * RE.maxSpeed;
    expect(leg?.tArr).toBeCloseTo(feasible, 9);
    expect(leg?.cruiseSpeed).toBeLessThanOrEqual(RE.maxSpeed * (1 + 1e-12));
    expect(Math.max(leg?.acceleration ?? 0, leg?.deceleration ?? 0)).toBeLessThanOrEqual(1 + 1e-9);
    expect(plan.legs[1]?.tDep).toBeCloseTo(feasible, 9);
    expect(plan.legs[1]?.tArr).toBeCloseTo(feasible + 2 * Math.sqrt(floorCoefficient * 1000), 9);
    expect(plan.adjustments).toBe(4);
  });

  it("uses a triangle floor of 2 sqrt(c L) for short legs", () => {
    const plan = buildMotionPlan({
      stops: [
        { s: 0, departure: 0 },
        { s: 400, arrival: 5 },
      ],
      dynamics: RE,
    });
    const floorCoefficient = (1 / (2 * 0.7) + 1 / (2 * 0.8)) * (0.8 / 1.0);
    expect(plan.legs[0]?.tArr).toBeCloseTo(2 * Math.sqrt(floorCoefficient * 400), 9);
  });

  it("rejects plans with fewer than two stops, a stop without any time, or non-finite values", () => {
    expect(() => buildMotionPlan({ stops: [{ s: 0, departure: 0 }], dynamics: RE })).toThrow(
      RangeError,
    );
    expect(() =>
      buildMotionPlan({ stops: [{ s: 0, departure: 0 }, { s: 10 }], dynamics: RE }),
    ).toThrow(RangeError);
    expect(() =>
      buildMotionPlan({
        stops: [
          { s: Number.NaN, departure: 0 },
          { s: 10, arrival: 5 },
        ],
        dynamics: RE,
      }),
    ).toThrow(RangeError);
  });
});

describe("evaluatePlan", () => {
  const plan = buildMotionPlan({ stops: THREE_STOPS, dynamics: RE });

  it("waits at the origin before the first departure and caps there", () => {
    expect(targetAt(plan, 500)).toMatchObject({ s: 0, v: 0, cap: 0, leg: 0 });
  });

  it("moves inside a leg with the next stop as the cap", () => {
    const state = targetAt(plan, 1200);
    expect(state.s).toBeGreaterThan(0);
    expect(state.s).toBeLessThan(8000);
    expect(state.v).toBeGreaterThan(0);
    expect(state.cap).toBe(8000);
  });

  it("dwells at an intermediate stop between arrival and departure", () => {
    expect(targetAt(plan, 1430)).toMatchObject({ s: 8000, v: 0, cap: 8000, leg: 0 });
  });

  it("stays at the last stop after the final arrival", () => {
    expect(targetAt(plan, 10_000)).toMatchObject({ s: 20_000, v: 0, cap: 20_000, leg: 1 });
  });

  it("gives the same result from any leg hint", () => {
    expect(targetAt(plan, 1700, 0)).toEqual(targetAt(plan, 1700, 1));
    expect(targetAt(plan, 1200, 1)).toEqual(targetAt(plan, 1200, 0));
  });
});

const planArbitrary = fc
  .array(
    fc.record({
      gap: fc.double({ min: 0, max: 60_000, noNaN: true }),
      travel: fc.double({ min: 1, max: 3600, noNaN: true }),
      dwell: fc.double({ min: 0, max: 600, noNaN: true }),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .map((legs) => {
    const stops: PlanStop[] = [{ s: 0, departure: 0 }];
    let s = 0;
    let t = 0;
    for (const leg of legs) {
      s += leg.gap;
      t += leg.travel;
      const arrival = t;
      t += leg.dwell;
      stops.push({ s, arrival, departure: t });
    }
    return buildMotionPlan({ stops, dynamics: RE });
  });

function sweepViolations(
  plan: MotionPlan,
  steps: number,
): { violations: string[]; maxStep: number; dt: number } {
  const state = createTargetState();
  const end = (plan.legs[plan.legs.length - 1]?.tArr ?? 0) + 10;
  const dt = (end + 10) / steps;
  let previousS = Number.NEGATIVE_INFINITY;
  let previousCap = Number.NEGATIVE_INFINITY;
  let maxStep = 0;
  const violations: string[] = [];
  for (let k = 0; k <= steps; k++) {
    evaluatePlan(plan, -10 + k * dt, state);
    if (state.s < previousS - 1e-9) violations.push(`s decreased at ${k}`);
    if (state.cap < previousCap) violations.push(`cap decreased at ${k}`);
    if (state.s > state.cap + 1e-9) violations.push(`s beyond cap at ${k}`);
    if (state.v < 0) violations.push(`negative speed at ${k}`);
    if (k > 0) maxStep = Math.max(maxStep, state.s - previousS);
    previousS = state.s;
    previousCap = state.cap;
  }
  return { violations, maxStep, dt };
}

describe("plan properties", () => {
  it("target arc length is continuous and non-decreasing in time and never passes the cap", () => {
    fc.assert(
      fc.property(planArbitrary, (plan) => {
        const { violations, maxStep, dt } = sweepViolations(plan, 2000);
        const maxSpeed = plan.legs.reduce((m, leg) => Math.max(m, leg.cruiseSpeed), 0);
        expect(violations).toEqual([]);
        expect(maxStep).toBeLessThanOrEqual(maxSpeed * dt * (1 + 1e-6) + 1e-6);
      }),
      { seed: PROPERTY_SEED, numRuns: 500 },
    );
  });
});

describe("planSpeed", () => {
  const plan = buildMotionPlan({ stops: THREE_STOPS, dynamics: RE });

  it("is zero at the origin before the first departure and in a dwell", () => {
    expect(planSpeed(plan, 500)).toBe(0);
    expect(planSpeed(plan, 1000)).toBe(0);
    expect(planSpeed(plan, 1430)).toBe(0);
    expect(planSpeed(plan, 1460)).toBe(0);
  });

  it("is the profile speed inside a leg, equal to the target speed", () => {
    for (const t of [1010, 1200, 1390, 1480, 1700, 1990]) {
      expect(planSpeed(plan, t)).toBe(targetAt(plan, t).v);
    }
    expect(planSpeed(plan, 1200)).toBeGreaterThan(0);
  });

  it("has no value from the last arrival on or for a time that is not a number", () => {
    expect(planSpeed(plan, 2000)).toBeUndefined();
    expect(planSpeed(plan, 10_000)).toBeUndefined();
    expect(planSpeed(plan, Number.NaN)).toBeUndefined();
    expect(planSpeed(plan, 1999.5)).toBeGreaterThan(0);
  });

  it("has no value for a plan whose only leg has no length after its arrival", () => {
    const held = buildMotionPlan({
      stops: [
        { s: 100, departure: 10 },
        { s: 100, arrival: 40 },
      ],
      dynamics: RE,
    });
    expect(planSpeed(held, 20)).toBe(0);
    expect(planSpeed(held, 41)).toBeUndefined();
  });
});

describe("planSpeed properties", () => {
  it("equals the numeric derivative of the arc length along the shape", () => {
    fc.assert(
      fc.property(planArbitrary, fc.double({ min: 0, max: 1, noNaN: true }), (plan, fraction) => {
        const first = plan.legs[0]?.tDep ?? 0;
        const last = plan.legs[plan.legs.length - 1]?.tArr ?? 0;
        const t = first - 5 + fraction * (last - first + 5);
        const h = 1e-3;
        fc.pre(t + h < last);
        const speed = planSpeed(plan, t) as number;
        const before = createTargetState();
        const after = createTargetState();
        evaluatePlan(plan, t - h, before);
        evaluatePlan(plan, t + h, after);
        const derivative = (after.s - before.s) / (2 * h);
        const kink = Math.max(speed, Math.abs(derivative)) * 1e-2 + 1e-3;
        const nearBreak = plan.legs.some((leg) =>
          [leg.tDep, leg.accelerationEnd, leg.decelerationStart, leg.tArr].some(
            (edge) => Math.abs(edge - t) < 2 * h,
          ),
        );
        fc.pre(!nearBreak);
        expect(Math.abs(speed - derivative)).toBeLessThanOrEqual(kink);
      }),
      {
        seed: PROPERTY_SEED,
        numRuns: 2000,
        interruptAfterTimeLimit: 20_000,
        markInterruptAsFailure: true,
      },
    );
  }, 30_000);

  it("integrates to the distance between the stops and is never negative", () => {
    fc.assert(
      fc.property(planArbitrary, (plan) => {
        const first = plan.legs[0]?.tDep ?? 0;
        const last = plan.legs[plan.legs.length - 1]?.tArr ?? 0;
        const steps = 4000;
        const dt = (last - first) / steps;
        let travelled = 0;
        for (let k = 0; k < steps; k++) {
          const speed = planSpeed(plan, first + (k + 0.5) * dt) as number;
          expect(speed).toBeGreaterThanOrEqual(0);
          travelled += speed * dt;
        }
        const total = plan.legs.reduce((sum, leg) => sum + (leg.s1 - leg.s0), 0);
        const peak = plan.legs.reduce((most, leg) => Math.max(most, leg.cruiseSpeed), 0);
        expect(Math.abs(travelled - total)).toBeLessThanOrEqual(
          total * 2e-2 + peak * dt * plan.legs.length * 4 + 1,
        );
      }),
      {
        seed: PROPERTY_SEED,
        numRuns: 200,
        interruptAfterTimeLimit: 20_000,
        markInterruptAsFailure: true,
      },
    );
  }, 30_000);
});
