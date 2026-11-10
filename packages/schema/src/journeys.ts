import { z } from "zod";
import {
  JOURNEY_OPERATOR_TERM_MAX,
  JOURNEY_OPERATOR_TERM_MIN,
  JOURNEY_OPERATOR_TERMS_MAX,
  JOURNEY_RELIABILITY_PATH,
  JOURNEY_RELIABILITY_TRAINS_MAX,
  JOURNEYS_PATH,
} from "./constants.ts";
import { TRAIN_CATEGORIES, TrainCategory } from "./train-detail.ts";

export {
  JOURNEY_OPERATOR_TERM_MAX,
  JOURNEY_OPERATOR_TERM_MIN,
  JOURNEY_OPERATOR_TERMS_MAX,
  JOURNEY_RELIABILITY_PATH,
  JOURNEY_RELIABILITY_TRAINS_MAX,
  JOURNEYS_PATH,
};

export const ROUTER_HEALTH_PATH = "/api/v1/router/health";

export const JOURNEY_CATEGORIES = TRAIN_CATEGORIES;
export const JOURNEY_SORTS = [
  "fastest",
  "fewestChanges",
  "earliestArrival",
  "latestDeparture",
] as const;
export const LONG_DISTANCE_PRODUCTS = ["ic", "flx"] as const;
export const JOURNEY_REMOVAL_REASONS = ["category", "product", "operator"] as const;

export const JOURNEY_RESULTS_DEFAULT = 5;
export const JOURNEY_RESULTS_MAX = 10;
export const JOURNEY_MAX_CHANGES_MAX = 8;

const instant = z.iso.datetime();
const label = z.string().trim().min(1);

export const JourneySort = z.enum(JOURNEY_SORTS);
export const LongDistanceProduct = z.enum(LONG_DISTANCE_PRODUCTS);

/** A leg's route line on the track, Google polyline encoded ([lat, lon] pairs). */
export const LegGeometry = z.object({
  polyline: z.string().min(1),
  precision: z.int().min(1).max(7),
  points: z.int().min(2),
});

export const JourneyStop = z.object({
  stopId: label.nullable(),
  name: z.string(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  time: instant.nullable(),
  scheduledTime: instant.nullable(),
  track: z.string().nullable(),
  scheduledTrack: z.string().nullable(),
  cancelled: z.boolean(),
});

export const WalkLeg = z.object({
  kind: z.literal("walk"),
  from: JourneyStop,
  to: JourneyStop,
  departure: instant,
  arrival: instant,
  durationS: z.number().nonnegative(),
});

/**
 * The timetable run of the train a leg rides: its trip instance, which opens the live train
 * card, and its first departure and last arrival as planned, to tell whether it runs now.
 */
export const LegRun = z.object({
  tripInstanceId: z.uuid(),
  departure: instant,
  arrival: instant,
});

export const TransitLeg = z.object({
  kind: z.literal("transit"),
  category: TrainCategory,
  motisMode: label,
  line: label.nullable(),
  tripNumber: label.nullable(),
  headsign: z.string().nullable(),
  operator: label.nullable(),
  tripId: label.nullable(),
  /** Null when the search index does not hold the trip's service day; absent from older answers. */
  run: LegRun.nullable().optional(),
  realtime: z.boolean(),
  cancelled: z.boolean(),
  staySeated: z.boolean(),
  from: JourneyStop,
  to: JourneyStop,
  departure: instant,
  arrival: instant,
  scheduledDeparture: instant,
  scheduledArrival: instant,
  durationS: z.number().nonnegative(),
  /** Present when the query asked for `geometry=true`; null when the router had no line. */
  geometry: LegGeometry.nullable().optional(),
});

export const JourneyLeg = z.discriminatedUnion("kind", [WalkLeg, TransitLeg]);

/** One connection. `tags` names the criteria on which it is the best journey of the answer. */
export const Journey = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  departure: instant,
  arrival: instant,
  durationS: z.number().nonnegative(),
  transfers: z.int().nonnegative(),
  categories: z.array(TrainCategory),
  operators: z.array(label),
  tags: z.array(JourneySort),
  legs: z.array(JourneyLeg).min(1),
});

/** What `GET /api/v1/journeys` answers: journeys over the DELFI timetable, routed by MOTIS. */
export const JourneysResponse = z.object({
  query: z.object({
    from: label,
    to: label,
    time: instant.nullable(),
    arriveBy: z.boolean(),
    categories: z.array(TrainCategory).min(1).max(JOURNEY_CATEGORIES.length),
    exclude: z.array(LongDistanceProduct),
    operators: z.array(label),
    avoidOperators: z.array(label),
    maxChanges: z.int().min(0).max(JOURNEY_MAX_CHANGES_MAX).nullable(),
    sort: JourneySort,
    results: z.int().min(1).max(JOURNEY_RESULTS_MAX),
    geometry: z.boolean().optional(),
  }),
  journeys: z.array(Journey),
  removedByFilter: z.int().nonnegative(),
  removedBy: z.object({
    category: z.int().nonnegative(),
    product: z.int().nonnegative(),
    operator: z.int().nonnegative(),
  }),
  routerCalls: z.int().positive(),
  partial: z.boolean(),
  earlierCursor: z.string().nullable(),
  laterCursor: z.string().nullable(),
});

export const JOURNEY_RELIABILITY_DAYS = 30;
export const JOURNEY_RELIABILITY_OPERATOR_MAX = 80;
/**
 * Why a leg has no reliability: it has no train number, the rollups hold no observed arrival of it
 * in the period, several operators run that number in that category and the leg's operator names
 * none of them, or the statistics cannot be read.
 */
export const RELIABILITY_MISSING_REASONS = [
  "no_number",
  "no_observations",
  "ambiguous",
  "unavailable",
] as const;

export const ReliabilityMissingReason = z.enum(RELIABILITY_MISSING_REASONS);

const reliabilityKey = {
  category: TrainCategory,
  number: z.string().regex(/^[0-9A-Za-z]{1,12}$/),
  operator: label.nullable(),
};

/**
 * Punctuality of one train number over the period, from the WP-7.2 rollups: `punctual6` is the
 * share of observed arrivals less than 6 minutes late (DB's rule), over `observedArrivals` arrivals
 * on `runs` runs since `firstDay`, the first service day with an observed arrival (null when the
 * rollups list no days).
 */
export const TrainReliability = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("known"),
    ...reliabilityKey,
    punctual6: z.number().min(0).max(1),
    observedArrivals: z.int().positive(),
    runs: z.int().nonnegative(),
    firstDay: z.iso.date().nullable(),
  }),
  z.object({ status: z.literal("missing"), ...reliabilityKey, reason: ReliabilityMissingReason }),
]);

/** What `GET /api/v1/journeys/reliability` answers, one entry per asked train in the asked order. */
export const JourneyReliabilityResponse = z.object({
  period: z.object({ from: z.iso.date(), to: z.iso.date(), days: z.int().positive() }),
  refreshedAt: instant.nullable(),
  trains: z.array(TrainReliability).max(JOURNEY_RELIABILITY_TRAINS_MAX),
});

export type LegGeometry = z.infer<typeof LegGeometry>;
export type ReliabilityMissingReason = z.infer<typeof ReliabilityMissingReason>;
export type TrainReliability = z.infer<typeof TrainReliability>;
export type JourneyReliabilityResponse = z.infer<typeof JourneyReliabilityResponse>;
export type JourneySort = z.infer<typeof JourneySort>;
export type LongDistanceProduct = z.infer<typeof LongDistanceProduct>;
export type JourneyStop = z.infer<typeof JourneyStop>;
export type WalkLeg = z.infer<typeof WalkLeg>;
export type LegRun = z.infer<typeof LegRun>;
export type TransitLeg = z.infer<typeof TransitLeg>;
export type JourneyLeg = z.infer<typeof JourneyLeg>;
export type Journey = z.infer<typeof Journey>;
export type JourneysResponse = z.infer<typeof JourneysResponse>;
export type JourneyRemovalReason = (typeof JOURNEY_REMOVAL_REASONS)[number];
