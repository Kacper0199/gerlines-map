import { describe, expect, it } from "vitest";
import { PlanClock } from "./plan-clock.ts";

describe("PlanClock", () => {
  it("has no time before the first head", () => {
    expect(new PlanClock(1).now(1000)).toBeNull();
  });

  it("starts on the first head and runs with the wall clock", () => {
    const clock = new PlanClock(1);
    clock.observe(1_000, 50_000);
    expect(clock.now(50_000)).toBeCloseTo(1_000, 6);
    expect(clock.now(52_500)).toBeCloseTo(1_002.5, 6);
  });

  it("runs at the time scale of a replay", () => {
    const clock = new PlanClock(10);
    clock.observe(1_000, 0);
    expect(clock.now(2_000)).toBeCloseTo(1_020, 6);
  });

  it("never goes backwards while heads arrive late or truncated", () => {
    const clock = new PlanClock(1);
    clock.observe(1_000, 0);
    let previous = clock.now(0) as number;
    let wall = 0;
    for (let step = 1; step <= 200; step++) {
      wall += 250;
      const lagging = step % 3 === 0 ? -1.4 : 0;
      if (step % 4 === 0) clock.observe(1_000 + wall / 1000 + lagging, wall);
      const now = clock.now(wall) as number;
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  it("never steps: an observation changes the clock's rate, not its value", () => {
    const clock = new PlanClock(1);
    clock.observe(1_000, 0);
    const before = clock.now(1_000) as number;
    clock.observe(1_000 + 1 + 4, 1_000);
    expect(clock.now(1_000)).toBeCloseTo(before, 9);
    const afterOneSecond = clock.now(2_000) as number;
    expect(afterOneSecond).toBeGreaterThan(before + 1);
    expect(afterOneSecond).toBeLessThan(before + 1.025);
  });

  it("closes a drift within seconds at no more than 2 % of the rate, in both directions", () => {
    for (const drift of [3, -3]) {
      const clock = new PlanClock(1);
      clock.observe(1_000, 0);
      let wall = 0;
      for (let second = 1; second <= 40; second++) {
        wall = second * 1_000;
        clock.observe(1_000 + second + (second === 1 ? drift : 0), wall);
      }
      expect(Math.abs((clock.now(wall) as number) - (1_000 + 40))).toBeLessThan(0.05);
    }
  });

  it("changes its rate by no more than 2 % whatever the drift", () => {
    const clock = new PlanClock(10);
    clock.observe(1_000, 0);
    clock.observe(1_000 + 10 + 100, 1_000);
    const a = clock.now(1_000) as number;
    const b = clock.now(2_000) as number;
    expect(b - a).toBeGreaterThan(10 * 0.98 - 1e-9);
    expect(b - a).toBeLessThan(10 * 1.02 + 1e-9);
  });

  it("moves smoothly at every frame while heads keep correcting it", () => {
    const clock = new PlanClock(1);
    clock.observe(1_000, 0);
    let previous = clock.now(0) as number;
    for (let frame = 1; frame <= 600; frame++) {
      const wall = frame * 16;
      if (frame % 60 === 0) clock.observe(1_000 + Math.floor(wall / 1000) + 0.5, wall);
      const now = clock.now(wall) as number;
      expect(now - previous).toBeGreaterThan(0.016 * 0.97);
      expect(now - previous).toBeLessThan(0.016 * 1.03);
      previous = now;
    }
  });

  it("restarts on a large difference such as a replay loop and says so", () => {
    const clock = new PlanClock(1);
    expect(clock.observe(1_000, 0)).toBe(false);
    expect(clock.observe(1_001, 1_000)).toBe(false);
    expect(clock.observe(50_000, 2_000)).toBe(true);
    expect(clock.now(2_000)).toBeCloseTo(50_000, 6);
    expect(clock.observe(10, 3_000)).toBe(true);
    expect(clock.now(3_000)).toBeCloseTo(10, 6);
  });

  it("restarts when time scale is changed", () => {
    const clock = new PlanClock(1);
    clock.observe(1_000, 0);
    clock.setScale(5);
    expect(clock.now(0)).toBeNull();
  });

  it("rejects a scale that is not positive", () => {
    expect(() => new PlanClock(0)).toThrow(RangeError);
  });
});
