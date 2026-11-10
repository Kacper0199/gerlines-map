import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRenderLock,
  isLoopback,
  parseRenderJob,
  parseServe,
  RenderLockHeld,
} from "./job.ts";

const NOW = Date.parse("2026-11-08T08:00:00Z") / 1000;

describe("playback render options", () => {
  it("needs --packs, the pack gate of live run", () => {
    expect(() => parseRenderJob(["--cache", "/srv/playback"], NOW)).toThrow(
      /--packs DIR is required/,
    );
  });

  it("takes the last hours, the budget, the nice level and named version instants", () => {
    const job = parseRenderJob(
      [
        "--cache",
        "/srv/playback",
        "--packs",
        "/srv/live",
        "--last",
        "3",
        "--version-available",
        "1=2026-10-19T00:00:00Z",
      ],
      NOW,
    );
    expect(job).toMatchObject({
      cache: "/srv/playback",
      packs: "/srv/live",
      now: NOW,
      to: NOW,
      from: NOW - 3 * 3600,
      budgetBytes: 2048 * 1_048_576,
      force: false,
      nice: 10,
    });
    expect(job.versionAvailable).toEqual(new Map([[1, Date.parse("2026-10-19T00:00:00Z") / 1000]]));
    const base = ["--cache", "/c", "--packs", "/p"];
    expect(parseRenderJob([...base, "--nice", "0"], NOW).nice).toBe(0);
    for (const nice of ["20", "-1", "x"]) {
      expect(() => parseRenderJob([...base, "--nice", nice], NOW), nice).toThrow(/--nice/);
    }
    expect(() => parseRenderJob([...base, "--budget-mb", "0"], NOW)).toThrow(/--budget-mb/);
  });
});

describe("playback serve options", () => {
  it("knows the loopback hosts", () => {
    for (const host of ["127.0.0.1", "127.8.0.1", "::1", "localhost"])
      expect(isLoopback(host), host).toBe(true);
    for (const host of ["0.0.0.0", "::", "192.168.1.4", "example.org", "128.0.0.1"])
      expect(isLoopback(host), host).toBe(false);
  });

  it("refuses --render-on-miss on a host other than loopback", () => {
    const base = ["--cache", "/c", "--packs", "/p", "--render-on-miss"];
    expect(() => parseServe([...base, "--host", "0.0.0.0"])).toThrow(/loopback/);
    expect(parseServe(["--cache", "/c", "--host", "0.0.0.0"])).toMatchObject({
      host: "0.0.0.0",
      renderOnMiss: false,
    });
  });

  it("renders on a miss with the job's options: --packs required, version instants taken", () => {
    expect(() => parseServe(["--cache", "/c", "--render-on-miss"])).toThrow(/--packs/);
    const serve = parseServe([
      "--cache",
      "/c",
      "--packs",
      "/p",
      "--render-on-miss",
      "--version-available",
      "1=2026-10-19T00:00:00Z",
    ]);
    expect(serve).toMatchObject({
      cache: "/c",
      packs: "/p",
      renderOnMiss: true,
      host: "127.0.0.1",
    });
    expect(serve.versionAvailable.get(1)).toBe(Date.parse("2026-10-19T00:00:00Z") / 1000);
  });
});

describe("the render lock", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "playback-lock-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lets one job hold the cache, takes over a lock of a dead process, and releases", async () => {
    const release = await acquireRenderLock(root);
    expect((await readFile(join(root, "render.lock"), "utf8")).trim()).toBe(String(process.pid));
    await release();
    await expect(readFile(join(root, "render.lock"))).rejects.toThrow();
    await writeFile(join(root, "render.lock"), "4242\n");
    await expect(acquireRenderLock(root, (pid) => pid === 4242)).rejects.toBeInstanceOf(
      RenderLockHeld,
    );
    expect((await readFile(join(root, "render.lock"), "utf8")).trim()).toBe("4242");
    await writeFile(join(root, "render.lock"), "999999\n");
    const again = await acquireRenderLock(root, (pid) => pid === process.pid);
    expect((await readFile(join(root, "render.lock"), "utf8")).trim()).toBe(String(process.pid));
    await again();
    await writeFile(join(root, "render.lock"), `${process.pid}\n`);
    const own = await acquireRenderLock(root, () => true);
    await own();
  });
});
