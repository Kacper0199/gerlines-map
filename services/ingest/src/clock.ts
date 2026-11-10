export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted || ms <= 0) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export function isoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function utcDate(epochMs: number): string {
  return isoUtc(epochMs).slice(0, 10);
}

export function utcHour(epochMs: number): string {
  return isoUtc(epochMs).slice(11, 13);
}
