import { describe, expect, it } from "vitest";
import { liveKeyOf } from "../live/train-ids.ts";
import {
  type CheckClock,
  type CheckSnapshot,
  type CheckStore,
  type CheckTarget,
  showTrain,
  snapshotOf,
} from "./check-hook.ts";

function world(options: {
  appearsAfterMs?: number;
  movingUntilMs?: number;
  cars?: CheckSnapshot["cars"];
}) {
  let at = 0;
  const calls: string[] = [];
  const clock: CheckClock = {
    now: () => at,
    wait: async (ms) => {
      at += ms;
    },
  };
  let selected: string | null = null;
  const store: CheckStore = {
    select: (id) => {
      calls.push(`select ${id}`);
      selected = id;
    },
    setFollowing: (on) => calls.push(`follow ${on}`),
  };
  const target: CheckTarget = {
    snapshot: () =>
      selected !== null && at >= (options.appearsAfterMs ?? 0)
        ? { key: liveKeyOf(selected), lon: 7.01, lat: 51.45, cars: options.cars ?? "drawn" }
        : null,
    isMoving: () => at < (options.movingUntilMs ?? 0),
    jumpTo: (camera) =>
      calls.push(
        `jump ${camera.center.join(",")} z${camera.zoom} p${camera.pitch} b${camera.bearing}`,
      ),
  };
  return { clock, store, target, calls, time: () => at };
}

describe("showTrain", () => {
  it("selects the trip, follows it and frames it once the flight has ended", async () => {
    const w = world({ appearsAfterMs: 300, movingUntilMs: 900 });
    const result = await showTrain(
      w.store,
      w.target,
      25282264,
      { zoom: 17, pitch: 50, bearing: 30 },
      w.clock,
    );
    expect(w.calls).toEqual([
      "select null",
      "select live:25282264",
      "follow true",
      "jump 7.01,51.45 z17 p50 b30",
    ]);
    expect(result).toEqual({
      found: true,
      key: 25282264,
      lon: 7.01,
      lat: 51.45,
      zoom: 17,
      cars: "drawn",
    });
    expect(w.time()).toBeGreaterThanOrEqual(900);
  });

  it("accepts the live: id and defaults to zoom 17 looking straight down", async () => {
    const w = world({});
    const result = await showTrain(w.store, w.target, "live:42", undefined, w.clock);
    expect(w.calls[1]).toBe("select live:42");
    expect(w.calls[3]).toBe("jump 7.01,51.45 z17 p0 b0");
    expect(result.key).toBe(42);
  });

  it("starts the selection again for a train that is already selected, so the camera flies again", async () => {
    const w = world({});
    await showTrain(w.store, w.target, 7, undefined, w.clock);
    await showTrain(w.store, w.target, 7, undefined, w.clock);
    expect(w.calls.filter((call) => call === "select null")).toHaveLength(2);
    expect(w.calls.filter((call) => call === "select live:7")).toHaveLength(2);
  });

  it("reports whether the cars are drawn, placed or only the chevron", async () => {
    for (const cars of ["drawn", "placed", "chevron"] as const) {
      const w = world({ cars });
      expect((await showTrain(w.store, w.target, 7, undefined, w.clock)).cars).toBe(cars);
    }
  });

  it("releases the selection after framing when asked, leaving the camera where it is", async () => {
    const w = world({});
    const result = await showTrain(w.store, w.target, 7, { release: true }, w.clock);
    expect(result.found).toBe(true);
    expect(w.calls.at(-1)).toBe("select null");
    expect(w.calls.filter((call) => call.startsWith("jump"))).toHaveLength(1);
  });

  it("gives up with found false when the train never appears in a frame, and clears the selection", async () => {
    const w = world({ appearsAfterMs: 1e9 });
    const result = await showTrain(w.store, w.target, 7, { timeoutMs: 2_000 }, w.clock);
    expect(result).toEqual({ found: false, key: 7 });
    expect(w.calls).not.toContain("follow false");
    expect(w.calls.at(-1)).toBe("select null");
    expect(w.calls.some((call) => call.startsWith("jump"))).toBe(false);
  });

  it("does not take the previous train's frame for the train asked for", async () => {
    let at = 0;
    const calls: string[] = [];
    const clock: CheckClock = {
      now: () => at,
      wait: async (ms) => {
        at += ms;
      },
    };
    const store: CheckStore = {
      select: (id) => calls.push(`select ${id}`),
      setFollowing: () => undefined,
    };
    const target: CheckTarget = {
      snapshot: () => (at < 200 ? { key: 25279378, lon: 9.757, lat: 53.583, cars: "drawn" } : null),
      isMoving: () => false,
      jumpTo: (camera) => calls.push(`jump ${camera.center.join(",")}`),
    };
    const result = await showTrain(store, target, 25279372, { timeoutMs: 2_000 }, clock);
    expect(result).toEqual({ found: false, key: 25279372 });
    expect(calls.some((call) => call.startsWith("jump"))).toBe(false);
  });

  it("refuses an id it cannot read as a trip key", async () => {
    const w = world({});
    await expect(showTrain(w.store, w.target, "ICE 70", undefined, w.clock)).rejects.toThrow(
      /trip key/,
    );
    await expect(showTrain(w.store, w.target, -3, undefined, w.clock)).rejects.toThrow(/trip key/);
    expect(w.calls).toEqual([]);
  });
});

describe("snapshotOf", () => {
  const selected = { id: "live:5", lon: 7, lat: 51 } as never;
  const keys = (list: number[]) => Int32Array.from(list);

  it("tells cars drawn, cars placed and the chevron apart", () => {
    expect(snapshotOf(selected, { drawnKeys: keys([5]), trainKeys: keys([5]) })?.cars).toBe(
      "drawn",
    );
    expect(snapshotOf(selected, { drawnKeys: keys([]), trainKeys: keys([5]) })?.cars).toBe(
      "placed",
    );
    expect(snapshotOf(selected, { drawnKeys: keys([6]), trainKeys: keys([6]) })?.cars).toBe(
      "chevron",
    );
    expect(snapshotOf(selected, undefined)?.cars).toBe("chevron");
  });

  it("names the train it shows", () => {
    expect(snapshotOf(selected, undefined)?.key).toBe(5);
  });

  it("is null without a selected train", () => {
    expect(snapshotOf(null, undefined)).toBeNull();
  });
});
