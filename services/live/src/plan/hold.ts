import {
  createLegState,
  createTargetState,
  evaluateLeg,
  evaluatePlan,
  FEASIBLE_ACCELERATION,
  fitLeg,
  MIN_LEG_DURATION,
  type MotionPlan,
  minimumLegDuration,
  type TrainDynamics,
} from "@gerlines/geo";
import type { Category } from "@gerlines/live-frame";
import { centimetre } from "../model.ts";

/** Delay (s) of the next arrival above which a train mid-leg holds at the approach (D-038 item 4). */
export const HOLD_THRESHOLD_S = 30;
/** Holds shorter than this (s) are not worth a stop: plain refit. */
export const MIN_HOLD_S = 10;
/** A hold point closer than this (m) to the station absorbs the delay as dwell instead. */
export const HOLD_STATION_MARGIN_M = 50;

/** Hold distance H before the station in metres: 1,500 m for hsr, ld and night, 800 m otherwise. */
export function approachDistance(category: Category): number {
  return category === "hsr" || category === "ld" || category === "night" ? 1500 : 800;
}

export interface HoldContext {
  /** The published plan as clients build it. */
  readonly plan: MotionPlan;
  readonly dynamics: TrainDynamics;
  readonly approach: number;
  /** Update time t_u (Unix seconds, after fromDeparture). */
  readonly now: number;
  /** The last plan stop the train departed (a station or an earlier hold point). */
  readonly fromS: number;
  readonly fromDeparture: number;
  /** The next station and its new arrival (Unix seconds). */
  readonly nextS: number;
  readonly newArrival: number;
}

export type HoldDecision =
  | { readonly kind: "refit" }
  | { readonly kind: "absorb" }
  | {
      readonly kind: "hold";
      readonly s: number;
      readonly arrival: number;
      readonly departure: number;
    };

const REFIT: HoldDecision = { kind: "refit" };
const ABSORB: HoldDecision = { kind: "absorb" };
const ITERATIONS = 80;

function shortestLeg(length: number, dynamics: TrainDynamics): number {
  return Math.max(
    MIN_LEG_DURATION,
    minimumLegDuration(length, dynamics, undefined, FEASIBLE_ACCELERATION),
  );
}

/**
 * "Hold at the approach" (D-038 item 4): when a train mid-leg learns of a later arrival, its
 * target keeps the position it has under the published plan at t_u and brakes to a hold point at
 * least its braking distance ahead and no closer than H to the station, stands there, and runs the
 * rest in the nominal minimum time so it arrives at the new time. Returns the hold stop (arc rounded
 * to the centimetre, whole-second times), or absorb (too close: keep the arrival, lengthen the
 * dwell), or refit (the hold would be shorter than MIN_HOLD_S or cannot be fitted).
 */
export function holdAtApproach(context: HoldContext): HoldDecision {
  const { dynamics, now, fromS, fromDeparture, nextS, newArrival } = context;
  if (!(now > fromDeparture)) return REFIT;
  const target = createTargetState();
  evaluatePlan(context.plan, now, target);
  const sU = target.s;
  const vU = target.v;
  if (!(sU > fromS + 0.01 && sU < nextS)) return REFIT;
  const braking = sU + (vU * vU) / (2 * dynamics.deceleration);
  const sH = Math.max(braking, nextS - context.approach);
  if (sH >= nextS - HOLD_STATION_MARGIN_M) return ABSORB;
  const state = createLegState();
  const position = (arrival: number, s: number): number => {
    evaluateLeg(fitLeg(fromS, s, fromDeparture, arrival, dynamics), now, state);
    return state.s;
  };
  const lowest = Math.max(fromDeparture + shortestLeg(sH - fromS, dynamics), now + 1);
  if (position(lowest, sH) < sU) return REFIT;
  let high = lowest + 60;
  while (position(high, sH) > sU) {
    high = lowest + 2 * (high - lowest);
    if (high - lowest > 86_400) return REFIT;
  }
  let low = lowest;
  for (let i = 0; i < ITERATIONS; i++) {
    const middle = (low + high) / 2;
    if (position(middle, sH) > sU) low = middle;
    else high = middle;
  }
  const fitted =
    solveHoldPoint(Math.round(low), context, sU, position) ??
    solveHoldPoint(Math.floor(low), context, sU, position);
  if (!fitted) return REFIT;
  const run = minimumLegDuration(
    nextS - fitted.s,
    dynamics,
    undefined,
    Math.max(dynamics.acceleration, dynamics.deceleration),
  );
  const departure = Math.floor(newArrival - run);
  if (departure - fitted.arrival < MIN_HOLD_S) return REFIT;
  return { kind: "hold", s: fitted.s, arrival: fitted.arrival, departure };
}

/** With the arrival fixed to whole seconds, the hold point that keeps the target at sU at now. */
function solveHoldPoint(
  arrival: number,
  context: HoldContext,
  sU: number,
  position: (arrival: number, s: number) => number,
): { s: number; arrival: number } | undefined {
  const { fromS, fromDeparture, nextS, dynamics, now } = context;
  if (!(arrival > now)) return undefined;
  let low = sU;
  let high = nextS - HOLD_STATION_MARGIN_M;
  if (!(high > low) || position(arrival, high) < sU) return undefined;
  for (let i = 0; i < ITERATIONS; i++) {
    const middle = (low + high) / 2;
    if (position(arrival, middle) < sU) low = middle;
    else high = middle;
  }
  const s = centimetre(high);
  if (s <= sU || arrival < fromDeparture + shortestLeg(s - fromS, dynamics)) return undefined;
  return { s, arrival };
}
