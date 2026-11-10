/** What a playback window may be (ADR-0014 draft): its length, how far back, and how long after its end. */
export interface PlaybackLimits {
  /** Window length; starts are multiples of it in Unix seconds. */
  readonly windowSeconds: number;
  /** The oldest start served, counted back from now (history kept for playback). */
  readonly maxAgeSeconds: number;
  /** Time after a window's end before it is rendered, so late payloads are folded first. */
  readonly settleSeconds: number;
}

export const DEFAULT_LIMITS: PlaybackLimits = {
  windowSeconds: 3600,
  maxAgeSeconds: 7 * 24 * 3600,
  settleSeconds: 1800,
};

export type WindowCheck =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | {
      readonly ok: false;
      readonly code: "MISALIGNED" | "TOO_OLD" | "NOT_SETTLED";
      readonly message: string;
    };

const START = /^[1-9]\d{9}$/;

/** A window start as written in a path: ten digits of Unix seconds, nothing else. */
export function parseWindowStart(text: string): number | null {
  return START.test(text) ? Number(text) : null;
}

export function checkWindow(
  start: number,
  now: number,
  limits: PlaybackLimits = DEFAULT_LIMITS,
): WindowCheck {
  const end = start + limits.windowSeconds;
  if (!Number.isInteger(start) || start % limits.windowSeconds !== 0) {
    return {
      ok: false,
      code: "MISALIGNED",
      message: `a window starts on a multiple of ${limits.windowSeconds} s`,
    };
  }
  if (start < now - limits.maxAgeSeconds) {
    return {
      ok: false,
      code: "TOO_OLD",
      message: `playback reaches back ${Math.round(limits.maxAgeSeconds / 86400)} days`,
    };
  }
  if (end + limits.settleSeconds > now) {
    return {
      ok: false,
      code: "NOT_SETTLED",
      message: `a window is played ${Math.round(limits.settleSeconds / 60)} min after its end`,
    };
  }
  return { ok: true, start, end };
}

/** Starts of the windows that lie wholly in [from, to] and pass `checkWindow` now, oldest first. */
export function dueWindows(
  from: number,
  to: number,
  now: number,
  limits: PlaybackLimits = DEFAULT_LIMITS,
): number[] {
  const due: number[] = [];
  const first = Math.ceil(from / limits.windowSeconds) * limits.windowSeconds;
  for (let start = first; start + limits.windowSeconds <= to; start += limits.windowSeconds) {
    if (checkWindow(start, now, limits).ok) due.push(start);
  }
  return due;
}
