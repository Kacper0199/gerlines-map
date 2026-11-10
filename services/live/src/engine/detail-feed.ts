import type { DetailPort, LiveInstanceState, LiveTickUpdate } from "./detail-port.ts";

export interface ProgressStop {
  readonly stopIndex: number;
  readonly arrival: number;
  readonly cancelled: boolean;
}

export interface Progress {
  readonly lastPassedIndex: number | null;
  readonly nextIndex: number | null;
  /** The next arrival that moves the progress, +Infinity after the last stop. */
  readonly changesAt: number;
}

/**
 * Progress by arrival over the served stops (static index ≥ 0, not cancelled). With a floor (a
 * static stop index ≥ 0), stops up to it count as passed whatever their times say, and the count
 * goes on from the stops after it: progress never goes back. A floor stop the plan now
 * lists as cancelled is not named as passed: the last served stop before it is.
 */
export function progressOf(stops: readonly ProgressStop[], now: number, floor = -1): Progress {
  let lastPassedIndex: number | null = floor >= 0 ? servedAtOrBefore(stops, floor) : null;
  for (const stop of stops) {
    if (stop.stopIndex < 0 || stop.stopIndex <= floor || stop.cancelled) continue;
    if (stop.arrival > now)
      return { lastPassedIndex, nextIndex: stop.stopIndex, changesAt: stop.arrival };
    lastPassedIndex = stop.stopIndex;
  }
  return { lastPassedIndex, nextIndex: null, changesAt: Number.POSITIVE_INFINITY };
}

/** The floor, or the last served stop before it when the plan lists the floor as cancelled. */
function servedAtOrBefore(stops: readonly ProgressStop[], floor: number): number {
  if (!stops.some((stop) => stop.stopIndex === floor && stop.cancelled)) return floor;
  let served = floor;
  for (const stop of stops) {
    if (stop.stopIndex >= floor) break;
    if (stop.stopIndex >= 0 && !stop.cancelled) served = stop.stopIndex;
  }
  return served;
}

export interface DispatcherStats {
  published: number;
  failed: number;
  merged: number;
  /** Batches given up after MAX_ATTEMPTS failures in a row. */
  dropped: number;
}

/** Attempts per batch before it is dropped; the wait doubles from RETRY_BASE_MS up to RETRY_MAX_MS. */
export const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8000;
/**
 * Seconds without an offer after which an update with no trains goes out anyway, so the detail
 * store's confirmation time keeps moving on a quiet night (the API turns 503 after 30 s).
 */
export const DETAIL_HEARTBEAT_S = 10;

interface Batch {
  at: number;
  sequence: number;
  timetableVersion: number;
  changed: Map<string, LiveInstanceState>;
  removed: Map<string, LiveInstanceState>;
  attempts: number;
}

/**
 * Takes detail updates from the tick without waiting and hands them to the port one at a time.
 * While a publish runs, newer updates merge (newest state per instance wins, a removal replaces a
 * change and a later change replaces a removal), so a slow port delays detail, never frames.
 */
export class DetailDispatcher {
  readonly stats: DispatcherStats = { published: 0, failed: 0, merged: 0, dropped: 0 };
  readonly #port: DetailPort;
  readonly #onError: (error: unknown) => void;
  readonly #wait: (ms: number) => Promise<void>;
  #pending: Batch | null = null;
  #running: Promise<void> | null = null;
  #lastOfferAt = Number.NEGATIVE_INFINITY;

  constructor(
    port: DetailPort,
    onError: (error: unknown) => void = () => {},
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.#port = port;
    this.#onError = onError;
    this.#wait = wait;
  }

  /** Queues an update; one without trains only as a heartbeat, DETAIL_HEARTBEAT_S after the last. */
  offer(update: LiveTickUpdate): void {
    const empty = update.changed.length === 0 && update.removed.length === 0;
    if (empty && update.at - this.#lastOfferAt < DETAIL_HEARTBEAT_S) return;
    this.#lastOfferAt = update.at;
    const pending = this.#pending;
    if (pending) this.stats.merged++;
    const target: Batch = pending ?? {
      at: update.at,
      sequence: update.sequence,
      timetableVersion: update.timetableVersion,
      changed: new Map<string, LiveInstanceState>(),
      removed: new Map<string, LiveInstanceState>(),
      attempts: 0,
    };
    target.at = update.at;
    target.sequence = update.sequence;
    target.timetableVersion = update.timetableVersion;
    for (const state of update.changed) {
      target.removed.delete(state.tripInstanceId);
      target.changed.set(state.tripInstanceId, state);
    }
    for (const state of update.removed) {
      target.changed.delete(state.tripInstanceId);
      target.removed.set(state.tripInstanceId, state);
    }
    this.#pending = target;
    this.#running ??= this.#drain();
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  async #drain(): Promise<void> {
    await Promise.resolve();
    while (this.#pending) {
      const batch = this.#pending;
      this.#pending = null;
      try {
        await this.#port.publish({
          at: batch.at,
          sequence: batch.sequence,
          timetableVersion: batch.timetableVersion,
          changed: [...batch.changed.values()],
          removed: [...batch.removed.values()],
        });
        this.stats.published++;
      } catch (error) {
        this.stats.failed++;
        this.#onError(error);
        batch.attempts++;
        if (batch.attempts >= MAX_ATTEMPTS) {
          this.stats.dropped++;
        } else {
          this.#requeue(batch);
          await this.#wait(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (batch.attempts - 1)));
        }
      }
    }
    this.#running = null;
  }

  /** Puts a failed batch back under what is pending: a state queued since then is newer and wins. */
  #requeue(batch: Batch): void {
    const newer = this.#pending;
    if (!newer) {
      this.#pending = batch;
      return;
    }
    for (const [id, state] of batch.changed) {
      if (!newer.changed.has(id) && !newer.removed.has(id)) newer.changed.set(id, state);
    }
    for (const [id, state] of batch.removed) {
      if (!newer.changed.has(id) && !newer.removed.has(id)) newer.removed.set(id, state);
    }
    newer.attempts = Math.max(newer.attempts, batch.attempts);
  }
}
