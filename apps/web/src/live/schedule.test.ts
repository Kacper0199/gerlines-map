import { describe, expect, it } from "vitest";
import type { ChainChanges } from "./chain.ts";
import { ScheduledChanges } from "./schedule.ts";

function changes(time: number, reloaded = false, shapeEpoch = 3): ChainChanges {
  return {
    time,
    shapeEpoch,
    reloaded,
    keys: reloaded ? new Set([1]) : null,
    changed: [],
    removed: [1],
  };
}

describe("ScheduledChanges", () => {
  it("hands out a frame's changes once the clock reaches its time, in order", () => {
    const queue = new ScheduledChanges(5_000);
    queue.push(changes(100), 0);
    queue.push(changes(102), 0);
    expect(queue.due(99.9, 10)).toEqual([]);
    expect(queue.due(100, 20).map((entry) => entry.changes.time)).toEqual([100]);
    expect(queue.due(101, 30)).toEqual([]);
    expect(queue.due(103, 40).map((entry) => entry.changes.time)).toEqual([102]);
    expect(queue.size).toBe(0);
  });

  it("never holds a frame longer than the limit, however far ahead its time is", () => {
    const queue = new ScheduledChanges(5_000);
    queue.push(changes(1_000_000), 1_000);
    expect(queue.due(10, 5_999)).toEqual([]);
    expect(queue.due(10, 6_000)).toHaveLength(1);
  });

  it("releases everything before a late entry in order when one entry is overdue", () => {
    const queue = new ScheduledChanges(5_000);
    queue.push(changes(500), 0);
    queue.push(changes(100), 0);
    const out = queue.due(100, 5_000);
    expect(out.map((entry) => entry.changes.time)).toEqual([500, 100]);
  });

  it("a reload replaces what is waiting and is due at once", () => {
    const queue = new ScheduledChanges(5_000);
    queue.push(changes(100), 0);
    queue.push(changes(101), 0);
    queue.push(changes(150, true), 0);
    expect(queue.size).toBe(1);
    expect(queue.due(0, 1)).toHaveLength(1);
  });

  it("drops nothing on reset but empties the queue", () => {
    const queue = new ScheduledChanges(5_000);
    queue.push(changes(100), 0);
    queue.reset();
    expect(queue.size).toBe(0);
    expect(queue.due(1_000, 10_000)).toEqual([]);
  });

  it("ignores a follow that changed nothing", () => {
    const queue = new ScheduledChanges(5_000);
    queue.push(
      { time: 100, shapeEpoch: 3, reloaded: false, keys: null, changed: [], removed: [] },
      0,
    );
    expect(queue.size).toBe(0);
  });
});
