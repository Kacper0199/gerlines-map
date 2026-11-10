import { decodeShapePack, encodeShapePack, shapePackToObject } from "@gerlines/live-frame";
import { describe, expect, it, vi } from "vitest";
import { ShapeStore, shapeIdOf, URGENT_PRIORITY } from "./shape-store.ts";
import { straightPack } from "./test-frames.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup(overrides: Partial<ConstructorParameters<typeof ShapeStore>[0]> = {}) {
  let wall = 0;
  const calls: string[] = [];
  const loaded: string[] = [];
  const fetchPack = vi.fn(async (epoch: number, id: number | string) => {
    calls.push(`${epoch}/${id}`);
    return straightPack(Number(id));
  });
  const store = new ShapeStore({
    fetchPack,
    onLoaded: (id) => loaded.push(id),
    now: () => wall,
    concurrency: 2,
    ...overrides,
  });
  return {
    store,
    calls,
    loaded,
    fetchPack,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

describe("ShapeStore", () => {
  it("names a shape by epoch and number or hash prefix", () => {
    expect(shapeIdOf(3, 12)).toBe("3/12");
    expect(shapeIdOf(0, "00112233445566aa")).toBe("0/00112233445566aa");
  });

  it("fetches nothing while held and starts the queued packs, lowest priority first, on release", async () => {
    const { store, calls, loaded } = setup({ held: true });
    store.request(3, 7, 2);
    store.request(3, 8, 1);
    store.request(3, 9, 3);
    await settle();
    expect(calls).toEqual([]);
    expect(store.stats()).toMatchObject({ pending: 3, inFlight: 0 });

    store.resume();
    await settle();
    expect(calls.slice(0, 2)).toEqual(["3/8", "3/7"]);
    expect(loaded.sort()).toEqual(["3/7", "3/8", "3/9"]);
  });

  it("loads a pack into a kernel shape and tells the listener", async () => {
    const { store, loaded } = setup();
    store.request(3, 7);
    await settle();
    const entry = store.get("3/7");
    expect(entry?.length).toBeCloseTo(40_000, 3);
    expect(entry?.shape.vertexCount).toBe(41);
    expect(Array.from(entry?.stops ?? [])).toEqual([0, 10_000, 20_000, 40_000]);
    expect(loaded).toEqual(["3/7"]);
  });

  it("fetches one pack once however often it is asked for", async () => {
    const { store, calls } = setup();
    store.request(3, 7);
    store.request(3, 7);
    await settle();
    store.request(3, 7);
    await settle();
    expect(calls).toEqual(["3/7"]);
  });

  it("keeps at most the concurrency limit of fetches in flight", async () => {
    const gates = [deferred<Uint8Array>(), deferred<Uint8Array>(), deferred<Uint8Array>()];
    let started = 0;
    const { store } = setup({ fetchPack: () => (gates[started++] as (typeof gates)[0]).promise });
    for (const id of [1, 2, 3]) store.request(3, id);
    await settle();
    expect(started).toBe(2);
    gates[0]?.resolve(straightPack(1));
    await settle();
    expect(started).toBe(3);
  });

  it("serves the lowest priority number first", async () => {
    const gates = [deferred<Uint8Array>(), deferred<Uint8Array>()];
    const order: number[] = [];
    let started = 0;
    const { store } = setup({
      concurrency: 1,
      fetchPack: (_epoch, id) => {
        order.push(Number(id));
        return (gates[started++] as (typeof gates)[0]).promise;
      },
    });
    store.request(3, 1, 5);
    store.request(3, 2, 9);
    store.request(3, 3, 1);
    await settle();
    gates[0]?.resolve(straightPack(1));
    await settle();
    expect(order).toEqual([1, 3]);
  });

  it("remembers a missing pack until the retry time, then asks again", async () => {
    const asked: string[] = [];
    const { store, advance } = setup({
      fetchPack: async (epoch, id) => {
        asked.push(`${epoch}/${id}`);
        return null;
      },
      missingRetryMs: 60_000,
    });
    store.request(3, 7);
    await settle();
    expect(store.isMissing("3/7")).toBe(true);
    store.request(3, 7);
    await settle();
    expect(asked).toHaveLength(1);
    advance(61_000);
    store.request(3, 7);
    await settle();
    expect(asked).toHaveLength(2);
  });

  it("retries a network failure with backoff and recovers", async () => {
    let attempts = 0;
    const { store, advance, loaded } = setup({
      fetchPack: async () => {
        attempts++;
        if (attempts < 3) throw new TypeError("network");
        return straightPack(7);
      },
      retryDelaysMs: [1_000, 4_000],
    });
    store.request(3, 7);
    await settle();
    expect(attempts).toBe(1);
    store.pump();
    await settle();
    expect(attempts).toBe(1);
    advance(1_000);
    store.pump();
    await settle();
    expect(attempts).toBe(2);
    advance(3_999);
    store.pump();
    await settle();
    expect(attempts).toBe(2);
    advance(1);
    store.pump();
    await settle();
    expect(attempts).toBe(3);
    expect(loaded).toEqual(["3/7"]);
  });

  it("treats a pack that does not decode as missing", async () => {
    const { store } = setup({ fetchPack: async () => Uint8Array.from([1, 2, 3, 4, 5]) });
    store.request(3, 7);
    await settle();
    expect(store.isMissing("3/7")).toBe(true);
    expect(store.get("3/7")).toBeUndefined();
  });

  it("names packs of an epoch 0 frame by hash prefix and checks the prefix", async () => {
    const asked: string[] = [];
    const { store } = setup({
      fetchPack: async (epoch, id) => {
        asked.push(`${epoch}/${id}`);
        return straightPack(7, 40_000, 0);
      },
    });
    store.request(0, "0000000000000000");
    await settle();
    expect(asked).toEqual(["0/0000000000000000"]);
    expect(store.get("0/0000000000000000")).toBeDefined();
    store.request(0, "ffffffffffffffff");
    await settle();
    expect(store.isMissing("0/ffffffffffffffff")).toBe(true);
  });

  it("treats a pack for another number as missing", async () => {
    const { store } = setup({ fetchPack: async () => straightPack(8) });
    store.request(3, 7);
    await settle();
    expect(store.isMissing("3/7")).toBe(true);
  });

  it("evicts the shapes nobody uses past its capacity, never one in use", async () => {
    let ref: ShapeStore | undefined;
    const { store } = setup({
      capacity: 2,
      concurrency: 1,
      onLoaded: (id) => {
        if (id === "3/1") ref?.retain(id);
      },
    });
    ref = store;
    for (const id of [1, 2, 3, 4]) store.request(3, id);
    await settle();
    expect(store.get("3/1")).toBeDefined();
    expect(store.size).toBe(2);
    store.release("3/1");
    expect(store.size).toBe(2);
  });

  it("evicts on its own after a load and after a release, with no call from the tick", async () => {
    let keep = false;
    let ref: ShapeStore | undefined;
    const { store } = setup({
      capacity: 2,
      concurrency: 1,
      onLoaded: (id) => {
        if (keep) ref?.retain(id);
      },
    });
    ref = store;
    for (const id of [1, 2, 3]) store.request(3, id);
    await settle();
    expect(store.size).toBe(2);
    expect(store.get("3/1")).toBeUndefined();
    expect(store.get("3/3")).toBeDefined();
    store.retain("3/2");
    store.retain("3/3");
    keep = true;
    store.request(3, 4);
    await settle();
    expect(store.size).toBe(3);
    store.release("3/2");
    expect(store.size).toBe(2);
    expect(store.get("3/2")).toBeUndefined();
  });

  it("forgets a missing pack after its retry time", async () => {
    let wall = 0;
    const { store } = setup({
      now: () => wall,
      missingRetryMs: 1000,
      fetchPack: async (_epoch, id) => (Number(id) === 1 ? null : straightPack(Number(id))),
    });
    store.request(3, 1);
    await settle();
    expect((store as unknown as { missing: Map<string, number> }).missing.size).toBe(1);
    wall = 1500;
    store.stats();
    expect((store as unknown as { missing: Map<string, number> }).missing.size).toBe(0);
  });

  it("does not scan the missing packs on every request", async () => {
    const { store } = setup({
      fetchPack: async (_epoch, id) => (Number(id) === 1 ? null : straightPack(Number(id))),
    });
    store.request(3, 1);
    await settle();
    const missing = (store as unknown as { missing: Map<string, number> }).missing;
    const scan = vi.spyOn(missing, "entries");
    const iterate = vi.spyOn(missing, Symbol.iterator);
    for (let id = 10; id < 200; id++) store.request(3, id);
    expect(scan).not.toHaveBeenCalled();
    expect(iterate).not.toHaveBeenCalled();
  });

  it("drops a pending pack nobody waits for any more", async () => {
    const gate = deferred<Uint8Array>();
    const { store } = setup({
      concurrency: 1,
      fetchPack: (_epoch, id) =>
        Number(id) === 1 ? gate.promise : Promise.resolve(straightPack(Number(id))),
    });
    store.request(3, 1);
    store.request(3, 2);
    expect(store.stats().pending).toBe(1);
    store.withdraw("3/2");
    expect(store.stats().pending).toBe(0);
    store.withdraw("3/1");
    expect(store.stats().inFlight).toBe(1);
  });

  it("reports loaded, pending and missing counts", async () => {
    const gate = deferred<Uint8Array>();
    const { store } = setup({
      concurrency: 1,
      fetchPack: (_epoch, id) =>
        Number(id) === 1 ? Promise.resolve(straightPack(1)) : gate.promise,
    });
    store.request(3, 1);
    store.request(3, 2);
    store.request(3, 3);
    await settle();
    expect(store.stats()).toEqual({ loaded: 1, pending: 1, inFlight: 1, missing: 0 });
  });
});

function setOf(numbers: readonly number[], epoch = 3): Uint8Array {
  const shapes = numbers.flatMap(
    (number) => shapePackToObject(decodeShapePack(straightPack(number, 40_000, epoch))).shapes,
  );
  return encodeShapePack({
    kind: "shapePack",
    timetableVersion: 1,
    shapeEpoch: epoch,
    shapes,
    coding: "compact",
  });
}

describe("ShapeStore pack sets", () => {
  it("adds every shape of a set and fetches singles only for what it lacks", async () => {
    const { store, calls, loaded } = setup();
    const first = deferred<Uint8Array | null>();
    const second = deferred<Uint8Array | null>();
    const added = store.loadSets(3, [() => first.promise, () => second.promise]);
    store.request(3, 7);
    store.request(3, 8);
    store.request(3, 9);
    await settle();
    expect(calls).toEqual([]);
    first.resolve(setOf([7, 11]));
    await settle();
    expect(loaded.sort()).toEqual(["3/11", "3/7"]);
    expect(calls).toEqual([]);
    second.resolve(setOf([8]));
    expect(await added).toEqual({ added: 3, read: 2, failure: null });
    await settle();
    expect(calls).toEqual(["3/9"]);
    expect(loaded.sort()).toEqual(["3/11", "3/7", "3/8", "3/9"]);
    const single = store.get("3/7");
    expect(single?.shape.vertexCount).toBe(41);
    expect(Array.from(single?.stops ?? [])).toEqual([0, 10_000, 20_000, 40_000]);
  });

  it("stops at a part it cannot read, says why, and lets the singles go", async () => {
    const { store, calls } = setup();
    store.request(3, 7);
    expect(await store.loadSets(3, [async () => null, async () => setOf([7])])).toEqual({
      added: 0,
      read: 0,
      failure: "not_found",
    });
    const truncated = setOf([5]).slice(0, 20);
    expect((await store.loadSets(3, [async () => truncated])).failure).toBe("truncated");
    const timeout = async () => {
      throw new DOMException("signal timed out", "TimeoutError");
    };
    expect(await store.loadSets(3, [async () => setOf([5]), timeout])).toEqual({
      added: 1,
      read: 1,
      failure: "timeout",
    });
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect((await store.loadSets(3, [offline])).failure).toBe("network");
    await settle();
    expect(calls).toEqual(["3/7"]);
  });

  it("waits with a set until a held store resumes, and gives the worker back between slices", async () => {
    let clock = 0;
    const pause = vi.fn(async () => {});
    const fetchSet = vi.fn(async () => setOf([1, 2, 3, 4, 5]));
    const { store } = setup({
      held: true,
      setSliceVertices: 82,
      pause,
      perf: () => {
        clock += 3;
        return clock;
      },
    });
    const added = store.loadSets(3, [fetchSet]);
    await settle();
    expect(fetchSet).not.toHaveBeenCalled();
    store.resume();
    expect(await added).toEqual({ added: 5, read: 1, failure: null });
    expect(pause).toHaveBeenCalledTimes(2);
    expect(store.longestSetSliceMs).toBeGreaterThan(0);
    expect(store.longestSetSliceMs).toBeLessThan(30);
  });

  it("lets the selected train's shape through while a set loads", async () => {
    const { store, calls } = setup();
    const set = deferred<Uint8Array | null>();
    void store.loadSets(3, [() => set.promise]);
    store.request(3, 9);
    store.request(3, 10, URGENT_PRIORITY);
    await settle();
    expect(calls).toEqual(["3/10"]);
    set.resolve(null);
    await settle();
    expect(calls).toEqual(["3/10", "3/9"]);
  });

  it("lets a few singles through once a part takes too long", async () => {
    const { store, calls, advance } = setup({ concurrency: 8, setHoldMs: 5_000 });
    void store.loadSets(3, [() => new Promise<Uint8Array | null>(() => {})]);
    for (const number of [1, 2, 3, 4]) store.request(3, number);
    await settle();
    expect(calls).toEqual([]);
    advance(5_001);
    store.pump();
    await settle();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fetch the shapes a set names as without a pack until a newer set drops them", async () => {
    const { store, calls, advance } = setup();
    const withAbsent = (numbers: number[], absent: number[]) =>
      encodeShapePack({
        kind: "shapePack",
        timetableVersion: 1,
        shapeEpoch: 3,
        shapes: numbers.flatMap((n) => shapePackToObject(decodeShapePack(setOf([n]))).shapes),
        coding: "compact",
        absent,
      });
    const set = deferred<Uint8Array | null>();
    const added = store.loadSets(3, [() => set.promise]);
    store.request(3, 9);
    store.request(3, 10);
    set.resolve(withAbsent([7], [9]));
    await added;
    await settle();
    expect(calls).toEqual(["3/10"]);
    expect(store.isMissing("3/9")).toBe(true);
    store.request(3, 9);
    await settle();
    expect(calls).toEqual(["3/10"]);
    await store.loadSets(3, [async () => withAbsent([8], [])]);
    expect(store.isMissing("3/9")).toBe(false);
    store.request(3, 9);
    await settle();
    expect(calls).toEqual(["3/10", "3/9"]);
    advance(12 * 60_000 + 1);
    expect(store.isMissing("3/9")).toBe(false);
  });

  it("keeps the shapes of a base set larger than its capacity until trains claim them", async () => {
    const { store } = setup({ capacity: 2 });
    await store.loadSets(3, [async () => setOf([1, 2, 3, 4, 5])], { base: true });
    expect(store.size).toBe(5);
  });

  it("keeps shapes it holds, skips them in the set, and counts only the new ones", async () => {
    const { store } = setup();
    store.request(3, 7);
    await settle();
    const before = store.get("3/7");
    expect(await store.loadSets(3, [async () => setOf([7, 8])])).toEqual({
      added: 1,
      read: 1,
      failure: null,
    });
    expect(store.get("3/7")).toBe(before);
  });
});
