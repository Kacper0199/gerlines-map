export interface Gap {
  readonly start: number;
  readonly end: number;
}

/**
 * Intervals with no successful fetch for longer than twice the cadence, between two successes.
 * `successTimes` may be unsorted and contain duplicates.
 */
export function findGaps(successTimes: readonly number[], cadenceMs: number): Gap[] {
  const sorted = [...new Set(successTimes)].sort((a, b) => a - b);
  const threshold = 2 * cadenceMs;
  const gaps: Gap[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const start = sorted[index - 1] ?? 0;
    const end = sorted[index] ?? 0;
    if (end - start > threshold) {
      gaps.push({ start, end });
    }
  }
  return gaps;
}

/** The gap still running at `now`, when the last success is older than twice the cadence. */
export function openGap(lastSuccess: number | null, now: number, cadenceMs: number): Gap | null {
  if (lastSuccess === null || now - lastSuccess <= 2 * cadenceMs) {
    return null;
  }
  return { start: lastSuccess, end: now };
}

export function snapshotOf(t: number, offsetMs = 1_000): number {
  return Math.floor((t - offsetMs) / 60_000) * 60_000 + offsetMs;
}

/**
 * Minute snapshots (`hh:mm:01` UTC for the DELFI mirror) strictly between the snapshots that the
 * successes bounding the gap correspond to.
 */
export function missingSnapshots(gap: Gap, offsetMs = 1_000): number[] {
  const snapshots: number[] = [];
  const last = snapshotOf(gap.end, offsetMs);
  for (let t = snapshotOf(gap.start, offsetMs) + 60_000; t < last; t += 60_000) {
    snapshots.push(t);
  }
  return snapshots;
}
