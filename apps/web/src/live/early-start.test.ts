// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionClient } from "../motion/worker-client.ts";
import {
  abandonEarlyWorker,
  adoptEarlyWorker,
  EARLY_WORKER_WATCHDOG_MS,
  startLiveEarly,
  takeEarlyWorker,
} from "./early-start.ts";

class FakeWorker {
  static created: FakeWorker[] = [];
  readonly url: URL;
  readonly options: WorkerOptions;
  readonly posted: unknown[] = [];
  terminated = false;

  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.created.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function hide(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  abandonEarlyWorker();
  FakeWorker.created = [];
  hide(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("early live start", () => {
  it("starts one module worker with the live config and the packs held, and hands it over once", () => {
    startLiveEarly("dark", "?live=/live/v1");
    startLiveEarly("dark", "?live=/live/v1");
    expect(FakeWorker.created).toHaveLength(1);
    const [worker] = FakeWorker.created;
    expect(worker?.options).toEqual({ type: "module" });
    expect(worker?.posted[0]).toMatchObject({
      type: "init-live",
      config: { baseUrl: "/live/v1", holdPacks: true },
    });
    expect(takeEarlyWorker()).toBe(worker);
    expect(takeEarlyWorker()).toBeUndefined();
  });

  it("does nothing where there are no workers", () => {
    vi.stubGlobal("Worker", undefined);
    startLiveEarly("dark", "");
    expect(takeEarlyWorker()).toBeUndefined();
  });

  it("follows the tab's visibility until the map takes the worker over", () => {
    startLiveEarly("dark", "");
    const [worker] = FakeWorker.created;
    hide(true);
    hide(false);
    expect(worker?.posted.slice(1)).toEqual([
      { type: "visibility", hidden: true },
      { type: "visibility", hidden: false },
    ]);
    takeEarlyWorker();
    hide(true);
    expect(worker?.posted).toHaveLength(3);
  });

  it("is terminated when abandoned, and a later start makes a new one", () => {
    startLiveEarly("dark", "");
    const [first] = FakeWorker.created;
    abandonEarlyWorker();
    expect(first?.terminated).toBe(true);
    expect(takeEarlyWorker()).toBeUndefined();
    hide(true);
    expect(first?.posted).toHaveLength(1);
    startLiveEarly("dark", "");
    expect(FakeWorker.created).toHaveLength(2);
  });

  it("is terminated after the watchdog when nobody has taken it", () => {
    startLiveEarly("dark", "");
    const [worker] = FakeWorker.created;
    vi.advanceTimersByTime(EARLY_WORKER_WATCHDOG_MS - 1);
    expect(worker?.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(worker?.terminated).toBe(true);
    expect(takeEarlyWorker()).toBeUndefined();
  });

  it("is not terminated by the watchdog once the map has taken it", () => {
    startLiveEarly("dark", "");
    const [worker] = FakeWorker.created;
    expect(takeEarlyWorker()).toBe(worker);
    vi.advanceTimersByTime(EARLY_WORKER_WATCHDOG_MS * 2);
    expect(worker?.terminated).toBe(false);
  });

  it("also terminates a worker the map took but failed to start with", () => {
    startLiveEarly("dark", "");
    const [worker] = FakeWorker.created;
    takeEarlyWorker();
    abandonEarlyWorker();
    expect(worker?.terminated).toBe(true);
  });
});

describe("adoptEarlyWorker", () => {
  it("sends the palette, the motion preference and the release of the packs, in that order", () => {
    const calls: string[] = [];
    const client = {
      setPalette: () => calls.push("palette"),
      setReducedMotion: (reduced: boolean) => calls.push(`reduced ${reduced}`),
      releasePacks: () => calls.push("release"),
    } as unknown as MotionClient;
    adoptEarlyWorker(client, { fill: {}, land: [0, 0, 0] } as never, true);
    expect(calls).toEqual(["palette", "reduced true", "release"]);
  });
});
