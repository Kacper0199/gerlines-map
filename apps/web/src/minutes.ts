const MINUTE_MS = 60_000;

export function minutesUntil(targetMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((targetMs - nowMs) / MINUTE_MS));
}
