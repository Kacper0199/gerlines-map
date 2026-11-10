import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import { availableBytes, DiskGuard } from "./disk-guard.ts";
import { HeartbeatLock, LockLostError, lockBlocks } from "./lock.ts";
import { Semaphore } from "./semaphore.ts";

let root: string;
let now = Date.parse("2026-10-25T09:00:00Z");
const clock: Clock = { now: () => now, sleep: async () => undefined };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-runtime-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("HeartbeatLock", () => {
  const options = () => ({ root, path: ".recorder.lock", clock, staleAfterMs: 90_000 });

  it("blocks a second writer while the first one beats", async () => {
    const first = new HeartbeatLock({ ...options(), pid: 10, host: "a" });
    const second = new HeartbeatLock({ ...options(), pid: 11, host: "a" });
    expect(await first.tryAcquire()).toBeNull();
    expect(await second.tryAcquire()).toMatchObject({ pid: 10, host: "a" });
  });

  it("takes over a stale lock after a crash", async () => {
    await new HeartbeatLock({ ...options(), pid: 10, host: "a" }).tryAcquire();
    now += 91_000;
    expect(await new HeartbeatLock({ ...options(), pid: 11, host: "a" }).tryAcquire()).toBeNull();
  });

  it("tells a writer that slept past the stale limit that it lost the lock", async () => {
    const sleeper = new HeartbeatLock({ ...options(), pid: 10, host: "a" });
    expect(await sleeper.tryAcquire()).toBeNull();
    now += 91_000;
    const successor = new HeartbeatLock({ ...options(), pid: 11, host: "a" });
    expect(await successor.tryAcquire()).toBeNull();
    await expect(sleeper.heartbeat()).rejects.toBeInstanceOf(LockLostError);
    await successor.heartbeat();
    expect(await successor.read()).toMatchObject({ pid: 11 });
  });

  it("leaves no lock behind when it is released while a heartbeat is still writing", async () => {
    for (let round = 0; round < 20; round++) {
      const lock = new HeartbeatLock({ ...options(), pid: 10, host: "a" });
      expect(await lock.tryAcquire()).toBeNull();
      const beat = lock.heartbeat();
      await lock.release();
      await beat;
      await lock.heartbeat();
      expect(await lock.read()).toBeNull();
    }
  });

  it("lets only one of two writers take a stale lock", async () => {
    await new HeartbeatLock({ ...options(), pid: 10, host: "a" }).tryAcquire();
    now += 91_000;
    const results = await Promise.all(
      [11, 12, 13].map((pid) => new HeartbeatLock({ ...options(), pid, host: "a" }).tryAcquire()),
    );
    expect(results.filter((owner) => owner === null)).toHaveLength(1);
  });

  it("treats a fresh lock file it cannot read as held", async () => {
    const path = join(root, ".recorder.lock");
    await writeFile(path, "");
    const seconds = now / 1000;
    await utimes(path, seconds, seconds);
    expect(
      await new HeartbeatLock({ ...options(), pid: 11, host: "a" }).tryAcquire(),
    ).toMatchObject({ pid: -1 });
    await utimes(path, seconds - 200, seconds - 200);
    expect(await new HeartbeatLock({ ...options(), pid: 11, host: "a" }).tryAcquire()).toBeNull();
  });

  it("lets a restarted container (same host, pid 1) take its own lock back at once", async () => {
    await new HeartbeatLock({ ...options(), pid: 1, host: "c0ffee" }).tryAcquire();
    expect(
      await new HeartbeatLock({ ...options(), pid: 1, host: "c0ffee" }).tryAcquire(),
    ).toBeNull();
  });

  it("releases only its own lock", async () => {
    const first = new HeartbeatLock({ ...options(), pid: 10, host: "a" });
    await first.tryAcquire();
    await new HeartbeatLock({ ...options(), pid: 11, host: "a" }).release();
    expect(await first.read()).toMatchObject({ pid: 10 });
    await first.release();
    expect(await first.read()).toBeNull();
  });

  it("ignores an unreadable lock file", () => {
    expect(lockBlocks(null, { pid: 1, host: "x" }, now, 90_000)).toBe(false);
  });
});

describe("availableBytes", () => {
  it("counts available blocks in fragment-size units, as measured on a Docker Desktop bind mount", () => {
    const virtiofs = { bsize: 1_048_576, frsize: 4_096, bavail: 52_100_000 };
    expect(availableBytes(virtiofs)).toBe(213_401_600_000);
  });

  it("falls back to the block size when the fragment size is missing", () => {
    expect(availableBytes({ bsize: 4_096, bavail: 10 })).toBe(40_960);
  });
});

describe("DiskGuard", () => {
  it("pauses below the floor and resumes above it, reporting only changes", async () => {
    let free = 30;
    const guard = new DiskGuard(root, 20, async () => free);
    expect(await guard.check()).toEqual({ paused: false, freeBytes: 30 });
    expect(await guard.check()).toBeNull();
    free = 19;
    expect(await guard.check()).toEqual({ paused: true, freeBytes: 19 });
    expect(guard.paused).toBe(true);
    free = 25;
    expect(await guard.check()).toEqual({ paused: false, freeBytes: 25 });
  });
});

describe("Semaphore", () => {
  it("never runs more than its limit at once", async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    };
    await Promise.all(Array.from({ length: 7 }, () => semaphore.run(task)));
    expect(peak).toBe(2);
    expect(semaphore.inUse).toBe(0);
  });
});
