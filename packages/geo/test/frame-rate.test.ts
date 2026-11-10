import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTROLLER, TrainMotion } from "../src/motion.ts";
import { buildMotionPlan, type MotionPlan, type PlanStop } from "../src/plan.ts";
import { createShape } from "../src/shape.ts";
import { FRANKFURT_MERCATOR, PROPERTY_SEED } from "./arbitraries.ts";
import { seededRandom } from "./ice379.ts";
import { type FrameRecord, jitteredFrameTimes, simulateFrameTimes } from "./simulate.ts";

const DYNAMICS = { maxSpeed: 44.4, acceleration: 0.7, deceleration: 0.8 };
const { x: X0, y: Y0 } = FRANKFURT_MERCATOR;
const EAST = createShape({ x: [X0, X0 + 100_000], y: [Y0, Y0], s: [0, 100_000] });
const NORTH = createShape({ x: [X0, X0], y: [Y0, Y0 + 100_000], s: [0, 100_000] });
const MIN_INTERVAL = 1 / 120;
const MAX_INTERVAL = 0.25;

const STOPS: PlanStop[] = [
  { s: 0, departure: 100 },
  { s: 12_000, arrival: 600, departure: 660 },
  { s: 30_000, arrival: 1300, departure: 1360 },
  { s: 50_000, arrival: 2100 },
];

function plan(delay: number): MotionPlan {
  return buildMotionPlan({
    stops: STOPS.map((stop, k) =>
      k === 0
        ? stop
        : {
            s: stop.s,
            arrival: (stop.arrival ?? 0) + delay,
            departure: stop.departure === undefined ? undefined : stop.departure + delay,
          },
    ),
    dynamics: DYNAMICS,
  });
}

interface SwapCase {
  readonly at: number;
  readonly delay: number;
  readonly newShape: boolean;
  readonly frameSeed: number;
  readonly fixedInterval: number | undefined;
  readonly timeScale: number;
}

const swapCase: fc.Arbitrary<SwapCase> = fc.record({
  at: fc.double({ min: 150, max: 2000, noNaN: true }),
  delay: fc.constantFrom(-900, -600, 600, 900, 0),
  newShape: fc.boolean(),
  frameSeed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  fixedInterval: fc.option(fc.double({ min: MIN_INTERVAL, max: MAX_INTERVAL, noNaN: true }), {
    nil: undefined,
  }),
  timeScale: fc.constantFrom(1, 1, 10),
});

function runSwapCase(c: SwapCase): FrameRecord[] {
  const start = c.at - 3;
  const motion = new TrainMotion(EAST, plan(0), start);
  motion.timeScale = c.timeScale;
  const random = seededRandom(c.frameSeed);
  const scale = c.timeScale;
  const frameTimes =
    c.fixedInterval === undefined
      ? jitteredFrameTimes(start, MIN_INTERVAL * scale, MAX_INTERVAL * scale, random)
      : (n: number) => start + n * (c.fixedInterval as number) * scale;
  const frames: FrameRecord[] = [];
  simulateFrameTimes(
    motion,
    [{ time: c.at, plan: plan(c.delay), ...(c.newShape ? { shape: NORTH } : {}) }],
    c.at + 4 * scale,
    frameTimes,
    (frame) => frames.push({ ...frame }),
  );
  return frames;
}

describe("crossfades at any frame rate (1/120 s to 0.25 s per frame)", () => {
  it("draws the frame of every swap at opacity 0", () => {
    fc.assert(
      fc.property(swapCase, (c) => {
        const frames = runSwapCase(c);
        const visibleSwaps = frames.filter((f) => f.swapped && f.alpha > 0);
        expect(visibleSwaps).toEqual([]);
        expect(frames.every((f) => f.alpha >= 0 && f.alpha <= 1)).toBe(true);
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });

  it("ends a frame whose fade-out completes early at opacity 0 on the new target", () => {
    const motion = new TrainMotion(EAST, plan(0), 1000);
    motion.advance(1001);
    const result = motion.update(plan(600), 1001);
    expect(result.crossfade).toBe("distance");
    motion.advance(1001 + 1 / 6);
    expect(motion.alpha).toBeGreaterThan(0);
    motion.advance(1001 + 2 / 6);
    expect(motion.swapCount).toBe(1);
    expect(motion.alpha).toBe(0);
    expect(motion.s).toBe(motion.target.s);
    expect(motion.time).toBe(1001 + 2 / 6);
  });

  it("keeps fades and the resync gap in wall-clock time at a 10x time scale", () => {
    const motion = new TrainMotion(EAST, plan(0), 1000);
    motion.timeScale = 10;
    motion.advance(1000 + 1.25);
    expect(motion.alpha).toBeCloseTo(0.5, 9);
    motion.advance(1000 + 2.5);
    expect(motion.alpha).toBe(1);
    motion.advance(1000 + 2.5 + 40);
    expect(motion.lastCrossfade).toBe("start");
    motion.advance(1000 + 2.5 + 40 + 51);
    expect(motion.lastCrossfade).toBe("gap");
    expect(DEFAULT_CONTROLLER.resyncGap * 10).toBeLessThan(51);
  });

  it("continues a fade without a step when the time scale changes during it", () => {
    const motion = new TrainMotion(EAST, plan(0), 1000);
    motion.advance(1000.125);
    expect(motion.alpha).toBeCloseTo(0.5, 9);
    motion.timeScale = 10;
    motion.advance(1000.125 + 0.25);
    expect(motion.alpha).toBeCloseTo(0.6, 9);
  });

  it("rejects a time scale that is not finite and above 0", () => {
    const motion = new TrainMotion(EAST, plan(0), 0);
    expect(() => {
      motion.timeScale = 0;
    }).toThrow(RangeError);
    expect(() => {
      motion.timeScale = Number.NaN;
    }).toThrow(RangeError);
    expect(motion.timeScale).toBe(1);
  });
});
