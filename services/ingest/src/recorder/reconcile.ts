import type { Clock } from "../clock.ts";
import { errorMessage, type Logger } from "../log.ts";
import type { ReconcileOutcome, ReconcileTicket } from "./index-sink.ts";

export const RECONCILE_MS = 60 * 60_000;
export const RECONCILE_RETRY_MS: readonly number[] = [60_000, 120_000, 300_000];
export const RECONCILE_TICK_MS = 60_000;

/**
 * How long after the last reconcile the next one is due. A clean index waits the hour; a dirty one
 * retries after 1, 2 and 5 minutes while reconciles keep leaving it dirty, then falls back to the hour.
 * `dirtyInRow` counts the reconciles in a row that ended with the index dirty.
 */
export function reconcileDelayMs(dirty: boolean, dirtyInRow: number): number {
  if (!dirty) return RECONCILE_MS;
  return RECONCILE_RETRY_MS[Math.max(0, dirtyInRow - 1)] ?? RECONCILE_MS;
}

export interface ReconcileSink {
  readonly dirty: boolean;
  takeRecovered(): boolean;
  beginReconcile(): ReconcileTicket;
  endReconcile(ticket: ReconcileTicket, outcome: ReconcileOutcome): boolean;
}

export interface ReconcileLoopOptions {
  readonly clock: Clock;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly sink: ReconcileSink;
  /** Rebuilds the index from the files; throws when it could not, returns early once the signal aborts. */
  readonly reconcile: (signal: AbortSignal) => Promise<void>;
}

async function reconcileOnce(options: ReconcileLoopOptions): Promise<boolean> {
  const { clock, signal, logger, sink } = options;
  const ticket = sink.beginReconcile();
  const startedAt = clock.now();
  let outcome: ReconcileOutcome = "clean";
  try {
    await options.reconcile(signal);
  } catch (error) {
    outcome = "failed";
    if (!signal.aborted) {
      logger.log("warn", "reconcile from files failed", { error: errorMessage(error) });
    }
  }
  if (signal.aborted) outcome = "aborted";
  const clean = sink.endReconcile(ticket, outcome);
  if (outcome === "clean" && clean && ticket.wasDirty) {
    logger.log("info", "database index healed from files", {
      durationMs: clock.now() - startedAt,
    });
  }
  return clean;
}

/**
 * Reconciles at start, then each hour while the index is clean and on a short backoff while it is dirty.
 * A write that succeeds again after failures restarts the backoff, so an index the database refused at a
 * cold start heals within minutes of the database coming up, however long it took.
 */
export async function reconcileLoop(options: ReconcileLoopOptions): Promise<void> {
  const { clock, signal, logger, sink } = options;
  let lastAt: number | null = null;
  let dirtyInRow = 0;
  while (!signal.aborted) {
    try {
      if (sink.takeRecovered() && sink.dirty) dirtyInRow = 0;
      if (lastAt === null || clock.now() - lastAt >= reconcileDelayMs(sink.dirty, dirtyInRow)) {
        lastAt = clock.now();
        dirtyInRow = (await reconcileOnce(options)) ? 0 : dirtyInRow + 1;
      }
    } catch (error) {
      lastAt = null;
      logger.log("error", "background task failed, retrying on its next turn", {
        task: "reconcile",
        error: errorMessage(error),
      });
    }
    await clock.sleep(RECONCILE_TICK_MS, signal);
  }
}
