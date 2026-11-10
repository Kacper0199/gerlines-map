import { describe, expect, it } from "vitest";
import type { RealtimeChunk } from "./readers.ts";
import { BackgroundReloads, type ReloadTarget } from "./reloads.ts";
import { type ForecastRow, RealtimeStore } from "./store.ts";

function row(
  instanceId: string,
  observedAt: number,
  delay: number,
  sourceId = "delfi",
): ForecastRow {
  return {
    instanceId,
    serviceDate: "2026-10-25",
    stopIndex: 0,
    sourceId,
    observedAt,
    predictedArrival: 1000 + delay,
    predictedDeparture: 1000 + delay,
    arrivalDelay: delay,
    departureDelay: delay,
    cancelled: false,
    explicit: true,
    stopPlaceId: null,
  };
}

const DELFI: ReloadTarget = { sourceId: "delfi", serviceDates: new Set(["2026-10-25"]) };

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("BackgroundReloads", () => {
  it("starts a reload without waiting for it and hands its batches over once loaded", async () => {
    const release = gate();
    const reloads = new BackgroundReloads(async function* (_target, ids, asOf) {
      await release.opened;
      yield {
        rows: ids.map((id) => row(id, asOf - 5, 60)),
        reload: { sourceId: "delfi", instanceIds: ids },
      };
    });
    reloads.start(DELFI, ["a", "b"], 100);
    expect([...reloads.take()]).toEqual([]);
    expect(reloads.pending).toBe(1);
    release.open();
    await reloads.idle();
    const chunks = [...reloads.take()];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.reload?.instanceIds).toEqual(["a", "b"]);
    expect(reloads.pending).toBe(0);
    expect(reloads.stats).toMatchObject({ started: 1, completed: 1, chunks: 1 });
  });

  it("keeps rows followed while the reload ran: they go on top of the replaced rows", async () => {
    const release = gate();
    const reloads = new BackgroundReloads(async function* (_target, ids, asOf) {
      await release.opened;
      yield {
        rows: ids.map((id) => row(id, asOf - 5, 60)),
        reload: { sourceId: "delfi", instanceIds: ids },
      };
    });
    const store = new RealtimeStore();
    store.apply([row("a", 90, 30), row("b", 90, 30)]);
    reloads.start(DELFI, ["a", "b"], 100);
    const followed = [row("a", 110, 240), row("c", 110, 10), row("a", 110, 99, "gtfsde")];
    store.apply(followed);
    reloads.note(followed);
    release.open();
    await reloads.idle();
    for (const chunk of reloads.take()) {
      const reload = chunk.reload as NonNullable<RealtimeChunk["reload"]>;
      store.replace(reload.sourceId, reload.instanceIds, chunk.rows);
    }
    expect(store.source("a", "delfi")?.stops.get(0)?.arrivalDelay).toBe(240);
    expect(store.source("b", "delfi")?.stops.get(0)?.arrivalDelay).toBe(60);
    expect(store.source("a", "gtfsde")?.stops.get(0)?.arrivalDelay).toBe(99);
  });

  it("never throws into the tick: a failed reload is logged and runs again after a growing backoff", async () => {
    const order: string[] = [];
    const logs: Record<string, unknown>[] = [];
    let failures = 2;
    let clock = 0;
    const reloads = new BackgroundReloads(
      async function* (target, ids) {
        order.push(`${target.sourceId}:${ids.join(",")}`);
        if (target.sourceId === "delfi" && failures-- > 0) throw new Error("db gone");
        yield { rows: [], reload: { sourceId: target.sourceId, instanceIds: ids } };
      },
      { log: (f) => logs.push(f), retryMs: 5_000, now: () => clock },
    );
    reloads.start(DELFI, ["a"], 100);
    reloads.start({ sourceId: "gtfsde", serviceDates: null }, ["a", "b"], 100);
    await reloads.idle();
    expect([...reloads.take()]).toEqual([]);
    expect(logs).toMatchObject([
      { msg: "rebuild reload failed", retryInMs: 5_000, source: "delfi" },
    ]);
    clock = 4_999;
    expect([...reloads.take()]).toEqual([]);
    await reloads.idle();
    expect(order).toEqual(["delfi:a"]);
    clock = 5_000;
    expect([...reloads.take()]).toEqual([]);
    await reloads.idle();
    expect(logs.at(-1)).toMatchObject({ retryInMs: 10_000 });
    clock = 15_000;
    [...reloads.take()];
    await reloads.idle();
    const chunks = [...reloads.take()];
    expect(chunks.map((c) => c.reload?.sourceId)).toEqual(["delfi", "gtfsde"]);
    expect(order).toEqual(["delfi:a", "delfi:a", "delfi:a", "gtfsde:a,b"]);
    expect(reloads.stats).toMatchObject({ started: 2, completed: 2, failed: 2 });
  });

  it("starts the backoff again at its base after a reload succeeds", async () => {
    const logs: Record<string, unknown>[] = [];
    const outcomes = [false, true, false, true];
    let clock = 0;
    const reloads = new BackgroundReloads(
      async function* (target, ids) {
        if (!outcomes.shift()) throw new Error("db gone");
        yield { rows: [], reload: { sourceId: target.sourceId, instanceIds: ids } };
      },
      { log: (f) => logs.push(f), retryMs: 5_000, now: () => clock },
    );
    reloads.start(DELFI, ["a"], 100);
    await reloads.idle();
    clock = 5_000;
    [...reloads.take()];
    await reloads.idle();
    expect([...reloads.take()].map((c) => c.reload?.instanceIds)).toEqual([["a"]]);
    reloads.start(DELFI, ["b"], 200);
    await reloads.idle();
    expect(logs.map((f) => f.retryInMs)).toEqual([5_000, 5_000]);
  });

  it("merges notices into a reload that has not started; everything absorbs every waiting one", async () => {
    const release = gate();
    const loads: string[] = [];
    const reloads = new BackgroundReloads(async function* (target, ids) {
      loads.push(
        `${target.sourceId}:${[...(target.serviceDates ?? ["*"])].join("+")}:${ids.join(",")}`,
      );
      await release.opened;
      yield { rows: [], reload: { sourceId: target.sourceId, instanceIds: ids } };
    });
    reloads.start(DELFI, ["a"], 100);
    await Promise.resolve();
    await Promise.resolve();
    reloads.start({ sourceId: "gtfsde", serviceDates: new Set(["2026-10-25"]) }, ["a"], 101);
    reloads.start({ sourceId: "gtfsde", serviceDates: new Set(["2026-10-26"]) }, ["b"], 102);
    reloads.start(DELFI, ["c"], 103);
    expect(reloads.pending).toBe(3);
    reloads.start({ sourceId: null, serviceDates: null }, ["a", "b", "c", "d"], 104);
    expect(reloads.pending).toBe(2);
    expect(reloads.stats.merged).toBe(3);
    release.open();
    await reloads.idle();
    expect(loads).toEqual(["delfi:2026-10-25:a", "null:*:a,b,c,d"]);
  });
});
