/** Speeds in m/s, accelerations in m/s^2. */
export interface TrainDynamics {
  readonly maxSpeed: number;
  readonly acceleration: number;
  readonly deceleration: number;
}

export type TrainCategory = "hsr" | "ld" | "night" | "rfast" | "reg" | "sbahn" | "foreign";

const KMH = 1 / 3.6;

/**
 * Display dynamics per category. Engineering assumptions for drawing, not measured values:
 * maximum speed is the category's typical top speed in Germany, acceleration and deceleration are
 * mean values over a start or stop (constant-acceleration model). To be calibrated against recorded
 * realtime in replay.
 */
export const CATEGORY_DYNAMICS: Readonly<Record<TrainCategory, TrainDynamics>> = {
  hsr: { maxSpeed: 300 * KMH, acceleration: 0.5, deceleration: 0.6 },
  ld: { maxSpeed: 200 * KMH, acceleration: 0.4, deceleration: 0.6 },
  night: { maxSpeed: 200 * KMH, acceleration: 0.3, deceleration: 0.5 },
  rfast: { maxSpeed: 160 * KMH, acceleration: 0.7, deceleration: 0.8 },
  reg: { maxSpeed: 160 * KMH, acceleration: 0.8, deceleration: 0.8 },
  sbahn: { maxSpeed: 140 * KMH, acceleration: 1.0, deceleration: 0.9 },
  foreign: { maxSpeed: 200 * KMH, acceleration: 0.5, deceleration: 0.6 },
};

export type LegKind = "hold" | "trapezoid" | "triangle";

/**
 * One stop-to-stop leg: at rest at s0 until tDep, accelerate, cruise, decelerate, at rest at s1 at
 * tArr. Times in seconds on the caller's clock, arc lengths in ground metres. acceleration and
 * deceleration are the effective values after fitting (raised above the dynamics when the
 * timetable is tighter than the nominal profile allows).
 */
export interface Leg {
  readonly kind: LegKind;
  readonly s0: number;
  readonly s1: number;
  readonly tDep: number;
  readonly tArr: number;
  readonly cruiseSpeed: number;
  readonly acceleration: number;
  readonly deceleration: number;
  readonly accelerationEnd: number;
  readonly decelerationStart: number;
}

export interface LegState {
  s: number;
  v: number;
}

export function createLegState(): LegState {
  return { s: 0, v: 0 };
}

function makeLeg(
  kind: LegKind,
  s0: number,
  s1: number,
  tDep: number,
  tArr: number,
  cruiseSpeed: number,
  acceleration: number,
  deceleration: number,
): Leg {
  return {
    kind,
    s0,
    s1,
    tDep,
    tArr,
    cruiseSpeed,
    acceleration,
    deceleration,
    accelerationEnd: kind === "hold" ? tDep : tDep + cruiseSpeed / acceleration,
    decelerationStart: kind === "hold" ? tArr : tArr - cruiseSpeed / deceleration,
  };
}

function withScaledAccelerations(
  kind: LegKind,
  s0: number,
  s1: number,
  tDep: number,
  tArr: number,
  cruiseSpeed: number,
  dynamics: TrainDynamics,
  harmonicCoefficient: number,
): Leg {
  const nominal = 1 / (2 * dynamics.acceleration) + 1 / (2 * dynamics.deceleration);
  const factor = nominal / harmonicCoefficient;
  return makeLeg(
    kind,
    s0,
    s1,
    tDep,
    tArr,
    cruiseSpeed,
    dynamics.acceleration * factor,
    dynamics.deceleration * factor,
  );
}

function checkedSpeedLimit(speedLimit: number | undefined): number {
  if (speedLimit === undefined) return Number.POSITIVE_INFINITY;
  if (!(speedLimit > 0)) throw new RangeError(`speed limit must be above 0, got ${speedLimit}`);
  return speedLimit;
}

/**
 * Fits the speed profile of one leg to distance L = s1 - s0 and duration T = tArr - tDep.
 *
 * With c = 1/(2a) + 1/(2b), a trapezoid with cruise v covers L = vT - c v^2. The nominal fit takes
 * the smaller root v = 2L / (T + sqrt(T^2 - 4cL)). When that is infeasible (T below 2 sqrt(cL)) or
 * above the speed limit, accelerations are raised with their ratio kept: a triangle peaking at 2L/T
 * if that stays within the limit, otherwise a trapezoid cruising exactly at the limit. Only when
 * the timetable demands an average speed at or above the limit is the limit ignored. A speed limit
 * must be above 0 (Infinity means none); NaN, 0 or a negative limit is a RangeError.
 */
export function fitLeg(
  s0: number,
  s1: number,
  tDep: number,
  tArr: number,
  dynamics: TrainDynamics,
  speedLimit?: number,
): Leg {
  const duration = tArr - tDep;
  const length = s1 - s0;
  if (!(duration > 0) || !(length >= 0)) {
    throw new RangeError(
      `leg needs a positive duration and non-negative length, got T=${duration} L=${length}`,
    );
  }
  if (!(dynamics.acceleration > 0 && dynamics.deceleration > 0 && dynamics.maxSpeed > 0)) {
    throw new RangeError("dynamics need positive maximum speed, acceleration and deceleration");
  }
  const vmax = Math.min(dynamics.maxSpeed, checkedSpeedLimit(speedLimit));
  if (length === 0) return makeLeg("hold", s0, s1, tDep, tArr, 0, 1, 1);
  const averageSpeed = length / duration;
  const nominal = 1 / (2 * dynamics.acceleration) + 1 / (2 * dynamics.deceleration);
  const discriminant = duration * duration - 4 * nominal * length;
  if (discriminant >= 0) {
    const cruise = (2 * length) / (duration + Math.sqrt(discriminant));
    if (cruise <= vmax || averageSpeed >= vmax) {
      return makeLeg(
        "trapezoid",
        s0,
        s1,
        tDep,
        tArr,
        cruise,
        dynamics.acceleration,
        dynamics.deceleration,
      );
    }
  }
  if (2 * averageSpeed <= vmax || averageSpeed >= vmax) {
    const peak = 2 * averageSpeed;
    return withScaledAccelerations(
      "triangle",
      s0,
      s1,
      tDep,
      tArr,
      peak,
      dynamics,
      duration / (2 * peak),
    );
  }
  const coefficient = (vmax * duration - length) / (vmax * vmax);
  return withScaledAccelerations("trapezoid", s0, s1, tDep, tArr, vmax, dynamics, coefficient);
}

/**
 * Shortest duration in seconds in which a train with these dynamics covers `length` metres from
 * rest to rest within the speed limit, when its accelerations may be raised (ratio kept) until the
 * larger one reaches `accelerationCeiling`. Arrivals earlier than this cannot be drawn without
 * implausible motion.
 */
export function minimumLegDuration(
  length: number,
  dynamics: TrainDynamics,
  speedLimit: number | undefined,
  accelerationCeiling: number,
): number {
  const vmax = Math.min(dynamics.maxSpeed, checkedSpeedLimit(speedLimit));
  if (!(length > 0)) return 0;
  const nominal = 1 / (2 * dynamics.acceleration) + 1 / (2 * dynamics.deceleration);
  const strongest = Math.max(dynamics.acceleration, dynamics.deceleration);
  const coefficient = nominal * Math.min(1, strongest / accelerationCeiling);
  if (length >= coefficient * vmax * vmax) return length / vmax + coefficient * vmax;
  return 2 * Math.sqrt(coefficient * length);
}

/**
 * Floats per leg in a flat leg buffer (MotionPlan.legData), read every frame: tDep, tArr, s0, s1,
 * cruise speed, acceleration, deceleration, acceleration end, deceleration start.
 */
export const LEG_STRIDE = 9;

export function writeLegData(leg: Leg, data: Float64Array, offset: number): void {
  data[offset] = leg.tDep;
  data[offset + 1] = leg.tArr;
  data[offset + 2] = leg.s0;
  data[offset + 3] = leg.s1;
  data[offset + 4] = leg.cruiseSpeed;
  data[offset + 5] = leg.acceleration;
  data[offset + 6] = leg.deceleration;
  data[offset + 7] = leg.accelerationEnd;
  data[offset + 8] = leg.decelerationStart;
}

/**
 * Target arc length and speed at time t of the leg stored at `offset` in a flat leg buffer; before
 * tDep at rest at s0, after tArr at rest at s1, a leg of zero length holds s0.
 */
export function evaluateLegData(
  data: Float64Array,
  offset: number,
  t: number,
  out: LegState,
): void {
  const tDep = data[offset] as number;
  const s0 = data[offset + 2] as number;
  const s1 = data[offset + 3] as number;
  const tArr = data[offset + 1] as number;
  if (t <= tDep || s1 === s0) {
    out.s = s0;
    out.v = 0;
    return;
  }
  if (t >= tArr) {
    out.s = s1;
    out.v = 0;
    return;
  }
  const cruise = data[offset + 4] as number;
  const accelerationEnd = data[offset + 7] as number;
  const decelerationStart = data[offset + 8] as number;
  if (t < accelerationEnd) {
    const acceleration = data[offset + 5] as number;
    const tau = t - tDep;
    out.s = s0 + 0.5 * acceleration * tau * tau;
    out.v = acceleration * tau;
  } else if (t < decelerationStart) {
    out.s = s0 + 0.5 * cruise * (accelerationEnd - tDep) + cruise * (t - accelerationEnd);
    out.v = cruise;
  } else {
    const deceleration = data[offset + 6] as number;
    const remaining = tArr - t;
    out.s = s1 - 0.5 * deceleration * remaining * remaining;
    out.v = deceleration * remaining;
  }
}

const singleLeg = new Float64Array(LEG_STRIDE);

/** Target arc length and speed of a leg at time t; before tDep at rest at s0, after tArr at s1. */
export function evaluateLeg(leg: Leg, t: number, out: LegState): void {
  writeLegData(leg, singleLeg, 0);
  evaluateLegData(singleLeg, 0, t, out);
}
