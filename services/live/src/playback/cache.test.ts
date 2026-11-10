import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeadEntry } from "../evidence/continuity.ts";
import { FileStore } from "../publish/storage.ts";
import {
  compactHeads,
  headForInstant,
  PlaybackCache,
  REPLACED_RETAIN_SECONDS,
  type RenderedWindow,
} from "./cache.ts";

const START = 1_761_393_600;
const END = START + 3600;
const bytes = (seed: number, length = 2048) =>
  Uint8Array.from({ length }, (_, i) => (i * seed + 11) % 251);

let root: string;
let cache: PlaybackCache;
let wall = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "playback-cache-"));
  wall = Math.floor(Date.now() / 1000);
  cache = new PlaybackCache(root, { wallClock: () => wall });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const heads: HeadEntry[] = [
  [START, 100, 100, 101, 7],
  [START + 1, 100, 100, 101, 7],
  [START + 2, 101, 100, 101, 7],
  [START + 3, 101, 100, 101, 7],
  [START + 12, 102, 100, 101, 7],
];

async function rendered(start: number, seed = 3): Promise<{ dir: string; window: RenderedWindow }> {
  const dir = await cache.scratchDirectory(start);
  const store = new FileStore(dir);
  await store.object("k", 100, bytes(seed));
  await store.object("d", 101, bytes(seed + 1, 300));
  await store.object("d", 102, bytes(seed + 2, 300));
  await store.head(Uint8Array.from([1, 2, 3]), {
    kind: "head",
    sequence: 102,
    timetableVersion: 7,
    timeBase: start + 12,
    keyframeSequence: 100,
    oldestSequence: 101,
  });
  return {
    dir,
    window: {
      start,
      end: start + 3600,
      heads: heads.map(([at, ...rest]) => [at - START + start, ...rest] as unknown as HeadEntry),
      shapeEpoch: 3,
      firstSequence: 100,
      lastSequence: 102,
      wallSeconds: 1.5,
      deltaInterval: 10,
      keyframeInterval: 300,
    },
  };
}

describe("compactHeads and headForInstant", () => {
  it("keeps the first head of each state", () => {
    expect(compactHeads(heads)).toEqual([heads[0], heads[2], heads[4]]);
  });

  it("answers the head of an instant with the instant as its publication time", () => {
    const compact = compactHeads(heads);
    expect(headForInstant([], START, END)).toBeNull();
    expect(headForInstant(compact, START + 5.7, END)).toEqual({
      kind: "head",
      sequence: 101,
      timetableVersion: 7,
      timeBase: START + 5,
      keyframeSequence: 100,
      oldestSequence: 101,
    });
    expect(headForInstant(compact, END + 100, END)).toMatchObject({
      sequence: 102,
      timeBase: END,
    });
  });
  it("answers an instant before the first head with the first head (a cold start publishes late)", () => {
    const late: HeadEntry[] = [
      [START + 4, 100, 100, 101, 7],
      [START + 20, 101, 100, 101, 7],
    ];
    expect(headForInstant(late, START, END)).toEqual({
      kind: "head",
      sequence: 100,
      timetableVersion: 7,
      timeBase: START + 4,
      keyframeSequence: 100,
      oldestSequence: 101,
    });
  });
});

describe("PlaybackCache", () => {
  it("stores a rendered window as brotli and gzip only under its revision, with its index written last", async () => {
    const { dir, window } = await rendered(START);
    const index = await cache.put(window, dir);
    expect(index).toMatchObject({
      format: 1,
      start: START,
      end: END,
      shapeEpoch: 3,
      firstSequence: 100,
      lastSequence: 102,
      objects: 3,
      deltaInterval: 10,
      keyframeInterval: 300,
      heads: compactHeads(window.heads),
    });
    expect(index.revision).toMatch(/^[0-9a-f]{12}$/);
    const revisionDir = join(root, "w", String(START), index.revision);
    expect((await readdir(join(revisionDir, "k"))).sort()).toEqual(["100.bin.br", "100.bin.gz"]);
    expect((await readdir(revisionDir)).sort()).toEqual(["d", "index.json", "k"]);
    expect((await readdir(join(root, "w", String(START)))).sort()).toEqual(
      ["index.json", index.revision].sort(),
    );
    expect(await readdir(join(root, "tmp"))).toEqual([]);
    expect(await cache.index(START)).toEqual(index);
    expect(await cache.revisionIndex(START, index.revision)).toEqual(index);
    expect(await cache.revisionIndex(START, "000000000000")).toBeNull();
    expect(await cache.revisionIndex(START, "../../tmp")).toBeNull();
  });

  it("reads every encoding back, the plain bytes from the gzip copy", async () => {
    const { dir, window } = await rendered(START);
    const index = await cache.put(window, dir);
    const reader = cache.reader(START, index.revision);
    expect(new Uint8Array((await reader.read("k/100.bin")) as Buffer)).toEqual(bytes(3));
    const br = (await reader.read("d/101.bin.br")) as Buffer;
    expect(new Uint8Array(brotliDecompressSync(br))).toEqual(bytes(4, 300));
    expect(await reader.read("d/103.bin")).toBeNull();
    expect(await reader.read("../index.json")).toBeNull();
    expect(await cache.reader(START, "../w").read("k/100.bin")).toBeNull();
  });

  it("keeps serving a revision's bytes to a read that began before another revision was put", async () => {
    const first = await rendered(START);
    const a = await cache.put(first.window, first.dir);
    const reader = cache.reader(START, a.revision);
    const pending = reader.read("k/100.bin.gz");
    const other = await rendered(START, 9);
    const putting = cache.put(other.window, other.dir);
    const during = await reader.read("k/100.bin");
    const b = await putting;
    expect(b.revision).not.toBe(a.revision);
    expect(await pending).not.toBeNull();
    expect(new Uint8Array(during as Buffer)).toEqual(bytes(3));
    expect(new Uint8Array((await reader.read("k/100.bin")) as Buffer)).toEqual(bytes(3));
    expect(
      new Uint8Array((await cache.reader(START, b.revision).read("k/100.bin")) as Buffer),
    ).toEqual(bytes(9));
    expect(await cache.index(START)).toMatchObject({ revision: b.revision });
    expect(await cache.revisionIndex(START, a.revision)).toMatchObject({ revision: a.revision });
  });

  it("removes a replaced revision in prune only after it was kept for the retention time", async () => {
    const first = await rendered(START);
    const a = await cache.put(first.window, first.dir);
    wall += 10;
    const other = await rendered(START, 9);
    const b = await cache.put(other.window, other.dir);
    const now = START + 86400;
    const budgetBytes = 1e9;
    wall += REPLACED_RETAIN_SECONDS - 1;
    expect(await cache.prune({ budgetBytes, now })).toEqual([]);
    expect(await cache.revisionIndex(START, a.revision)).not.toBeNull();
    wall += 2;
    expect(await cache.prune({ budgetBytes, now })).toEqual([]);
    expect(await cache.revisionIndex(START, a.revision)).toBeNull();
    expect(await cache.reader(START, a.revision).read("k/100.bin")).toBeNull();
    expect(await cache.revisionIndex(START, b.revision)).not.toBeNull();
    expect((await readdir(join(root, "w", String(START)))).sort()).toEqual(
      ["index.json", b.revision].sort(),
    );
  });

  it("counts a kept replaced revision in the budget", async () => {
    const first = await rendered(START);
    const a = await cache.put(first.window, first.dir);
    const other = await rendered(START, 9);
    await cache.put(other.window, other.dir);
    const later = await rendered(START + 3600);
    await cache.put(later.window, later.dir);
    const now = START + 86400;
    expect(await cache.prune({ budgetBytes: 2 * a.storedBytes + 10, now })).toEqual([START]);
    expect((await cache.list()).map((index) => index.start)).toEqual([START + 3600]);
  });

  it("sweeps scratch renders of dead processes and ones older than an hour, and keeps live ones", async () => {
    const tmp = join(root, "tmp");
    const live = join(tmp, `${START}-${process.pid}-1`);
    const dead = join(tmp, `${START}-999999-1`);
    const old = join(tmp, `${START}-${process.pid}-2`);
    const stray = join(tmp, "index.json.123.tmp");
    for (const dir of [live, dead, old]) await mkdir(dir, { recursive: true });
    await writeFile(stray, "{}");
    const hourAgo = new Date((wall - 3601) * 1000);
    await utimes(old, hourAgo, hourAgo);
    await utimes(stray, hourAgo, hourAgo);
    const removed = await cache.sweepScratch({ alive: (pid) => pid === process.pid });
    expect(removed.sort()).toEqual(
      [`${START}-999999-1`, `${START}-${process.pid}-2`, "index.json.123.tmp"].sort(),
    );
    expect(await readdir(tmp)).toEqual([`${START}-${process.pid}-1`]);
  });

  it("gives the same revision to the same bytes and another to other bytes", async () => {
    const first = await rendered(START);
    const a = await cache.put(first.window, first.dir);
    const again = await rendered(START);
    const b = await cache.put(again.window, again.dir);
    expect(b.revision).toBe(a.revision);
    const other = await rendered(START, 9);
    const c = await cache.put(other.window, other.dir);
    expect(c.revision).not.toBe(a.revision);
    expect(await cache.index(START)).toMatchObject({ revision: c.revision });
  });

  it("sees a window that another process rendered again", async () => {
    const first = await rendered(START);
    const a = await cache.put(first.window, first.dir);
    expect(await cache.index(START)).toMatchObject({ revision: a.revision });
    const job = new PlaybackCache(root, { wallClock: () => wall });
    const other = await rendered(START, 9);
    const b = await job.put(other.window, other.dir);
    expect(b.revision).not.toBe(a.revision);
    expect(await cache.index(START)).toMatchObject({ revision: b.revision });
    await job.remove(START);
    expect(await cache.index(START)).toBeNull();
  });

  it("lists windows oldest first and prunes old ones, then the oldest, down to the budget", async () => {
    for (const start of [START, START + 3600, START + 7200]) {
      const { dir, window } = await rendered(start);
      await cache.put(window, dir);
    }
    const listed = await cache.list();
    expect(listed.map((index) => index.start)).toEqual([START, START + 3600, START + 7200]);
    const size = listed[0]?.storedBytes ?? 0;
    expect(size).toBeGreaterThan(0);
    const now = START + 3600 + 7 * 86400;
    expect(await cache.prune({ budgetBytes: 10 * size, now })).toEqual([START]);
    expect(await cache.prune({ budgetBytes: size, now })).toEqual([START + 3600]);
    expect((await cache.list()).map((index) => index.start)).toEqual([START + 7200]);
    expect(await cache.index(START)).toBeNull();
  });

  it("ignores a window without an index (a render that died before its commit point)", async () => {
    const { dir } = await rendered(START);
    expect(dir.startsWith(join(root, "tmp"))).toBe(true);
    expect(await cache.list()).toEqual([]);
    expect(await cache.index(START)).toBeNull();
  });
});
