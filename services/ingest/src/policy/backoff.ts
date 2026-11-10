export interface BackoffPolicy {
  readonly baseMs: number;
  readonly capMs: number;
  readonly jitterRatio: number;
}

export type Random = () => number;

export function backoffDelayMs(failures: number, policy: BackoffPolicy, random: Random): number {
  if (failures <= 0) {
    return 0;
  }
  const exponential = policy.baseMs * 2 ** Math.min(failures - 1, 30);
  const spread = 1 + policy.jitterRatio * (2 * random() - 1);
  return Math.min(policy.capMs, Math.round(Math.min(exponential, policy.capMs) * spread));
}

const BACKOFF_CAP_MS = 15 * 60_000;
const BACKOFF_BASE_CEILING_MS = 30 * 60_000;

/** The backoff of a source polled every `periodMs`: a daily source retries within the hour, not a day later. */
export function backoffForPeriod(periodMs: number): BackoffPolicy {
  return {
    baseMs: Math.min(periodMs, BACKOFF_BASE_CEILING_MS),
    capMs: Math.max(BACKOFF_CAP_MS, periodMs),
    jitterRatio: 0.2,
  };
}
