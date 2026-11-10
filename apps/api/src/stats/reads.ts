/** Statistics queries run at once in this process, over all statistics and reliability requests: the pool size. */
export const STATS_READS_MAX = 6;

/** The most queries each statistics read runs at once (`StatsService`), which it takes from the gate. */
export const STATS_READ_QUERIES = {
  network: 6,
  land: 5,
  station: 4,
  train: 3,
  line: 3,
  segments: 2,
} as const;

/** The process-wide reads are taken: the caller answers 503 and the client tries again. */
export class StatsBusyError extends Error {
  constructor() {
    super("statistics reads are all taken");
    this.name = "StatsBusyError";
  }
}

export interface ReadGate {
  tryEnter(queries?: number): boolean;
  leave(queries?: number): void;
  inFlight(): number;
}

/**
 * Counts the queries running in this process and refuses a read whose queries would go above
 * `max`. A read of more queries than `max` counts as `max`, so it runs alone.
 */
export function readGate(max: number = STATS_READS_MAX): ReadGate {
  let running = 0;
  const share = (queries: number) => Math.min(Math.max(1, queries), max);
  return {
    tryEnter(queries = 1) {
      if (running + share(queries) > max) return false;
      running += share(queries);
      return true;
    },
    leave(queries = 1) {
      running = Math.max(0, running - share(queries));
    },
    inFlight: () => running,
  };
}

/** Runs `read` inside the gate, or fails at once with `StatsBusyError` when its queries do not fit. */
export async function gated<T>(gate: ReadGate, read: () => Promise<T>, queries = 1): Promise<T> {
  if (!gate.tryEnter(queries)) throw new StatsBusyError();
  try {
    return await read();
  } finally {
    gate.leave(queries);
  }
}
