import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_DYNAMICS,
  createLegState,
  evaluateLeg,
  fitLeg,
  type Leg,
  minimumLegDuration,
  type TrainDynamics,
} from "../src/profile.ts";
import { PROPERTY_SEED } from "./arbitraries.ts";

const ICE: TrainDynamics = { maxSpeed: 83.3, acceleration: 0.5, deceleration: 0.6 };

function stateAt(leg: Leg, t: number) {
  const state = createLegState();
  evaluateLeg(leg, t, state);
  return { ...state };
}

describe("fitLeg", () => {
  it("fits a trapezoid whose cruise speed solves L = vT - v^2 (1/2a + 1/2b)", () => {
    const leg = fitLeg(1000, 21_000, 100, 500, ICE);
    const c = 1 / (2 * ICE.acceleration) + 1 / (2 * ICE.deceleration);
    expect(leg.kind).toBe("trapezoid");
    expect(leg.cruiseSpeed * 400 - c * leg.cruiseSpeed ** 2).toBeCloseTo(20_000, 6);
    expect(leg.acceleration).toBe(0.5);
    expect(leg.deceleration).toBe(0.6);
    expect(leg.accelerationEnd).toBeCloseTo(100 + leg.cruiseSpeed / 0.5, 9);
    expect(leg.decelerationStart).toBeCloseTo(500 - leg.cruiseSpeed / 0.6, 9);
  });

  it("starts at rest at s0, cruises, and stops exactly at s1 at the arrival time", () => {
    const leg = fitLeg(1000, 21_000, 100, 500, ICE);
    expect(stateAt(leg, 100)).toEqual({ s: 1000, v: 0 });
    expect(stateAt(leg, 300).v).toBeCloseTo(leg.cruiseSpeed, 9);
    expect(stateAt(leg, 500).s).toBeCloseTo(21_000, 9);
    expect(stateAt(leg, 500).v).toBeCloseTo(0, 9);
  });

  it("falls back to a triangle with raised accelerations when the leg is too short in time", () => {
    const leg = fitLeg(0, 1000, 0, 40, ICE);
    expect(leg.kind).toBe("triangle");
    expect(leg.cruiseSpeed).toBeCloseTo(50, 9);
    expect(leg.acceleration).toBeGreaterThan(ICE.acceleration);
    expect(leg.acceleration / leg.deceleration).toBeCloseTo(0.5 / 0.6, 9);
    expect(leg.accelerationEnd).toBeCloseTo(leg.decelerationStart, 9);
    expect(stateAt(leg, 40).s).toBeCloseTo(1000, 9);
  });

  it("prefers a trapezoid at the maximum speed over a triangle peak above it", () => {
    const leg = fitLeg(0, 5000, 0, 100, ICE);
    expect(leg.kind).toBe("trapezoid");
    expect(leg.cruiseSpeed).toBeCloseTo(ICE.maxSpeed, 9);
    expect(stateAt(leg, 100).s).toBeCloseTo(5000, 9);
  });

  it("caps the cruise at the speed limit by raising the accelerations", () => {
    const limited = fitLeg(0, 30_000, 0, 600, ICE, 55);
    expect(limited.kind).toBe("trapezoid");
    expect(limited.cruiseSpeed).toBeCloseTo(55, 9);
    expect(limited.acceleration).toBeGreaterThan(0.5);
    expect(stateAt(limited, 600).s).toBeCloseTo(30_000, 9);
  });

  it("exceeds the speed limit only when the timetable demands a higher average speed", () => {
    const leg = fitLeg(0, 60_000, 0, 600, ICE, 90);
    expect(leg.cruiseSpeed).toBeGreaterThan(100);
    expect(stateAt(leg, 600).s).toBeCloseTo(60_000, 9);
  });

  it("holds still when both stops share an arc length", () => {
    const leg = fitLeg(500, 500, 0, 60, ICE);
    expect(leg.kind).toBe("hold");
    expect(stateAt(leg, 30)).toEqual({ s: 500, v: 0 });
  });

  it("solves the cruise speed without cancellation for very slow legs", () => {
    const leg = fitLeg(0, 10, 0, 100_000, ICE);
    expect(leg.cruiseSpeed).toBeCloseTo(1e-4, 9);
    expect(stateAt(leg, 100_000).s).toBeCloseTo(10, 9);
  });

  it("rejects non-positive durations and dynamics", () => {
    expect(() => fitLeg(0, 100, 10, 10, ICE)).toThrow(RangeError);
    expect(() => fitLeg(0, 100, 0, 10, { ...ICE, acceleration: 0 })).toThrow(RangeError);
  });

  it("rejects a speed limit that is NaN or not above 0 and accepts Infinity as no limit", () => {
    for (const limit of [Number.NaN, 0, -10, Number.NEGATIVE_INFINITY]) {
      expect(() => fitLeg(0, 1000, 0, 100, ICE, limit)).toThrow(RangeError);
      expect(() => minimumLegDuration(1000, ICE, limit, 1)).toThrow(RangeError);
    }
    expect(fitLeg(0, 1000, 0, 100, ICE, Number.POSITIVE_INFINITY)).toEqual(
      fitLeg(0, 1000, 0, 100, ICE),
    );
  });
});

describe("CATEGORY_DYNAMICS", () => {
  it("covers every display category with plausible rail values", () => {
    for (const dynamics of Object.values(CATEGORY_DYNAMICS)) {
      expect(dynamics.maxSpeed).toBeGreaterThan(20);
      expect(dynamics.maxSpeed).toBeLessThan(90);
      expect(dynamics.acceleration).toBeGreaterThan(0.2);
      expect(dynamics.acceleration).toBeLessThanOrEqual(1.2);
      expect(dynamics.deceleration).toBeLessThanOrEqual(1.2);
    }
  });
});

const legInput = fc.record({
  length: fc.oneof(
    fc.double({ min: 0.01, max: 500, noNaN: true }),
    fc.double({ min: 500, max: 400_000, noNaN: true }),
  ),
  duration: fc.double({ min: 1, max: 20_000, noNaN: true }),
  acceleration: fc.double({ min: 0.2, max: 1.2, noNaN: true }),
  deceleration: fc.double({ min: 0.2, max: 1.2, noNaN: true }),
  maxSpeed: fc.double({ min: 20, max: 90, noNaN: true }),
});

function profileViolations(leg: Leg, steps: number): string[] {
  const accelerationBound = Math.max(leg.acceleration, leg.deceleration) * (1 + 1e-6);
  const dt = (leg.tArr - leg.tDep) / steps;
  const violations: string[] = [];
  let previous = stateAt(leg, leg.tDep);
  for (let k = 1; k <= steps; k++) {
    const current = stateAt(leg, leg.tDep + k * dt);
    const meanSpeed = (current.s - previous.s) / dt;
    const speedChange = Math.abs(current.v - previous.v);
    if (current.s < previous.s - 1e-9) violations.push(`s decreased at step ${k}`);
    if (current.v < 0) violations.push(`negative speed at step ${k}`);
    if (current.v > leg.cruiseSpeed * (1 + 1e-12)) violations.push(`above cruise at ${k}`);
    if (speedChange > accelerationBound * dt + 1e-9) violations.push(`acceleration at ${k}`);
    if (meanSpeed > Math.max(current.v, previous.v) + accelerationBound * dt + 1e-6) {
      violations.push(`position inconsistent with speed at step ${k}`);
    }
    previous = current;
  }
  return violations;
}

describe("leg profile properties", () => {
  it("is continuous, monotone, at rest at both ends, with bounded acceleration", () => {
    fc.assert(
      fc.property(legInput, (input) => {
        const dynamics = {
          maxSpeed: input.maxSpeed,
          acceleration: input.acceleration,
          deceleration: input.deceleration,
        };
        const leg = fitLeg(100, 100 + input.length, 0, input.duration, dynamics);
        const start = stateAt(leg, 0);
        const end = stateAt(leg, input.duration);
        expect(start.s).toBe(100);
        expect(start.v).toBe(0);
        expect(Math.abs(end.s - (100 + input.length))).toBeLessThan(
          1e-6 * Math.max(1, input.length),
        );
        expect(end.v).toBeLessThan(1e-6 * Math.max(1, leg.cruiseSpeed));
        expect(profileViolations(leg, 400)).toEqual([]);
      }),
      { seed: PROPERTY_SEED, numRuns: 3000 },
    );
  });

  it("never exceeds the maximum speed when the timetable allows it", () => {
    fc.assert(
      fc.property(legInput, (input) => {
        fc.pre(input.length / input.duration < input.maxSpeed * 0.999);
        const leg = fitLeg(0, input.length, 0, input.duration, {
          maxSpeed: input.maxSpeed,
          acceleration: input.acceleration,
          deceleration: input.deceleration,
        });
        expect(leg.cruiseSpeed).toBeLessThanOrEqual(input.maxSpeed * (1 + 1e-9));
      }),
      { seed: PROPERTY_SEED, numRuns: 3000 },
    );
  });
});
