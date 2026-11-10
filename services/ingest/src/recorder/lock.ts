import { type FileHandle, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import type { Clock } from "../clock.ts";
import { readTextIfExists, resolveInside } from "../storage/files.ts";

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
}

export interface LockOptions {
  readonly root: string;
  readonly path: string;
  readonly clock: Clock;
  readonly staleAfterMs: number;
  readonly pid?: number;
  readonly host?: string;
}

/** Whether an existing lock still belongs to a live writer other than us. */
export function lockBlocks(
  owner: LockOwner | null,
  us: { pid: number; host: string },
  now: number,
  staleAfterMs: number,
): boolean {
  if (owner === null) return false;
  if (owner.pid === us.pid && owner.host === us.host) return false;
  return now - Date.parse(owner.heartbeatAt) < staleAfterMs;
}

export class LockLostError extends Error {}

const TAKING_OVER: LockOwner = { pid: -1, host: "taking over", startedAt: "", heartbeatAt: "" };

function parseOwner(text: string): LockOwner | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as LockOwner;
  } catch {
    return null;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * One writer per recordings directory and job: a lock file with a heartbeat. The lock is created
 * exclusively; a stale lock (no heartbeat for `staleAfterMs`, or one left by this same host and pid, as
 * a restarted container has) is replaced under a takeover file, so of several writers that find it stale
 * only one can take it. The heartbeat checks ownership and throws `LockLostError` when another
 * writer took the lock over, for example after this process slept past the stale limit.
 */
export class HeartbeatLock {
  private readonly options: LockOptions;
  private readonly pid: number;
  private readonly host: string;
  private startedAt = "";
  private beating: Promise<void> = Promise.resolve();
  private released = false;

  constructor(options: LockOptions) {
    this.options = options;
    this.pid = options.pid ?? process.pid;
    this.host = options.host ?? hostname();
  }

  private get path(): string {
    return resolveInside(this.options.root, this.options.path);
  }

  async read(): Promise<LockOwner | null> {
    return parseOwner((await readTextIfExists(this.path)) ?? "");
  }

  private owner(now: number): LockOwner {
    return {
      pid: this.pid,
      host: this.host,
      startedAt: this.startedAt,
      heartbeatAt: new Date(now).toISOString(),
    };
  }

  private async createExclusive(now: number): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "wx");
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
    try {
      this.startedAt = new Date(now).toISOString();
      this.released = false;
      await handle.writeFile(JSON.stringify(this.owner(now)));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  }

  /** The live writer holding the lock, or null when it is stale. An unreadable fresh file counts as held. */
  private async judge(now: number): Promise<LockOwner | null> {
    const owner = await this.read();
    if (owner !== null) {
      const us = { pid: this.pid, host: this.host };
      return lockBlocks(owner, us, now, this.options.staleAfterMs) ? owner : null;
    }
    const info = await stat(this.path).catch(() => null);
    if (info === null || now - info.mtimeMs >= this.options.staleAfterMs) return null;
    return { pid: -1, host: "unknown", startedAt: "", heartbeatAt: info.mtime.toISOString() };
  }

  /**
   * Replaces a stale lock while holding `<lock>.takeover`, created exclusively: of several writers that find
   * the lock stale only one judges it again and removes it, so nobody can remove a lock another writer has
   * just created. A takeover file left by a crash is cleared once older than the stale limit.
   */
  private async takeOver(now: number): Promise<LockOwner | null> {
    const mutex = `${this.path}.takeover`;
    try {
      await (await open(mutex, "wx")).close();
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const info = await stat(mutex).catch(() => null);
      if (info && now - info.mtimeMs >= this.options.staleAfterMs) await rm(mutex, { force: true });
      return (await this.read()) ?? TAKING_OVER;
    }
    try {
      const live = await this.judge(now);
      if (live) return live;
      await rm(this.path, { force: true });
      if (await this.createExclusive(now)) return null;
      return (await this.read()) ?? TAKING_OVER;
    } finally {
      await rm(mutex, { force: true });
    }
  }

  async tryAcquire(): Promise<LockOwner | null> {
    const now = this.options.clock.now();
    if (await this.createExclusive(now)) return null;
    return (await this.judge(now)) ?? this.takeOver(now);
  }

  async acquire(signal: AbortSignal, onWait: (owner: LockOwner) => void): Promise<boolean> {
    while (!signal.aborted) {
      const blocker = await this.tryAcquire();
      if (blocker === null) return true;
      onWait(blocker);
      await this.options.clock.sleep(this.options.staleAfterMs / 3, signal);
    }
    return false;
  }

  /** Beats one at a time; a beat still writing when the lock is released finishes before the file is removed. */
  heartbeat(): Promise<void> {
    const beat = this.beating.then(() => this.beat());
    this.beating = beat.catch(() => undefined);
    return beat;
  }

  private async beat(): Promise<void> {
    if (this.released) return;
    const current = await this.read();
    if (
      current?.pid !== this.pid ||
      current.host !== this.host ||
      current.startedAt !== this.startedAt
    ) {
      throw new LockLostError(
        `lock ${this.options.path} is now held by pid ${current?.pid ?? "none"} on ${current?.host ?? "none"}`,
      );
    }
    const next = `${this.path}.next-${this.pid}`;
    await writeFile(next, JSON.stringify(this.owner(this.options.clock.now())));
    await rename(next, this.path);
  }

  async release(): Promise<void> {
    this.released = true;
    await this.beating;
    const owner = await this.read();
    if (owner?.pid === this.pid && owner.host === this.host && owner.startedAt === this.startedAt) {
      await rm(this.path, { force: true });
    }
  }
}
