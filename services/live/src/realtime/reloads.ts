import type { RealtimeChunk } from "./readers.ts";
import type { ForecastRow } from "./store.ts";

/** What a rebuild notice asks to reload: one source (every source when null) on some days. */
export interface ReloadTarget {
  readonly sourceId: string | null;
  readonly serviceDates: ReadonlySet<string> | null;
}

/** Reads a reload's batches as of `asOf`; each chunk carries `reload` with its instance ids. */
export type ReloadLoader = (
  target: ReloadTarget,
  ids: readonly string[],
  asOf: number,
) => AsyncIterable<RealtimeChunk>;

interface PendingReload {
  target: ReloadTarget;
  ids: readonly string[];
  idSet: ReadonlySet<string>;
  asOf: number;
  /** Rows followed for these instances since the reload started: applied again on top of it. */
  readonly since: ForecastRow[];
  readonly ready: RealtimeChunk[];
  state: "queued" | "loading" | "loaded" | "failed";
  /** Wall clock (ms) from which a failed reload runs again. */
  retryAt: number;
}

export interface ReloadStats {
  started: number;
  /** Notices merged into a reload still waiting to run. */
  merged: number;
  completed: number;
  failed: number;
  chunks: number;
}

export interface ReloadOptions {
  /** Told each failure and when it is retried (the reload never throws into the tick). */
  readonly log?: (fields: Record<string, unknown>) => void;
  /** First wait (ms) before a failed reload runs again, doubled up to `maxRetryMs`. */
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  /** Wall clock in ms (tests pass a fake). */
  readonly now?: () => number;
}

/**
 * Rebuild reloads off the tick: on compressed chunks one batch takes up to about
 * 3 s and a full reload about 30 s, so the tick only starts a reload and later takes the batches
 * that are done. One reload runs at a time, in notice order; a notice for a reload that has not
 * started yet merges into it. A batch replaces what the store holds for its instances, so rows the
 * follow delivered for them since the reload started go on top of it: the store keeps the newer row
 * per stop, and nothing followed meanwhile is lost. A failed load is logged and runs again from its
 * first batch after a backoff (5 s doubling to 5 min, reset by a success); the tick goes on.
 */
export class BackgroundReloads {
  readonly stats: ReloadStats = { started: 0, merged: 0, completed: 0, failed: 0, chunks: 0 };
  readonly #load: ReloadLoader;
  readonly #log: (fields: Record<string, unknown>) => void;
  readonly #retryMs: number;
  readonly #maxRetryMs: number;
  readonly #now: () => number;
  readonly #queue: PendingReload[] = [];
  #worker: Promise<void> | null = null;
  #wait: number;

  constructor(load: ReloadLoader, options: ReloadOptions = {}) {
    this.#load = load;
    this.#log = options.log ?? (() => {});
    this.#retryMs = options.retryMs ?? 5_000;
    this.#maxRetryMs = options.maxRetryMs ?? 300_000;
    this.#now = options.now ?? Date.now;
    this.#wait = this.#retryMs;
  }

  /** Reloads in flight or waiting to be taken. */
  get pending(): number {
    return this.#queue.length;
  }

  start(target: ReloadTarget, ids: readonly string[], asOf: number): void {
    if (ids.length === 0) return;
    if (this.#merge(target, ids, asOf)) return;
    this.#queue.push({
      target,
      ids,
      idSet: new Set(ids),
      asOf,
      since: [],
      ready: [],
      state: "queued",
      retryAt: 0,
    });
    this.stats.started++;
    this.#kick();
  }

  /** Rows the follow just handed to the store. */
  note(rows: readonly ForecastRow[]): void {
    if (this.#queue.length === 0) return;
    for (const pending of this.#queue) {
      const source = pending.target.sourceId;
      for (const row of rows) {
        if ((source === null || row.sourceId === source) && pending.idSet.has(row.instanceId))
          pending.since.push(row);
      }
    }
  }

  /** The finished batches in order, each with the rows followed since its reload started. */
  *take(): Iterable<RealtimeChunk> {
    const now = this.#now();
    for (const pending of this.#queue) {
      if (pending.state === "failed" && now >= pending.retryAt) pending.state = "queued";
    }
    this.#kick();
    while (this.#queue.length > 0) {
      const pending = this.#queue[0] as PendingReload;
      for (let chunk = pending.ready.shift(); chunk; chunk = pending.ready.shift()) {
        this.stats.chunks++;
        yield withFollowed(chunk, pending.since);
      }
      if (pending.state !== "loaded") return;
      this.#queue.shift();
      this.stats.completed++;
    }
  }

  /** Resolves when no reload is loading (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#worker) await this.#worker;
  }

  /**
   * Merges a notice into reloads that have not started: a notice for one source into a waiting
   * reload of that source or of everything, a notice for everything into one reload of everything
   * that replaces every waiting one.
   */
  #merge(target: ReloadTarget, ids: readonly string[], asOf: number): boolean {
    const waiting = this.#queue.filter(
      (pending) =>
        pending.state === "queued" &&
        (target.sourceId === null ||
          pending.target.sourceId === null ||
          pending.target.sourceId === target.sourceId),
    );
    const into = waiting[0];
    if (!into) return false;
    const absorbed = target.sourceId === null ? waiting.slice(1) : [];
    const all = [into, ...absorbed];
    const days =
      target.serviceDates === null || all.some((pending) => pending.target.serviceDates === null)
        ? null
        : new Set([
            ...all.flatMap((pending) => [...(pending.target.serviceDates ?? [])]),
            ...target.serviceDates,
          ]);
    into.target = {
      sourceId: target.sourceId === null ? null : into.target.sourceId,
      serviceDates: days,
    };
    into.ids = [...new Set([...all.flatMap((pending) => pending.ids), ...ids])].sort();
    into.idSet = new Set(into.ids);
    into.asOf = Math.max(asOf, ...all.map((pending) => pending.asOf));
    for (const pending of absorbed) {
      into.since.push(...pending.since);
      this.#queue.splice(this.#queue.indexOf(pending), 1);
    }
    this.stats.merged += 1 + absorbed.length;
    return true;
  }

  #kick(): void {
    if (this.#queue.some((pending) => pending.state === "queued")) this.#worker ??= this.#drain();
  }

  async #drain(): Promise<void> {
    await Promise.resolve();
    for (;;) {
      const next = this.#queue.find((pending) => pending.state === "queued");
      if (!next || this.#queue.some((pending) => pending.state === "failed")) break;
      next.state = "loading";
      try {
        for await (const chunk of this.#load(next.target, next.ids, next.asOf))
          next.ready.push(chunk);
        next.state = "loaded";
        this.#wait = this.#retryMs;
      } catch (error) {
        next.ready.length = 0;
        next.state = "failed";
        next.retryAt = this.#now() + this.#wait;
        this.stats.failed++;
        this.#log({
          msg: "rebuild reload failed",
          source: next.target.sourceId,
          instances: next.ids.length,
          retryInMs: this.#wait,
          error: String(error).slice(0, 300),
        });
        this.#wait = Math.min(this.#wait * 2, this.#maxRetryMs);
        break;
      }
    }
    this.#worker = null;
  }
}

function withFollowed(chunk: RealtimeChunk, since: readonly ForecastRow[]): RealtimeChunk {
  if (since.length === 0 || !chunk.reload) return chunk;
  const ids = new Set(chunk.reload.instanceIds);
  const extra = since.filter((row) => ids.has(row.instanceId));
  return extra.length === 0 ? chunk : { ...chunk, rows: [...chunk.rows, ...extra] };
}
