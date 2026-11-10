import { describe, expect, it } from "vitest";
import type { LiveInstanceState } from "./engine/detail-port.ts";
import { type GiveWay, giveWayHolds, ProgressCheck } from "./render.ts";

const state = (
  id: string,
  at: number,
  lastPassedIndex: number | null,
  nextIndex: number | null,
): LiveInstanceState => ({
  tripInstanceId: id,
  key: 1,
  serviceDate: "2026-10-25",
  feedVersionId: 1,
  tripKey: null,
  category: "RE",
  source: null,
  geometry: { available: true, reason: null },
  delaySeconds: null,
  cancelled: false,
  lastPassedIndex,
  nextIndex,
  endsAt: at + 3600,
  at,
});

const update = (states: LiveInstanceState[]) => ({
  at: states[0]?.at ?? 0,
  sequence: 1,
  timetableVersion: 1,
  changed: states,
  removed: [],
});

describe("ProgressCheck (detail gate)", () => {
  it("counts a lower stop with a served stop at or below the furthest as a step back", async () => {
    const check = new ProgressCheck();
    await check.publish(update([state("a", 10, 8, 9)]));
    await check.publish(update([state("a", 20, 7, 8)]));
    expect(check.report()).toMatchObject({ backwards: 1, givenWay: 0 });
  });

  it("counts a give-way to the served stop before cancelled ones apart, not as a step back", async () => {
    const check = new ProgressCheck();
    await check.publish(update([state("a", 10, 10, 11), state("b", 10, 1, 2)]));
    await check.publish(update([state("a", 20, 9, 18), state("b", 20, 0, null)]));
    await check.publish(update([state("a", 30, 18, 19)]));
    expect(check.report()).toMatchObject({ backwards: 0, givenWay: 2, examples: [] });
    expect(check.report().givenWayExamples).toHaveLength(2);
    expect(check.report()).toMatchObject({ givenWayUnverified: 2, passed: false });
    await check.verify(async () => true);
    expect(check.report()).toMatchObject({
      givenWayVerified: 2,
      givenWayUnverified: 0,
      passed: true,
    });
  });

  it("measures later states against the furthest stop, so a give-way that then steps back counts", async () => {
    const check = new ProgressCheck();
    await check.publish(update([state("a", 10, 5, 6)]));
    await check.publish(update([state("a", 20, 4, 6)]));
    await check.publish(update([state("a", 30, 3, 5)]));
    expect(check.report()).toMatchObject({ backwards: 1, givenWay: 1 });
  });
});

describe("ProgressCheck give-way verification", () => {
  it("counts no stop after a furthest stop as a step back; for a cancelled trip it is a give-way to verify", async () => {
    const check = new ProgressCheck();
    await check.publish(update([state("a", 10, 5, 6), state("b", 10, 5, 6)]));
    await check.publish(update([state("a", 20, null, null)]));
    await check.publish(update([{ ...state("b", 20, null, null), cancelled: true }]));
    expect(check.report()).toMatchObject({ backwards: 1, givenWay: 1, passed: false });
    expect(check.report().examples[0]).toContain("a at");
  });

  it("verifies each give-way against the stops between and fails the gate on one that does not hold", async () => {
    const check = new ProgressCheck();
    await check.publish(update([state("a", 10, 10, 11), state("b", 10, 1, 2)]));
    await check.publish(update([state("a", 20, 3, 11), state("b", 20, 0, null)]));
    const asked: GiveWay[] = [];
    await check.verify(async (giveWay) => {
      asked.push(giveWay);
      return giveWay.tripInstanceId === "b";
    });
    expect(asked.map((g) => [g.tripInstanceId, g.passed, g.furthest, g.at])).toEqual([
      ["a", 3, 10, 20],
      ["b", 0, 1, 20],
    ]);
    expect(check.report()).toMatchObject({
      givenWay: 2,
      givenWayVerified: 1,
      givenWayUnverified: 1,
      passed: false,
    });
    expect(check.report().unverifiedExamples[0]).toContain("a at");
  });
});

describe("giveWayHolds", () => {
  const stop = (stopIndex: number, cancelled: boolean, passThrough = false) => ({
    stopIndex,
    cancelled,
    passThrough,
  });

  it("holds when every stop after the reported one up to the furthest is cancelled or passed through", () => {
    const stops = [
      stop(0, false),
      stop(1, true),
      stop(2, false, true),
      stop(3, true),
      stop(4, false),
    ];
    expect(giveWayHolds(stops, 0, 3)).toBe(true);
    expect(giveWayHolds(stops, 0, 4)).toBe(false);
  });

  it("does not hold when a served stop lies between, or a stop is unknown", () => {
    expect(giveWayHolds([stop(0, false), stop(1, false), stop(2, true)], 0, 2)).toBe(false);
    expect(giveWayHolds([stop(0, false), stop(2, true)], 0, 2)).toBe(false);
  });
});
