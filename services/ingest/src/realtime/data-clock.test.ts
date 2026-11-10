import { describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import { DataClock } from "./data-clock.ts";

function wallAt(start: number): Clock & { set(at: number): void } {
  let now = start;
  return {
    now: () => now,
    sleep: async () => {},
    set: (at) => {
      now = at;
    },
  };
}

const NOV_3 = Date.parse("2026-11-03T17:00:00Z");
const OCT_25 = Date.parse("2026-10-25T00:00:00Z");

describe("DataClock", () => {
  it("reads the recordings' time while a run catches up on days of payloads", () => {
    const clock = new DataClock(wallAt(NOV_3), OCT_25);
    expect(clock.now()).toBe(OCT_25);
    clock.observe(OCT_25 + 3_600_000);
    expect(clock.now()).toBe(OCT_25 + 3_600_000);
  });

  it("never runs ahead of the wall clock once caught up", () => {
    const wall = wallAt(NOV_3);
    const clock = new DataClock(wall, NOV_3 - 60_000);
    clock.observe(NOV_3 + 5_000);
    expect(clock.now()).toBe(NOV_3);
    wall.set(NOV_3 + 10_000);
    expect(clock.now()).toBe(NOV_3 + 5_000);
  });

  it("never goes backwards, not for an older payload nor a wall clock step back", () => {
    const wall = wallAt(NOV_3);
    const clock = new DataClock(wall, NOV_3 - 60_000);
    clock.observe(NOV_3);
    const before = clock.now();
    clock.observe(NOV_3 - 3_600_000);
    expect(clock.now()).toBe(before);
    wall.set(NOV_3 - 1_000);
    expect(clock.now()).toBe(before);
  });

  it("stays at the newest payload while the feeds are silent", () => {
    const wall = wallAt(NOV_3);
    const clock = new DataClock(wall, NOV_3 - 60_000);
    clock.observe(NOV_3);
    wall.set(NOV_3 + 600_000);
    expect(clock.now()).toBe(NOV_3);
  });

  it("keeps the wall clock for the wall time of a log line", () => {
    const wall = wallAt(NOV_3);
    const clock = new DataClock(wall, OCT_25);
    expect(clock.wall.now()).toBe(NOV_3);
  });
});
