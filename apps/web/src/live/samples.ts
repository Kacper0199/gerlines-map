const CAPACITY = 1_200;

/** The last samples of a duration, summarised as percentiles for the diagnostics. */
export class Samples {
  private readonly values = new Float64Array(CAPACITY);
  private count = 0;
  total = 0;

  add(value: number): void {
    this.values[this.total % CAPACITY] = value;
    this.total++;
    this.count = Math.min(this.count + 1, CAPACITY);
  }

  summary(): { p50: number; p95: number; max: number; count: number } {
    if (this.count === 0) return { p50: 0, p95: 0, max: 0, count: 0 };
    const sorted = Array.from(this.values.subarray(0, this.count)).sort((a, b) => a - b);
    const at = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
    return {
      p50: at(0.5),
      p95: at(0.95),
      max: sorted[sorted.length - 1] as number,
      count: this.total,
    };
  }
}
