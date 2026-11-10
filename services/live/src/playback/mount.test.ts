import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileStore } from "../publish/storage.ts";
import { createLiveApp } from "../server/app.ts";
import { playbackDirectory, withPlayback } from "./mount.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "playback-mount-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the playback flag of live run", () => {
  it("is off unless LIVE_PLAYBACK_DIR names an absolute directory", () => {
    expect(playbackDirectory({})).toBeNull();
    expect(playbackDirectory({ LIVE_PLAYBACK_DIR: "  " })).toBeNull();
    expect(() => playbackDirectory({ LIVE_PLAYBACK_DIR: "data/playback" })).toThrow(/absolute/);
    expect(playbackDirectory({ LIVE_PLAYBACK_DIR: " /srv/playback " })).toBe("/srv/playback");
  });

  it("leaves the live routes alone when off and adds the playback routes when on", async () => {
    const live = createLiveApp(new FileStore(root));
    const off = withPlayback(live, null, () => 0);
    expect(off).toBe(live);
    expect((await off.request("/playback/v1/windows")).status).toBe(404);
    const on = withPlayback(createLiveApp(new FileStore(root)), root, () => 1_800_000_000);
    expect((await on.request("/playback/v1/windows")).status).toBe(200);
    const unrendered = await on.request(`/playback/v1/w/${1_800_000_000 - 7200}`);
    expect(unrendered.status).toBe(404);
    expect(((await unrendered.json()) as { error: { code: string } }).error.code).toBe(
      "NOT_RENDERED",
    );
    expect((await on.request("/healthz")).status).toBe(200);
    const missing = await on.request("/live/v1/k/12.bin");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});
