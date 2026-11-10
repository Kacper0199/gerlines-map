import { createShape, type Shape } from "@gerlines/geo";
import {
  decodeShapePack,
  FrameDecodeError,
  openShapePack,
  type ShapePolyline,
  shapePolyline,
} from "@gerlines/live-frame";

/** Bytes of the pack for a shape, null when the server has none (404). Throws on a network failure. */
export type PackFetcher = (epoch: number, shapeId: number | string) => Promise<Uint8Array | null>;

export interface LoadedShape {
  readonly id: string;
  /** The content hash of the shape: two shapes with the same hash and stops are one track. */
  readonly hash: string;
  readonly shape: Shape;
  /** Stop arc positions in metres, in the shape's stop list. */
  readonly stops: Float64Array;
  readonly length: number;
}

export interface ShapeStoreOptions {
  readonly fetchPack: PackFetcher;
  readonly onLoaded: (id: string) => void;
  readonly now?: () => number;
  readonly concurrency?: number;
  readonly capacity?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly missingRetryMs?: number;
  /** Queue requests without fetching until `release()`. */
  readonly held?: boolean;
  /** Vertices of a pack set decoded and built before the worker runs again (default 8,000). */
  readonly setSliceVertices?: number;
  /** Gives the worker back between slices of a pack set (default a zero timeout). */
  readonly pause?: () => Promise<void>;
  /** A part in flight this long lets a few single fetches through (default 8 s). */
  readonly setHoldMs?: number;
  /** A clock for slice durations (default performance.now). */
  readonly perf?: () => number;
}

/** What `loadSets` did: shapes added, parts read, and why it stopped early (null: it did not). */
export interface SetLoad {
  readonly added: number;
  readonly read: number;
  readonly failure: string | null;
}

/** The priority of a shape that must not wait for pack sets (the selected train's). */
export const URGENT_PRIORITY = -1;

export interface ShapeStoreStats {
  readonly loaded: number;
  readonly pending: number;
  readonly inFlight: number;
  readonly missing: number;
}

interface Pending {
  readonly epoch: number;
  readonly shapeId: number | string;
  priority: number;
  readyAt: number;
  failures: number;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_CAPACITY = 2500;
const DEFAULT_RETRY_MS = [2_000, 5_000, 15_000, 30_000] as const;
const DEFAULT_MISSING_RETRY_MS = 60_000;
const DEFAULT_SET_SLICE_VERTICES = 8_000;
const DEFAULT_SET_HOLD_MS = 8_000;
/** Single fetches a slow pack set part lets through at once. */
const SINGLES_BESIDE_SETS = 2;
/** A pack set window and its lead (FORMAT.md 4.2): absent shapes wait this long at most. */
const ABSENT_MS = 12 * 60_000;

/** A stable code for why a pack set part was not read (diagnostics). */
function failureCode(error: unknown): string {
  if (error instanceof FrameDecodeError) return error.code;
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof RangeError) return "unusable";
  return "network";
}

export function shapeIdOf(epoch: number, shapeId: number | string): string {
  return `${epoch}/${shapeId}`;
}

/**
 * Shape packs by (epoch, number) or (0, hash prefix): shapes are immutable, so a built kernel shape
 * is kept for as long as a train uses it and a while after (least recently released first out).
 * Fetches are limited in number, ordered by priority (lower first), retried with backoff after a
 * network failure and not repeated for a pack the server does not have until the retry time.
 */
export class ShapeStore {
  private readonly options: ShapeStoreOptions;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly baseCapacity: number;
  private capacity: number;
  private readonly retryDelays: readonly number[];
  private readonly missingRetryMs: number;
  private readonly shapes = new Map<string, LoadedShape>();
  private readonly references = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Set<string>();
  private readonly missing = new Map<string, number>();
  private held: boolean;
  private setsLoading = 0;
  private readonly heldSets: (() => void)[] = [];
  private partStartedAt = 0;
  private longestSlice = 0;
  private absentBySet = new Set<string>();
  private readonly perf: () => number;

  constructor(options: ShapeStoreOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.baseCapacity = options.capacity ?? DEFAULT_CAPACITY;
    this.capacity = this.baseCapacity;
    this.perf = options.perf ?? (() => performance.now());
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_MS;
    this.missingRetryMs = options.missingRetryMs ?? DEFAULT_MISSING_RETRY_MS;
    this.held = options.held ?? false;
  }

  /** Starts the fetches that were queued while the store was held. */
  resume(): void {
    this.held = false;
    for (const start of this.heldSets.splice(0)) start();
    this.pump();
  }

  /**
   * Loads the parts of pack sets one after the other (FORMAT.md 4.2): every shape not loaded yet
   * becomes a kernel shape, a slice of at most `setSliceVertices` vertices at a time so the worker
   * keeps drawing, and trains waiting for it are told at once. Single fetches wait while a part
   * loads, so no shape is fetched twice, except urgent ones (the selected train) and, once a part
   * has taken longer than `setHoldMs`, a few at a time; they fetch what the sets lack afterwards.
   * While the store is held the sets wait for `resume()`. Resolves with the shapes added, the parts
   * read and why reading stopped; it stops at the first part that cannot be read.
   */
  loadSets(
    epoch: number,
    parts: readonly (() => Promise<Uint8Array | null>)[],
    options: { readonly base?: boolean } = {},
  ): Promise<SetLoad> {
    this.setsLoading++;
    return new Promise((resolve) => {
      const start = () => {
        void this.readParts(epoch, parts, options.base === true)
          .then(resolve)
          .finally(() => {
            this.setsLoading--;
            this.pump();
          });
      };
      if (this.held) this.heldSets.push(start);
      else start();
    });
  }

  /** The longest the worker ran without a break while reading sets, in ms (diagnostics). */
  get longestSetSliceMs(): number {
    return this.longestSlice;
  }

  private async readParts(
    epoch: number,
    parts: readonly (() => Promise<Uint8Array | null>)[],
    base: boolean,
  ): Promise<SetLoad> {
    let added = 0;
    let read = 0;
    let shapes = 0;
    for (const fetch of parts) {
      this.partStartedAt = this.now();
      try {
        const bytes = await fetch();
        if (!bytes) return { added, read, failure: "not_found" };
        added += await this.readSet(epoch, bytes, (count) => {
          shapes += count;
          if (base) this.capacity = Math.max(this.baseCapacity, Math.ceil(shapes * 1.25));
        });
        read++;
      } catch (error) {
        return { added, read, failure: failureCode(error) };
      }
    }
    return { added, read, failure: null };
  }

  /** Reads one part; `opened` hears its shape count before any shape is added. */
  private async readSet(epoch: number, bytes: Uint8Array, opened: (count: number) => void) {
    const budget = this.options.setSliceVertices ?? DEFAULT_SET_SLICE_VERTICES;
    const pause = this.options.pause ?? (() => new Promise((done) => setTimeout(done, 0)));
    let started = this.perf();
    const cursor = openShapePack(bytes);
    if (epoch === 0 || !cursor.number) throw new RangeError("a pack set without shape numbers");
    opened(cursor.count);
    if (cursor.absent) this.markAbsent(epoch, cursor.absent);
    let added = 0;
    let vertices = 0;
    while (cursor.next < cursor.count) {
      if (vertices >= budget) {
        this.longestSlice = Math.max(this.longestSlice, this.perf() - started);
        await pause();
        started = this.perf();
        vertices = 0;
      }
      const i = cursor.next;
      vertices += cursor.vertexCount[i] as number;
      const id = shapeIdOf(epoch, cursor.number[i] as number);
      if (this.shapes.has(id) || this.inFlight.has(id)) cursor.skip();
      else if (this.addFromSet(cursor.read(), epoch)) added++;
    }
    cursor.finish();
    this.longestSlice = Math.max(this.longestSlice, this.perf() - started);
    this.enforceCapacity();
    return added;
  }

  /**
   * Shapes a set names as without a pack are not fetched one by one until a newer set no longer
   * names them, or for one window and its lead at most.
   */
  private markAbsent(epoch: number, absent: Uint32Array): void {
    const listed = new Set<string>();
    for (const number of absent) listed.add(shapeIdOf(epoch, number));
    for (const id of this.absentBySet) if (!listed.has(id)) this.missing.delete(id);
    this.absentBySet = listed;
    const until = this.now() + ABSENT_MS;
    for (const id of listed) {
      if (this.shapes.has(id)) continue;
      this.pending.delete(id);
      this.missing.set(id, until);
    }
  }

  private addFromSet(polyline: ShapePolyline, epoch: number): boolean {
    const id = shapeIdOf(epoch, polyline.number as number);
    if (this.shapes.has(id) || this.inFlight.has(id)) return false;
    this.pending.delete(id);
    this.missing.delete(id);
    this.shapes.set(id, {
      id,
      hash: polyline.hash,
      shape: createShape(polyline),
      stops: polyline.stops,
      length: polyline.length,
    });
    this.options.onLoaded(id);
    return true;
  }

  get size(): number {
    return this.shapes.size;
  }

  get(id: string): LoadedShape | undefined {
    const shape = this.shapes.get(id);
    if (shape) {
      this.shapes.delete(id);
      this.shapes.set(id, shape);
    }
    return shape;
  }

  isMissing(id: string): boolean {
    const until = this.missing.get(id);
    return until !== undefined && this.now() < until;
  }

  request(epoch: number, shapeId: number | string, priority = 0): void {
    const id = shapeIdOf(epoch, shapeId);
    if (this.shapes.has(id) || this.inFlight.has(id) || this.isMissing(id)) return;
    const waiting = this.pending.get(id);
    if (waiting) {
      waiting.priority = Math.min(waiting.priority, priority);
      if (priority <= URGENT_PRIORITY) this.pump();
      return;
    }
    this.missing.delete(id);
    this.pending.set(id, { epoch, shapeId, priority, readyAt: 0, failures: 0 });
    this.pump();
  }

  retain(id: string): void {
    this.references.set(id, (this.references.get(id) ?? 0) + 1);
  }

  release(id: string): void {
    const count = (this.references.get(id) ?? 0) - 1;
    if (count > 0) {
      this.references.set(id, count);
      return;
    }
    this.references.delete(id);
    this.enforceCapacity();
  }

  /** Drops a queued pack no train waits for any more (one already being fetched finishes). */
  withdraw(id: string): void {
    this.pending.delete(id);
  }

  /**
   * Drops the least recently used shapes that no train references while over capacity. The store
   * calls it after a load and after the last release of a shape, so a tick never scans the cache.
   */
  enforceCapacity(): void {
    if (this.shapes.size <= this.capacity) return;
    for (const id of this.shapes.keys()) {
      if (this.shapes.size <= this.capacity) return;
      if (!this.references.has(id)) this.shapes.delete(id);
    }
  }

  stats(): ShapeStoreStats {
    this.pruneMissing();
    return {
      loaded: this.shapes.size,
      pending: this.pending.size,
      inFlight: this.inFlight.size,
      missing: [...this.missing.values()].filter((until) => this.now() < until).length,
    };
  }

  /** Starts fetches while slots are free; call it again when a retry time may have passed. */
  pump(): void {
    while (!this.held && this.inFlight.size < this.concurrency) {
      const next = this.next(this.inFlight.size >= this.singlesBesideSets());
      if (!next) return;
      const [id, entry] = next;
      this.pending.delete(id);
      this.inFlight.add(id);
      void this.load(id, entry);
    }
  }

  /** How many single fetches may run while sets load: none at first, a few for a slow part. */
  private singlesBesideSets(): number {
    if (this.setsLoading === 0) return this.concurrency;
    const hold = this.options.setHoldMs ?? DEFAULT_SET_HOLD_MS;
    return this.now() - this.partStartedAt > hold ? SINGLES_BESIDE_SETS : 0;
  }

  private next(urgentOnly = false): [string, Pending] | undefined {
    const now = this.now();
    let best: [string, Pending] | undefined;
    for (const candidate of this.pending) {
      if (candidate[1].readyAt > now) continue;
      if (urgentOnly && candidate[1].priority > URGENT_PRIORITY) continue;
      if (!best || candidate[1].priority < best[1].priority) best = candidate;
    }
    return best;
  }

  private async load(id: string, entry: Pending): Promise<void> {
    try {
      const bytes = await this.options.fetchPack(entry.epoch, entry.shapeId);
      if (bytes === null) {
        this.markMissing(id);
        return;
      }
      const loaded = this.build(id, entry, bytes);
      if (!loaded) {
        this.markMissing(id);
        return;
      }
      this.shapes.set(id, loaded);
      this.options.onLoaded(id);
      this.enforceCapacity();
    } catch {
      this.retryLater(id, entry);
    } finally {
      this.inFlight.delete(id);
      this.pump();
    }
  }

  private build(id: string, entry: Pending, bytes: Uint8Array): LoadedShape | null {
    try {
      const view = decodeShapePack(bytes);
      if (view.count !== 1) return null;
      const polyline = shapePolyline(view, 0);
      if (entry.epoch > 0 && polyline.number !== entry.shapeId) return null;
      if (entry.epoch === 0 && !polyline.hash.startsWith(String(entry.shapeId))) return null;
      return {
        id,
        hash: polyline.hash,
        shape: createShape(polyline),
        stops: polyline.stops,
        length: polyline.length,
      };
    } catch {
      return null;
    }
  }

  private markMissing(id: string): void {
    this.pruneMissing();
    this.missing.set(id, this.now() + this.missingRetryMs);
  }

  private pruneMissing(): void {
    const now = this.now();
    for (const [id, until] of this.missing) {
      if (now >= until) this.missing.delete(id);
    }
  }

  private retryLater(id: string, entry: Pending): void {
    const delay = this.retryDelays[Math.min(entry.failures, this.retryDelays.length - 1)] ?? 30_000;
    this.pending.set(id, {
      ...entry,
      failures: entry.failures + 1,
      readyAt: this.now() + delay,
    });
  }
}
