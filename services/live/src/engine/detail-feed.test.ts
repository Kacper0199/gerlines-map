import { describe, expect, it } from "vitest";
import { DETAIL_HEARTBEAT_S, DetailDispatcher, progressOf } from "./detail-feed.ts";
import type { LiveInstanceState, LiveTickUpdate } from "./detail-port.ts";

function state(id: string, at: number): LiveInstanceState {
  return {
    tripInstanceId: id,
    key: 1,
    serviceDate: "2026-10-25",
    feedVersionId: 1,
    tripKey: null,
    category: "reg",
    source: null,
    geometry: { available: true, reason: null },
    delaySeconds: null,
    cancelled: false,
    lastPassedIndex: null,
    nextIndex: 0,
    endsAt: 2000,
    at,
  };
}

function update(
  at: number,
  changed: LiveInstanceState[],
  removed: LiveInstanceState[] = [],
): LiveTickUpdate {
  return { at, sequence: at, timetableVersion: 1, changed, removed };
}

describe("progressOf", () => {
  const stops = [
    { stopIndex: 0, arrival: 100, cancelled: false },
    { stopIndex: 1, arrival: 200, cancelled: true },
    { stopIndex: -1, arrival: 250, cancelled: false },
    { stopIndex: 2, arrival: 300, cancelled: false },
  ];

  it("counts a stop as passed from its arrival and skips cancelled and off-timetable stops", () => {
    expect(progressOf(stops, 99)).toEqual({ lastPassedIndex: null, nextIndex: 0, changesAt: 100 });
    expect(progressOf(stops, 100)).toEqual({ lastPassedIndex: 0, nextIndex: 2, changesAt: 300 });
    expect(progressOf(stops, 300)).toEqual({
      lastPassedIndex: 2,
      nextIndex: null,
      changesAt: Number.POSITIVE_INFINITY,
    });
  });

  it("holds the progress at a floor and counts on from there", () => {
    const later = [
      { stopIndex: 0, arrival: 100, cancelled: false },
      { stopIndex: 1, arrival: 500, cancelled: false },
      { stopIndex: 2, arrival: 400, cancelled: false },
      { stopIndex: 3, arrival: 900, cancelled: false },
    ];
    expect(progressOf(later, 450)).toMatchObject({ lastPassedIndex: 0, nextIndex: 1 });
    expect(progressOf(later, 450, 1)).toEqual({ lastPassedIndex: 2, nextIndex: 3, changesAt: 900 });
    expect(progressOf(later, 350, 1)).toEqual({ lastPassedIndex: 1, nextIndex: 2, changesAt: 400 });
    expect(progressOf(later, 950, 1).lastPassedIndex).toBe(3);
    expect(progressOf(stops, 99, 0)).toEqual({ lastPassedIndex: 0, nextIndex: 2, changesAt: 300 });
  });

  it("does not name a floor stop the plan now cancels as passed", () => {
    expect(progressOf(stops, 250, 1)).toEqual({ lastPassedIndex: 0, nextIndex: 2, changesAt: 300 });
    expect(progressOf(stops, 300, 1).lastPassedIndex).toBe(2);
  });
});

describe("DetailDispatcher", () => {
  it("merges updates queued behind a running publish, newest state and removals winning", async () => {
    const seen: LiveTickUpdate[] = [];
    let release: () => void = () => {};
    const dispatcher = new DetailDispatcher({
      publish: (u) => {
        seen.push(u);
        return seen.length === 1
          ? new Promise<void>((resolve) => (release = resolve))
          : Promise.resolve();
      },
    });
    dispatcher.offer(update(1, [state("a", 1)]));
    await Promise.resolve();
    await Promise.resolve();
    dispatcher.offer(update(2, [state("a", 2), state("b", 2)]));
    dispatcher.offer(update(3, [state("a", 3)], [state("b", 3)]));
    dispatcher.offer(update(4, [], []));
    release();
    await dispatcher.idle();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.at).toBe(3);
    expect(seen[1]?.changed.map((s) => [s.tripInstanceId, s.at])).toEqual([["a", 3]]);
    expect(seen[1]?.removed.map((s) => [s.tripInstanceId, s.at])).toEqual([["b", 3]]);
    expect(dispatcher.stats).toEqual({ published: 2, failed: 0, merged: 1, dropped: 0 });
  });
});

describe("DetailDispatcher retries", () => {
  it("puts a failed batch back under newer states and publishes it on the next attempt", async () => {
    const seen: LiveTickUpdate[] = [];
    let fail = true;
    const waits: number[] = [];
    const dispatcher = new DetailDispatcher(
      {
        publish: async (u) => {
          if (fail) {
            fail = false;
            dispatcher.offer(update(2, [state("a", 2)]));
            throw new Error("valkey down");
          }
          seen.push(u);
        },
      },
      () => {},
      async (ms) => {
        waits.push(ms);
      },
    );
    dispatcher.offer(update(1, [state("a", 1)], [state("b", 1)]));
    await dispatcher.idle();
    expect(waits).toEqual([500]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.changed.map((s) => [s.tripInstanceId, s.at])).toEqual([["a", 2]]);
    expect(seen[0]?.removed.map((s) => [s.tripInstanceId, s.at])).toEqual([["b", 1]]);
    expect(dispatcher.stats).toMatchObject({ published: 1, failed: 1, dropped: 0 });
  });

  it("drops a batch after the last attempt, waiting longer each time", async () => {
    const waits: number[] = [];
    const dispatcher = new DetailDispatcher(
      {
        publish: async () => {
          throw new Error("down");
        },
      },
      () => {},
      async (ms) => {
        waits.push(ms);
      },
    );
    dispatcher.offer(update(1, [state("a", 1)]));
    await dispatcher.idle();
    expect(waits).toEqual([500, 1000, 2000, 4000]);
    expect(dispatcher.stats).toMatchObject({ failed: 5, dropped: 1, published: 0 });
  });

  it("sends an update without trains as a heartbeat after 10 s without an offer", async () => {
    const published: LiveTickUpdate[] = [];
    const dispatcher = new DetailDispatcher({ publish: async (u) => void published.push(u) });
    dispatcher.offer(update(100, [state("a", 100)]));
    for (let at = 101; at <= 100 + 3 * DETAIL_HEARTBEAT_S; at++) {
      dispatcher.offer(update(at, []));
      await dispatcher.idle();
    }
    expect(published.map((u) => [u.at, u.changed.length, u.removed.length])).toEqual([
      [100, 1, 0],
      [110, 0, 0],
      [120, 0, 0],
      [130, 0, 0],
    ]);
  });
});
