import { ContinuityMeter, type ContinuityReport, DEFAULT_CONTINUITY } from "../src/continuity.ts";
import {
  type ControllerParams,
  type CrossfadeReason,
  DEFAULT_CONTROLLER,
  TrainMotion,
} from "../src/motion.ts";
import type { MotionPlan, PlanStop } from "../src/plan.ts";
import { type DelayStep, type Ice379, planFor, seededRandom, stopsAfterSteps } from "./ice379.ts";

export interface UpdateOutcome {
  readonly time: number;
  readonly delay: number;
  readonly error: number;
  readonly crossfade: CrossfadeReason | undefined;
  readonly convergenceTime: number | undefined;
  readonly superseded: boolean;
  readonly overshoot: number;
}

export interface ScenarioResult {
  readonly continuity: ContinuityReport;
  readonly updates: readonly UpdateOutcome[];
  readonly crossfades: Readonly<Record<CrossfadeReason, number>>;
  readonly freezeSeconds: number;
  readonly longestFreeze: number;
  readonly maxHeadBeyondShape: number;
  /** Largest amount by which the speed rose above 1.5 vTarget + 8 m/s (rising above it is a violation). */
  readonly maxSpeedOverCeiling: number;
  readonly simulatedSeconds: number;
}

/**
 * Frames at frameRate wall-clock frames per second (default 60), or with jitter at wall-clock
 * intervals drawn uniformly from [jitter.min, jitter.max] (seeded); timeScale plan seconds per
 * wall-clock second (default 1, 10 for a 10x replay).
 */
export interface ScenarioOptions {
  readonly from: number;
  readonly until: number;
  readonly frameRate?: number;
  readonly jitter?: { readonly min: number; readonly max: number; readonly seed: number };
  readonly timeScale?: number;
  readonly params?: ControllerParams;
}

interface UpdateTracker {
  time: number;
  delay: number;
  error: number;
  crossfade: CrossfadeReason | undefined;
  convergedAt: number | undefined;
  superseded: boolean;
  minErrorBeforeConvergence: number;
}

export function baseStops(train: Ice379): PlanStop[] {
  return train.stops.map((stop) => ({
    s: stop.s,
    arrival: stop.arrival,
    departure: stop.departure,
  }));
}

class ScenarioRecorder {
  readonly meter: ContinuityMeter;
  readonly crossfades: Record<CrossfadeReason, number> = {
    start: 0,
    distance: 0,
    shape: 0,
    stop: 0,
    gap: 0,
    invalid: 0,
  };
  readonly trackers: UpdateTracker[] = [];
  freezeSeconds = 0;
  longestFreeze = 0;
  maxHeadBeyondShape = 0;
  maxSpeedOverCeiling = Number.NEGATIVE_INFINITY;
  private currentFreeze = 0;
  private previousSpeed: number;
  private readonly motion: TrainMotion;
  private readonly params: ControllerParams;

  constructor(motion: TrainMotion, params: ControllerParams) {
    this.motion = motion;
    this.params = params;
    this.previousSpeed = motion.v;
    this.meter = new ContinuityMeter(DEFAULT_CONTINUITY, motion.shape);
  }

  recordUpdate(
    now: number,
    delay: number,
    error: number,
    crossfade: CrossfadeReason | undefined,
  ): void {
    const open = this.trackers[this.trackers.length - 1];
    if (open && open.convergedAt === undefined) open.superseded = true;
    this.trackers.push({
      time: now,
      delay,
      error,
      crossfade,
      convergedAt: undefined,
      superseded: false,
      minErrorBeforeConvergence: error,
    });
  }

  recordFrame(now: number, dt: number, swapped: boolean): void {
    const motion = this.motion;
    if (swapped) this.crossfades[motion.lastCrossfade]++;
    this.meter.observe(now, motion.sample.x, motion.sample.y, motion.alpha, motion.s, swapped);
    this.trackConvergence(now);
    this.trackFreeze(dt);
    this.maxHeadBeyondShape = Math.max(this.maxHeadBeyondShape, motion.sample.beyondEnd);
    const ceiling = this.params.speedFactor * motion.target.v + this.params.speedOffset;
    if (motion.v > this.previousSpeed) {
      this.maxSpeedOverCeiling = Math.max(this.maxSpeedOverCeiling, motion.v - ceiling);
    }
    this.previousSpeed = motion.v;
  }

  private trackConvergence(now: number): void {
    const motion = this.motion;
    const tracker = this.trackers[this.trackers.length - 1];
    if (!tracker || tracker.convergedAt !== undefined) return;
    const error = motion.target.s - motion.s;
    if (tracker.error > 0) {
      tracker.minErrorBeforeConvergence = Math.min(tracker.minErrorBeforeConvergence, error);
    }
    const settled = Math.abs(error) < 1 && Math.abs(motion.target.v - motion.v) < 0.1;
    if (motion.alpha === 1 && settled) tracker.convergedAt = now;
  }

  private trackFreeze(dt: number): void {
    const motion = this.motion;
    if (motion.alpha === 1 && motion.v < 0.01 && motion.target.v > 1) {
      this.freezeSeconds += dt;
      this.currentFreeze += dt;
      this.longestFreeze = Math.max(this.longestFreeze, this.currentFreeze);
    } else {
      this.currentFreeze = 0;
    }
  }

  outcomes(): UpdateOutcome[] {
    return this.trackers.map((t) => ({
      time: t.time,
      delay: t.delay,
      error: t.error,
      crossfade: t.crossfade,
      convergenceTime: t.convergedAt === undefined ? undefined : t.convergedAt - t.time,
      superseded: t.superseded,
      overshoot: t.error > 0 ? Math.max(0, -t.minErrorBeforeConvergence) : 0,
    }));
  }
}

/** Runs ICE 379 with delay steps and measures continuity and convergence (see ScenarioOptions). */
export function runScenario(
  train: Ice379,
  steps: readonly DelayStep[],
  options: ScenarioOptions,
): ScenarioResult {
  const frameRate = options.frameRate ?? 60;
  const timeScale = options.timeScale ?? 1;
  const jitter = options.jitter;
  const random = jitter ? seededRandom(jitter.seed) : undefined;
  const nextInterval = () =>
    timeScale *
    (jitter && random ? jitter.min + random() * (jitter.max - jitter.min) : 1 / frameRate);
  const params = options.params ?? DEFAULT_CONTROLLER;
  const ordered = [...steps].sort((a, b) => a.time - b.time);
  const base = baseStops(train);
  const plans = stopsAfterSteps(base, ordered).map((stops) => planFor(train, stops));
  const motion = new TrainMotion(train.shape, planFor(train, base), options.from, params);
  motion.timeScale = timeScale;
  const recorder = new ScenarioRecorder(motion, params);
  let next = 0;
  let previous = options.from;
  for (let n = 1; previous < options.until; n++) {
    const now = jitter ? previous + nextInterval() : options.from + n * nextInterval();
    while (next < ordered.length && (ordered[next] as DelayStep).time <= now) {
      const outcome = motion.update(plans[next] as MotionPlan, now);
      recorder.recordUpdate(
        now,
        (ordered[next] as DelayStep).delay,
        outcome.error,
        outcome.crossfade,
      );
      next++;
    }
    const swapsBefore = motion.swapCount;
    motion.advance(now);
    recorder.recordFrame(now, now - previous, motion.swapCount !== swapsBefore);
    previous = now;
  }
  return {
    continuity: recorder.meter.report(),
    updates: recorder.outcomes(),
    crossfades: recorder.crossfades,
    freezeSeconds: recorder.freezeSeconds,
    longestFreeze: recorder.longestFreeze,
    maxHeadBeyondShape: recorder.maxHeadBeyondShape,
    maxSpeedOverCeiling: recorder.maxSpeedOverCeiling,
    simulatedSeconds: options.until - options.from,
  };
}

export type LegPhase = "accelerating" | "cruising" | "decelerating" | "dwelling";

/** A time inside leg `leg` of the base plan at the given phase. */
export function phaseTime(train: Ice379, leg: number, phase: LegPhase): number {
  const plan = planFor(train, baseStops(train));
  const l = plan.legs[leg];
  if (!l) throw new RangeError(`no leg ${leg}`);
  switch (phase) {
    case "accelerating":
      return (l.tDep + l.accelerationEnd) / 2;
    case "cruising":
      return (l.accelerationEnd + l.decelerationStart) / 2;
    case "decelerating":
      return (l.decelerationStart + l.tArr) / 2;
    case "dwelling": {
      const nextLeg = plan.legs[leg + 1];
      return nextLeg ? (l.tArr + nextLeg.tDep) / 2 : l.tArr + 30;
    }
  }
}
