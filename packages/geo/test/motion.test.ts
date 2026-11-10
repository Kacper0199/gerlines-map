import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ContinuityMeter } from "../src/continuity.ts";
import { DEFAULT_CONTROLLER, TrainMotion } from "../src/motion.ts";
import { buildMotionPlan, type MotionPlan, type PlanStop } from "../src/plan.ts";
import type { TrainDynamics } from "../src/profile.ts";
import { createShape, type Shape } from "../src/shape.ts";
import { FRANKFURT_MERCATOR, PROPERTY_SEED } from "./arbitraries.ts";
import { type FrameRecord, type PlanUpdate, simulateFrames } from "./simulate.ts";

const DYNAMICS: TrainDynamics = { maxSpeed: 44.4, acceleration: 0.7, deceleration: 0.8 };
const FPS = 60;

function straightShape(lengthMetres: number): Shape {
  const { x, y } = FRANKFURT_MERCATOR;
  return createShape({ x: [x, x + lengthMetres], y: [y, y], s: [0, lengthMetres] });
}

const SHAPE = straightShape(100_000);

function plan(stops: PlanStop[]): MotionPlan {
  return buildMotionPlan({ stops, dynamics: DYNAMICS });
}

function delayed(stops: PlanStop[], delay: number, fromIndex = 0): PlanStop[] {
  return stops.map((stop, index) =>
    index < fromIndex
      ? stop
      : {
          s: stop.s,
          arrival: stop.arrival === undefined ? undefined : stop.arrival + delay,
          departure: stop.departure === undefined ? undefined : stop.departure + delay,
        },
  );
}

const STOPS: PlanStop[] = [
  { s: 0, departure: 100 },
  { s: 12_000, arrival: 600, departure: 660 },
  { s: 30_000, arrival: 1300, departure: 1360 },
  { s: 50_000, arrival: 2100 },
];

function run(motion: TrainMotion, updates: PlanUpdate[], until: number): FrameRecord[] {
  const frames: FrameRecord[] = [];
  simulateFrames(motion, updates, until, FPS, (frame) => frames.push({ ...frame }));
  return frames;
}

describe("TrainMotion start", () => {
  it("starts on the target and fades in over the fade-in duration", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 300);
    expect(motion.s).toBe(motion.target.s);
    expect(motion.alpha).toBe(0);
    motion.advance(300 + DEFAULT_CONTROLLER.fadeInDuration / 2);
    expect(motion.alpha).toBeCloseTo(0.5, 9);
    motion.advance(301);
    expect(motion.alpha).toBe(1);
  });

  it("tracks an unchanged plan exactly", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    const frames = run(motion, [], 2200);
    const worst = frames.reduce((m, f) => Math.max(m, Math.abs(f.targetS - f.s)), 0);
    expect(worst).toBeLessThan(1e-6);
    expect(motion.s).toBeCloseTo(50_000, 6);
  });

  it("ignores frames whose time does not advance", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 400);
    const before = motion.s;
    motion.advance(399);
    expect(motion.s).toBe(before);
    expect(motion.time).toBe(400);
  });
});

describe("TrainMotion controller variants and safety nets", () => {
  it("runs the plain linear catch-up law without producing NaN", () => {
    const linear = { ...DEFAULT_CONTROLLER, catchUpDeceleration: Number.POSITIVE_INFINITY };
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0, linear);
    run(motion, [{ time: 900, plan: plan(delayed(STOPS, -45, 1)) }], 1290);
    expect(Number.isFinite(motion.s)).toBe(true);
    expect(Math.abs(motion.target.s - motion.s)).toBeLessThan(1);
  });

  it("crossfades during motion when the target outruns the display by more than the crossfade distance", () => {
    const sprint = buildMotionPlan({
      stops: [
        { s: 0, departure: 10 },
        { s: 40_000, arrival: 70 },
      ],
      dynamics: { maxSpeed: 2000, acceleration: 50, deceleration: 50 },
      feasibilityAcceleration: 1000,
    });
    const motion = new TrainMotion(SHAPE, sprint, 0);
    const frames = run(motion, [], 200);
    expect(motion.lastCrossfade).toBe("distance");
    expect(frames.some((f) => f.swapped)).toBe(true);
    expect(Math.abs(motion.target.s - motion.s)).toBeLessThan(1);
  });

  it("keeps a slowed display at a fraction of the target speed when ahead, if configured", () => {
    const floored = { ...DEFAULT_CONTROLLER, aheadSpeedFraction: 0.5 };
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0, floored);
    const frames = run(motion, [{ time: 900, plan: plan(delayed(STOPS, 60, 1)) }], 1000);
    const settled = frames.filter((f) => f.time > 930 && f.time < 960);
    expect(settled.every((f) => f.v >= 0.5 * f.targetV - 1e-9)).toBe(true);
  });
});

describe("TrainMotion updates", () => {
  it("slows down without reversing when a delay puts the target behind", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    const frames = run(motion, [{ time: 900, plan: plan(delayed(STOPS, 60, 1)) }], 1800);
    let reversals = 0;
    for (let n = 1; n < frames.length; n++) {
      if ((frames[n] as FrameRecord).s < (frames[n - 1] as FrameRecord).s) reversals++;
    }
    expect(reversals).toBe(0);
    const afterUpdate = frames.filter((f) => f.time > 900 && f.time < 905);
    expect(Math.min(...afterUpdate.map((f) => f.v))).toBeLessThan(
      Math.min(...afterUpdate.map((f) => f.targetV)),
    );
    expect(motion.alpha).toBe(1);
    expect(Math.abs(motion.target.s - motion.s)).toBeLessThan(1);
  });

  it("catches up within the speed bound when the target jumps ahead", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    const frames = run(motion, [{ time: 900, plan: plan(delayed(STOPS, -45, 1)) }], 1290);
    const bound = (f: FrameRecord) =>
      DEFAULT_CONTROLLER.speedFactor * f.targetV + DEFAULT_CONTROLLER.speedOffset;
    expect(frames.every((f) => f.v <= bound(f) + 1e-9)).toBe(true);
    expect(frames.every((f) => f.alpha === 1 || f.time < 1)).toBe(true);
    const last = frames[frames.length - 1] as FrameRecord;
    expect(Math.abs(last.targetS - last.s)).toBeLessThan(1);
  });

  it("crossfades instead of jumping when the error exceeds the crossfade distance", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    const frames = run(motion, [{ time: 900, plan: plan(delayed(STOPS, 600, 1)) }], 902);
    const swap = frames.findIndex((f) => f.swapped);
    expect(motion.lastCrossfade).toBe("distance");
    expect(swap).toBeGreaterThan(0);
    const swapFrame = frames[swap] as FrameRecord;
    expect(swapFrame.alpha).toBe(0);
    expect(swapFrame.time - 900).toBeCloseTo(DEFAULT_CONTROLLER.fadeOutDuration, 1);
    expect(swapFrame.s).toBeCloseTo(swapFrame.targetS, 9);
    const visible = frames.filter(
      (f, n) => n > 0 && f.alpha > 0 && (frames[n - 1] as FrameRecord).alpha > 0,
    );
    expect(visible.length).toBeGreaterThan(0);
    expect(motion.alpha).toBe(1);
  });

  it("crossfades instead of waiting when the display has already passed the stop the target returns to", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    run(motion, [], 700);
    expect(motion.s).toBeGreaterThan(12_000);
    expect(motion.s).toBeLessThan(12_000 + 3000);
    const result = motion.update(plan(delayed(STOPS, 60, 1)), 700);
    expect(result.crossfade).toBe("stop");
    motion.advance(701);
    expect(motion.s).toBe(12_000);
    expect(motion.target.s).toBe(12_000);
  });

  it("brakes past a stop moved back within its braking distance instead of stopping dead", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    let now = 0;
    while (motion.s < 12_000 - 15) {
      now += 1 / FPS;
      motion.advance(now);
    }
    expect(motion.v).toBeGreaterThan(3);
    const moved = STOPS.map((stop, k) => (k === 1 ? { ...stop, s: 12_000 - 14 } : stop));
    expect(motion.update(plan(moved), now).crossfade).toBeUndefined();
    const meter = new ContinuityMeter();
    let past = 0;
    for (let n = 1; n <= 60 * FPS; n++) {
      motion.advance(now + n / FPS);
      meter.observe(motion.time, motion.sample.x, motion.sample.y, motion.alpha, motion.s);
      past = Math.max(past, motion.s - (12_000 - 14));
    }
    const report = meter.report();
    expect([report.jumps, report.stalls, report.backwardSteps]).toEqual([0, 0, 0]);
    expect(past).toBeGreaterThan(0);
    expect(past).toBeLessThanOrEqual(DEFAULT_CONTROLLER.passedStopTolerance);
    expect(motion.v).toBe(0);
  });

  it("crossfades when a stop moves back further than the display can stop within the tolerance", () => {
    const strict = { ...DEFAULT_CONTROLLER, passedStopTolerance: 1 };
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0, strict);
    let now = 0;
    while (motion.s < 12_000 - 15) {
      now += 1 / FPS;
      motion.advance(now);
    }
    const moved = STOPS.map((stop, k) => (k === 1 ? { ...stop, s: 12_000 - 14 } : stop));
    expect(motion.update(plan(moved), now).crossfade).toBe("stop");
  });

  it("crossfades when the shape changes", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    const other = straightShape(60_000);
    motion.update(plan(STOPS), 0.5, other);
    expect(motion.lastCrossfade).toBe("shape");
    motion.advance(0.5 + DEFAULT_CONTROLLER.fadeOutDuration + 0.01);
    expect(motion.shape).toBe(other);
  });

  it("stops at a stop where the target dwells instead of passing it", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    const frames = run(motion, [{ time: 400, plan: plan(delayed(STOPS, -60, 1)) }], 680);
    expect(motion.lastCrossfade).toBe("start");
    const dwelling = frames.filter((f) => f.targetV === 0 && f.targetS === 12_000);
    expect(dwelling.length).toBeGreaterThan(0);
    expect(
      frames.filter((f) => f.time < 600).reduce((m, f) => Math.max(m, f.s), 0),
    ).toBeLessThanOrEqual(12_000 + 1e-3);
    const arrivedBeforeDeparture = frames.some((f) => f.time < 600 && f.s > 12_000 - 1);
    expect(arrivedBeforeDeparture).toBe(true);
  });

  it("takes a plan that arrives during a fade-out as the one to fade in with", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    run(motion, [], 900);
    expect(motion.update(plan(delayed(STOPS, 600, 1)), 900).crossfade).toBe("distance");
    motion.advance(900.1);
    expect(motion.alpha).toBeLessThan(1);
    const latest = plan(delayed(STOPS, 5, 1));
    expect(motion.update(latest, 900.1).crossfade).toBeUndefined();
    expect(motion.plan).not.toBe(latest);
    motion.advance(900.5);
    expect(motion.plan).toBe(latest);
    expect(motion.lastCrossfade).toBe("distance");
  });

  it("resynchronises with a fade-in after a long gap between frames", () => {
    const motion = new TrainMotion(SHAPE, plan(STOPS), 0);
    motion.advance(1);
    motion.advance(1000);
    expect(motion.lastCrossfade).toBe("gap");
    expect(motion.s).toBe(motion.target.s);
    expect(motion.alpha).toBe(0);
  });
});

interface Scenario {
  readonly stops: PlanStop[];
  readonly updates: { readonly at: number; readonly delay: number; readonly fromStop: number }[];
}

const CONVERGENCE_BOUND = 1000;
const PROPERTY_RUNS = 200;

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .record({
    legs: fc.array(
      fc.record({
        length: fc.double({ min: 1000, max: 25_000, noNaN: true }),
        averageSpeed: fc.double({ min: 8, max: 40, noNaN: true }),
        dwell: fc.double({ min: 0, max: 300, noNaN: true }),
      }),
      { minLength: 2, maxLength: 6 },
    ),
    updates: fc.array(
      fc.record({
        fraction: fc.double({ min: 0, max: 1, noNaN: true }),
        delay: fc.constantFrom(-900, -300, -120, 120, 300, 900),
        fromStop: fc.nat(8),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  })
  .map(({ legs, updates }) => {
    const stops: PlanStop[] = [{ s: 0, departure: 60 }];
    let s = 0;
    let t = 60;
    for (const leg of legs) {
      s += leg.length;
      t += leg.length / leg.averageSpeed;
      const arrival = t;
      t += leg.dwell;
      stops.push({ s, arrival, departure: t });
    }
    const spacing = CONVERGENCE_BOUND;
    const times = updates
      .map((u) => 60 + u.fraction * t)
      .sort((a, b) => a - b)
      .reduce<number[]>((kept, time) => {
        const last = kept[kept.length - 1];
        if (last === undefined || time - last >= spacing) kept.push(time);
        return kept;
      }, []);
    return {
      stops,
      updates: times.map((at, i) => {
        const update = updates[i] as (typeof updates)[number];
        return { at, delay: update.delay, fromStop: Math.min(update.fromStop, stops.length - 1) };
      }),
    };
  });

function scenarioUpdates(scenario: Scenario): PlanUpdate[] {
  let stops = scenario.stops;
  return scenario.updates.map((u) => {
    stops = delayed(stops, u.delay, u.fromStop);
    return { time: u.at, plan: plan(stops) };
  });
}

function scenarioEnd(scenario: Scenario, updates: PlanUpdate[]): number {
  const lastPlan = updates[updates.length - 1]?.plan ?? plan(scenario.stops);
  const lastArrival = lastPlan.legs[lastPlan.legs.length - 1]?.tArr ?? 0;
  const lastUpdate = updates[updates.length - 1]?.time ?? 0;
  return Math.max(lastArrival, lastUpdate) + CONVERGENCE_BOUND;
}

interface InvariantReport {
  readonly violations: string[];
  readonly converged: boolean[];
}

function frameViolation(frame: FrameRecord, previous: FrameRecord): string | undefined {
  const limit = DEFAULT_CONTROLLER.accelerationLimit;
  const dt = 1 / FPS;
  const step = frame.s - previous.s;
  if (frame.swapped) return frame.alpha === 0 ? undefined : "visible swap";
  if (step < 0) return "backwards";
  if (Math.abs(frame.v - previous.v) > limit * dt * (1 + 1e-9) + 1e-12) return "acceleration";
  if (step > frame.v * dt + 1e-9) return "step above speed";
  const line = frame.cap + DEFAULT_CONTROLLER.passedStopTolerance;
  if (previous.s <= line && frame.s > line + 1e-3) return "passed the cap";
  const ceiling = DEFAULT_CONTROLLER.speedFactor * frame.targetV + DEFAULT_CONTROLLER.speedOffset;
  if (frame.v > previous.v && frame.v > ceiling + 1e-9) return "speed rose above the ceiling";
  return undefined;
}

function isConverged(frame: FrameRecord): boolean {
  return (
    frame.alpha === 1 &&
    Math.abs(frame.targetS - frame.s) < 1 &&
    Math.abs(frame.targetV - frame.v) < 0.1
  );
}

function checkInvariants(scenario: Scenario): InvariantReport {
  const motion = new TrainMotion(SHAPE, plan(scenario.stops), 0);
  const updates = scenarioUpdates(scenario);
  const converged = updates.map(() => false);
  const violations: string[] = [];
  let active = -1;
  simulateFrames(motion, updates, scenarioEnd(scenario, updates), FPS, (frame, previous) => {
    const violation =
      frameViolation(frame, previous) ?? (motion.sample.beyondEnd === 0 ? undefined : "off shape");
    if (violation && violations.length < 5) violations.push(`${violation} at t=${frame.time}`);
    while ((updates[active + 1]?.time ?? Number.POSITIVE_INFINITY) <= frame.time) active++;
    const deadline = (updates[active]?.time ?? Number.NEGATIVE_INFINITY) + CONVERGENCE_BOUND;
    if (active >= 0 && frame.time <= deadline && isConverged(frame)) converged[active] = true;
  });
  return { violations, converged };
}

describe("TrainMotion properties (60 fps, random plans and delay updates)", () => {
  it(`never backwards while visible, |dv/dt| within the limit, never past the cap, converged within ${CONVERGENCE_BOUND} s of every update`, {
    timeout: 600_000,
  }, () => {
    fc.assert(
      fc.property(scenarioArbitrary, (scenario) => {
        const { violations, converged } = checkInvariants(scenario);
        expect(violations).toEqual([]);
        expect(converged.every(Boolean)).toBe(true);
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });
});
