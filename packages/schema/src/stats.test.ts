import { describe, expect, it } from "vitest";
import {
  STATS_GAIN_BINS,
  STATS_MAX_SEGMENTS,
  STATS_PATHS,
  STATS_SEGMENT_MIN_RUNS,
  STATS_SEGMENT_NOTE,
  STATS_SPEED_BINS,
  StatsSegmentFigures,
  StatsTrainSegments,
} from "./stats.ts";

const place = (id: string) => ({ id, name: "Hamburg Hbf" });
const A = "4eda9b92-2ddf-5610-b59b-ed665a8b2610";
const B = "5eda9b92-2ddf-5610-b59b-ed665a8b2610";

const known = {
  status: "known",
  runs: 24,
  medianGainS: 30,
  p80GainS: 95,
  meanGainS: -45,
  gainCounts: STATS_GAIN_BINS.map(() => 0),
  speed: { status: "missing", legs: 0, reason: "no_distance" },
} as const;

const answer = {
  kind: "trainSegments",
  period: { from: "2025-11-01", to: "2025-11-30", days: 30 },
  freshness: { refreshedAt: null, maxLagMinutes: 40, note: "lag" },
  generatedAt: "2026-11-08T05:00:00.000Z",
  number: "596",
  operatorId: null,
  categories: ["hsr"],
  groups: [
    {
      category: "hsr",
      operator: { id: "db-fernverkehr-ag", name: "DB Fernverkehr AG" },
      runs: 24,
      shown: true,
    },
    { category: "reg", operator: null, runs: 11, shown: false },
  ],
  route: { runs: 24, patternRuns: 18 },
  minRuns: STATS_SEGMENT_MIN_RUNS,
  note: STATS_SEGMENT_NOTE,
  gainBins: STATS_GAIN_BINS.map(([fromS, toS]) => ({ fromS, toS })),
  segments: [
    {
      position: 0,
      onRoute: true,
      from: place(A),
      to: place(B),
      train: known,
      all: { ...known, runs: 3443 },
    },
    {
      position: 1,
      onRoute: false,
      from: place(B),
      to: { id: A, name: null },
      train: { status: "missing", runs: 2, reason: "too_few_runs" },
      all: { status: "missing", runs: 0, reason: "no_runs" },
    },
  ],
  truncated: false,
};

describe("segment profile contract", () => {
  it("names the route below the train route", () => {
    expect(STATS_PATHS.trainSegments).toBe("/api/v1/stats/trains/{number}/segments");
  });

  it("mirrors the 21 gain bins and 31 speed bins of stat_bin, without gaps", () => {
    expect(STATS_GAIN_BINS).toHaveLength(21);
    expect(STATS_GAIN_BINS[0]).toEqual([null, -600]);
    expect(STATS_GAIN_BINS[7]).toEqual([0, 60]);
    expect(STATS_GAIN_BINS[16]).toEqual([540, 600]);
    expect(STATS_GAIN_BINS[20]).toEqual([3600, null]);
    expect(STATS_SPEED_BINS).toHaveLength(31);
    expect(STATS_SPEED_BINS[30]).toEqual([300, null]);
    for (const bins of [STATS_GAIN_BINS, STATS_SPEED_BINS]) {
      for (let index = 1; index < bins.length; index += 1) {
        expect(bins[index]?.[0]).toBe(bins[index - 1]?.[1]);
      }
    }
  });

  it("counts the speed minimum in legs with a distance, not runs", () => {
    expect(
      StatsSegmentFigures.safeParse({
        ...known,
        speed: { status: "missing", runs: 3, reason: "too_few_runs" },
      }).success,
    ).toBe(false);
  });

  it("names a segment whose runs have no gains apart from one without runs", () => {
    expect(
      StatsSegmentFigures.parse({ status: "missing", runs: 6, reason: "no_gains" }),
    ).toMatchObject({ reason: "no_gains" });
  });

  it("gives the gain bin bounds once and one count per bin in each segment", () => {
    expect(StatsTrainSegments.safeParse({ ...answer, gainBins: [] }).success).toBe(false);
    expect(StatsSegmentFigures.safeParse({ ...known, gainCounts: [1, 2] }).success).toBe(false);
  });

  it("accepts a profile with known and missing segments", () => {
    expect(StatsTrainSegments.parse(answer).segments).toHaveLength(2);
  });

  it("keeps a missing segment free of figures and with a reason", () => {
    expect(
      StatsSegmentFigures.safeParse({ status: "missing", runs: 3, reason: "too_few_runs" }).success,
    ).toBe(true);
    expect(StatsSegmentFigures.safeParse({ status: "missing", runs: 3 }).success).toBe(false);
    expect(
      StatsSegmentFigures.safeParse({ ...known, status: "missing", reason: "too_few_runs" }).data,
    ).toEqual({ status: "missing", runs: 24, reason: "too_few_runs" });
    expect(StatsSegmentFigures.safeParse({ ...known, medianGainS: null }).success).toBe(false);
  });

  it("refuses an unknown minimum and more than the segment cap", () => {
    expect(StatsTrainSegments.safeParse({ ...answer, minRuns: 3 }).success).toBe(false);
    const many = Array.from({ length: STATS_MAX_SEGMENTS + 1 }, (_, position) => ({
      ...answer.segments[0],
      position,
    }));
    expect(StatsTrainSegments.safeParse({ ...answer, segments: many }).success).toBe(false);
  });
});
