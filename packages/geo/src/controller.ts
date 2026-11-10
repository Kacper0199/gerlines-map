/**
 * Display controller settings. Times in seconds, speeds in m/s, accelerations in m/s^2, distances
 * in ground metres.
 */
export interface ControllerParams {
  readonly gainTime: number;
  readonly accelerationLimit: number;
  readonly speedFactor: number;
  readonly speedOffset: number;
  readonly catchUpDeceleration: number;
  readonly aheadSpeedFraction: number;
  readonly brakingDeceleration: number;
  readonly crossfadeDistance: number;
  readonly passedStopTolerance: number;
  readonly fadeOutDuration: number;
  readonly fadeInDuration: number;
  readonly maxStep: number;
  readonly resyncGap: number;
}

/**
 * gainTime, accelerationLimit, speedFactor, speedOffset, crossfadeDistance and the fades follow
 * docs/architecture.md section 8.1. catchUpDeceleration limits the error term to sqrt(2 d |e|) so a
 * large error is closed without overshoot under the acceleration limit (Infinity gives the plain
 * linear term). aheadSpeedFraction keeps a display that is ahead of its target at no less than this
 * fraction of the target speed (0, the architecture default, lets it stop and wait).
 * brakingDeceleration shapes the approach to a stop the display must not pass; it stays below
 * accelerationLimit so the limited speed can follow it. A target that gets further than
 * crossfadeDistance away between updates (only possible with plans built outside buildMotionPlan's
 * feasibility floor) is crossfaded too. passedStopTolerance (ground metres) is how far a display
 * may be drawn past the stop its target heads to or dwells at: an update after which the display,
 * braking at accelerationLimit, would come to rest further past that stop is crossfaded (reason
 * stop); 25 m is one coach length, far below the uncertainty of a stop point on the track.
 * fadeOutDuration, fadeInDuration and resyncGap are wall-clock seconds (MotionFleet.timeScale).
 * maxStep is the largest integration step on the plan clock; a frame gap above resyncGap (a hidden
 * tab) moves the train to its target with a fade-in.
 */
export const DEFAULT_CONTROLLER: ControllerParams = {
  gainTime: 4,
  accelerationLimit: 1.2,
  speedFactor: 1.5,
  speedOffset: 8,
  catchUpDeceleration: 0.96,
  aheadSpeedFraction: 0,
  brakingDeceleration: 1.0,
  crossfadeDistance: 3000,
  passedStopTolerance: 25,
  fadeOutDuration: 0.25,
  fadeInDuration: 0.25,
  maxStep: 0.05,
  resyncGap: 5,
};

/**
 * Why a train was faded out and back in: it appeared (start), its error exceeded crossfadeDistance
 * (distance), its shape changed (shape), the display had already passed the stop its target is
 * heading to or dwelling at, so it would have to wait there (stop), frames stopped for longer
 * than resyncGap (gap), or its display or target state was not finite (invalid: the train is
 * resynchronised at once, and stays hidden with s NaN while its target is not finite).
 */
export type CrossfadeReason = "start" | "distance" | "shape" | "stop" | "gap" | "invalid";

/**
 * error: target minus display arc length in metres at the slot's own time before the update; NaN
 * when the shape changes (arc lengths on two shapes do not compare) or a state is not finite.
 * crossfade: why the update fades the train out and in, undefined when it is blended.
 */
export interface UpdateResult {
  readonly error: number;
  readonly crossfade: CrossfadeReason | undefined;
}
