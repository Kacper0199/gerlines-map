import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeHead } from "@gerlines/live-frame";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeadEntry } from "../evidence/continuity.ts";
import { FileStore } from "../publish/storage.ts";
import { createReplayApp, headAt, ReplayClock } from "./replay.ts";

const HEADS: HeadEntry[] = [
  [1000, 10, 10, 11, 1],
  [1001, 10, 10, 11, 1],
  [1002, 11, 10, 11, 1],
  [1005, 12, 10, 11, 1],
];

describe("headAt", () => {
  it("takes the last head published at or before the time", () => {
    expect(headAt(HEADS, 1000)?.[1]).toBe(10);
    expect(headAt(HEADS, 1002.9)?.[1]).toBe(11);
    expect(headAt(HEADS, 1004)?.[1]).toBe(11);
    expect(headAt(HEADS, 1005)?.[1]).toBe(12);
    expect(headAt(HEADS, 9999)?.[1]).toBe(12);
  });

  it("has no head before the first", () => {
    expect(headAt(HEADS, 999)).toBeNull();
    expect(headAt([], 5)).toBeNull();
  });
});

describe("ReplayClock", () => {
  it("runs at the speed from the start time", () => {
    let wall = 50;
    const clock = new ReplayClock({
      first: 1000,
      last: 1100,
      speed: 10,
      loop: false,
      wall: () => wall,
    });
    expect(clock.now()).toBe(1000);
    wall = 52;
    expect(clock.now()).toBe(1020);
  });

  it("starts at a given instant", () => {
    const clock = new ReplayClock({
      first: 1000,
      last: 1100,
      speed: 1,
      loop: false,
      wall: () => 0,
      startAt: 1040,
    });
    expect(clock.now()).toBe(1040);
  });

  it("stops at the last head, or starts again when looping", () => {
    let wall = 0;
    const stop = new ReplayClock({
      first: 1000,
      last: 1100,
      speed: 10,
      loop: false,
      wall: () => wall,
    });
    wall = 100;
    expect(stop.now()).toBe(1100);
    wall = 0;
    const loop = new ReplayClock({
      first: 1000,
      last: 1100,
      speed: 10,
      loop: true,
      wall: () => wall,
    });
    wall = 12;
    expect(loop.now()).toBeCloseTo(1000 + ((12 * 10) % 101), 6);
  });

  it("rejects a speed that is not positive", () => {
    expect(
      () => new ReplayClock({ first: 0, last: 1, speed: 0, loop: false, wall: () => 0 }),
    ).toThrow(RangeError);
  });
});

describe("replay app", () => {
  let frames: string;
  let packs: string;
  let wall = 0;

  beforeAll(async () => {
    frames = await mkdtemp(join(tmpdir(), "replay-frames-"));
    packs = await mkdtemp(join(tmpdir(), "replay-packs-"));
    const store = new FileStore(frames);
    await store.object("k", 10, Uint8Array.from([1, 2, 3]));
    await store.object("d", 11, Uint8Array.from([4, 5, 6]));
    await new FileStore(packs).pack(3, 7, Uint8Array.from([7, 8, 9]));
  });

  afterAll(async () => {
    await rm(frames, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  });

  let built: ReturnType<typeof createReplayApp> | undefined;

  function app() {
    if (!built) {
      wall = 0;
      built = createReplayApp({
        frames: new FileStore(frames),
        packs: new FileStore(packs),
        heads: HEADS,
        clock: new ReplayClock({
          first: 1000,
          last: 1005,
          speed: 1,
          loop: false,
          wall: () => wall,
        }),
      });
    }
    return built;
  }

  it("serves the head of the virtual time, plain, with the head's cache rule", async () => {
    const replay = app();
    wall = 2;
    const response = await replay.request("/live/v1/head");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=1");
    const head = decodeHead(new Uint8Array(await response.arrayBuffer()));
    expect(head).toMatchObject({
      sequence: 11,
      keyframeSequence: 10,
      oldestSequence: 11,
      timeBase: 1002,
    });
  });

  it("moves the head on with the clock", async () => {
    wall = 5;
    const head = decodeHead(
      new Uint8Array(await (await app().request("/live/v1/head")).arrayBuffer()),
    );
    expect(head.sequence).toBe(12);
  });

  it("serves frames from the render and shape packs from the pack store", async () => {
    const key = await app().request("/live/v1/k/10.bin");
    expect(Array.from(new Uint8Array(await key.arrayBuffer()))).toEqual([1, 2, 3]);
    const pack = await app().request("/live/v1/s/3/7.bin");
    expect(Array.from(new Uint8Array(await pack.arrayBuffer()))).toEqual([7, 8, 9]);
    expect((await app().request("/live/v1/s/3/8.bin")).status).toBe(404);
    expect((await app().request("/live/v1/d/999.bin")).status).toBe(404);
  });

  it("states the replay clock for tools", async () => {
    wall = 3;
    const body = (await (await app().request("/replay/state")).json()) as Record<string, number>;
    expect(body).toMatchObject({ virtualNow: 1003, speed: 1, first: 1000, last: 1005 });
  });
});
