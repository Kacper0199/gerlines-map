import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROPERTY_SEED } from "./arbitraries.ts";
import { runStress } from "./stress-scenario.ts";

describe("controller under realistic realtime (curved 120 km shapes, 24 to 120 fps with jitter, updates every 20 to 60 s, epoch 1.8e9)", () => {
  it("never jumps, stalls, reverses, passes a cap, leaves the track or shows a swap", {
    timeout: 120_000,
  }, () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const result = runStress({ seed, windowSeconds: 1200 });
        const c = result.continuity;
        expect(result.violations).toEqual([]);
        expect({
          jumps: c.jumps,
          stalls: c.stalls,
          backwardSteps: c.backwardSteps,
          visibleSwaps: c.visibleSwaps,
          overspeedSteps: c.overspeedSteps,
          offTrackFrames: c.offTrackFrames,
        }).toEqual({
          jumps: 0,
          stalls: 0,
          backwardSteps: 0,
          visibleSwaps: 0,
          overspeedSteps: 0,
          offTrackFrames: 0,
        });
        expect(result.updates).toBeGreaterThan(15);
      }),
      { seed: PROPERTY_SEED, numRuns: 40 },
    );
  });
});
