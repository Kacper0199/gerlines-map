import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { Head } from "@gerlines/live-frame";
import type { HeadEntry } from "../evidence/continuity.ts";
import { headAt } from "../server/replay.ts";
import { DEFAULT_LIMITS, type PlaybackLimits } from "./window.ts";

const gunzipAsync = promisify(gunzip);

/** What a render of one window hands to the cache. */
export interface RenderedWindow {
  readonly start: number;
  readonly end: number;
  /** Every head the render wrote, ordered by time. */
  readonly heads: readonly HeadEntry[];
  readonly shapeEpoch: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly wallSeconds: number;
  readonly deltaInterval: number;
  readonly keyframeInterval: number;
}

/** `w/<start>/<revision>/index.json`, and its copy `w/<start>/index.json` renamed in last: the commit point. */
export interface PlaybackIndex {
  readonly format: 1;
  readonly start: number;
  readonly end: number;
  /** Hash prefix of the objects and heads: object URLs carry it, so a re-render never mixes. */
  readonly revision: string;
  readonly shapeEpoch: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly deltaInterval: number;
  readonly keyframeInterval: number;
  /** The first head of each state: [publication time, sequence, keyframe, oldest, timetable version]. */
  readonly heads: readonly HeadEntry[];
  readonly objects: number;
  readonly storedBytes: number;
  readonly renderedAt: string;
  readonly renderSeconds: number;
}

/** The first head of each state; a render writes one head per tick, mostly of an unchanged state. */
export function compactHeads(heads: readonly HeadEntry[]): HeadEntry[] {
  const compact: HeadEntry[] = [];
  for (const entry of heads) {
    const previous = compact.at(-1);
    if (previous && previous[1] === entry[1] && previous[4] === entry[4]) continue;
    compact.push(entry);
  }
  return compact;
}

/**
 * The head a client of the live chain saw at `at`: the newest state published by then, with the
 * instant (whole seconds, at most the window's end) as its publication time. Before the first head
 * (the cold engine publishes a few seconds into the window) it is the first head at its own time.
 */
export function headForInstant(heads: readonly HeadEntry[], at: number, end: number): Head | null {
  const entry = headAt(heads, at) ?? heads[0];
  if (!entry) return null;
  const [published, sequence, keyframeSequence, oldestSequence, timetableVersion] = entry;
  return {
    kind: "head",
    sequence,
    timetableVersion,
    timeBase: Math.max(published, Math.min(Math.floor(at), end)),
    keyframeSequence,
    oldestSequence,
  };
}

const OBJECT = /^[kd]\/[1-9]\d{0,9}\.bin(?:\.br|\.gz)?$/;
const REVISION = /^[0-9a-f]{12}$/;
const KINDS = ["k", "d"] as const;
const SCRATCH = /^\d+-(\d+)-\d+(?:\..+)?$/;

/**
 * How long a replaced revision stays after a re-render committed another (wall seconds): a client
 * may hold the old index for its 60 s max-age plus as long again at the CDN, and keeps fetching the
 * old revision's deltas while it plays that window, up to its hour at 1x; two hours cover both.
 */
export const REPLACED_RETAIN_SECONDS = 7200;
/** A scratch render older than this is a dead one, whoever wrote it (a render takes about 40 s). */
export const SCRATCH_MAX_AGE_SECONDS = 3600;

let scratchCounter = 0;

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await treeBytes(child);
    else total += (await stat(child).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Whether a process id is running (EPERM means it runs under another user). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PlaybackCacheOptions {
  /** Wall clock in Unix seconds, for render times, the retention of replaced revisions and scratch age. */
  readonly wallClock?: () => number;
}

/**
 * Rendered playback windows on disk. Each revision lives in its own directory
 * (`<root>/w/<start>/<revision>/{k,d}/`, with its index), so the bytes under a revision never
 * change; `<root>/w/<start>/index.json` names the current revision and is replaced by a rename, the
 * commit point. Objects are kept as brotli and gzip copies (the plain bytes come from the gzip copy
 * on the rare request without either). Renders write into `<root>/tmp/` and move in whole.
 */
export class PlaybackCache {
  readonly root: string;
  readonly #wallClock: () => number;
  readonly #indexes = new Map<string, { readonly stamp: string; readonly index: PlaybackIndex }>();

  constructor(root: string, options: PlaybackCacheOptions = {}) {
    this.root = root;
    this.#wallClock = options.wallClock ?? (() => Date.now() / 1000);
  }

  #windowDir(start: number): string {
    return join(this.root, "w", String(start));
  }

  async scratchDirectory(start: number): Promise<string> {
    scratchCounter++;
    const dir = join(this.root, "tmp", `${start}-${process.pid}-${scratchCounter}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Removes what killed renders and failed commits left in `tmp/`: entries of a process that no
   * longer runs, and any entry older than an hour. Returns the names removed.
   */
  async sweepScratch(
    options: { readonly alive?: (pid: number) => boolean } = {},
  ): Promise<string[]> {
    const alive = options.alive ?? processAlive;
    const tmp = join(this.root, "tmp");
    const cutoff = this.#wallClock() - SCRATCH_MAX_AGE_SECONDS;
    const removed: string[] = [];
    for (const name of await names(tmp)) {
      const path = join(tmp, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      const pid = SCRATCH.exec(name)?.[1];
      const dead = pid !== undefined && !alive(Number(pid));
      if (dead || info.mtimeMs / 1000 < cutoff) {
        await rm(path, { recursive: true, force: true });
        removed.push(name);
      }
    }
    return removed;
  }

  async #readIndex(key: string, path: string, valid: (index: PlaybackIndex) => boolean) {
    let stamp: string;
    try {
      const info = await stat(path);
      stamp = `${info.mtimeMs}:${info.size}:${info.ino}`;
    } catch {
      this.#indexes.delete(key);
      return null;
    }
    const held = this.#indexes.get(key);
    if (held && held.stamp === stamp) return held.index;
    let index: PlaybackIndex | null = null;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as PlaybackIndex;
      index = parsed.format === 1 && valid(parsed) ? parsed : null;
    } catch {
      index = null;
    }
    if (index) this.#indexes.set(key, { stamp, index });
    else this.#indexes.delete(key);
    return index;
  }

  /** The window's current index, read again whenever its file changed (the render job is another process). */
  index(start: number): Promise<PlaybackIndex | null> {
    return this.#readIndex(
      String(start),
      join(this.#windowDir(start), "index.json"),
      (index) => index.start === start,
    );
  }

  /** The index of one revision of a window, current or replaced but still kept. */
  revisionIndex(start: number, revision: string): Promise<PlaybackIndex | null> {
    if (!REVISION.test(revision)) return Promise.resolve(null);
    return this.#readIndex(
      `${start}/${revision}`,
      join(this.#windowDir(start), revision, "index.json"),
      (index) => index.start === start && index.revision === revision,
    );
  }

  async list(): Promise<PlaybackIndex[]> {
    const starts = (await names(join(this.root, "w")))
      .filter((name) => /^[1-9]\d{9}$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
    const indexes: PlaybackIndex[] = [];
    for (const start of starts) {
      const index = await this.index(start);
      if (index) indexes.push(index);
    }
    return indexes;
  }

  /** Bytes of one revision's object by its relative path (`k/<seq>.bin` with `.br`, `.gz` or nothing). */
  reader(start: number, revision: string): { read(relative: string): Promise<Buffer | null> } {
    const dir = join(this.#windowDir(start), revision);
    return {
      read: async (relative) => {
        if (!REVISION.test(revision) || !OBJECT.test(relative)) return null;
        if (relative.endsWith(".br") || relative.endsWith(".gz"))
          return readOrNull(join(dir, relative));
        const gz = await readOrNull(join(dir, `${relative}.gz`));
        return gz ? gunzipAsync(gz) : null;
      },
    };
  }

  /**
   * Compacts a render in `dir` (from `scratchDirectory`), moves it to its revision's directory and
   * commits it by renaming the window's index over the previous one. The previous revision stays
   * until `prune` finds it older than `REPLACED_RETAIN_SECONDS`.
   */
  async put(window: RenderedWindow, dir: string): Promise<PlaybackIndex> {
    const digests: string[] = [];
    let storedBytes = 0;
    let objects = 0;
    for (const kind of KINDS) {
      for (const name of (await names(join(dir, kind))).sort()) {
        const path = join(dir, kind, name);
        if (name.endsWith(".bin")) {
          const plain = await readFile(path);
          digests.push(`${kind}/${name}:${createHash("sha256").update(plain).digest("hex")}`);
          objects++;
          await rm(path);
        } else if (name.endsWith(".br") || name.endsWith(".gz")) {
          storedBytes += (await stat(path)).size;
        } else {
          await rm(path, { force: true });
        }
      }
    }
    await rm(join(dir, "head"), { force: true });
    const heads = compactHeads(window.heads);
    const revision = createHash("sha256")
      .update(JSON.stringify({ shapeEpoch: window.shapeEpoch, heads, digests }))
      .digest("hex")
      .slice(0, 12);
    const index: PlaybackIndex = {
      format: 1,
      start: window.start,
      end: window.end,
      revision,
      shapeEpoch: window.shapeEpoch,
      firstSequence: window.firstSequence,
      lastSequence: window.lastSequence,
      deltaInterval: window.deltaInterval,
      keyframeInterval: window.keyframeInterval,
      heads,
      objects,
      storedBytes,
      renderedAt: new Date(this.#wallClock() * 1000).toISOString(),
      renderSeconds: window.wallSeconds,
    };
    const text = JSON.stringify(index);
    const windowDir = this.#windowDir(window.start);
    const revisionDir = join(windowDir, revision);
    await mkdir(windowDir, { recursive: true });
    if (
      await stat(join(revisionDir, "index.json")).then(
        () => true,
        () => false,
      )
    ) {
      await rm(dir, { recursive: true, force: true });
    } else {
      await rm(revisionDir, { recursive: true, force: true });
      await writeFile(join(dir, "index.json"), text);
      await rename(dir, revisionDir);
    }
    const pointer = `${dir}.index.json`;
    await writeFile(pointer, text);
    await rename(pointer, join(windowDir, "index.json"));
    return index;
  }

  async remove(start: number): Promise<void> {
    for (const key of [...this.#indexes.keys()]) {
      if (key === String(start) || key.startsWith(`${start}/`)) this.#indexes.delete(key);
    }
    await rm(this.#windowDir(start), { recursive: true, force: true });
  }

  /**
   * Revisions of a window other than its current one: those replaced longer ago than the retention
   * are removed, the bytes of the ones kept are returned.
   */
  async #pruneReplaced(index: PlaybackIndex, retainSeconds: number): Promise<number> {
    const windowDir = this.#windowDir(index.start);
    const committed = Date.parse(index.renderedAt) / 1000;
    const expired = !(this.#wallClock() - committed < retainSeconds);
    let kept = 0;
    for (const name of await names(windowDir)) {
      if (name === "index.json" || name === index.revision) continue;
      const path = join(windowDir, name);
      if (expired || !REVISION.test(name)) {
        this.#indexes.delete(`${index.start}/${name}`);
        await rm(path, { recursive: true, force: true });
      } else {
        kept += await treeBytes(path);
      }
    }
    return kept;
  }

  /**
   * Drops windows past the age limit and replaced revisions past their retention, then the oldest
   * windows until the rest (kept replaced revisions counted) fit the budget.
   */
  async prune(options: {
    readonly budgetBytes: number;
    readonly now: number;
    readonly limits?: PlaybackLimits;
    readonly retainSeconds?: number;
  }): Promise<number[]> {
    const limits = options.limits ?? DEFAULT_LIMITS;
    const retainSeconds = options.retainSeconds ?? REPLACED_RETAIN_SECONDS;
    const removed: number[] = [];
    const kept: { readonly start: number; readonly bytes: number }[] = [];
    for (const index of await this.list()) {
      if (index.start < options.now - limits.maxAgeSeconds) {
        await this.remove(index.start);
        removed.push(index.start);
      } else {
        const replaced = await this.#pruneReplaced(index, retainSeconds);
        kept.push({ start: index.start, bytes: index.storedBytes + replaced });
      }
    }
    let total = kept.reduce((sum, window) => sum + window.bytes, 0);
    for (const window of kept) {
      if (total <= options.budgetBytes) break;
      await this.remove(window.start);
      removed.push(window.start);
      total -= window.bytes;
    }
    return removed;
  }
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}
