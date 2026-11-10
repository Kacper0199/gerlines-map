import type { SegmentLegTotals, SegmentRow } from "@gerlines/db";
import {
  STATS_GAIN_BINS,
  STATS_SEGMENT_MIN_RUNS,
  STATS_SPEED_BINS,
  type StatsSegment,
  type StatsSegmentFigures,
  type StatsSegmentSpeed,
} from "@gerlines/schema/stats";
import { binCounts, histogramQuantile, mean } from "./summary.ts";

const KMH_DIGITS = 10;

function speedOf(totals: SegmentLegTotals): StatsSegmentSpeed {
  const legs = totals.n_speed;
  if (legs === 0 || totals.sum_distance_m === null || !totals.sum_run_act_s) {
    return { status: "missing", legs, reason: "no_distance" };
  }
  if (legs < STATS_SEGMENT_MIN_RUNS) return { status: "missing", legs, reason: "too_few_runs" };
  const median = histogramQuantile(totals.speed_hist, 0.5, STATS_SPEED_BINS, null);
  if (median === null) return { status: "missing", legs, reason: "no_distance" };
  const meanKmh = (totals.sum_distance_m / totals.sum_run_act_s) * 3.6;
  return {
    status: "known",
    legs,
    meanKmh: Math.round(meanKmh * KMH_DIGITS) / KMH_DIGITS,
    medianKmh: median,
  };
}

/**
 * Delay gain of the legs on one segment, known from `STATS_SEGMENT_MIN_RUNS` runs on: median and
 * 80th percentile from the gain bins in whole minutes (`histogramQuantile`), the mean from the sums.
 */
export function segmentFigures(totals: SegmentLegTotals | null): StatsSegmentFigures {
  const runs = totals?.n_runs ?? 0;
  if (!totals || runs === 0) return { status: "missing", runs: 0, reason: "no_runs" };
  if (runs < STATS_SEGMENT_MIN_RUNS) return { status: "missing", runs, reason: "too_few_runs" };
  const medianGainS = histogramQuantile(totals.gain_hist, 0.5, STATS_GAIN_BINS);
  const p80GainS = histogramQuantile(totals.gain_hist, 0.8, STATS_GAIN_BINS);
  const meanGainS = mean(totals.sum_gain_s, totals.n_legs);
  if (medianGainS === null || p80GainS === null || meanGainS === null) {
    return { status: "missing", runs, reason: "no_gains" };
  }
  return {
    status: "known",
    runs,
    medianGainS,
    p80GainS,
    meanGainS,
    gainCounts: binCounts(totals.gain_hist, STATS_GAIN_BINS),
    speed: speedOf(totals),
  };
}

export const GAIN_BINS = STATS_GAIN_BINS.map(([fromS, toS]) => ({ fromS, toS }));

export function segmentOf(row: SegmentRow, position: number): StatsSegment {
  return {
    position,
    onRoute: row.route_index !== null,
    from: { id: row.from_stop_place_id, name: row.from_name },
    to: { id: row.to_stop_place_id, name: row.to_name },
    train: segmentFigures(row.train),
    all: segmentFigures(row.all),
  };
}
