const DELAY_SECONDS = /^\d{1,9}$/;

/** Milliseconds to wait from `now`, for both `Retry-After` forms; null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (DELAY_SECONDS.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  if (!/[A-Za-z]/.test(trimmed)) {
    return null;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const DEFAULT_PROVIDER_PAUSE_MS = 60_000;
const MAX_PROVIDER_PAUSE_MS = 15 * 60_000;

/** How long every caller of a provider waits after a 429 or 503: `Retry-After`, else a minute, at most 15. */
export function providerPauseMs(
  status: number | null | undefined,
  retryAfter: string | null | undefined,
  now: number,
): number | null {
  if (status !== 429 && status !== 503) return null;
  return Math.min(
    parseRetryAfter(retryAfter, now) ?? DEFAULT_PROVIDER_PAUSE_MS,
    MAX_PROVIDER_PAUSE_MS,
  );
}
