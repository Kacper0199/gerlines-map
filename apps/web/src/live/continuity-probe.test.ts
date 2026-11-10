import { describe, expect, it } from "vitest";
import type { Palette } from "../motion/frame.ts";
import { ContinuityProbe } from "./continuity-probe.ts";
import { LiveTrains } from "./live-trains.ts";
import { ShapeStore } from "./shape-store.ts";
import { stop, straightPack, TIME_BASE, trip } from "./test-frames.ts";

const PALETTE: Palette = {
  fill: {
    hsr: [1, 1, 1],
    ld: [1, 1, 1],
    night: [1, 1, 1],
    rfast: [1, 1, 1],
    reg: [1, 1, 1],
    sbahn: [1, 1, 1],
    foreign: [1, 1, 1],
  },
  land: [0, 0, 0],
};
const T0 = TIME_BASE;

async function trainsOn(): Promise<LiveTrains> {
  const store = new ShapeStore({
    fetchPack: async (_e, id) => straightPack(Number(id)),
    onLoaded: () => undefined,
    now: () => 0,
  });
  store.request(3, 7);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return new LiveTrains(store, PALETTE);
}

const RUN = [stop(T0, T0 + 60), stop(T0 + 600, T0 + 660), stop(T0 + 1500)];

function step(changed: ReturnType<typeof trip>[], removed: number[] = []) {
  return {
    time: 0,
    shapeEpoch: 3,
    reloaded: false,
    keys: null,
    changed,
    removed,
  };
}

describe("ContinuityProbe", () => {
  it("measures a smooth run without jumps, stalls or backward steps", async () => {
    const trains = await trainsOn();
    trains.apply(step([trip(1, { stops: RUN }), trip(2, { stops: RUN })]), T0 - 20);
    const probe = new ContinuityProbe(1);
    for (let t = T0 - 20; t < T0 + 1600; t += 1 / 30) {
      trains.advance(t);
      probe.observe(trains, t);
    }
    const report = probe.report();
    expect(report.measuredTrains).toBe(2);
    expect(report.frames).toBeGreaterThan(5000);
    expect(report).toMatchObject({
      jumps: 0,
      stalls: 0,
      backwardSteps: 0,
      visibleSwaps: 0,
      overspeedSteps: 0,
      offTrackFrames: 0,
    });
    expect(report.judgedPairs).toBeGreaterThan(1000);
    expect(report.maxAcceleration).toBeLessThan(1.3);
  });

  it("counts a swap drawn above opacity zero and a jump", async () => {
    const trains = await trainsOn();
    trains.apply(step([trip(1, { stops: RUN })]), T0);
    const probe = new ContinuityProbe(1);
    for (let t = T0; t < T0 + 100; t += 1 / 30) {
      trains.advance(t);
      probe.observe(trains, t);
    }
    const slot = trains.entry(1)?.slot as number;
    trains.fleet.s[slot] = (trains.fleet.s[slot] as number) + 2000;
    trains.advance(T0 + 100);
    probe.observe(trains, T0 + 100);
    const report = probe.report();
    expect(report.jumps).toBeGreaterThanOrEqual(1);
  });

  it("measures only its share of the trains", async () => {
    const trains = await trainsOn();
    const many = Array.from({ length: 200 }, (_, i) => trip(1000 + i, { stops: RUN }));
    trains.apply(step(many), T0);
    const probe = new ContinuityProbe(0.1);
    trains.advance(T0 + 1);
    probe.observe(trains, T0 + 1);
    const measured = probe.report().measuredTrains;
    expect(measured).toBeGreaterThan(5);
    expect(measured).toBeLessThan(45);
  });

  it("keeps the counts of a train that has gone", async () => {
    const trains = await trainsOn();
    trains.apply(step([trip(1, { stops: RUN })]), T0);
    const probe = new ContinuityProbe(1);
    for (let t = T0; t < T0 + 30; t += 1 / 30) {
      trains.advance(t);
      probe.observe(trains, t);
    }
    trains.apply(step([], [1]), T0 + 30);
    probe.observe(trains, T0 + 30);
    expect(probe.report().frames).toBeGreaterThan(800);
    expect(probe.report().measuredTrains).toBe(1);
  });
});
