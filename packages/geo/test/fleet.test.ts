import { describe, expect, it } from "vitest";
import { HEAD_STRIDE, MotionFleet } from "../src/fleet.ts";
import { TrainMotion } from "../src/motion.ts";
import { buildMotionPlan, type MotionPlan, planSpeed } from "../src/plan.ts";
import { createShape } from "../src/shape.ts";
import { FRANKFURT_MERCATOR } from "./arbitraries.ts";

const { x: X0, y: Y0 } = FRANKFURT_MERCATOR;
const NORTH = createShape({ x: [X0, X0], y: [Y0, Y0 + 50_000], s: [0, 50_000] });
const EAST = createShape({ x: [X0, X0 + 50_000], y: [Y0, Y0], s: [0, 50_000] });
const DYNAMICS = { maxSpeed: 44, acceleration: 0.7, deceleration: 0.8 };

function planFrom(start: number, delay = 0): MotionPlan {
  return buildMotionPlan({
    stops: [
      { s: 0, departure: start + delay },
      { s: 20_000, arrival: start + 900 + delay, departure: start + 960 + delay },
      { s: 45_000, arrival: start + 2000 + delay },
    ],
    dynamics: DYNAMICS,
  });
}

describe("MotionFleet", () => {
  it("advances each slot exactly like a train on its own", () => {
    const fleet = new MotionFleet();
    const a = fleet.add(NORTH, planFrom(0), 0);
    const b = fleet.add(EAST, planFrom(100), 0);
    const aloneA = new TrainMotion(NORTH, planFrom(0), 0);
    const aloneB = new TrainMotion(EAST, planFrom(100), 0);
    for (let n = 1; n <= 60 * 1200; n++) {
      const now = n / 60;
      if (n === 60 * 600) {
        fleet.update(b, planFrom(100, 120), now);
        aloneB.update(planFrom(100, 120), now);
      }
      fleet.advance(now);
      aloneA.advance(now);
      aloneB.advance(now);
    }
    expect(fleet.s[a]).toBe(aloneA.s);
    expect(fleet.s[b]).toBe(aloneB.s);
    expect(fleet.v[b]).toBe(aloneB.v);
  });

  it("keeps every slot exact through leg pool growth, compaction and slot reuse", () => {
    const fleet = new MotionFleet();
    const alone: (TrainMotion | undefined)[] = [];
    const longPlan = (start: number, stops: number) =>
      buildMotionPlan({
        stops: Array.from({ length: stops }, (_, k) => ({
          s: (k * 45_000) / (stops - 1),
          arrival: start + k * 400,
          departure: start + k * 400 + 30,
        })),
        dynamics: DYNAMICS,
      });
    for (let i = 0; i < 300; i++) {
      const plan = longPlan(-i, 2 + (i % 5));
      expect(fleet.add(EAST, plan, 0)).toBe(i);
      alone.push(new TrainMotion(EAST, plan, 0));
    }
    for (let n = 1; n <= 600; n++) {
      const now = n / 10;
      if (n % 50 === 0) {
        for (let i = n % 7; i < 300; i += 7) {
          const plan = longPlan(-i + n / 100, 3 + ((i + n) % 9));
          fleet.update(i, plan, now);
          alone[i]?.update(plan, now);
        }
        const gone = (n / 50) * 11;
        fleet.remove(gone);
        alone[gone] = undefined;
        const plan = longPlan(n / 10, 8);
        expect(fleet.add(EAST, plan, now)).toBe(gone);
        alone[gone] = new TrainMotion(EAST, plan, now);
      }
      fleet.advance(now);
      for (const train of alone) train?.advance(now);
    }
    alone.forEach((train, i) => {
      expect(fleet.s[i]).toBe(train?.s);
    });
  });

  it("grows past its initial capacity and keeps earlier slots intact", () => {
    const fleet = new MotionFleet();
    const slots = Array.from({ length: 100 }, (_, i) => fleet.add(EAST, planFrom(-i * 10), 0));
    fleet.advance(30);
    expect(slots[99]).toBe(99);
    expect(fleet.count).toBe(100);
    expect(fleet.s[0]).toBeGreaterThanOrEqual(0);
    expect(fleet.time[57]).toBe(30);
  });

  it("skips removed slots and reuses them", () => {
    const fleet = new MotionFleet();
    const first = fleet.add(EAST, planFrom(0), 0);
    fleet.add(NORTH, planFrom(0), 0);
    fleet.remove(first);
    fleet.advance(500);
    expect(fleet.time[first]).toBe(0);
    expect(fleet.alpha[first]).toBe(0);
    const again = fleet.add(NORTH, planFrom(0), 500);
    expect(again).toBe(first);
    expect(fleet.alive[first]).toBe(1);
    expect(fleet.shapeOf(first)).toBe(NORTH);
  });

  it("writes head poses relative to the origin with heading and opacity", () => {
    const fleet = new MotionFleet();
    fleet.add(NORTH, planFrom(0), 0);
    const removed = fleet.add(EAST, planFrom(0), 0);
    fleet.add(EAST, planFrom(0), 0);
    fleet.remove(removed);
    for (let n = 1; n <= 600; n++) fleet.advance(300 + n / 60);
    const out = new Float32Array(fleet.count * HEAD_STRIDE);
    fleet.writeHeads(X0, Y0, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(fleet.s[0] as number, 2);
    expect(out[3]).toBeCloseTo(Math.PI / 2, 6);
    expect(out[4]).toBe(1);
    expect(out[HEAD_STRIDE + 4]).toBe(0);
    expect(out[2 * HEAD_STRIDE]).toBeCloseTo(fleet.s[2] as number, 2);
    expect(out[2 * HEAD_STRIDE + 3]).toBeCloseTo(0, 6);
  });

  it("keeps Float32 output at centimetre precision near the origin", () => {
    const fleet = new MotionFleet();
    fleet.add(EAST, planFrom(0), 300);
    const out = new Float32Array(HEAD_STRIDE);
    fleet.writeHeads(X0 + 10_000, Y0, out);
    expect(Math.abs((out[0] as number) - ((fleet.x[0] as number) - X0 - 10_000))).toBeLessThan(
      0.01,
    );
  });

  it("hides a slot whose target is not finite and brings it back on the next valid plan", () => {
    const fleet = new MotionFleet();
    const slot = fleet.add(EAST, planFrom(0), 0);
    for (let n = 1; n <= 60 * 300; n++) fleet.advance(n / 60);
    const valid = planFrom(0);
    const legData = valid.legData.slice();
    legData[4] = Number.NaN;
    const broken: MotionPlan = { ...valid, legData };
    const result = fleet.update(slot, broken, 300);
    expect(result.crossfade).toBe("invalid");
    expect(fleet.lastCrossfade(slot)).toBe("invalid");
    fleet.advance(310);
    expect(fleet.alpha[slot]).toBe(0);
    const out = new Float32Array(HEAD_STRIDE);
    fleet.writeHeads(X0, Y0, out);
    expect(out[4]).toBe(0);
    expect(Number.isFinite(out[0]) && Number.isFinite(out[1])).toBe(true);
    const back = fleet.update(slot, planFrom(0), 310);
    expect(back.crossfade).toBe("invalid");
    for (let n = 1; n <= 60; n++) fleet.advance(310 + n / 60);
    expect(fleet.alpha[slot]).toBe(1);
    expect(fleet.s[slot]).toBeCloseTo(fleet.targetS[slot] as number, 6);
  });

  it("hides a slot whose plan turns non-finite between updates", () => {
    const fleet = new MotionFleet();
    const valid = planFrom(0);
    const legData = valid.legData.slice();
    legData[4] = Number.NaN;
    const slot = fleet.add(EAST, { ...valid, legData }, 0);
    for (let n = 1; n <= 60 * 300; n++) fleet.advance(n / 60);
    expect(fleet.lastCrossfade(slot)).toBe("invalid");
    expect(fleet.alpha[slot]).toBe(0);
    expect(Number.isFinite(fleet.x[slot])).toBe(true);
  });

  it("runs a plan built with NaN and zero speed limits with finite state", () => {
    const fleet = new MotionFleet();
    const plan = buildMotionPlan({
      stops: [
        { s: 0, departure: 0 },
        { s: 20_000, arrival: 900, departure: 960 },
        { s: 45_000, arrival: 2000 },
      ],
      dynamics: DYNAMICS,
      legSpeedLimits: [Number.NaN, 0],
    });
    const slot = fleet.add(EAST, plan, 0);
    for (let n = 1; n <= 60 * 2100; n++) fleet.advance(n / 60);
    expect(fleet.s[slot]).toBeCloseTo(45_000, 6);
    expect(fleet.alpha[slot]).toBe(1);
  });

  it("keeps the head on the shape when plan stops lie outside it, and counts such plans", () => {
    const fleet = new MotionFleet();
    const outside = buildMotionPlan({
      stops: [
        { s: -20, departure: 0 },
        { s: 20_000, arrival: 900, departure: 960 },
        { s: 50_015, arrival: 2000 },
      ],
      dynamics: DYNAMICS,
    });
    const slot = fleet.add(EAST, outside, 0);
    expect(fleet.outOfRangePlans).toBe(1);
    let beyond = 0;
    for (let n = 1; n <= 60 * 2100; n++) {
      fleet.advance(n / 60);
      beyond = Math.max(beyond, fleet.beyondEnd[slot] as number);
    }
    expect(beyond).toBe(0);
    expect(fleet.s[slot]).toBeCloseTo(50_000, 6);
    expect(fleet.s[slot]).toBeLessThanOrEqual(50_000);
    fleet.update(slot, planFrom(0), 2100);
    expect(fleet.outOfRangePlans).toBe(1);
    fleet.update(slot, outside, 2100);
    expect(fleet.outOfRangePlans).toBe(2);
  });

  it("holds a hand-built plan that starts before the shape at arc length 0", () => {
    const fleet = new MotionFleet();
    const valid = planFrom(100);
    const legData = valid.legData.slice();
    legData[2] = -20;
    const slot = fleet.add(EAST, { ...valid, legData }, 0);
    expect(fleet.outOfRangePlans).toBe(1);
    expect(fleet.s[slot]).toBe(0);
    expect(fleet.targetV[slot]).toBe(0);
  });

  it("refuses to write heads into an array that is too short", () => {
    const fleet = new MotionFleet();
    fleet.add(EAST, planFrom(0), 0);
    fleet.add(NORTH, planFrom(0), 0);
    expect(() => fleet.writeHeads(X0, Y0, new Float32Array(2 * HEAD_STRIDE - 1))).toThrow(
      RangeError,
    );
  });

  it("writes the heads of a slot subset in the given order", () => {
    const fleet = new MotionFleet();
    const east = fleet.add(EAST, planFrom(0), 0);
    const north = fleet.add(NORTH, planFrom(0), 0);
    const gone = fleet.add(EAST, planFrom(0), 0);
    fleet.remove(gone);
    for (let n = 1; n <= 600; n++) fleet.advance(300 + n / 60);
    const all = new Float32Array(3 * HEAD_STRIDE);
    fleet.writeHeads(X0, Y0, all);
    const slots = new Int32Array([north, gone, east, 99]);
    const out = new Float32Array(3 * HEAD_STRIDE);
    fleet.writeHeadSlots(slots, 3, X0, Y0, out);
    expect(Array.from(out.subarray(0, HEAD_STRIDE))).toEqual(
      Array.from(all.subarray(north * HEAD_STRIDE, (north + 1) * HEAD_STRIDE)),
    );
    expect(out[HEAD_STRIDE + 4]).toBe(0);
    expect(Array.from(out.subarray(2 * HEAD_STRIDE))).toEqual(
      Array.from(all.subarray(east * HEAD_STRIDE, (east + 1) * HEAD_STRIDE)),
    );
    expect(() => fleet.writeHeadSlots(slots, 4, X0, Y0, new Float32Array(20))).toThrow(RangeError);
    expect(() => fleet.writeHeadSlots(slots, 5, X0, Y0, new Float32Array(25))).toThrow(RangeError);
    expect(() => fleet.writeHeadSlots(slots, 3, X0, Y0, new Float32Array(14))).toThrow(RangeError);
  });

  it("scales the offsets for a renderer that expects ground metres", () => {
    const fleet = new MotionFleet();
    fleet.add(NORTH, planFrom(0), 0);
    for (let n = 1; n <= 600; n++) fleet.advance(300 + n / 60);
    const plain = new Float32Array(HEAD_STRIDE);
    const scaled = new Float32Array(HEAD_STRIDE);
    fleet.writeHeads(X0, Y0 - 1000, plain);
    fleet.writeHeads(X0, Y0 - 1000, scaled, 0.64);
    expect(scaled[1]).toBeCloseTo((plain[1] as number) * 0.64, 2);
    expect(scaled[3]).toBe(plain[3]);
    expect(() => fleet.writeHeads(X0, Y0, scaled, 0)).toThrow(RangeError);
  });

  it("refuses updates and lookups on a removed slot", () => {
    const fleet = new MotionFleet();
    const slot = fleet.add(EAST, planFrom(0), 0);
    fleet.remove(slot);
    expect(() => fleet.update(slot, planFrom(0), 10)).toThrow(RangeError);
    expect(() => fleet.shapeOf(slot)).toThrow(RangeError);
    expect(() => fleet.planOf(slot)).toThrow(RangeError);
    fleet.advanceSlot(slot, 10);
    expect(fleet.time[slot]).toBe(0);
    expect(() => fleet.update(7, planFrom(0), 10)).toThrow(RangeError);
  });
});

describe("MotionFleet.settleFades", () => {
  it("shows a train that is fading in at full opacity at once, for a clock that stands still", () => {
    const fleet = new MotionFleet();
    const slot = fleet.add(NORTH, planFrom(0), 100);
    fleet.advance(100);
    expect(fleet.alpha[slot]).toBe(0);
    fleet.settleFades(100);
    expect(fleet.alpha[slot]).toBe(1);
    const s = fleet.s[slot];
    fleet.advance(100);
    expect(fleet.s[slot]).toBe(s);
    expect(fleet.alpha[slot]).toBe(1);
  });

  it("swaps in the pending plan of a train that is fading out and shows it", () => {
    const fleet = new MotionFleet();
    const slot = fleet.add(NORTH, planFrom(0), 0);
    for (let n = 1; n <= 600; n++) fleet.advance(n / 10);
    fleet.update(slot, planFrom(0, 1500), 60);
    fleet.advance(60.1);
    expect(fleet.alpha[slot]).toBeLessThan(1);
    fleet.settleFades(60.1);
    expect(fleet.alpha[slot]).toBe(1);
    expect(fleet.swaps[slot]).toBeGreaterThan(0);
  });

  it("leaves a train that is not fading alone", () => {
    const fleet = new MotionFleet();
    const slot = fleet.add(NORTH, planFrom(0), 0);
    for (let n = 1; n <= 100; n++) fleet.advance(n / 10);
    const s = fleet.s[slot];
    fleet.settleFades(10);
    expect(fleet.alpha[slot]).toBe(1);
    expect(fleet.s[slot]).toBe(s);
  });
});

describe("MotionFleet.planSpeed", () => {
  it("is the speed of the plan at the slot's own time, zero in a dwell, undefined after the plan", () => {
    const fleet = new MotionFleet();
    const plan = planFrom(100);
    const slot = fleet.add(NORTH, plan, 90);
    expect(fleet.planSpeed(slot)).toBe(0);
    for (const t of [100.5, 400, 700, 1040, 1500, 2050]) {
      fleet.advance(t);
      expect(fleet.planSpeed(slot)).toBe(planSpeed(plan, t));
    }
    expect(fleet.planSpeed(slot)).toBeGreaterThan(0);
    fleet.advance(2100);
    expect(fleet.planSpeed(slot)).toBeUndefined();
  });

  it("agrees with the display speed once the display follows the plan", () => {
    const fleet = new MotionFleet();
    const slot = fleet.add(NORTH, planFrom(0), 0);
    for (let n = 1; n <= 60 * 400; n++) fleet.advance(n / 60);
    const speed = fleet.planSpeed(slot) as number;
    expect(speed).toBeGreaterThan(10);
    expect(Math.abs((fleet.v[slot] as number) - speed)).toBeLessThan(0.5);
  });

  it("follows the plan that replaced the old one and ignores the fade that swaps it", () => {
    const fleet = new MotionFleet();
    const slot = fleet.add(NORTH, planFrom(0), 0);
    for (let n = 1; n <= 600; n++) fleet.advance(n / 10);
    const later = planFrom(0, 1500);
    fleet.update(slot, later, 60);
    fleet.settleFades(60);
    expect(fleet.planSpeed(slot)).toBe(planSpeed(later, fleet.time[slot] as number));
    expect(fleet.planSpeed(slot)).toBe(0);
  });

  it("is undefined for a free slot and for a train hidden by a state that is not finite", () => {
    const fleet = new MotionFleet();
    const valid = planFrom(0);
    const legData = valid.legData.slice();
    legData[4] = Number.NaN;
    const hidden = fleet.add(EAST, { ...valid, legData }, 0);
    const freed = fleet.add(NORTH, planFrom(0), 0);
    fleet.remove(freed);
    for (let n = 1; n <= 60 * 300; n++) fleet.advance(n / 60);
    expect(fleet.planSpeed(hidden)).toBeUndefined();
    expect(fleet.planSpeed(freed)).toBeUndefined();
  });

  it("stands still for a target outside the shape", () => {
    const fleet = new MotionFleet();
    const plan = buildMotionPlan({
      stops: [
        { s: 0, departure: 0 },
        { s: 80_000, arrival: 1500 },
      ],
      dynamics: DYNAMICS,
    });
    const slot = fleet.add(NORTH, plan, 0);
    fleet.advance(1450);
    expect(fleet.planSpeed(slot)).toBe(0);
  });
});
