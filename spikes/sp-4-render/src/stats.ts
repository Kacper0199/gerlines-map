export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function percentile(sorted: ArrayLike<number>, fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? 0;
  return low + (high - low) * (position - lower);
}

export function summarize(values: ArrayLike<number>): Summary {
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    count: sorted.length,
    mean: sorted.length === 0 ? Number.NaN : sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length === 0 ? Number.NaN : (sorted[sorted.length - 1] ?? Number.NaN),
  };
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
