import {
  evaluateLegData,
  fitLeg,
  LEG_STRIDE,
  type Leg,
  minimumLegDuration,
  type TrainDynamics,
  writeLegData,
} from "./profile.ts";

/** Minimum leg duration in seconds, also for legs of zero length. */
export const MIN_LEG_DURATION = 1;

/**
 * Default ceiling in m/s^2 for accelerations a timetable may force on a leg. Below the display
 * acceleration limit (1.2 m/s^2), so the display can follow every normalised plan exactly.
 */
export const FEASIBLE_ACCELERATION = 1.0;

/**
 * One stop of a running trip: arc length along the trip's shape in ground metres and predicted
 * arrival and departure in seconds on the caller's clock (any epoch, one clock per plan). At least
 * one of the two times is required.
 */
export interface PlanStop {
  readonly s: number;
  readonly arrival?: number | undefined;
  readonly departure?: number | undefined;
}

/**
 * stops in travel order; legSpeedLimits[k] in m/s for the leg from stop k to stop k + 1 (undefined
 * for none; a value that is not finite and above 0 is treated as none and counted in adjustments).
 * shapeLength is the ground length of the trip's shape in metres: stop arc lengths are clamped to
 * [0, shapeLength] (to [0, Infinity) without it), each clamp counted in adjustments.
 */
export interface PlanInput {
  readonly stops: readonly PlanStop[];
  readonly dynamics: TrainDynamics;
  readonly legSpeedLimits?: readonly (number | undefined)[];
  readonly feasibilityAcceleration?: number;
  readonly shapeLength?: number;
}

/**
 * Legs of a trip. Leg k covers [tDep_k, tDep_k+1): motion from stop k to stop k+1, then the dwell
 * at stop k+1. `adjustments` counts the repairs made while normalising the input (filled times,
 * clamped arc lengths, times moved later).
 */
export interface MotionPlan {
  readonly legs: readonly Leg[];
  /** The legs as a flat buffer (LEG_STRIDE floats per leg) for per-frame evaluation. */
  readonly legData: Float64Array;
  readonly adjustments: number;
}

function flattenLegs(legs: readonly Leg[]): Float64Array {
  const data = new Float64Array(legs.length * LEG_STRIDE);
  legs.forEach((leg, k) => {
    writeLegData(leg, data, k * LEG_STRIDE);
  });
  return data;
}

/**
 * Target of the plan at one time: arc length (m), speed (m/s), the cap (arc length of the stop the
 * target is heading to or dwelling at, which the display must not pass), and the leg index (kept
 * as the search hint for the next call).
 */
export interface TargetState {
  s: number;
  v: number;
  cap: number;
  leg: number;
}

export function createTargetState(): TargetState {
  return { s: 0, v: 0, cap: 0, leg: 0 };
}

interface NormalisedStop {
  s: number;
  arrival: number;
  departure: number;
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} is not finite`);
  return value;
}

function stopTimes(stop: PlanStop, index: number): { arrival: number; departure: number } {
  const arrival = stop.arrival ?? stop.departure;
  const departure = stop.departure ?? stop.arrival;
  if (arrival === undefined || departure === undefined) {
    throw new RangeError(`stop ${index} has neither arrival nor departure`);
  }
  return {
    arrival: requireFinite(arrival, `stop ${index} arrival`),
    departure: requireFinite(departure, `stop ${index} departure`),
  };
}

function normaliseStops(
  stops: readonly PlanStop[],
  shapeLength: number,
  legFloor: (leg: number, length: number) => number,
): {
  stops: NormalisedStop[];
  adjustments: number;
} {
  let adjustments = 0;
  const result: NormalisedStop[] = [];
  stops.forEach((stop, index) => {
    const times = stopTimes(stop, index);
    let s = requireFinite(stop.s, `stop ${index} arc length`);
    if (s < 0 || s > shapeLength) {
      s = Math.min(Math.max(s, 0), shapeLength);
      adjustments++;
    }
    let { arrival, departure } = times;
    const previous = result[index - 1];
    if (previous) {
      if (s < previous.s) {
        s = previous.s;
        adjustments++;
      }
      const shortest = Math.max(MIN_LEG_DURATION, legFloor(index - 1, s - previous.s));
      if (arrival < previous.departure + shortest) {
        arrival = previous.departure + shortest;
        adjustments++;
      }
    }
    if (departure < arrival) {
      departure = arrival;
      adjustments++;
    }
    result.push({ s, arrival, departure });
  });
  return { stops: result, adjustments };
}

function usableSpeedLimits(
  given: readonly (number | undefined)[] | undefined,
  legs: number,
): { limits: (number | undefined)[]; rejected: number } {
  const limits: (number | undefined)[] = [];
  let rejected = 0;
  for (let k = 0; k < legs; k++) {
    const limit = given?.[k];
    if (limit === undefined || (Number.isFinite(limit) && limit > 0)) {
      limits.push(limit);
    } else {
      limits.push(undefined);
      rejected++;
    }
  }
  return { limits, rejected };
}

/**
 * Builds the legs of a trip from its stops (in travel order). Input is normalised rather than
 * rejected where a repair is unambiguous: a missing time takes the other time of the stop, an arc
 * length outside [0, shapeLength] is clamped, one below the previous stop's is raised to it, an arrival earlier than the train can reach
 * the stop (minimumLegDuration with accelerations up to feasibilityAcceleration and the leg's
 * speed limit, at least MIN_LEG_DURATION) is moved later, a departure before its arrival is moved
 * to the arrival, a speed limit that is not finite and above 0 is dropped.
 */
export function buildMotionPlan(input: PlanInput): MotionPlan {
  if (input.stops.length < 2) throw new RangeError("a motion plan needs at least two stops");
  const feasibility = input.feasibilityAcceleration ?? FEASIBLE_ACCELERATION;
  const { limits, rejected } = usableSpeedLimits(input.legSpeedLimits, input.stops.length - 1);
  const legFloor = (leg: number, length: number) =>
    minimumLegDuration(length, input.dynamics, limits[leg], feasibility);
  const shapeLength = input.shapeLength ?? Number.POSITIVE_INFINITY;
  if (!(shapeLength >= 0))
    throw new RangeError(`shape length must be at least 0, got ${shapeLength}`);
  const normalised = normaliseStops(input.stops, shapeLength, legFloor);
  const stops = normalised.stops;
  const adjustments = normalised.adjustments + rejected;
  const legs: Leg[] = [];
  for (let k = 0; k + 1 < stops.length; k++) {
    const from = stops[k] as NormalisedStop;
    const to = stops[k + 1] as NormalisedStop;
    legs.push(fitLeg(from.s, to.s, from.departure, to.arrival, input.dynamics, limits[k]));
  }
  return { legs, legData: flattenLegs(legs), adjustments };
}

function legIndexAt(
  data: Float64Array,
  base: number,
  count: number,
  t: number,
  hint: number,
): number {
  const last = count - 1;
  let k = Math.min(Math.max(hint, 0), last);
  while (k < last && t >= (data[base + (k + 1) * LEG_STRIDE] as number)) k++;
  while (k > 0 && t < (data[base + k * LEG_STRIDE] as number)) k--;
  return k;
}

/**
 * Evaluates the plan at time t into `out`, starting the leg search from `out.leg` (amortised O(1)
 * when t moves forward). Before the first departure the target waits at the origin; after the last
 * arrival it stays at the last stop.
 */
export function evaluatePlan(plan: MotionPlan, t: number, out: TargetState): void {
  evaluateLegs(plan.legData, t, out);
}

/** evaluatePlan on a plan's flat leg buffer (MotionPlan.legData). */
export function evaluateLegs(data: Float64Array, t: number, out: TargetState): void {
  evaluateLegsAt(data, 0, data.length / LEG_STRIDE, t, out);
}

/** evaluatePlan on `count` legs stored from `base` in a shared flat leg buffer. */
export function evaluateLegsAt(
  data: Float64Array,
  base: number,
  count: number,
  t: number,
  out: TargetState,
): void {
  const k = legIndexAt(data, base, count, t, out.leg);
  const offset = base + k * LEG_STRIDE;
  out.leg = k;
  out.cap =
    k === 0 && t < (data[offset] as number)
      ? (data[offset + 2] as number)
      : (data[offset + 3] as number);
  evaluateLegData(data, offset, t, out);
}

/**
 * Whether the plan stored from `base` has ended at time t: t is at or after the arrival at its last
 * stop. A plan that ended holds its last stop and has no motion.
 */
export function planEndedAt(data: Float64Array, base: number, count: number, t: number): boolean {
  return t >= (data[base + (count - 1) * LEG_STRIDE + 1] as number);
}

const speedScratch = createTargetState();

/**
 * Speed in m/s along the shape of the plan at time t, the derivative of the arc length that
 * evaluatePlan gives: zero before the first departure and in every dwell, the profile speed inside a
 * leg, undefined from the last arrival on (a plan that ended holds and has no speed) and for a time
 * that is not a number. It is the speed of the plan itself: MotionFleet.planSpeed applies the clamp to the shape,
 * where a target beyond the shape's ends stands still.
 */
export function planSpeed(plan: MotionPlan, t: number): number | undefined {
  const count = plan.legs.length;
  if (!(count > 0) || Number.isNaN(t) || planEndedAt(plan.legData, 0, count, t)) return undefined;
  speedScratch.leg = 0;
  evaluateLegsAt(plan.legData, 0, count, t, speedScratch);
  return speedScratch.v;
}
