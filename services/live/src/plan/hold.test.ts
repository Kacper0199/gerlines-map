import { createTargetState, evaluatePlan, type MotionPlan } from "@gerlines/geo";
import { dynamicsFor, type MotionStop, motionPlanOf } from "@gerlines/geo/client-plan";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { approachDistance, type HoldDecision, holdAtApproach } from "./hold.ts";

const T = 1_793_000_000;
const SHAPE = 200_000;

function plan(stops: readonly MotionStop[], category: "hsr" | "reg" = "reg"): MotionPlan {
  const built = motionPlanOf(stops, category, SHAPE);
  if (!built) throw new Error("plan needs two stops");
  return built;
}

function stop(s: number, arrival: number, departure = arrival): MotionStop {
  return { s, arrival, departure, cancelled: false };
}

function targetAt(motion: MotionPlan, t: number): { s: number; v: number } {
  const target = createTargetState();
  evaluatePlan(motion, t, target);
  return { s: target.s, v: target.v };
}

function held(decision: HoldDecision) {
  if (decision.kind !== "hold") throw new Error(`expected a hold, got ${decision.kind}`);
  return decision;
}

describe("approachDistance", () => {
  it("is 1,500 m for hsr, ld and night and 800 m otherwise", () => {
    expect(approachDistance("hsr")).toBe(1500);
    expect(approachDistance("night")).toBe(1500);
    expect(approachDistance("sbahn")).toBe(800);
    expect(approachDistance("unknown")).toBe(800);
  });
});

describe("holdAtApproach", () => {
  const published = [stop(1000, T - 60, T), stop(16_000, T + 600, T + 660), stop(40_000, T + 1500)];

  it("keeps the target where it is at t_u and holds before the station", () => {
    const motion = plan(published);
    const now = T + 300;
    const before = targetAt(motion, now);
    const decision = held(
      holdAtApproach({
        plan: motion,
        dynamics: dynamicsFor("reg"),
        approach: 800,
        now,
        fromS: 1000,
        fromDeparture: T,
        nextS: 16_000,
        newArrival: T + 600 + 240,
      }),
    );
    expect(decision.s).toBeGreaterThan(before.s);
    expect(decision.s).toBeLessThanOrEqual(16_000 - 50);
    expect(decision.s).toBeGreaterThanOrEqual(16_000 - 800);
    expect(Number.isInteger(decision.arrival) && Number.isInteger(decision.departure)).toBe(true);
    expect(decision.departure - decision.arrival).toBeGreaterThanOrEqual(10);
    const next = plan([
      stop(1000, T - 60, T),
      stop(decision.s, decision.arrival, decision.departure),
      stop(16_000, T + 840, T + 900),
      stop(40_000, T + 1740),
    ]);
    expect(Math.abs(targetAt(next, now).s - before.s)).toBeLessThan(0.01);
  });

  it("can repeat: a second delay is fitted against the plan with the hold point", () => {
    const first = plan(published);
    const firstNow = T + 300;
    const one = held(
      holdAtApproach({
        plan: first,
        dynamics: dynamicsFor("reg"),
        approach: 800,
        now: firstNow,
        fromS: 1000,
        fromDeparture: T,
        nextS: 16_000,
        newArrival: T + 840,
      }),
    );
    const second = plan([
      stop(1000, T - 60, T),
      stop(one.s, one.arrival, one.departure),
      stop(16_000, T + 840, T + 900),
    ]);
    const secondNow = firstNow + 60;
    const before = targetAt(second, secondNow);
    const decision = holdAtApproach({
      plan: second,
      dynamics: dynamicsFor("reg"),
      approach: 800,
      now: secondNow,
      fromS: 1000,
      fromDeparture: T,
      nextS: 16_000,
      newArrival: T + 840 + 180,
    });
    const two = held(decision);
    const third = plan([
      stop(1000, T - 60, T),
      stop(two.s, two.arrival, two.departure),
      stop(16_000, T + 1020, T + 1080),
    ]);
    expect(Math.abs(targetAt(third, secondNow).s - before.s)).toBeLessThan(0.01);
  });

  it("absorbs the delay as dwell when the train is already within its braking distance", () => {
    const motion = plan(published);
    expect(
      holdAtApproach({
        plan: motion,
        dynamics: dynamicsFor("reg"),
        approach: 800,
        now: T + 595,
        fromS: 1000,
        fromDeparture: T,
        nextS: 16_000,
        newArrival: T + 900,
      }),
    ).toEqual({ kind: "absorb" });
  });

  it("refits when the hold would be shorter than 10 s or the train has not left", () => {
    const motion = plan(published);
    const context = {
      plan: motion,
      dynamics: dynamicsFor("reg"),
      approach: 800,
      fromS: 1000,
      fromDeparture: T,
      nextS: 16_000,
    };
    expect(holdAtApproach({ ...context, now: T + 300, newArrival: T + 605 }).kind).toBe("refit");
    expect(holdAtApproach({ ...context, now: T, newArrival: T + 900 }).kind).toBe("refit");
  });

  it("keeps the target in place for any leg, position and delay (property)", () => {
    const kinds = { hold: 0, absorb: 0, refit: 0 };
    fc.assert(
      fc.property(
        fc.integer({ min: 2_000, max: 60_000 }),
        fc.double({ min: 0.35, max: 0.95, noNaN: true }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.integer({ min: 31, max: 1800 }),
        fc.constantFrom("hsr" as const, "reg" as const),
        (length, speedShare, progress, delay, category) => {
          const dynamics = dynamicsFor(category);
          const duration = Math.ceil(length / (dynamics.maxSpeed * speedShare)) + 60;
          const motion = plan(
            [stop(500, T - 60, T), stop(500 + length, T + duration, T + duration + 60)],
            category,
          );
          const now = T + Math.max(1, Math.floor(duration * progress));
          const before = targetAt(motion, now);
          const decision = holdAtApproach({
            plan: motion,
            dynamics,
            approach: approachDistance(category),
            now,
            fromS: 500,
            fromDeparture: T,
            nextS: 500 + length,
            newArrival: T + duration + delay,
          });
          kinds[decision.kind]++;
          if (decision.kind !== "hold") return true;
          const next = plan(
            [
              stop(500, T - 60, T),
              stop(decision.s, decision.arrival, decision.departure),
              stop(500 + length, T + duration + delay),
            ],
            category,
          );
          expect(Math.abs(targetAt(next, now).s - before.s)).toBeLessThan(0.01);
          expect(decision.arrival).toBeGreaterThan(now);
          expect(decision.departure - decision.arrival).toBeGreaterThanOrEqual(10);
          expect(decision.s).toBeGreaterThan(before.s);
          expect(decision.s).toBeLessThanOrEqual(500 + length - 50);
          expect(next.adjustments).toBe(0);
          return true;
        },
      ),
      { seed: 20261029, numRuns: 300 },
    );
    expect(kinds.hold).toBeGreaterThan(150);
  });
});
