import { describe, expect, it } from "vitest";
import { ContinuityMeter, DEFAULT_CONTINUITY } from "../src/continuity.ts";
import { groundDistance } from "../src/mercator.ts";
import { createShape } from "../src/shape.ts";
import { FRANKFURT_MERCATOR } from "./arbitraries.ts";
import { seededRandom } from "./ice379.ts";

const { x: X0, y: Y0 } = FRANKFURT_MERCATOR;
const MERCATOR_PER_METRE = 1 / groundDistance(X0, Y0, X0 + 1, Y0);
const DT = 1 / 60;

function feed(meter: ContinuityMeter, positions: number[], alpha: (n: number) => number = () => 1) {
  positions.forEach((metres, n) => {
    meter.observe(n * DT, X0 + metres * MERCATOR_PER_METRE, Y0, alpha(n), metres);
  });
}

describe("ContinuityMeter", () => {
  it("reports ratio 1 and no jumps for constant speed", () => {
    const meter = new ContinuityMeter();
    feed(
      meter,
      Array.from({ length: 600 }, (_, n) => n * DT * 30),
    );
    const report = meter.report();
    expect(report.jumps).toBe(0);
    expect(report.maxRatio).toBeCloseTo(1, 6);
    expect(report.maxStep).toBeCloseTo(0.5, 6);
    expect(report.visiblePairs).toBe(599);
  });

  it("does not flag a start from rest at the acceleration limit", () => {
    const meter = new ContinuityMeter();
    feed(
      meter,
      Array.from({ length: 600 }, (_, n) => 0.5 * 1.2 * (n * DT) ** 2),
    );
    const report = meter.report();
    expect(report.jumps).toBe(0);
    expect(report.maxRatio).toBeLessThan(1.1);
    expect(report.maxAcceleration).toBeCloseTo(1.2, 3);
  });

  it("counts a 10 m teleport at 30 m/s as a jump", () => {
    const meter = new ContinuityMeter();
    feed(
      meter,
      Array.from({ length: 120 }, (_, n) => n * DT * 30 + (n >= 60 ? 10 : 0)),
    );
    const report = meter.report();
    expect(report.jumps).toBe(1);
    expect(report.maxRatio).toBeCloseTo(10.5 / 0.5, 3);
  });

  it("counts a sudden stop as a stall", () => {
    const meter = new ContinuityMeter();
    feed(
      meter,
      Array.from({ length: 120 }, (_, n) => Math.min(n, 60) * DT * 30),
    );
    expect(meter.report().stalls).toBe(1);
  });

  it("ignores displacement across frames where the train is hidden", () => {
    const meter = new ContinuityMeter();
    feed(
      meter,
      Array.from({ length: 120 }, (_, n) => n * DT * 30 + (n >= 60 ? 5000 : 0)),
      (n) => (n === 60 ? 0 : 1),
    );
    const report = meter.report();
    expect(report.jumps).toBe(0);
    expect(report.hiddenFrames).toBe(1);
  });

  it("takes acceleration from arc length so a sharp polyline corner does not read as one", () => {
    const meter = new ContinuityMeter();
    const speed = 60;
    for (let n = 0; n < 120; n++) {
      const s = n * DT * speed;
      const alongFirst = Math.min(s, 30);
      const alongSecond = Math.max(0, s - 30);
      const x = X0 + alongFirst * MERCATOR_PER_METRE;
      const y = Y0 + alongSecond * MERCATOR_PER_METRE;
      meter.observe(n * DT, x, y, 1, s);
    }
    const report = meter.report();
    expect(report.maxAcceleration).toBeLessThan(1e-6);
    expect(report.jumps).toBe(0);
  });

  it("counts visible backward steps from arc length", () => {
    const meter = new ContinuityMeter();
    feed(meter, [0, 1, 2, 1.5, 3]);
    expect(meter.report().backwardSteps).toBe(1);
  });

  it("does not flag starts, stops or steady motion at jittered frame intervals of 1/120 to 0.25 s", () => {
    const random = seededRandom(7);
    for (let run = 0; run < 50; run++) {
      const meter = new ContinuityMeter();
      let t = 0;
      for (let n = 0; n < 400; n++) {
        t += 1 / 120 + random() * (0.25 - 1 / 120);
        const moving = Math.min(t, 20);
        const braking = Math.max(0, Math.min(t - 40, 20));
        const s = 0.6 * moving * moving + 24 * Math.max(0, t - 20) - 0.6 * braking * braking;
        meter.observe(t, X0 + s * MERCATOR_PER_METRE, Y0, 1, s);
      }
      const report = meter.report();
      expect([report.jumps, report.stalls]).toEqual([0, 0]);
      expect(report.maxRatio).toBeLessThan(1.1);
    }
  });

  it("still counts a 10 m teleport at 30 m/s at jittered frame intervals", () => {
    const random = seededRandom(11);
    const meter = new ContinuityMeter();
    let t = 0;
    for (let n = 0; n < 200; n++) {
      t += 1 / 120 + random() * (0.25 - 1 / 120);
      const s = 30 * t + (n >= 100 ? 10 : 0);
      meter.observe(t, X0 + s * MERCATOR_PER_METRE, Y0, 1, s);
    }
    expect(meter.report().jumps).toBe(1);
  });

  it("counts a swap drawn above opacity 0 and ignores one drawn hidden", () => {
    const meter = new ContinuityMeter();
    meter.observe(0, X0, Y0, 1, 0);
    meter.observe(DT, X0 + 5000, Y0, 0.4, 3000, true);
    meter.observe(2 * DT, X0 + 5001, Y0, 0, 3001, true);
    expect(meter.report().visibleSwaps).toBe(1);
  });

  it("counts steps faster than the absolute speed ceiling", () => {
    const meter = new ContinuityMeter();
    feed(
      meter,
      Array.from({ length: 60 }, (_, n) => DT * (80 * Math.min(n, 30) + 160 * Math.max(0, n - 30))),
    );
    const report = meter.report();
    expect(report.overspeedSteps).toBe(29);
    expect(report.maxSpeed).toBeCloseTo(160, 6);
  });

  it("measures the distance of drawn positions to the polyline near their arc length", () => {
    const shape = createShape({ x: [X0, X0 + 1000, X0 + 1000], y: [Y0, Y0, Y0 + 1000] });
    const meter = new ContinuityMeter(DEFAULT_CONTINUITY, shape);
    const metre = MERCATOR_PER_METRE;
    meter.observe(0, X0 + 100, Y0, 1, 100 / metre);
    meter.observe(DT, X0 + 1000, Y0 + 50, 1, groundDistance(X0, Y0, X0 + 1000, Y0 + 50));
    expect(meter.report().offTrackFrames).toBe(0);
    expect(meter.report().maxTrackDistance).toBeLessThan(1e-6);
    meter.observe(2 * DT, X0 + 1000 + metre, Y0 + 60, 1);
    meter.observe(3 * DT, X0 + 1000, Y0 + 1000 + 10 * metre, 1, shape.length + 10);
    meter.observe(4 * DT, X0 + 500, Y0 + 500, 0, 500);
    const report = meter.report();
    expect(report.offTrackFrames).toBe(2);
    expect(Math.abs(report.maxTrackDistance - 10)).toBeLessThan(0.05);
  });

  it("documents its thresholds", () => {
    expect(DEFAULT_CONTINUITY).toEqual({
      jumpRatio: 2,
      stallRatio: 0.5,
      displacementFloor: 0.01,
      jumpAcceleration: 36,
      speedCeiling: 150,
      trackTolerance: 0.01,
      trackWindow: 100,
    });
  });
});
