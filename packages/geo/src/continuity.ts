import { groundDistance } from "./mercator.ts";
import { projectOntoShape, type Shape } from "./shape.ts";

/**
 * Thresholds of the frame-continuity metric (metres, seconds).
 *
 * Jumps and stalls: a frame's displacement d (ground metres between the drawn positions of two
 * consecutive visible frames) is compared with the displacement expected at the speed observed
 * over the previous frame, e = max(d_prev * dt / dt_prev, floor), with
 * floor = max(displacementFloor, jumpAcceleration * dt * (dt + dt_prev) / 2). ratio = d / e; a
 * jump is ratio > jumpRatio, a stall is ratio < stallRatio. Pairs where both d and e are at or
 * below the floor are not judged.
 *
 * speedCeiling: a visible step faster than this (arc length per second when given, else drawn
 * displacement per second) is counted as overspeed. trackTolerance: a visible frame drawn further
 * than this from the shape (searched within trackWindow of its arc length when given) is counted
 * as off the track.
 */
export interface ContinuityThresholds {
  readonly jumpRatio: number;
  readonly stallRatio: number;
  readonly displacementFloor: number;
  readonly jumpAcceleration: number;
  readonly speedCeiling: number;
  readonly trackTolerance: number;
  readonly trackWindow: number;
}

/**
 * jumpRatio 2 with jumpAcceleration 36 m/s^2: motion whose acceleration stays below a can change
 * the displacement by at most a * dt * (dt + dt_prev) / 2 between two frames, so its ratio stays
 * within 1 +- a / 36 at any frame interval (1 +- 0.034 at the display limit of 1.2 m/s^2); a jump
 * needs more than double the expected displacement and more than 36 m/s^2, 30 times the display
 * limit and far beyond any train. At 60 fps the floor is 1 cm (displacementFloor), 0.03 px at
 * zoom 18 (0.38 m/px at 50 degrees north). stallRatio 0.5 is the same test for sudden stops.
 * speedCeiling 150 m/s (540 km/h) is above the controller ceiling 1.5 v + 8 m/s for any train up
 * to 94 m/s (340 km/h; German lines run at most 300 km/h). trackTolerance 1 cm: positions are
 * interpolated on the polyline, so anything further off is a defect, not rounding.
 */
export const DEFAULT_CONTINUITY: ContinuityThresholds = {
  jumpRatio: 2,
  stallRatio: 0.5,
  displacementFloor: 0.01,
  jumpAcceleration: 36,
  speedCeiling: 150,
  trackTolerance: 0.01,
  trackWindow: 100,
};

export interface ContinuityReport {
  readonly frames: number;
  readonly hiddenFrames: number;
  readonly visiblePairs: number;
  readonly judgedPairs: number;
  readonly maxRatio: number;
  readonly minRatio: number;
  readonly jumps: number;
  readonly stalls: number;
  readonly backwardSteps: number;
  readonly visibleSwaps: number;
  readonly overspeedSteps: number;
  readonly maxSpeed: number;
  readonly offTrackFrames: number;
  readonly maxTrackDistance: number;
  readonly maxStep: number;
  readonly maxAcceleration: number;
}

/**
 * Streaming frame-continuity metric over the drawn positions of one train. Feed every rendered
 * frame with its time (s), Web Mercator position (m), opacity, optionally its arc length (m) and
 * whether the train was moved to a new position (a swap) since the previous frame. The jump and
 * stall ratios use the drawn displacement; with arc length given, backward steps are counted and
 * speed and acceleration are taken from arc length (a chord across a polyline vertex is shorter
 * than the arc and would read as a spurious acceleration). Pairs where either frame is hidden
 * (alpha 0) are not judged, so a move made while faded out does not count as a jump, but a swap
 * drawn above opacity 0 is counted. With a shape, every visible frame's distance to it is measured.
 */
export class ContinuityMeter {
  private readonly thresholds: ContinuityThresholds;
  private readonly shape: Shape | undefined;
  private frames = 0;
  private hiddenFrames = 0;
  private visiblePairs = 0;
  private judgedPairs = 0;
  private maxRatio = 0;
  private minRatio = Number.POSITIVE_INFINITY;
  private jumps = 0;
  private stalls = 0;
  private backwardSteps = 0;
  private visibleSwaps = 0;
  private overspeedSteps = 0;
  private maxSpeed = 0;
  private offTrackFrames = 0;
  private maxTrackDistance = 0;
  private maxStep = 0;
  private maxAcceleration = 0;
  private previousTime = Number.NaN;
  private previousX = Number.NaN;
  private previousY = Number.NaN;
  private previousS = Number.NaN;
  private previousVisible = false;
  private previousStep = Number.NaN;
  private previousArcStep = Number.NaN;
  private previousDt = Number.NaN;

  constructor(thresholds: ContinuityThresholds = DEFAULT_CONTINUITY, shape?: Shape) {
    this.thresholds = thresholds;
    this.shape = shape;
  }

  observe(
    time: number,
    x: number,
    y: number,
    alpha: number,
    s = Number.NaN,
    swapped = false,
  ): void {
    this.frames++;
    const visible = alpha > 0;
    if (!visible) this.hiddenFrames++;
    if (visible && swapped) this.visibleSwaps++;
    if (visible && this.shape) this.measureTrackDistance(this.shape, x, y, s);
    if (visible && this.previousVisible) {
      this.judgePair(
        time - this.previousTime,
        groundDistance(this.previousX, this.previousY, x, y),
        s,
      );
    } else {
      this.previousStep = Number.NaN;
    }
    this.previousTime = time;
    this.previousX = x;
    this.previousY = y;
    this.previousS = s;
    this.previousVisible = visible;
  }

  report(): ContinuityReport {
    return {
      frames: this.frames,
      hiddenFrames: this.hiddenFrames,
      visiblePairs: this.visiblePairs,
      judgedPairs: this.judgedPairs,
      maxRatio: this.maxRatio,
      minRatio: this.judgedPairs > 0 ? this.minRatio : 1,
      jumps: this.jumps,
      stalls: this.stalls,
      backwardSteps: this.backwardSteps,
      visibleSwaps: this.visibleSwaps,
      overspeedSteps: this.overspeedSteps,
      maxSpeed: this.maxSpeed,
      offTrackFrames: this.offTrackFrames,
      maxTrackDistance: this.maxTrackDistance,
      maxStep: this.maxStep,
      maxAcceleration: this.maxAcceleration,
    };
  }

  private measureTrackDistance(shape: Shape, x: number, y: number, s: number): void {
    const window = this.thresholds.trackWindow;
    const distance = Number.isFinite(s)
      ? projectOntoShape(shape, x, y, s - window, s + window).distance
      : projectOntoShape(shape, x, y, 0, shape.length).distance;
    if (distance > this.maxTrackDistance) this.maxTrackDistance = distance;
    if (distance > this.thresholds.trackTolerance) this.offTrackFrames++;
  }

  private judgePair(dt: number, step: number, s: number): void {
    this.visiblePairs++;
    if (step > this.maxStep) this.maxStep = step;
    if (s < this.previousS) this.backwardSteps++;
    const arcStep = Number.isFinite(s - this.previousS) ? s - this.previousS : step;
    if (dt > 0) {
      const speed = Math.abs(arcStep) / dt;
      if (speed > this.maxSpeed) this.maxSpeed = speed;
      if (speed > this.thresholds.speedCeiling) this.overspeedSteps++;
    }
    if (Number.isFinite(this.previousStep) && dt > 0) {
      const t = this.thresholds;
      const floor = Math.max(
        t.displacementFloor,
        (t.jumpAcceleration * dt * (dt + this.previousDt)) / 2,
      );
      const expected = Math.max((this.previousStep * dt) / this.previousDt, floor);
      if (step > floor || expected > floor) this.judgeRatio(step / expected);
      const speedChange = arcStep / dt - this.previousArcStep / this.previousDt;
      const acceleration = Math.abs(speedChange) / ((dt + this.previousDt) / 2);
      if (acceleration > this.maxAcceleration) this.maxAcceleration = acceleration;
    }
    this.previousStep = step;
    this.previousArcStep = arcStep;
    this.previousDt = dt;
  }

  private judgeRatio(ratio: number): void {
    this.judgedPairs++;
    if (ratio > this.maxRatio) this.maxRatio = ratio;
    if (ratio < this.minRatio) this.minRatio = ratio;
    if (ratio > this.thresholds.jumpRatio) this.jumps++;
    if (ratio < this.thresholds.stallRatio) this.stalls++;
  }
}
