import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileStore } from "../publish/storage.ts";
import { PlaybackCache } from "./cache.ts";
import { PlaybackRenderer, type RenderWindow } from "./renderer.ts";

const START = 1_761_393_600;
let root: string;
let cache: PlaybackCache;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "playback-renderer-"));
  cache = new PlaybackCache(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function gatedRender() {
  const calls: number[] = [];
  const releases: (() => void)[] = [];
  let running = 0;
  let maxRunning = 0;
  const render: RenderWindow = async (start, end, out) => {
    calls.push(start);
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise<void>((resolve) => releases.push(resolve));
    await new FileStore(out).object("k", 100, Uint8Array.from([start % 251, 1, 2]));
    running--;
    return {
      start,
      end,
      heads: [[start, 100, 100, 101, 1]],
      shapeEpoch: 3,
      firstSequence: 100,
      lastSequence: 100,
      wallSeconds: 0.1,
      deltaInterval: 10,
      keyframeInterval: 300,
    };
  };
  return { render, calls, releases, maxRunning: () => maxRunning };
}

describe("PlaybackRenderer", () => {
  it("renders one window at a time, once per window, and queues at most the limit", async () => {
    const fake = gatedRender();
    const renderer = new PlaybackRenderer(cache, fake.render, { maxPending: 2 });
    const a = renderer.request(START, START + 3600);
    const again = renderer.request(START, START + 3600);
    const b = renderer.request(START + 3600, START + 7200);
    const c = renderer.request(START + 7200, START + 10800);
    expect([a.status, again.status, b.status, c.status]).toEqual([
      "started",
      "pending",
      "started",
      "busy",
    ]);
    expect(renderer.pending).toBe(2);
    await vi.waitFor(() => expect(fake.releases).toHaveLength(1));
    expect(fake.calls).toEqual([START]);
    fake.releases.shift()?.();
    const index = await a.done;
    expect(index?.start).toBe(START);
    expect(await again.done).toEqual(index);
    await vi.waitFor(() => expect(fake.releases).toHaveLength(1));
    expect(fake.calls).toEqual([START, START + 3600]);
    fake.releases.shift()?.();
    await b.done;
    expect(fake.maxRunning()).toBe(1);
    expect(renderer.pending).toBe(0);
    const cached = renderer.request(START, START + 3600);
    expect(cached.status).toBe("started");
    expect((await cached.done)?.revision).toBe(index?.revision);
    expect(fake.calls).toEqual([START, START + 3600]);
  });

  it("drops the scratch output of a failed render and lets the window be asked again", async () => {
    let fail = true;
    const render: RenderWindow = async (start, end, out) => {
      await new FileStore(out).object("k", 100, Uint8Array.from([1]));
      if (fail) throw new Error("database gone");
      return {
        start,
        end,
        heads: [[start, 100, 100, 101, 1]],
        shapeEpoch: 3,
        firstSequence: 100,
        lastSequence: 100,
        wallSeconds: 0.1,
        deltaInterval: 10,
        keyframeInterval: 300,
      };
    };
    const errors: string[] = [];
    const renderer = new PlaybackRenderer(cache, render, {
      maxPending: 1,
      onError: (start, error) => errors.push(`${start} ${String(error)}`),
    });
    expect(await renderer.request(START, START + 3600).done).toBeNull();
    expect(errors).toEqual([`${START} Error: database gone`]);
    expect(await cache.list()).toEqual([]);
    fail = false;
    expect((await renderer.request(START, START + 3600).done)?.start).toBe(START);
  });
});
