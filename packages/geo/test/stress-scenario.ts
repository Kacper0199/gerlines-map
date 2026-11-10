import { ContinuityMeter, type ContinuityReport, DEFAULT_CONTINUITY } from "../src/continuity.ts";
import {
  type ControllerParams,
  type CrossfadeReason,
  DEFAULT_CONTROLLER,
  TrainMotion,
} from "../src/motion.ts";
import { buildMotionPlan, type MotionPlan, type PlanStop } from "../src/plan.ts";
import { CATEGORY_DYNAMICS, type TrainDynamics } from "../src/profile.ts";
import { createShape, type Shape } from "../src/shape.ts";
import { FRANKFURT_MERCATOR } from "./arbitraries.ts";
import { seededRandom } from "./ice379.ts";

/** Plan clock epoch of the stress runs (seconds, about 2027-01-15), so Float64 rounding is real. */
export const STRESS_EPOCH = 1.8e9;
const MERCATOR_PER_GROUND_METRE = 1.56;
const SHAPE_LENGTH = 120_000;

export interface StressOptions {
  readonly seed: number;
  readonly windowSeconds: number;
  readonly params?: ControllerParams;
  /** Largest stop arc length jitter per update in metres (default 20). */
  readonly stopJitter?: number;
}

export interface StressResult {
  readonly continuity: ContinuityReport;
  readonly violations: readonly string[];
  readonly crossfades: Readonly<Record<CrossfadeReason, number>>;
  readonly updates: number;
  readonly frames: number;
  readonly frameRate: number;
  /** Largest distance a visible display was drawn past the stop its target heads to or dwells at. */
  readonly maxPastCap: number;
  /** Visible time with the display more than 1 cm past that stop. */
  readonly pastCapSeconds: number;
  /** Visible time with the display stopped while its target moves faster than 1 m/s. */
  readonly freezeSeconds: number;
}

/** A rail-like curved shape: straights and arcs of radius 500 m to 5 km, vertices every 20 to 150 m. */
export function curvedShape(random: () => number): Shape {
  const x = [FRANKFURT_MERCATOR.x];
  const y = [FRANKFURT_MERCATOR.y];
  let heading = random() * 2 * Math.PI;
  let length = 0;
  while (length < SHAPE_LENGTH) {
    const piece = 500 + random() * 4000;
    const curvature = random() < 0.4 ? 0 : (random() < 0.5 ? -1 : 1) / (500 + random() * 4500);
    const spacing = 20 + random() * 130;
    for (let along = 0; along < piece; along += spacing) {
      heading += curvature * spacing;
      x.push((x[x.length - 1] as number) + MERCATOR_PER_GROUND_METRE * spacing * Math.cos(heading));
      y.push((y[y.length - 1] as number) + MERCATOR_PER_GROUND_METRE * spacing * Math.sin(heading));
      length += spacing;
    }
  }
  return createShape({ x, y });
}

interface StopState {
  readonly baseS: number;
  s: number;
  arrival: number;
  departure: number;
}

function initialStops(random: () => number, shape: Shape, dynamics: TrainDynamics): StopState[] {
  const nearEnd = random() < 0.3;
  const stops: StopState[] = [];
  let s = 200 + random() * 1000;
  let t = STRESS_EPOCH + random() * 1000;
  stops.push({ baseS: s, s, arrival: t, departure: t });
  const lastS = nearEnd ? shape.length - random() * 10 : shape.length - 500;
  while (s + 5000 < lastS) {
    const leg = Math.min(5000 + random() * 25_000, lastS - s);
    s += leg;
    const averageSpeed = Math.min(15 + random() * 30, 0.8 * dynamics.maxSpeed);
    t += leg / averageSpeed;
    const arrival = t;
    t += 30 + random() * 150;
    stops.push({ baseS: s, s, arrival, departure: t });
  }
  return stops;
}

function planOf(
  stops: readonly StopState[],
  dynamics: TrainDynamics,
  shapeLength: number | undefined,
): MotionPlan {
  const input: PlanStop[] = stops.map((stop, k) => ({
    s: stop.s,
    ...(k > 0 ? { arrival: stop.arrival } : {}),
    ...(k < stops.length - 1 ? { departure: stop.departure } : {}),
  }));
  return buildMotionPlan(
    shapeLength === undefined
      ? { stops: input, dynamics }
      : { stops: input, dynamics, shapeLength },
  );
}

/**
 * Applies one realtime update at time `now` (a random walk of the delay with mean 0): with
 * probability 0.4 a delay of every event still in the future (up to +-90 s, in 15 % of updates up
 * to +-15 min), with probability 0.4 an arrival-only shift of the next arrival, which moves the leg
 * in progress whose departure already happened (up to +-60 s, in 15 % up to +-5 min), otherwise
 * the same times; with probability 1/2 a fresh jitter of every stop's arc length around its base.
 */
function delayFutureEvents(stops: StopState[], now: number, random: () => number): void {
  const delay = (2 * random() - 1) * (random() < 0.85 ? 90 : 900);
  for (const stop of stops) {
    if (stop.arrival > now) stop.arrival += delay;
    if (stop.departure > now) stop.departure += delay;
  }
}

function shiftNextArrival(stops: StopState[], now: number, random: () => number): void {
  const next = stops.find((stop, k) => k > 0 && stop.arrival > now);
  if (!next) return;
  const shift = (2 * random() - 1) * (random() < 0.85 ? 60 : 300);
  next.arrival = Math.max(now + 1, next.arrival + shift);
  next.departure = Math.max(next.departure, next.arrival);
}

function applyUpdate(stops: StopState[], now: number, random: () => number, jitter: number): void {
  const kind = random();
  if (kind < 0.4) delayFutureEvents(stops, now, random);
  else if (kind < 0.8) shiftNextArrival(stops, now, random);
  if (random() < 0.5) {
    for (const stop of stops) stop.s = stop.baseS + (2 * random() - 1) * jitter;
  }
}

class FrameChecks {
  readonly violations: string[] = [];
  readonly crossfades: Record<CrossfadeReason, number> = {
    start: 0,
    distance: 0,
    shape: 0,
    stop: 0,
    gap: 0,
    invalid: 0,
  };
  maxPastCap = 0;
  pastCapSeconds = 0;
  freezeSeconds = 0;
  private previousS: number;
  private previousV: number;

  private readonly motion: TrainMotion;
  private readonly params: ControllerParams;
  readonly meter: ContinuityMeter;

  constructor(motion: TrainMotion, params: ControllerParams, meter: ContinuityMeter) {
    this.motion = motion;
    this.params = params;
    this.meter = meter;
    this.previousS = motion.s;
    this.previousV = motion.v;
  }

  frame(now: number, dt: number, swapped: boolean): void {
    const motion = this.motion;
    if (swapped) this.crossfades[motion.lastCrossfade]++;
    const sample = motion.sample;
    this.meter.observe(now, sample.x, sample.y, motion.alpha, motion.s, swapped);
    if (!swapped) this.checkControl(now, dt);
    if (sample.beyondEnd > 0) this.flag("beyond the shape end", now);
    if (motion.alpha > 0) this.measureStops(dt);
    this.previousS = motion.s;
    this.previousV = motion.v;
  }

  private checkControl(now: number, dt: number): void {
    const { motion, params } = this;
    const target = motion.target;
    const change = Math.abs(motion.v - this.previousV);
    if (change > params.accelerationLimit * dt * (1 + 1e-9) + 1e-12) this.flag("acceleration", now);
    const line = target.cap + params.passedStopTolerance;
    if (this.previousS <= line && motion.s > line + 1e-3) this.flag("passed the cap", now);
    const ceiling = params.speedFactor * target.v + params.speedOffset;
    if (motion.v > this.previousV && motion.v > ceiling + 1e-9) {
      this.flag("speed above the ceiling", now);
    }
  }

  private measureStops(dt: number): void {
    const motion = this.motion;
    const target = motion.target;
    const past = motion.s - target.cap;
    if (past > this.maxPastCap) this.maxPastCap = past;
    if (past > 0.01) this.pastCapSeconds += dt;
    if (motion.alpha === 1 && motion.v < 0.01 && target.v > 1) this.freezeSeconds += dt;
  }

  private flag(what: string, t: number): void {
    if (this.violations.length < 5) {
      this.violations.push(`${what} at t=${(t - STRESS_EPOCH).toFixed(3)}`);
    }
  }
}

/**
 * The review's stress scenario: a curved 120 km shape, a random category, frames at a random
 * 24 to 120 fps with +-30 % jitter per frame, realtime updates every 20 to 60 s (delays,
 * arrival-only shifts in the middle of a leg, stop arc length jitter, in 3 of 10 runs a last stop
 * within 10 m of the shape end), plans built with or without the shape length (seeded coin), plan
 * clock at epoch 1.8e9. Checks every frame and returns the first violations with the report.
 */
export function runStress(options: StressOptions): StressResult {
  const random = seededRandom(options.seed);
  const params = options.params ?? DEFAULT_CONTROLLER;
  const jitter = options.stopJitter ?? 20;
  const shape = curvedShape(random);
  const categories = Object.values(CATEGORY_DYNAMICS);
  const dynamics = categories[Math.floor(random() * categories.length)] as TrainDynamics;
  const stops = initialStops(random, shape, dynamics);
  const shapeLength = random() < 0.5 ? shape.length : undefined;
  const first = (stops[0] as StopState).departure;
  const last = (stops[stops.length - 1] as StopState).arrival;
  const start = first - 60 + random() * Math.max(0, last - first - options.windowSeconds);
  const until = start + options.windowSeconds;
  const frameRate = 24 + random() * 96;
  const motion = new TrainMotion(shape, planOf(stops, dynamics, shapeLength), start, params);
  const checks = new FrameChecks(motion, params, new ContinuityMeter(DEFAULT_CONTINUITY, shape));
  let nextUpdate = start + 20 + random() * 40;
  let updates = 0;
  let frames = 0;
  let previous = start;
  while (previous < until) {
    const now = previous + (0.7 + 0.6 * random()) / frameRate;
    while (nextUpdate <= now) {
      applyUpdate(stops, nextUpdate, random, jitter);
      motion.update(planOf(stops, dynamics, shapeLength), now);
      updates++;
      nextUpdate += 20 + random() * 40;
    }
    const swapsBefore = motion.swapCount;
    motion.advance(now);
    frames++;
    checks.frame(now, now - previous, motion.swapCount !== swapsBefore);
    previous = now;
  }
  return {
    continuity: checks.meter.report(),
    violations: checks.violations,
    crossfades: checks.crossfades,
    updates,
    frames,
    frameRate,
    maxPastCap: checks.maxPastCap,
    pastCapSeconds: checks.pastCapSeconds,
    freezeSeconds: checks.freezeSeconds,
  };
}
