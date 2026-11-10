import { retryDelayMs } from "./car-layers.ts";

const QUIET_AFTER_ATTEMPTS = 3;

/**
 * Runs `load` until it succeeds, waiting 1 s doubling to 1 min between attempts and reporting each
 * failure (after the third attempt only when the error changed, so a permanent 404 does not warn every
 * minute); returns a function that stops it. A failed manifest or palette fetch (network blip,
 * deploy race) then costs a delay, not the 3D cars for the whole session.
 */
export function loadWithRetry<T>(
  load: () => Promise<T>,
  onLoaded: (value: T) => void,
  onFailure: (error: unknown, attempt: number, delayMs: number) => void,
): () => void {
  let cancelled = false;
  let lastReported = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (number: number): void => {
    load().then(
      (value) => {
        if (cancelled) return;
        try {
          onLoaded(value);
        } catch (error) {
          onFailure(error, number, 0);
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        const delay = retryDelayMs(number);
        const text = String(error);
        if (number <= QUIET_AFTER_ATTEMPTS || text !== lastReported)
          onFailure(error, number, delay);
        lastReported = text;
        timer = setTimeout(() => attempt(number + 1), delay);
      },
    );
  };
  attempt(1);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
