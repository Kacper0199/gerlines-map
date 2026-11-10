import type { RollupTotals } from "@gerlines/db";
import {
  STATS_DELAY_BINS,
  type StatsDay,
  type StatsDelayBin,
  type StatsHour,
  type StatsSummary,
} from "@gerlines/schema/stats";

const SHARE_DIGITS = 1e4;
const SECONDS_DIGITS = 10;

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * SHARE_DIGITS) / SHARE_DIGITS : null;
}

export function mean(sum: number, n: number): number | null {
  return n > 0 ? Math.round((sum / n) * SECONDS_DIGITS) / SECONDS_DIGITS : null;
}

type Bins = readonly (readonly [number | null, number | null])[];

/** The bin counts of a stored histogram, without its underflow and overflow cells. */
export function binCounts(hist: readonly number[] | null, bins: Bins = STATS_DELAY_BINS): number[] {
  const counts = hist ? hist.slice(1, hist.length - 1) : [];
  return bins.map((_, index) => counts[index] ?? 0);
}

export function binnedHistogram(
  hist: readonly number[] | null,
  bins: Bins = STATS_DELAY_BINS,
): StatsDelayBin[] {
  const counts = binCounts(hist, bins);
  return bins.map(([fromS, toS], index) => ({ fromS, toS, count: counts[index] ?? 0 }));
}

export function delayHistogram(hist: readonly number[] | null): StatsDelayBin[] {
  return binnedHistogram(hist, STATS_DELAY_BINS);
}

/** Delays and gains are whole minutes in the sources: the step of the values inside a bin. */
export const MINUTE_S = 60;
const EPSILON = 1e-9;

/**
 * The q quantile of a stored histogram over `bins` (the delay bins unless given): the smallest value
 * at which q of the counts are reached, like `percentile_disc`. With a `step` the values of a bin are
 * its whole steps from the lower bound, spread evenly, so a 60 s bin gives its lower bound and a delay
 * or gain of exactly 0 stays 0; without one the value is interpolated inside the bin (speeds). An
 * open-ended bin gives its bound.
 */
export function histogramQuantile(
  hist: readonly number[] | null,
  q: number,
  bins: Bins = STATS_DELAY_BINS,
  step: number | null = MINUTE_S,
): number | null {
  const counts = binCounts(hist, bins);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total === 0 || q < 0 || q > 1) return null;
  const target = q * total;
  let upto = 0;
  for (const [index, n] of counts.entries()) {
    upto += n;
    if (n === 0 || upto + EPSILON < target) continue;
    const [lower, upper] = bins[index] ?? [null, null];
    if (lower === null) return upper;
    if (upper === null) return lower;
    const within = target - (upto - n);
    if (step === null) {
      const value = lower + ((upper - lower) * within) / n;
      return Math.round(value * SECONDS_DIGITS) / SECONDS_DIGITS;
    }
    const values = Math.max(1, Math.round((upper - lower) / step));
    const rank = Math.ceil((within * values) / n - EPSILON) - 1;
    return lower + Math.min(values - 1, Math.max(0, rank)) * step;
  }
  return null;
}

export function summarize(totals: RollupTotals): StatsSummary {
  return {
    stops: totals.n_stops,
    cancelled: totals.n_cancelled,
    additional: totals.n_additional,
    noData: totals.n_no_data,
    observed: totals.n_observed,
    observedArrivals: totals.n_observed_arr,
    punctual6: ratio(totals.n_lt_6min_arr, totals.n_observed_arr),
    punctual16: ratio(totals.n_lt_16min_arr, totals.n_observed_arr),
    cancelledShare: ratio(totals.n_cancelled, totals.n_stops),
    meanDelayS: mean(totals.sum_delay_s, totals.n_observed),
    medianDelayS: histogramQuantile(totals.delay_hist, 0.5),
    p90DelayS: histogramQuantile(totals.delay_hist, 0.9),
    maxDelayS: totals.max_delay_s,
    platformChanged: totals.n_platform_changed,
    observedCarried: totals.n_observed_carried,
    observedPropagated: totals.n_observed_propagated,
  };
}

export function daySummary(day: string, totals: RollupTotals): StatsDay {
  return {
    day,
    stops: totals.n_stops,
    cancelled: totals.n_cancelled,
    observedArrivals: totals.n_observed_arr,
    punctual6: ratio(totals.n_lt_6min_arr, totals.n_observed_arr),
    punctual16: ratio(totals.n_lt_16min_arr, totals.n_observed_arr),
    meanDelayS: mean(totals.sum_delay_s, totals.n_observed),
  };
}

export function hourSummary(hour: number, totals: RollupTotals): StatsHour {
  return {
    hour,
    stops: totals.n_stops,
    cancelled: totals.n_cancelled,
    observedArrivals: totals.n_observed_arr,
    punctual6: ratio(totals.n_lt_6min_arr, totals.n_observed_arr),
    meanDelayS: mean(totals.sum_delay_s, totals.n_observed),
  };
}

export const EMPTY_TOTALS: RollupTotals = {
  n_stops: 0,
  n_cancelled: 0,
  n_additional: 0,
  n_no_data: 0,
  n_carried: 0,
  n_observed: 0,
  n_lt_6min: 0,
  n_lt_16min: 0,
  n_observed_arr: 0,
  n_lt_6min_arr: 0,
  n_lt_16min_arr: 0,
  n_observed_carried: 0,
  n_observed_propagated: 0,
  sum_delay_s: 0,
  max_delay_s: null,
  n_platform_changed: 0,
  delay_hist: null,
  n_runs: null,
  n_dep_observed: null,
  n_dep_lt_6min: null,
};
