import type { TrainMotion } from "../src/motion.ts";
import type { MotionPlan } from "../src/plan.ts";
import type { Shape } from "../src/shape.ts";

export interface PlanUpdate {
  readonly time: number;
  readonly plan: MotionPlan;
  readonly shape?: Shape;
}

/** Reused between frames: copy fields you need to keep. */
export interface FrameRecord {
  time: number;
  s: number;
  v: number;
  alpha: number;
  targetS: number;
  targetV: number;
  cap: number;
  swapped: boolean;
  x: number;
  y: number;
}

export function createFrameRecord(): FrameRecord {
  return {
    time: 0,
    s: 0,
    v: 0,
    alpha: 0,
    targetS: 0,
    targetV: 0,
    cap: 0,
    swapped: false,
    x: 0,
    y: 0,
  };
}

function capture(motion: TrainMotion, swapped: boolean, into: FrameRecord): void {
  into.time = motion.time;
  into.s = motion.s;
  into.v = motion.v;
  into.alpha = motion.alpha;
  into.targetS = motion.target.s;
  into.targetV = motion.target.v;
  into.cap = motion.target.cap;
  into.swapped = swapped;
  into.x = motion.sample.x;
  into.y = motion.sample.y;
}

/** Drives `motion` at a fixed frame rate until `until`, applying updates at their times. */
export function simulateFrames(
  motion: TrainMotion,
  updates: readonly PlanUpdate[],
  until: number,
  frameRate: number,
  onFrame: (frame: FrameRecord, previous: FrameRecord) => void,
): void {
  const start = motion.time;
  simulateFrameTimes(motion, updates, until, (n) => start + n / frameRate, onFrame);
}

/**
 * Drives `motion` through the frame times frameTime(1), frameTime(2), ... (increasing) until one
 * reaches `until`, applying updates at the first frame at or after their times.
 */
export function simulateFrameTimes(
  motion: TrainMotion,
  updates: readonly PlanUpdate[],
  until: number,
  frameTime: (n: number) => number,
  onFrame: (frame: FrameRecord, previous: FrameRecord) => void,
): void {
  const ordered = [...updates].sort((a, b) => a.time - b.time);
  let next = 0;
  let previous = createFrameRecord();
  let current = createFrameRecord();
  capture(motion, false, previous);
  for (let n = 1; ; n++) {
    const now = Math.min(frameTime(n), until);
    while (next < ordered.length && (ordered[next] as PlanUpdate).time <= now) {
      const update = ordered[next] as PlanUpdate;
      motion.update(update.plan, now, update.shape);
      next++;
    }
    const swapsBefore = motion.swapCount;
    motion.advance(now);
    capture(motion, motion.swapCount !== swapsBefore, current);
    onFrame(current, previous);
    const spare = previous;
    previous = current;
    current = spare;
    if (now >= until) return;
  }
}

/** Frame times from `start` with intervals drawn uniformly from [minInterval, maxInterval]. */
export function jitteredFrameTimes(
  start: number,
  minInterval: number,
  maxInterval: number,
  random: () => number,
): (n: number) => number {
  let time = start;
  let index = 0;
  return (n) => {
    while (index < n) {
      time += minInterval + random() * (maxInterval - minInterval);
      index++;
    }
    return time;
  };
}
