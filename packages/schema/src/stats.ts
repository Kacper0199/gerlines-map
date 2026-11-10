import { z } from "zod";
import { TrainCategory } from "./train-detail.ts";

export const STATS_BASE_PATH = "/api/v1/stats";
export const STATS_PATHS = {
  today: `${STATS_BASE_PATH}/today`,
  period: `${STATS_BASE_PATH}/period`,
  train: `${STATS_BASE_PATH}/trains/{number}`,
  trainSegments: `${STATS_BASE_PATH}/trains/{number}/segments`,
  line: `${STATS_BASE_PATH}/lines/{line}`,
  station: `${STATS_BASE_PATH}/stations/{id}`,
  land: `${STATS_BASE_PATH}/lands/{code}`,
} as const;

/** Longest period one request may cover, in service days. */
export const STATS_MAX_DAYS = 366;
/** The rollups refresh every 30 minutes, level 2 five to nine minutes after level 1 (WP-2.7). */
export const STATS_MAX_LAG_MINUTES = 40;
export const STATS_LAG_NOTE =
  "Statistics are up to about 40 minutes behind the live map, because they are read from rollups refreshed every 30 minutes.";

export const STATS_LAND_CODES = [
  "DE-SH",
  "DE-HH",
  "DE-NI",
  "DE-HB",
  "DE-NW",
  "DE-HE",
  "DE-RP",
  "DE-BW",
  "DE-BY",
  "DE-SL",
  "DE-BE",
  "DE-BB",
  "DE-MV",
  "DE-SN",
  "DE-ST",
  "DE-TH",
] as const;

/**
 * The delay bins of `stat_bin` (kind delay), lower bound inclusive, upper exclusive, in seconds;
 * null is open-ended. One-minute bins up to 16 minutes put DB's 5:59 and 15:59 rules on edges.
 */
export const STATS_DELAY_BINS: readonly (readonly [number | null, number | null])[] = [
  [-1800, -300],
  [-300, 0],
  ...Array.from({ length: 16 }, (_, i) => [i * 60, (i + 1) * 60] as const),
  [960, 1200],
  ...Array.from({ length: 8 }, (_, i) => [1200 + i * 300, 1500 + i * 300] as const),
  [3600, 5400],
  [5400, 7200],
  [7200, null],
];

/** The delay gain bins of `stat_bin` (kind gain), in seconds, lower bound inclusive; null is open-ended. */
export const STATS_GAIN_BINS: readonly (readonly [number | null, number | null])[] = [
  [null, -600],
  [-600, -300],
  ...Array.from({ length: 15 }, (_, i) => [-300 + i * 60, -240 + i * 60] as const),
  [600, 900],
  [900, 1800],
  [1800, 3600],
  [3600, null],
];

/** The speed bins of `stat_bin` (kind speed), 10 km/h wide from 0, the last one 300 km/h and over. */
export const STATS_SPEED_BINS: readonly (readonly [number | null, number | null])[] = [
  ...Array.from({ length: 30 }, (_, i) => [i * 10, (i + 1) * 10] as const),
  [300, null],
];

/** A segment needs this many runs in the period before its figures are shown, like the planner's hint. */
export const STATS_SEGMENT_MIN_RUNS = 5;
/** Most segments one answer lists: the route first, then the other legs of the number by runs. */
export const STATS_MAX_SEGMENTS = 100;
export const STATS_SEGMENT_NOTE =
  "Delay gain is the arrival delay at the end of a segment minus the departure delay at its start, in whole minutes like the sources. Median and p80 are the smallest gains at which half and 80 percent of the legs are reached, so a gain of exactly 0 counts as 0. Legs after a feed stopped reporting keep a gain of exactly 0, so more legs show 0 than ran exactly on time.";

export const StatsLandCode = z.enum(STATS_LAND_CODES);
export const StatsTrainNumber = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z]{1,12}$/, "letters and digits, at most 12");
export const StatsLineName = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-zÄÖÜäöüß+ -]{1,16}$/, "letters, digits, spaces, plus and hyphen, at most 16");

const day = z.iso.date();
const instant = z.iso.datetime();
const count = z.int().nonnegative();
const share = z.number().min(0).max(1).nullable();
const seconds = z.number().nullable();
const label = z.string().trim().min(1);

export const StatsPeriod = z.object({
  from: day,
  to: day,
  days: z.int().min(1).max(STATS_MAX_DAYS),
});

export const StatsFreshness = z.object({
  refreshedAt: instant.nullable(),
  maxLagMinutes: z.literal(STATS_MAX_LAG_MINUTES),
  note: label,
});

/**
 * Counts and shares of the stops in scope. Shares and delays are null when nothing was observed:
 * missing data stays missing. `punctual6` is DB's operational punctuality: arrivals (origins left
 * out) less than 6 minutes late among observed arrivals, cancellations not counted.
 */
export const StatsSummary = z.object({
  stops: count,
  cancelled: count,
  additional: count,
  noData: count,
  observed: count,
  observedArrivals: count,
  punctual6: share,
  punctual16: share,
  cancelledShare: share,
  meanDelayS: seconds,
  medianDelayS: seconds,
  p90DelayS: seconds,
  maxDelayS: z.int().nullable(),
  platformChanged: count,
  observedCarried: count,
  observedPropagated: count,
});

export const StatsDelayBin = z.object({
  fromS: z.int().nullable(),
  toS: z.int().nullable(),
  count,
});

export const StatsDay = z.object({
  day,
  stops: count,
  cancelled: count,
  observedArrivals: count,
  punctual6: share,
  punctual16: share,
  meanDelayS: seconds,
});

export const StatsHour = z.object({
  hour: z.int().min(0).max(23),
  stops: count,
  cancelled: count,
  observedArrivals: count,
  punctual6: share,
  meanDelayS: seconds,
});

export const StatsByCategory = z.object({
  category: TrainCategory.nullable(),
  summary: StatsSummary,
});

export const StatsOperator = z.object({ id: label, name: label.nullable() });

export const StatsByLand = z.object({
  landCode: StatsLandCode,
  name: label,
  summary: StatsSummary,
});

const envelope = {
  period: StatsPeriod,
  freshness: StatsFreshness,
  generatedAt: instant,
};

const breakdown = {
  summary: StatsSummary,
  byCategory: z.array(StatsByCategory),
  byDay: z.array(StatsDay),
  byHour: z.array(StatsHour),
  delayHistogram: z.array(StatsDelayBin),
};

export const StatsNetwork = z.object({
  kind: z.literal("network"),
  ...envelope,
  categories: z.array(TrainCategory).nullable(),
  ...breakdown,
  byLand: z.array(StatsByLand),
  outsideGermany: z.object({ foreignStops: count, unassignedStops: count }),
});

export const StatsStation = z.object({
  kind: z.literal("station"),
  ...envelope,
  categories: z.array(TrainCategory).nullable(),
  station: z.object({ id: z.uuid(), name: label, landCode: z.string().nullable() }),
  ...breakdown,
  departures: z.object({ observed: count, punctual6: share }),
  byOperator: z.array(z.object({ operator: StatsOperator.nullable(), summary: StatsSummary })),
});

export const StatsLand = z.object({
  kind: z.literal("land"),
  ...envelope,
  categories: z.array(TrainCategory).nullable(),
  land: z.object({ code: StatsLandCode, name: label }),
  ...breakdown,
});

export const StatsRunGroup = z.object({
  operator: StatsOperator.nullable(),
  category: TrainCategory.nullable(),
  line: label.nullable(),
  runs: count,
  summary: StatsSummary,
  byDay: z.array(StatsDay.extend({ runs: count })),
  delayHistogram: z.array(StatsDelayBin),
});

export const StatsTrain = z.object({
  kind: z.literal("train"),
  ...envelope,
  number: label,
  operatorId: label.nullable(),
  groups: z.array(StatsRunGroup),
});

export const StatsLine = z.object({
  kind: z.literal("line"),
  ...envelope,
  line: label,
  operatorId: label.nullable(),
  groups: z.array(StatsRunGroup),
});

export const StatsSegmentPlace = z.object({ id: z.uuid(), name: label.nullable() });

/** One gain bin's bounds in seconds, lower inclusive; null is open-ended. */
export const StatsGainBin = z.object({ fromS: z.int().nullable(), toS: z.int().nullable() });

/**
 * Speed over the segment from its distance and actual run time; missing where no leg had a distance.
 * `legs` counts the legs with a distance, and the minimum of `STATS_SEGMENT_MIN_RUNS` applies to them.
 */
export const StatsSegmentSpeed = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("known"),
    legs: count,
    meanKmh: z.number().nonnegative(),
    medianKmh: z.number().nonnegative(),
  }),
  z.object({
    status: z.literal("missing"),
    legs: count,
    reason: z.enum(["no_distance", "too_few_runs"]),
  }),
]);

/**
 * Delay gain over one segment: median and 80th percentile (from the gain bins, in whole minutes) and
 * mean in seconds, positive when time was lost. Missing below `STATS_SEGMENT_MIN_RUNS` runs.
 */
export const StatsSegmentFigures = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("known"),
    runs: count,
    medianGainS: z.number(),
    p80GainS: z.number(),
    meanGainS: z.number(),
    /** Legs per gain bin, in the order of the answer's `gainBins`. */
    gainCounts: z.array(count).length(STATS_GAIN_BINS.length),
    speed: StatsSegmentSpeed,
  }),
  z.object({
    status: z.literal("missing"),
    runs: count,
    reason: z.enum(["no_runs", "too_few_runs", "no_gains"]),
  }),
]);

export const StatsSegment = z.object({
  position: z.int().nonnegative(),
  onRoute: z.boolean(),
  from: StatsSegmentPlace,
  to: StatsSegmentPlace,
  train: StatsSegmentFigures,
  all: StatsSegmentFigures,
});

/**
 * One train behind a number in the period: its category and operator with its runs. A number is often
 * several trains (an ICE, an RB and a bus); the profile shows one of them (`shown`).
 */
export const StatsSegmentGroup = z.object({
  category: TrainCategory.nullable(),
  operator: StatsOperator.nullable(),
  runs: count,
  shown: z.boolean(),
});

/**
 * The segment profile of a train number (R-09): the legs between consecutive stops of its most
 * frequent stop sequence in the period (`onRoute`, in order), then its other legs by runs, each with
 * this number's delay gain against every train on that leg. `categories` and `operatorId` choose the
 * runs of the number; of the category and operator groups left (`groups`, most runs first) only the
 * first is profiled, so a number shared by several trains never mixes them. `all` counts every train
 * on the leg.
 */
export const StatsTrainSegments = z.object({
  kind: z.literal("trainSegments"),
  ...envelope,
  number: label,
  operatorId: label.nullable(),
  categories: z.array(TrainCategory).nullable(),
  groups: z.array(StatsSegmentGroup),
  route: z.object({ runs: count, patternRuns: count }),
  minRuns: z.literal(STATS_SEGMENT_MIN_RUNS),
  note: label,
  gainBins: z.array(StatsGainBin).length(STATS_GAIN_BINS.length),
  segments: z.array(StatsSegment).max(STATS_MAX_SEGMENTS),
  truncated: z.boolean(),
});

export type StatsSummary = z.infer<typeof StatsSummary>;
export type StatsDelayBin = z.infer<typeof StatsDelayBin>;
export type StatsDay = z.infer<typeof StatsDay>;
export type StatsHour = z.infer<typeof StatsHour>;
export type StatsFreshness = z.infer<typeof StatsFreshness>;
export type StatsPeriod = z.infer<typeof StatsPeriod>;
export type StatsOperator = z.infer<typeof StatsOperator>;
export type StatsRunGroup = z.infer<typeof StatsRunGroup>;
export type StatsNetwork = z.infer<typeof StatsNetwork>;
export type StatsStation = z.infer<typeof StatsStation>;
export type StatsLand = z.infer<typeof StatsLand>;
export type StatsTrain = z.infer<typeof StatsTrain>;
export type StatsLine = z.infer<typeof StatsLine>;
export type StatsLandCode = z.infer<typeof StatsLandCode>;
export type StatsGainBin = z.infer<typeof StatsGainBin>;
export type StatsSegmentGroup = z.infer<typeof StatsSegmentGroup>;
export type StatsSegmentSpeed = z.infer<typeof StatsSegmentSpeed>;
export type StatsSegmentFigures = z.infer<typeof StatsSegmentFigures>;
export type StatsSegment = z.infer<typeof StatsSegment>;
export type StatsTrainSegments = z.infer<typeof StatsTrainSegments>;
