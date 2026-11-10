import { describe, expect, it } from "vitest";
import { DEFAULT_CONTROLLER } from "../src/motion.ts";
import { DELAY_STEPS_SECONDS, type DelayStep, loadIce379, seededRandom } from "./ice379.ts";
import { type LegPhase, phaseTime, runScenario, type ScenarioResult } from "./ice379-scenario.ts";

const train = loadIce379();
const FRANKFURT_TO_MANNHEIM = 5;
const PHASES: LegPhase[] = ["accelerating", "cruising", "decelerating", "dwelling"];

function expectSmoothAndOnTrack(result: ScenarioResult): void {
  expect(result.continuity.jumps).toBe(0);
  expect(result.continuity.stalls).toBe(0);
  expect(result.continuity.backwardSteps).toBe(0);
  expect(result.continuity.visibleSwaps).toBe(0);
  expect(result.continuity.overspeedSteps).toBe(0);
  expect(result.continuity.offTrackFrames).toBe(0);
  expect(result.maxHeadBeyondShape).toBe(0);
  expect(result.maxSpeedOverCeiling).toBeLessThanOrEqual(1e-9);
  for (const update of result.updates) {
    if (update.crossfade === undefined && !update.superseded)
      expect(update.convergenceTime).toBeDefined();
  }
}

describe("ICE 379 with injected delay steps (60 fps)", () => {
  for (const delay of DELAY_STEPS_SECONDS) {
    for (const phase of PHASES) {
      it(`absorbs a ${delay / 60} min step while ${phase} without a jump`, () => {
        const time = phaseTime(train, FRANKFURT_TO_MANNHEIM, phase);
        const result = runScenario(train, [{ time, delay }], {
          from: time - 120,
          until: time + 1500,
        });
        expectSmoothAndOnTrack(result);
        expect(result.updates).toHaveLength(1);
      });
    }
  }

  it("absorbs six random steps over the whole trip, three seeds", { timeout: 60_000 }, () => {
    const first = train.stops[0]?.departure ?? 0;
    const last = train.stops[train.stops.length - 1]?.arrival ?? 0;
    for (const seed of [1, 2, 3]) {
      const random = seededRandom(seed);
      const steps: DelayStep[] = Array.from({ length: 6 }, () => ({
        time: first + random() * (last - first),
        delay: DELAY_STEPS_SECONDS[Math.floor(random() * DELAY_STEPS_SECONDS.length)] ?? 120,
      }));
      const result = runScenario(train, steps, { from: first - 60, until: last + 1200 });
      expectSmoothAndOnTrack(result);
      expect(result.continuity.judgedPairs).toBeGreaterThan(1_000_000);
    }
  });

  it("absorbs six random steps at a variable frame rate and at 10x replay", {
    timeout: 60_000,
  }, () => {
    const first = train.stops[0]?.departure ?? 0;
    const last = train.stops[train.stops.length - 1]?.arrival ?? 0;
    const random = seededRandom(4);
    const steps: DelayStep[] = Array.from({ length: 6 }, () => ({
      time: first + random() * (last - first),
      delay: DELAY_STEPS_SECONDS[Math.floor(random() * DELAY_STEPS_SECONDS.length)] ?? 120,
    }));
    const window = { from: first - 60, until: last + 1200 };
    const variable = runScenario(train, steps, {
      ...window,
      jitter: { min: 1 / 120, max: 0.25, seed: 4 },
    });
    expectSmoothAndOnTrack(variable);
    expect(variable.continuity.judgedPairs).toBeGreaterThan(100_000);
    const replay = runScenario(train, steps, { ...window, timeScale: 10 });
    expectSmoothAndOnTrack(replay);
    expect(replay.continuity.judgedPairs).toBeGreaterThan(100_000);
  });

  it("uses the controller defaults of docs/architecture.md section 8.1", () => {
    expect(DEFAULT_CONTROLLER).toMatchObject({
      gainTime: 4,
      accelerationLimit: 1.2,
      speedFactor: 1.5,
      speedOffset: 8,
      crossfadeDistance: 3000,
      fadeOutDuration: 0.25,
    });
  });
});
