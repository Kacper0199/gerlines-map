import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@gerlines/db";
import { afterAll, describe, expect, it } from "vitest";
import { checkChain } from "../evidence/chain-check.ts";
import { type HeadEntry, runContinuity } from "../evidence/continuity.ts";
import { FileStore } from "../publish/storage.ts";
import { parseAvailability } from "../timetable/available.ts";
import { createPlaybackApp } from "./app.ts";
import { PlaybackCache, type PlaybackIndex } from "./cache.ts";
import { databaseRenderWindow, versionLoadTimes } from "./render-window.ts";
import { PlaybackRenderer } from "./renderer.ts";
import { DEFAULT_LIMITS } from "./window.ts";

/**
 * A playback window rendered from a replay database and read back through the HTTP routes
 * (GERLINES_PLAYBACK_DATABASE_URL, read only, for example gerlines_wp32 with 2026-10-25 10:00 to
 * 22:00Z; GERLINES_PLAYBACK_PACKS, its shape packs, for example data/live/packs-t102/v1;
 * GERLINES_PLAYBACK_VERSION_AVAILABLE, ID=ISO pairs replacing load times, for example
 * 1=2026-10-19T00:00:00Z as wp32 loaded its version on 2026-10-29). Skipped without a database and
 * packs unless GERLINES_PLAYBACK_TESTS=required (CI has no replay database). GERLINES_PLAYBACK_FROM and GERLINES_PLAYBACK_SECONDS
 * choose the window.
 */
const databaseUrl = process.env.GERLINES_PLAYBACK_DATABASE_URL;
const packsDir = process.env.GERLINES_PLAYBACK_PACKS;
const required = process.env.GERLINES_PLAYBACK_TESTS === "required";
const named = parseAvailability(
  (process.env.GERLINES_PLAYBACK_VERSION_AVAILABLE ?? "").split(",").filter(Boolean),
);
const FROM = Date.parse(process.env.GERLINES_PLAYBACK_FROM ?? "2026-10-25T12:00:00Z") / 1000;
const SECONDS = Number(process.env.GERLINES_PLAYBACK_SECONDS ?? 600);

describe.runIf(required && !(databaseUrl && packsDir))("the playback integration test", () => {
  it("is required but has no database or packs", () => {
    expect.fail("GERLINES_PLAYBACK_DATABASE_URL and GERLINES_PLAYBACK_PACKS are required");
  });
});

describe.skipIf(!(databaseUrl && packsDir))("a playback window rendered from history", () => {
  const db = createDatabase({
    databaseUrl: databaseUrl ?? "postgres://unused/unused",
    applicationName: "gerlines-live-playback-test",
    maxConnections: 4,
  });
  const limits = { ...DEFAULT_LIMITS, windowSeconds: SECONDS };
  const now = () => FROM + SECONDS + DEFAULT_LIMITS.settleSeconds;
  let root = "";
  afterAll(async () => {
    await db.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("renders once, serves the chain over HTTP, and the chain and motion checks stay clean", async () => {
    root = await mkdtemp(join(tmpdir(), "playback-integration-"));
    const cache = new PlaybackCache(root);
    const renderWindow = databaseRenderWindow({
      db,
      packs: packsDir ?? "",
      versionAvailable: named,
    });
    const renderer = new PlaybackRenderer(cache, renderWindow, { maxPending: 1 });
    const app = createPlaybackApp({ cache, renderer, now, limits });

    expect((await app.request(`/playback/v1/w/${FROM}`)).status).toBe(202);
    const request = renderer.request(FROM, FROM + SECONDS);
    expect(request.status).toBe("pending");
    const rendered = await request.done;
    expect(rendered).not.toBeNull();
    const response = await app.request(`/playback/v1/w/${FROM}`);
    expect(response.status).toBe(200);
    const index = ((await response.json()) as { data: PlaybackIndex }).data;
    expect(index.revision).toBe(rendered?.revision);

    const base = `/playback/v1/w/${FROM}/${index.revision}`;
    let served = 0;
    const frames = async (relative: string) => {
      const object = await app.request(`${base}/${relative}`, {
        headers: { "Accept-Encoding": "identity" },
      });
      if (object.status !== 200) return null;
      served++;
      return new Uint8Array(await object.arrayBuffer());
    };
    const chain = await checkChain(frames, index.heads, { clients: 40, seed: 7 });
    expect(chain).toMatchObject({ mismatches: 0, chainErrors: [], finalStatesEqual: true });
    expect(served).toBeGreaterThan(0);

    {
      const packs = new FileStore(packsDir ?? "");
      const continuity = await runContinuity({
        frames,
        packs: async (relative) => {
          const bytes = await packs.read(relative);
          return bytes ? new Uint8Array(bytes) : null;
        },
        shapeEpoch: index.shapeEpoch,
        heads: index.heads,
        from: index.start,
        to: index.end,
        timeScale: 10,
        fps: 60,
        sampleShare: 1,
        seed: 7,
      });
      process.stderr.write(
        `${JSON.stringify({ index: { ...index, heads: index.heads.length }, chain, continuity: continuity.continuity })}\n`,
      );
      expect(continuity.continuity).toMatchObject({
        jumps: 0,
        stalls: 0,
        backwardSteps: 0,
        visibleSwaps: 0,
        offTrackFrames: 0,
      });
    }
  });

  it("hides a timetable version until its load time unless an instant is named", async () => {
    const loads = await versionLoadTimes(db);
    expect(loads.size).toBeGreaterThan(0);
    const unnamed = [...loads].filter(([id]) => !named.has(id));
    const versions = (heads: readonly HeadEntry[]) => new Set(heads.map((head) => head[4]));
    const out = await mkdtemp(join(tmpdir(), "playback-load-time-"));
    try {
      const plain = databaseRenderWindow({ db, packs: packsDir ?? "" });
      const window = await plain(FROM, FROM + 30, out);
      for (const [id, loaded] of loads) {
        if (loaded > FROM + 30) expect(versions(window.heads).has(id), String(id)).toBe(false);
      }
      process.stderr.write(
        `${JSON.stringify({ loads: [...loads], unnamed: unnamed.length, versions: [...versions(window.heads)] })}\n`,
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
