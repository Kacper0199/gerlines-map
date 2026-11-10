import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { decodeHead } from "@gerlines/live-frame";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadEntry } from "../evidence/continuity.ts";
import { FileStore } from "../publish/storage.ts";
import { createPlaybackApp } from "./app.ts";
import { PlaybackCache, type PlaybackIndex } from "./cache.ts";
import { PlaybackRenderer, type RenderWindow } from "./renderer.ts";

const START = 1_761_393_600;
const END = START + 3600;
const NOW = END + 86400;
const IMMUTABLE = "public, max-age=31536000, immutable";
const keyframe = Uint8Array.from({ length: 4096 }, (_, i) => (i * 5) % 251);
const heads: HeadEntry[] = [
  [START, 100, 100, 101, 7],
  [START + 20, 101, 100, 101, 7],
];

let root: string;
let cache: PlaybackCache;
let index: PlaybackIndex;

const render: RenderWindow = async (start, end, out) => {
  await new FileStore(out).object("k", 100, keyframe);
  await new FileStore(out).object("d", 101, keyframe.slice(0, 900));
  return {
    start,
    end,
    heads,
    shapeEpoch: 3,
    firstSequence: 100,
    lastSequence: 101,
    wallSeconds: 0.1,
    deltaInterval: 10,
    keyframeInterval: 300,
  };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "playback-app-"));
  cache = new PlaybackCache(root);
  const out = await cache.scratchDirectory(START);
  index = await cache.put(await render(START, END, out), out);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function app(renderer: PlaybackRenderer | null = null) {
  return createPlaybackApp({ cache, renderer, now: () => NOW });
}

describe("playback routes", () => {
  it("lists the rendered windows with the limits", async () => {
    const response = await app().request("/playback/v1/windows");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await response.json()) as { data: { windows: unknown[]; limits: unknown } };
    expect(body.data.windows).toEqual([
      { start: START, end: END, revision: index.revision, shapeEpoch: 3 },
    ]);
    expect(body.data.limits).toEqual({
      windowSeconds: 3600,
      maxAgeSeconds: 604800,
      settleSeconds: 1800,
    });
  });

  it("serves a window's index", async () => {
    const response = await app().request(`/playback/v1/w/${START}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: PlaybackIndex }).data).toEqual(index);
  });

  it("answers a window outside the limits or not on the hour with its reason", async () => {
    const cases: [string, number, string][] = [
      [String(START + 60), 400, "MISALIGNED"],
      [String(START - 8 * 86400), 400, "TOO_OLD"],
      [String(NOW - 3600), 400, "NOT_SETTLED"],
      ["17613936", 400, "INVALID_WINDOW"],
      [String(START - 3600), 404, "NOT_RENDERED"],
    ];
    for (const [start, status, code] of cases) {
      const response = await app().request(`/playback/v1/w/${start}`);
      expect(response.status, start).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it("serves the head of an instant as the live head, cached for good", async () => {
    const base = `/playback/v1/w/${START}/${index.revision}`;
    const response = await app().request(`${base}/head?at=${START + 25}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE);
    const head = decodeHead(new Uint8Array(await response.arrayBuffer()));
    expect(head).toMatchObject({
      sequence: 101,
      keyframeSequence: 100,
      oldestSequence: 101,
      timetableVersion: 7,
      timeBase: START + 25,
    });
    for (const at of [String(START - 1), String(END + 1), "abc", `${START}.5`, ""]) {
      expect((await app().request(`${base}/head?at=${at}`)).status, at).toBe(400);
    }
    expect(
      (await app().request(`/playback/v1/w/${START}/000000000000/head?at=${START}`)).status,
    ).toBe(404);
  });

  it("serves keyframes and deltas in brotli, gzip or plain, under the revision only", async () => {
    const base = `/playback/v1/w/${START}/${index.revision}`;
    const br = await app().request(`${base}/k/100.bin`, { headers: { "Accept-Encoding": "br" } });
    expect(br.status).toBe(200);
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(new Uint8Array(brotliDecompressSync(Buffer.from(await br.arrayBuffer())))).toEqual(
      keyframe,
    );
    const plain = await app().request(`${base}/d/101.bin`, {
      headers: { "Accept-Encoding": "identity" },
    });
    expect(new Uint8Array(await plain.arrayBuffer())).toEqual(keyframe.slice(0, 900));
    for (const path of [
      `${base}/k/102.bin`,
      `${base}/k/0100.bin`,
      `${base}/x/100.bin`,
      `/playback/v1/w/${START}/ffffffffffff/k/100.bin`,
    ]) {
      expect((await app().request(path)).status, path).toBe(404);
    }
  });

  it("keeps serving the replaced revision's bytes and heads after a re-render commits another", async () => {
    const other = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 251);
    const out = await cache.scratchDirectory(START);
    await new FileStore(out).object("k", 100, other);
    await new FileStore(out).object("d", 101, other.slice(0, 900));
    const next = await cache.put(
      { ...(await render(START, END, await cache.scratchDirectory(START))), heads },
      out,
    );
    expect(next.revision).not.toBe(index.revision);
    const current = await app().request(`/playback/v1/w/${START}`);
    expect(((await current.json()) as { data: PlaybackIndex }).data.revision).toBe(next.revision);
    const identity = { headers: { "Accept-Encoding": "identity" } };
    const old = await app().request(
      `/playback/v1/w/${START}/${index.revision}/k/100.bin`,
      identity,
    );
    expect(old.status).toBe(200);
    expect(old.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(new Uint8Array(await old.arrayBuffer())).toEqual(keyframe);
    const fresh = await app().request(
      `/playback/v1/w/${START}/${next.revision}/k/100.bin`,
      identity,
    );
    expect(new Uint8Array(await fresh.arrayBuffer())).toEqual(other);
    expect(
      (await app().request(`/playback/v1/w/${START}/${index.revision}/head?at=${START + 25}`))
        .status,
    ).toBe(200);
  });

  it("answers an instant before the window's first head with the first head", async () => {
    const later = START - 3600;
    const out = await cache.scratchDirectory(later);
    const lateHeads: HeadEntry[] = [
      [later + 3, 100, 100, 101, 7],
      [later + 20, 101, 100, 101, 7],
    ];
    const lateIndex = await cache.put(
      { ...(await render(later, later + 3600, out)), heads: lateHeads },
      out,
    );
    const response = await app().request(
      `/playback/v1/w/${later}/${lateIndex.revision}/head?at=${later}`,
    );
    expect(response.status).toBe(200);
    expect(decodeHead(new Uint8Array(await response.arrayBuffer()))).toMatchObject({
      sequence: 100,
      timeBase: later + 3,
    });
  });

  it("starts a render for a missing window when a renderer is given, and says when it is busy", async () => {
    const releases: (() => void)[] = [];
    const slow: RenderWindow = async (start, end, out) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return render(start, end, out);
    };
    const renderer = new PlaybackRenderer(cache, slow, { maxPending: 1 });
    const missing = START - 3600;
    const first = await app(renderer).request(`/playback/v1/w/${missing}`);
    expect(first.status).toBe(202);
    expect(first.headers.get("retry-after")).toBe("30");
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe("RENDERING");
    const other = await app(renderer).request(`/playback/v1/w/${missing - 3600}`);
    expect(other.status).toBe(503);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe("BUSY");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(renderer.pending).toBe(0));
    const ready = await app(renderer).request(`/playback/v1/w/${missing}`);
    expect(ready.status).toBe(200);
  });
});
