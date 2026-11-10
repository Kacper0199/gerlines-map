import { STATS_DELAY_BINS, StatsSummary } from "@gerlines/schema/stats";
import { describe, expect, it } from "vitest";
import {
  binCounts,
  delayHistogram,
  EMPTY_TOTALS,
  histogramQuantile,
  ratio,
  summarize,
} from "./summary.ts";

const stored = (counts: Record<number, number>) => [
  0,
  ...STATS_DELAY_BINS.map((_, bin) => counts[bin] ?? 0),
  0,
];

describe("delay histogram", () => {
  it("has the 30 bins of stat_bin with DB's 6 and 16 minute rules on edges", () => {
    expect(STATS_DELAY_BINS).toHaveLength(30);
    expect(STATS_DELAY_BINS[0]).toEqual([-1800, -300]);
    expect(STATS_DELAY_BINS[7]).toEqual([300, 360]);
    expect(STATS_DELAY_BINS[8]?.[0]).toBe(360);
    expect(STATS_DELAY_BINS[17]).toEqual([900, 960]);
    expect(STATS_DELAY_BINS[18]).toEqual([960, 1200]);
    expect(STATS_DELAY_BINS[26]).toEqual([3300, 3600]);
    expect(STATS_DELAY_BINS[29]).toEqual([7200, null]);
    for (let bin = 1; bin < STATS_DELAY_BINS.length; bin += 1) {
      expect(STATS_DELAY_BINS[bin]?.[0]).toBe(STATS_DELAY_BINS[bin - 1]?.[1]);
    }
  });

  it("drops the underflow and overflow cells and fills a missing histogram with zeros", () => {
    expect(binCounts(stored({ 2: 5, 29: 1 }))).toEqual(
      STATS_DELAY_BINS.map((_, bin) => (bin === 2 ? 5 : bin === 29 ? 1 : 0)),
    );
    expect(binCounts(null)).toEqual(STATS_DELAY_BINS.map(() => 0));
    const bins = delayHistogram(stored({ 3: 2 }));
    expect(bins[3]).toEqual({ fromS: 60, toS: 120, count: 2 });
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(2);
  });

  it("reads a quantile as the whole minute of its bin where it falls", () => {
    const hist = stored({ 2: 2, 3: 2 });
    expect(histogramQuantile(hist, 0.5)).toBe(0);
    expect(histogramQuantile(hist, 0.25)).toBe(0);
    expect(histogramQuantile(hist, 0.75)).toBe(60);
    expect(histogramQuantile(hist, 1)).toBe(60);
    expect(histogramQuantile(stored({ 18: 4 }), 0.5)).toBe(1020);
    expect(histogramQuantile(stored({ 18: 4 }), 1)).toBe(1140);
    expect(histogramQuantile(stored({ 29: 3 }), 0.5)).toBe(7200);
    expect(histogramQuantile(null, 0.5)).toBeNull();
    expect(histogramQuantile(hist, 1.5)).toBeNull();
  });

  it("interpolates inside a bin when the values are not whole minutes", () => {
    const hist = stored({ 2: 2, 3: 2 });
    expect(histogramQuantile(hist, 0.25, STATS_DELAY_BINS, null)).toBe(30);
    expect(histogramQuantile(hist, 0.5, STATS_DELAY_BINS, null)).toBe(60);
    expect(histogramQuantile(hist, 0.75, STATS_DELAY_BINS, null)).toBe(90);
  });

  it("keeps a delay of exactly 0 at 0 when half the stops had none", () => {
    const delays = [...Array(10).fill(0), 60, 60, 120, 180, 240, 300, 420, 600, 900, 1500];
    const hist = histogramOf(delays);
    expect(histogramQuantile(hist, 0.5)).toBe(0);
    expect(histogramQuantile(hist, 0.9)).toBe(600);
  });

  it("matches the exact quantiles of a whole-minute sample", () => {
    const delays = [
      -360, -120, -60, 0, 0, 0, 0, 0, 0, 0, 60, 60, 60, 120, 120, 180, 240, 240, 300, 360, 420, 540,
      720, 960, 1080, 1140, 1320, 1800, 2700, 3900, 6000, 9000,
    ];
    const hist = histogramOf(delays);
    for (const q of [0.05, 0.1, 0.25, 0.5, 0.6, 0.75, 0.8, 0.9, 0.95]) {
      const exact = percentileDisc(delays, q);
      const value = histogramQuantile(hist, q) as number;
      if (binWidth(exact) === 60) expect(value, `q ${q}`).toBe(exact);
      else expect(binOf(value), `q ${q}`).toEqual(binOf(exact));
      expect(Number.isInteger(value / 60), `q ${q}`).toBe(true);
    }
  });

  it("stays within one minute below the exact quantile when values carry seconds", () => {
    const delays = Array.from({ length: 200 }, (_, i) => Math.round((i * 7919) % 1100) - 50);
    const hist = histogramOf(delays);
    for (const q of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const exact = percentileDisc(delays, q);
      const value = histogramQuantile(hist, q) as number;
      expect(value, `q ${q}`).toBeLessThanOrEqual(exact);
      expect(exact - value, `q ${q}`).toBeLessThan(binWidth(exact));
    }
  });
});

function binIndex(value: number): number {
  return STATS_DELAY_BINS.findIndex(
    ([lower, upper]) => (lower === null || value >= lower) && (upper === null || value < upper),
  );
}

function binOf(value: number): readonly [number | null, number | null] {
  return STATS_DELAY_BINS[binIndex(value)] ?? [null, null];
}

function binWidth(value: number): number {
  const [lower, upper] = binOf(value);
  return lower === null || upper === null ? Number.POSITIVE_INFINITY : upper - lower;
}

function histogramOf(values: readonly number[]): number[] {
  const counts: Record<number, number> = {};
  for (const value of values) counts[binIndex(value)] = (counts[binIndex(value)] ?? 0) + 1;
  return stored(counts);
}

function percentileDisc(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;
}

describe("summarize", () => {
  it("keeps shares and delays missing when nothing was observed", () => {
    const summary = summarize({ ...EMPTY_TOTALS, n_stops: 4, n_no_data: 4 });
    expect(summary.punctual6).toBeNull();
    expect(summary.meanDelayS).toBeNull();
    expect(summary.medianDelayS).toBeNull();
    expect(summary.cancelledShare).toBe(0);
    expect(StatsSummary.parse(summary)).toEqual(summary);
  });

  it("takes punctuality from arrivals only and rounds shares to four digits", () => {
    const summary = summarize({
      ...EMPTY_TOTALS,
      n_stops: 10,
      n_cancelled: 1,
      n_observed: 9,
      n_observed_arr: 3,
      n_lt_6min_arr: 1,
      n_lt_16min_arr: 2,
      n_lt_6min: 7,
      sum_delay_s: 1000,
      max_delay_s: 600,
      delay_hist: stored({ 2: 9 }),
    });
    expect(summary.punctual6).toBe(0.3333);
    expect(summary.punctual16).toBe(0.6667);
    expect(summary.cancelledShare).toBe(0.1);
    expect(summary.meanDelayS).toBe(111.1);
    expect(summary.medianDelayS).toBe(0);
    expect(summary.maxDelayS).toBe(600);
    expect(ratio(1, 0)).toBeNull();
  });
});
