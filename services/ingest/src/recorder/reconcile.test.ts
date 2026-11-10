import { describe, expect, it } from "vitest";
import type { Logger } from "../log.ts";
import { FakeIndex } from "../testing/fake-index.ts";
import { VirtualClock } from "../testing/virtual-clock.ts";
import { IndexSink } from "./index-sink.ts";
import { RECONCILE_MS, type ReconcileSink, reconcileDelayMs, reconcileLoop } from "./reconcile.ts";

const minutes = (ms: number) => ms / 60_000;
const START = Date.parse("2026-11-08T15:00:00.000Z");
const gap = { start: 0, end: 1 };

describe("reconcileDelayMs", () => {
  it("waits the hour while the index is clean", () => {
    expect(reconcileDelayMs(false, 0)).toBe(RECONCILE_MS);
    expect(minutes(RECONCILE_MS)).toBe(60);
  });

  it("backs off 1, 2 and 5 minutes while reconciles leave the index dirty, then the hour", () => {
    expect([1, 2, 3, 4, 9].map((inRow) => minutes(reconcileDelayMs(true, inRow)))).toEqual([
      1, 2, 5, 60, 60,
    ]);
  });

  it("comes back within a minute when a write fails after a clean reconcile", () => {
    expect(minutes(reconcileDelayMs(true, 0))).toBe(1);
  });
});

function harness(
  options: {
    readonly sinkFor?: (sink: IndexSink) => ReconcileSink;
    readonly failWriteDuringFirst?: boolean;
  } = {},
) {
  const clock = new VirtualClock(START);
  const index = new FakeIndex();
  const messages: string[] = [];
  const logger: Logger = { log: (_level, message) => messages.push(message) };
  const sink = new IndexSink(index, logger);
  const stop = new AbortController();
  const reconciledAt: number[] = [];
  const failWrite = async () => {
    index.down = true;
    await sink.gap("vbn-rt", gap);
    index.down = false;
  };
  let during: (() => Promise<void>) | null = options.failWriteDuringFirst ? failWrite : null;
  const loop = reconcileLoop({
    clock,
    signal: stop.signal,
    logger,
    sink: options.sinkFor ? options.sinkFor(sink) : sink,
    reconcile: async () => {
      reconciledAt.push(minutes(clock.now() - START));
      const step = during;
      during = null;
      await step?.();
    },
  });
  return {
    clock,
    index,
    sink,
    messages,
    reconciledAt,
    failWrite,
    until: (minute: number) => clock.runUntil(START + minute * 60_000),
    stop: async () => {
      stop.abort();
      await loop;
    },
  };
}

describe("reconcileLoop", () => {
  it("reconciles at start, then hourly while the index stays clean", async () => {
    const run = harness();
    await run.until(125);
    await run.stop();

    expect(run.reconciledAt).toEqual([0, 60, 120]);
  });

  it("runs again a minute later when a write failed during a reconcile", async () => {
    const run = harness({ failWriteDuringFirst: true });
    await run.until(10);
    await run.stop();

    expect(run.reconciledAt).toEqual([0, 1]);
    expect(run.sink.dirty).toBe(false);
    expect(run.messages).toContain("database index healed from files");
  });

  it("runs within a minute when a write fails after a clean reconcile", async () => {
    const run = harness();
    await run.until(30);
    await run.failWrite();
    await run.until(32);
    await run.stop();

    expect(run.reconciledAt).toEqual([0, 31]);
  });

  it("logs an error outside the reconcile itself and tries again on the next tick", async () => {
    let throwsLeft = 1;
    const run = harness({
      sinkFor: (sink) => ({
        get dirty() {
          return sink.dirty;
        },
        takeRecovered: () => sink.takeRecovered(),
        endReconcile: (ticket, outcome) => sink.endReconcile(ticket, outcome),
        beginReconcile: () => {
          if (throwsLeft-- > 0) throw new Error("bookkeeping broke");
          return sink.beginReconcile();
        },
      }),
    });
    await run.until(2);
    await run.stop();

    expect(run.messages).toContain("background task failed, retrying on its next turn");
    expect(run.reconciledAt).toEqual([1]);
  });
});
