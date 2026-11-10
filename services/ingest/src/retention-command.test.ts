import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Clock, systemClock } from "./clock.ts";
import { silentLogger } from "./log.ts";
import { HeartbeatLock, type LockOwner } from "./recorder/lock.ts";
import {
  BACKFILL_LOCK,
  type ProcessedSource,
  type RetentionCommandContext,
  runRetention,
} from "./retention-command.ts";

let root: string;
let printed: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-retention-cli-"));
  printed = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const nothing: ProcessedSource = {
  lookup: { processed: async () => new Set<string>(), note: "test" },
  close: async () => undefined,
};

function context(extra: Partial<RetentionCommandContext> = {}): RetentionCommandContext {
  return {
    recordingsDir: root,
    clock: systemClock,
    logger: silentLogger,
    print: (text) => printed.push(text),
    databaseName: "gerlines",
    openProcessed: () => nothing,
    ...extra,
  };
}

async function lockOwner(): Promise<LockOwner | null> {
  try {
    return JSON.parse(await readFile(join(root, BACKFILL_LOCK), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

async function otherBackfill(): Promise<HeartbeatLock> {
  const lock = new HeartbeatLock({
    root,
    path: BACKFILL_LOCK,
    clock: systemClock,
    staleAfterMs: 600_000,
    pid: 999_999,
    host: "elsewhere",
  });
  expect(await lock.tryAcquire()).toBeNull();
  return lock;
}

describe("retention command guards", () => {
  it("refuses to keep fewer than 3 days", async () => {
    await expect(runRetention(["--keep-days", "2"], context())).rejects.toThrow(/3 or more/);
  });

  it("refuses --apply with --as-of", async () => {
    await expect(
      runRetention(["--apply", "--as-of", "2026-11-10T00:00:00Z"], context()),
    ).rejects.toThrow(/only as of now/);
  });

  it("refuses a relative manifest root", async () => {
    await expect(runRetention(["--manifest-root", "manifests"], context())).rejects.toThrow(
      /absolute/,
    );
  });

  it("counts processed payloads only from the shared database", async () => {
    let opened = false;
    const ctx = context({
      databaseName: "gerlines_wp23",
      openProcessed: () => {
        opened = true;
        return nothing;
      },
    });
    await expect(runRetention(["--processed-db"], ctx)).rejects.toThrow(
      /only the shared database gerlines/,
    );
    expect(opened).toBe(false);
  });
});

describe("retention command locking", () => {
  it("plans a dry run without the backfill lock, even while a backfill runs", async () => {
    const backfill = await otherBackfill();
    expect(await runRetention([], context())).toBe(0);
    expect(JSON.parse(printed[0] ?? "{}")).toMatchObject({ dryRun: true, deletable: [] });
    await backfill.release();
  });

  it("refuses to apply while a backfill holds the lock", async () => {
    const backfill = await otherBackfill();
    await expect(runRetention(["--apply"], context())).rejects.toThrow(/a backfill runs/);
    expect((await lockOwner())?.host).toBe("elsewhere");
    await backfill.release();
  });

  it("takes the lock before planning, keeps it alive while working, and releases it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let tick = Date.parse("2026-11-09T06:00:00Z");
    const steppingClock: Clock = { ...systemClock, now: () => (tick += 1_000) };
    const seen: (LockOwner | null)[] = [];
    let atOpen: LockOwner | null = null;
    const slow: ProcessedSource = {
      lookup: { processed: async () => new Set<string>(), note: "slow" },
      close: async () => {
        const first = await lockOwner();
        seen.push(first);
        vi.advanceTimersByTime(20);
        let next = first;
        while (next?.heartbeatAt === first?.heartbeatAt) {
          await new Promise((resolve) => setImmediate(resolve));
          next = await lockOwner();
        }
        seen.push(next);
      },
    };
    const ctx = context({
      clock: steppingClock,
      heartbeatMs: 20,
      openProcessed: () => {
        atOpen = JSON.parse(readFileSync(join(root, BACKFILL_LOCK), "utf8")) as LockOwner;
        return slow;
      },
    });
    expect(await runRetention(["--apply", "--processed-db"], ctx)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const [before, after] = seen;
    expect((atOpen as LockOwner | null)?.pid).toBe(process.pid);
    expect(before?.pid).toBe(process.pid);
    expect(after?.pid).toBe(process.pid);
    expect(Date.parse(after?.heartbeatAt ?? "")).toBeGreaterThan(
      Date.parse(before?.heartbeatAt ?? ""),
    );
    await expect(stat(join(root, BACKFILL_LOCK))).rejects.toThrow();
    expect(JSON.parse(printed[0] ?? "{}").applied).toMatchObject({ deleted: [], freedBytes: 0 });
  }, 15_000);
});
