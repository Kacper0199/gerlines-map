/** Durations (ms) of database queries and work by name, for the p95 evidence and the logs. */
const durations = new Map<string, number[]>();
const MAX_SAMPLES = 200_000;

export function recordDuration(name: string, milliseconds: number): void {
  const list = durations.get(name) ?? [];
  if (list.length < MAX_SAMPLES) list.push(milliseconds);
  durations.set(name, list);
}

export async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    recordDuration(name, performance.now() - started);
  }
}

export interface DurationSummary {
  readonly name: string;
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly total: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

export function durationSummary(): DurationSummary[] {
  return [...durations.entries()]
    .map(([name, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return {
        name,
        count: list.length,
        p50: round(quantile(sorted, 0.5)),
        p95: round(quantile(sorted, 0.95)),
        max: round(sorted.at(-1) ?? 0),
        total: round(list.reduce((sum, value) => sum + value, 0)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resetDurations(): void {
  durations.clear();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
