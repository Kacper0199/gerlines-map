import { type BackoffPolicy, backoffDelayMs, type Random } from "./backoff.ts";

const MAX_RETRY_AFTER_MS = 86_400_000;

/** First instant strictly after `t` that lies `offsetMs` into a UTC period of `periodMs`. */
export function slotAfter(t: number, periodMs: number, offsetMs: number): number {
  const candidate = Math.floor((t - offsetMs) / periodMs) * periodMs + offsetMs;
  return candidate > t ? candidate : candidate + periodMs;
}

function slotAtOrAfter(t: number, periodMs: number, offsetMs: number): number {
  return slotAfter(t - 1, periodMs, offsetMs);
}

export interface AttemptInput {
  readonly now: number;
  readonly periodMs: number;
  readonly offsetMs: number;
  readonly jitterMs: number;
  readonly failures: number;
  readonly retryAfterMs: number | null;
  readonly backoff: BackoffPolicy;
  readonly random: Random;
}

/**
 * The next attempt: the next slot of the period after a success; after a failure or a `Retry-After`, the
 * first slot of the backoff grid (the period, or the backoff base when that is shorter) once both have passed.
 */
export function nextAttemptAt(input: AttemptInput): number {
  const { now, periodMs, offsetMs } = input;
  const backoff = backoffDelayMs(input.failures, input.backoff, input.random);
  const retryAfter = Math.min(input.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS);
  const earliest = now + Math.max(backoff, retryAfter);
  const retryGridMs = Math.min(periodMs, input.backoff.baseMs);
  const slot =
    earliest > now
      ? slotAtOrAfter(earliest, retryGridMs, offsetMs % retryGridMs)
      : slotAfter(now, periodMs, offsetMs);
  return slot + Math.floor(input.random() * input.jitterMs);
}
