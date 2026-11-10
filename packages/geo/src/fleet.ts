import {
  type ControllerParams,
  type CrossfadeReason,
  DEFAULT_CONTROLLER,
  type UpdateResult,
} from "./controller.ts";
import {
  createTargetState,
  evaluateLegsAt,
  type MotionPlan,
  planEndedAt,
  type TargetState,
} from "./plan.ts";
import { LEG_STRIDE } from "./profile.ts";
import { createShapeSample, type Shape, sampleShapeArrays } from "./shape.ts";

/**
 * Floats per train in MotionFleet.writeHeads output: x, y relative to the origin (Web Mercator
 * metres times the scale argument), z (m), heading (radians, counterclockwise from east in the map
 * plane, from the smoothed shape tangent), opacity.
 */
export const HEAD_STRIDE = 5;

const REASONS: readonly CrossfadeReason[] = [
  "start",
  "distance",
  "shape",
  "stop",
  "gap",
  "invalid",
];
const GAP_REASON = REASONS.indexOf("gap");
const INVALID_REASON = REASONS.indexOf("invalid");
const PHASE_NONE = 0;
const PHASE_OUT = 1;
const PHASE_IN = 2;
const PHASE_HIDDEN = 3;
const INITIAL_CAPACITY = 16;
const FADE_ROUNDING = 1e-9;

function grownFloat64(source: Float64Array, capacity: number): Float64Array<ArrayBuffer> {
  const next = new Float64Array(capacity);
  next.set(source);
  return next;
}

function grownInt32(source: Int32Array, capacity: number): Int32Array<ArrayBuffer> {
  const next = new Int32Array(capacity);
  next.set(source);
  return next;
}

function grownUint8(source: Uint8Array, capacity: number): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(capacity);
  next.set(source);
  return next;
}

function stopsOutside(plan: MotionPlan, length: number): boolean {
  const data = plan.legData;
  for (let offset = 0; offset < data.length; offset += LEG_STRIDE) {
    const s0 = data[offset + 2] as number;
    const s1 = data[offset + 3] as number;
    if (s0 < 0 || s1 < 0 || s0 > length || s1 > length) return true;
  }
  return false;
}

function checkScale(scale: number): void {
  if (!(Number.isFinite(scale) && scale > 0)) {
    throw new RangeError(`scale must be finite and above 0, got ${scale}`);
  }
}

/** Keeps a target on [0, length]: a target outside stands still at the nearer end. */
function clampToShape(target: TargetState, length: number): void {
  if (target.s > length) {
    target.s = length;
    target.v = 0;
  } else if (target.s < 0) {
    target.s = 0;
    target.v = 0;
  }
  if (target.cap > length) target.cap = length;
  else if (target.cap < 0) target.cap = 0;
}

/**
 * Display state of many running trips in typed columns (one slot per trip), advanced frame by
 * frame along their shapes in arc length.
 *
 * Each plan gives a target (arc length and speed) at every time; the display follows it with a
 * speed command that is never negative, a limited acceleration, and a cap at the stop the target is
 * heading to or dwelling at, so it never moves backwards and does not pass such a stop. When an
 * update moves that stop back within the display's braking distance, the display brakes at the
 * acceleration limit and comes to rest at most passedStopTolerance past it. Updates with an error
 * above crossfadeDistance, a new shape, or a stop the display would pass by more than that fade the
 * train out, move it to the new target while invisible (the frame of the move is drawn at alpha 0
 * at any frame rate) and fade it in. Targets are clamped to [0, shape length].
 *
 * Columns are public for reading (index by slot); they are reallocated when the fleet grows, so do
 * not keep references across add(). Typed columns keep per-frame state out of boxed object fields.
 */
export class MotionFleet {
  readonly params: ControllerParams;
  count = 0;
  /**
   * Plans passed to add or update with a stop outside [0, shape length]. Their targets are clamped
   * to the shape, so the head never leaves it; build plans with PlanInput.shapeLength to repair the
   * stops instead.
   */
  outOfRangePlans = 0;
  time = new Float64Array(INITIAL_CAPACITY);
  s = new Float64Array(INITIAL_CAPACITY);
  v = new Float64Array(INITIAL_CAPACITY);
  alpha = new Float64Array(INITIAL_CAPACITY);
  targetS = new Float64Array(INITIAL_CAPACITY);
  targetV = new Float64Array(INITIAL_CAPACITY);
  cap = new Float64Array(INITIAL_CAPACITY);
  x = new Float64Array(INITIAL_CAPACITY);
  y = new Float64Array(INITIAL_CAPACITY);
  z = new Float64Array(INITIAL_CAPACITY);
  tangentX = new Float64Array(INITIAL_CAPACITY);
  tangentY = new Float64Array(INITIAL_CAPACITY);
  beyondEnd = new Float64Array(INITIAL_CAPACITY);
  swaps = new Int32Array(INITIAL_CAPACITY);
  alive = new Uint8Array(INITIAL_CAPACITY);
  private fadeStart = new Float64Array(INITIAL_CAPACITY);
  private fadeProgress = new Float64Array(INITIAL_CAPACITY);
  private restUntil = new Float64Array(INITIAL_CAPACITY);
  private fadeStartAlpha = new Float64Array(INITIAL_CAPACITY);
  private shapeLength = new Float64Array(INITIAL_CAPACITY);
  private shapeVertexCount = new Int32Array(INITIAL_CAPACITY);
  private leg = new Int32Array(INITIAL_CAPACITY);
  private legOffset = new Int32Array(INITIAL_CAPACITY);
  private legCount = new Int32Array(INITIAL_CAPACITY);
  private legCapacity = new Int32Array(INITIAL_CAPACITY);
  private legPool = new Float64Array(INITIAL_CAPACITY * 16 * LEG_STRIDE);
  private legPoolUsed = 0;
  private shapeHint = new Int32Array(INITIAL_CAPACITY);
  private phase = new Uint8Array(INITIAL_CAPACITY);
  private reason = new Uint8Array(INITIAL_CAPACITY);
  private readonly shapes: (Shape | undefined)[] = [];
  private readonly plans: (MotionPlan | undefined)[] = [];
  private readonly shapeRecords: (Float64Array | undefined)[] = [];
  private readonly shapeAttributes: (Float32Array | undefined)[] = [];
  private readonly pendingPlans: (MotionPlan | undefined)[] = [];
  private readonly pendingShapes: (Shape | undefined)[] = [];
  private readonly freeSlots: number[] = [];
  private readonly scratchTarget = createTargetState();
  private readonly scratchSample = createShapeSample();
  private scale = 1;

  constructor(params: ControllerParams = DEFAULT_CONTROLLER) {
    this.params = params;
  }

  /**
   * Plan seconds per wall-clock second (1 live, 10 for a 10x replay). Fades and the resync gap are
   * wall-clock durations, so they are stretched by this factor on the plan clock; the motion itself
   * (speeds, accelerations, maxStep) stays on the plan clock.
   */
  get timeScale(): number {
    return this.scale;
  }

  set timeScale(value: number) {
    if (!(Number.isFinite(value) && value > 0)) {
      throw new RangeError(`time scale must be finite and above 0, got ${value}`);
    }
    this.scale = value;
  }

  /** Adds a trip at time `now`, placed on its target and fading in; returns its slot. */
  add(shape: Shape, plan: MotionPlan, now: number): number {
    const slot = this.freeSlots.pop() ?? this.count++;
    this.ensureCapacity(this.count);
    this.alive[slot] = 1;
    this.swaps[slot] = 0;
    this.leg[slot] = 0;
    this.pendingPlans[slot] = undefined;
    this.pendingShapes[slot] = undefined;
    this.assignShape(slot, shape);
    this.assignPlan(slot, plan);
    if (stopsOutside(plan, shape.length)) this.outOfRangePlans++;
    this.moveToTarget(slot, now);
    this.reason[slot] = 0;
    return slot;
  }

  /** Frees a slot and drops its shape and plan references; advance skips it, add may reuse it. */
  remove(slot: number): void {
    if (!this.alive[slot]) return;
    this.alive[slot] = 0;
    this.legCapacity[slot] = 0;
    this.alpha[slot] = 0;
    this.shapes[slot] = undefined;
    this.plans[slot] = undefined;
    this.shapeRecords[slot] = undefined;
    this.shapeAttributes[slot] = undefined;
    this.pendingPlans[slot] = undefined;
    this.pendingShapes[slot] = undefined;
    this.freeSlots.push(slot);
  }

  /** The shape of a live slot (RangeError for a free slot). */
  shapeOf(slot: number): Shape {
    this.requireLive(slot);
    return this.shapes[slot] as Shape;
  }

  /** The plan of a live slot (RangeError for a free slot). */
  planOf(slot: number): MotionPlan {
    this.requireLive(slot);
    return this.plans[slot] as MotionPlan;
  }

  lastCrossfade(slot: number): CrossfadeReason {
    return REASONS[this.reason[slot] as number] as CrossfadeReason;
  }

  /**
   * Replaces the plan (and optionally the shape) of a slot. The error is measured at the slot's
   * own time, so it compares positions at one instant; `now` starts the fade when one is needed.
   * RangeError for a free slot.
   */
  update(slot: number, plan: MotionPlan, now: number, shape?: Shape): UpdateResult {
    this.requireLive(slot);
    const nextShape = shape ?? (this.shapes[slot] as Shape);
    if (stopsOutside(plan, nextShape.length)) this.outOfRangePlans++;
    const probe = this.scratchTarget;
    probe.leg = this.leg[slot] as number;
    evaluateLegsAt(plan.legData, 0, plan.legs.length, this.time[slot] as number, probe);
    clampToShape(probe, this.shapeLength[slot] as number);
    const sameShape = nextShape === this.shapes[slot];
    const error = sameShape ? probe.s - (this.s[slot] as number) : Number.NaN;
    if (sameShape && !Number.isFinite(error)) {
      this.pendingPlans[slot] = plan;
      this.pendingShapes[slot] = undefined;
      this.resync(slot, now, INVALID_REASON);
      return { error, crossfade: "invalid" };
    }
    let crossfade: CrossfadeReason | undefined;
    if (!sameShape) crossfade = "shape";
    else if (Math.abs(error) > this.params.crossfadeDistance) crossfade = "distance";
    else if (this.stoppingPoint(slot) > probe.cap + this.params.passedStopTolerance) {
      crossfade = "stop";
    }
    if (crossfade) {
      this.beginFadeOut(slot, plan, nextShape, now, crossfade);
    } else if (this.phase[slot] === PHASE_OUT) {
      this.pendingPlans[slot] = plan;
    } else {
      this.assignPlan(slot, plan);
      this.leg[slot] = probe.leg;
      this.targetS[slot] = probe.s;
      this.targetV[slot] = probe.v;
      this.cap[slot] = probe.cap;
    }
    return { error, crossfade };
  }

  /**
   * Speed in m/s along the shape of the slot's plan at the slot's own time, the speed of the motion
   * the display follows (not the display's own speed, which differs only while it catches up with a
   * new plan). Zero at the origin before the first departure and in a dwell, undefined for a free
   * slot, a train that is hidden because its state is not finite, and a plan that has ended; a target beyond the
   * shape's ends is clamped to them and stands still, as the display does.
   */
  planSpeed(slot: number): number | undefined {
    if (!this.alive[slot] || this.phase[slot] === PHASE_HIDDEN) return undefined;
    const base = this.legOffset[slot] as number;
    const count = this.legCount[slot] as number;
    const t = this.time[slot] as number;
    if (!(count > 0) || Number.isNaN(t) || planEndedAt(this.legPool, base, count, t)) {
      return undefined;
    }
    const target = this.scratchTarget;
    target.leg = this.leg[slot] as number;
    this.evaluateSlot(slot, t, target);
    return Number.isFinite(target.v) ? target.v : undefined;
  }

  /** Advances every live slot to time `now` (seconds, the plans' clock). */
  advance(now: number): void {
    const alive = this.alive;
    for (let slot = 0; slot < this.count; slot++) {
      if (alive[slot]) this.advanceSlot(slot, now);
    }
  }

  /**
   * Ends every fade at once: a train fading in is fully visible, one fading out gets its pending plan
   * now. For a clock that stands still, which no fade (counted in the plans' time) could finish.
   */
  settleFades(now: number): void {
    for (let slot = 0; slot < this.count; slot++) {
      if (!this.alive[slot]) continue;
      if (this.phase[slot] === PHASE_OUT) this.resync(slot, now, this.reason[slot] as number);
      if (this.phase[slot] === PHASE_IN) {
        this.alpha[slot] = 1;
        this.phase[slot] = PHASE_NONE;
      }
    }
  }

  /** Advances one slot to time `now`; a free slot is left alone. */
  advanceSlot(slot: number, now: number): void {
    if (!this.alive[slot]) return;
    const start = this.time[slot] as number;
    const elapsed = now - start;
    if (!(elapsed > 0)) return;
    if (this.phase[slot] === PHASE_HIDDEN) {
      this.moveToTarget(slot, now);
      return;
    }
    const gap = this.params.resyncGap * this.scale;
    if (now < (this.restUntil[slot] as number) && elapsed <= gap) {
      this.time[slot] = now;
      return;
    }
    if (elapsed > gap) {
      this.resync(slot, now, GAP_REASON);
      return;
    }
    const steps = Math.ceil(elapsed / this.params.maxStep);
    const h = elapsed / steps;
    for (let k = 1; k <= steps; k++) {
      if (this.step(slot, k === steps ? now : start + k * h, h)) {
        this.resync(slot, now, this.reason[slot] as number);
        return;
      }
    }
    if (!Number.isFinite(this.s[slot] as number)) {
      this.resync(slot, now, INVALID_REASON);
      return;
    }
    this.refreshSample(slot);
  }

  /**
   * Writes the head pose of slots [0, count) into `out` (HEAD_STRIDE floats per slot; free slots
   * get opacity 0); RangeError when `out` is shorter than count * HEAD_STRIDE.
   *
   * x, y are Web Mercator metres relative to (originX, originY), times `scale`. Relative values
   * keep centimetres in Float32 near the origin (absolute EPSG:3857 values near 7e6 m keep only
   * about 0.5 m). A Web Mercator metre is a metre on a sphere of radius 6378137 m stretched by
   * 1 / cos(latitude). A renderer that takes metre offsets on its own sphere of radius r (deck.gl
   * METER_OFFSETS) needs scale = cos(lat0) * r / 6378137 at the origin's latitude lat0, and that is
   * exact only near the origin: north or south of it the error grows as about d^2 tan(lat0) / (2 R),
   * at 50 degrees north 0.09 m at 1 km, 9 m at 10 km, 230 m at 50 km. Re-centre the origin near the
   * camera, or draw in a coordinate mode that is linear in Web Mercator (scale 1).
   */
  writeHeads(originX: number, originY: number, out: Float32Array, scale = 1): void {
    checkScale(scale);
    if (out.length < this.count * HEAD_STRIDE) {
      throw new RangeError(`out holds ${out.length} floats, ${this.count * HEAD_STRIDE} needed`);
    }
    for (let slot = 0; slot < this.count; slot++) {
      this.writeHead(slot, slot * HEAD_STRIDE, originX, originY, out, scale);
    }
  }

  /**
   * writeHeads for the first `slotCount` entries of `slots` (for example the trains in view plus a
   * margin), written in that order from the start of `out`. RangeError when slotCount exceeds
   * slots.length, a listed slot was never added, or `out` is shorter than slotCount * HEAD_STRIDE.
   */
  writeHeadSlots(
    slots: ArrayLike<number>,
    slotCount: number,
    originX: number,
    originY: number,
    out: Float32Array,
    scale = 1,
  ): void {
    checkScale(scale);
    if (!(slotCount >= 0 && slotCount <= slots.length)) {
      throw new RangeError(`slotCount ${slotCount} outside [0, ${slots.length}]`);
    }
    if (out.length < slotCount * HEAD_STRIDE) {
      throw new RangeError(`out holds ${out.length} floats, ${slotCount * HEAD_STRIDE} needed`);
    }
    for (let k = 0; k < slotCount; k++) {
      const slot = slots[k] as number;
      if (!(Number.isInteger(slot) && slot >= 0 && slot < this.count)) {
        throw new RangeError(`slot ${slot} was never added`);
      }
      this.writeHead(slot, k * HEAD_STRIDE, originX, originY, out, scale);
    }
  }

  private writeHead(
    slot: number,
    o: number,
    originX: number,
    originY: number,
    out: Float32Array,
    scale: number,
  ): void {
    out[o] = ((this.x[slot] as number) - originX) * scale;
    out[o + 1] = ((this.y[slot] as number) - originY) * scale;
    out[o + 2] = this.z[slot] as number;
    out[o + 3] = Math.atan2(this.tangentY[slot] as number, this.tangentX[slot] as number);
    out[o + 4] = this.alive[slot] ? (this.alpha[slot] as number) : 0;
  }

  private requireLive(slot: number): void {
    if (!this.alive[slot]) throw new RangeError(`slot ${slot} is not in use`);
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.s.length) return;
    const capacity = Math.max(needed, this.s.length * 2);
    this.time = grownFloat64(this.time, capacity);
    this.s = grownFloat64(this.s, capacity);
    this.v = grownFloat64(this.v, capacity);
    this.alpha = grownFloat64(this.alpha, capacity);
    this.targetS = grownFloat64(this.targetS, capacity);
    this.targetV = grownFloat64(this.targetV, capacity);
    this.cap = grownFloat64(this.cap, capacity);
    this.x = grownFloat64(this.x, capacity);
    this.y = grownFloat64(this.y, capacity);
    this.z = grownFloat64(this.z, capacity);
    this.tangentX = grownFloat64(this.tangentX, capacity);
    this.tangentY = grownFloat64(this.tangentY, capacity);
    this.beyondEnd = grownFloat64(this.beyondEnd, capacity);
    this.fadeStart = grownFloat64(this.fadeStart, capacity);
    this.fadeProgress = grownFloat64(this.fadeProgress, capacity);
    this.restUntil = grownFloat64(this.restUntil, capacity);
    this.fadeStartAlpha = grownFloat64(this.fadeStartAlpha, capacity);
    this.shapeLength = grownFloat64(this.shapeLength, capacity);
    this.shapeVertexCount = grownInt32(this.shapeVertexCount, capacity);
    this.swaps = grownInt32(this.swaps, capacity);
    this.leg = grownInt32(this.leg, capacity);
    this.legOffset = grownInt32(this.legOffset, capacity);
    this.legCount = grownInt32(this.legCount, capacity);
    this.legCapacity = grownInt32(this.legCapacity, capacity);
    this.shapeHint = grownInt32(this.shapeHint, capacity);
    this.alive = grownUint8(this.alive, capacity);
    this.phase = grownUint8(this.phase, capacity);
    this.reason = grownUint8(this.reason, capacity);
  }

  private assignShape(slot: number, shape: Shape): void {
    this.shapes[slot] = shape;
    this.shapeRecords[slot] = shape.records;
    this.shapeAttributes[slot] = shape.attributes;
    this.shapeLength[slot] = shape.length;
    this.shapeVertexCount[slot] = shape.vertexCount;
    this.shapeHint[slot] = 0;
  }

  private assignPlan(slot: number, plan: MotionPlan): void {
    this.plans[slot] = plan;
    this.restUntil[slot] = 0;
    const legs = plan.legs.length;
    if (legs > (this.legCapacity[slot] as number)) {
      const capacity = Math.max(legs, 2 * (this.legCapacity[slot] as number));
      this.legOffset[slot] = this.reservePool(capacity * LEG_STRIDE);
      this.legCapacity[slot] = capacity;
    }
    this.legPool.set(plan.legData, this.legOffset[slot] as number);
    this.legCount[slot] = legs;
  }

  private reservePool(size: number): number {
    if (this.legPoolUsed + size > this.legPool.length) this.compactPool(size);
    const offset = this.legPoolUsed;
    this.legPoolUsed += size;
    return offset;
  }

  private compactPool(extra: number): void {
    let live = extra;
    for (let slot = 0; slot < this.count; slot++) {
      if (this.alive[slot]) live += (this.legCapacity[slot] as number) * LEG_STRIDE;
    }
    const pool = new Float64Array(Math.max(2 * live, this.legPool.length));
    let used = 0;
    for (let slot = 0; slot < this.count; slot++) {
      const size = (this.legCapacity[slot] as number) * LEG_STRIDE;
      if (!this.alive[slot] || size === 0) continue;
      const from = this.legOffset[slot] as number;
      pool.set(this.legPool.subarray(from, from + size), used);
      this.legOffset[slot] = used;
      used += size;
    }
    this.legPool = pool;
    this.legPoolUsed = used;
  }

  private moveToTarget(slot: number, now: number): void {
    const target = this.scratchTarget;
    target.leg = this.leg[slot] as number;
    this.evaluateSlot(slot, now, target);
    this.time[slot] = now;
    this.restUntil[slot] = 0;
    this.alpha[slot] = 0;
    if (!(Number.isFinite(target.s) && Number.isFinite(target.v) && Number.isFinite(target.cap))) {
      this.leg[slot] = 0;
      this.s[slot] = Number.NaN;
      this.v[slot] = 0;
      this.phase[slot] = PHASE_HIDDEN;
      return;
    }
    this.leg[slot] = target.leg;
    this.s[slot] = target.s;
    this.v[slot] = target.v;
    this.targetS[slot] = target.s;
    this.targetV[slot] = target.v;
    this.cap[slot] = target.cap;
    this.phase[slot] = PHASE_IN;
    this.fadeStart[slot] = now;
    this.fadeProgress[slot] = 0;
    this.refreshSample(slot);
  }

  private beginFadeOut(
    slot: number,
    plan: MotionPlan,
    shape: Shape,
    now: number,
    reason: CrossfadeReason,
  ): void {
    this.pendingPlans[slot] = plan;
    this.pendingShapes[slot] = shape;
    this.reason[slot] = REASONS.indexOf(reason);
    this.restUntil[slot] = 0;
    if (this.phase[slot] !== PHASE_OUT) {
      this.phase[slot] = PHASE_OUT;
      this.fadeStart[slot] = now;
      this.fadeProgress[slot] = 0;
      this.fadeStartAlpha[slot] = this.alpha[slot] as number;
    }
  }

  private resync(slot: number, now: number, reasonCode: number): void {
    const plan = this.pendingPlans[slot];
    const shape = this.pendingShapes[slot];
    if (plan) this.assignPlan(slot, plan);
    if (shape) this.assignShape(slot, shape);
    this.pendingPlans[slot] = undefined;
    this.pendingShapes[slot] = undefined;
    this.reason[slot] = reasonCode;
    this.swaps[slot] = (this.swaps[slot] as number) + 1;
    this.moveToTarget(slot, now);
  }

  /** One integration step to time t; returns true when a fade-out has completed (swap due). */
  private step(slot: number, t: number, h: number): boolean {
    const p = this.params;
    const phase = this.phase[slot];
    if (phase === PHASE_OUT) {
      const progress = this.advanceFade(slot, t, h, p.fadeOutDuration);
      const startAlpha = this.fadeStartAlpha[slot] as number;
      if (progress >= 1 || startAlpha <= 0) return true;
      this.alpha[slot] = startAlpha * (1 - progress);
    } else if (phase === PHASE_IN) {
      const progress = this.advanceFade(slot, t, h, p.fadeInDuration);
      this.alpha[slot] = Math.min(1, progress);
      if (progress >= 1) this.phase[slot] = PHASE_NONE;
    }
    this.control(slot, t, h);
    this.time[slot] = t;
    const distance = Math.abs((this.targetS[slot] as number) - (this.s[slot] as number));
    if (this.phase[slot] !== PHASE_OUT && distance > p.crossfadeDistance) {
      this.beginFadeOut(
        slot,
        this.plans[slot] as MotionPlan,
        this.shapes[slot] as Shape,
        t,
        "distance",
      );
    }
    return false;
  }

  /**
   * Adds the part of the step (t - h, t] after the fade started, in wall-clock time, to the fade
   * progress; accumulating keeps the fade continuous when the time scale changes during it.
   */
  private advanceFade(slot: number, t: number, h: number, duration: number): number {
    const span = Math.min(h, t - (this.fadeStart[slot] as number));
    const sum =
      (this.fadeProgress[slot] as number) + (span > 0 ? span / (duration * this.scale) : 0);
    const progress = sum > 1 - FADE_ROUNDING ? 1 : sum;
    this.fadeProgress[slot] = progress;
    return progress;
  }

  private control(slot: number, t: number, h: number): void {
    const p = this.params;
    const s = this.s[slot] as number;
    const v = this.v[slot] as number;
    const previousTargetS = this.targetS[slot] as number;
    const error = previousTargetS - s;
    const target = this.scratchTarget;
    target.leg = this.leg[slot] as number;
    this.evaluateSlot(slot, t, target);
    this.leg[slot] = target.leg;
    this.targetS[slot] = target.s;
    this.targetV[slot] = target.v;
    this.cap[slot] = target.cap;
    const meanTargetSpeed = (target.s - previousTargetS) / h;
    const magnitude = Math.abs(error);
    const linear = magnitude / p.gainTime;
    const catchUp =
      p.catchUpDeceleration < Number.POSITIVE_INFINITY
        ? Math.min(linear, Math.sqrt(2 * p.catchUpDeceleration * magnitude))
        : linear;
    const ceiling = p.speedFactor * target.v + p.speedOffset;
    const floor = error < 0 ? p.aheadSpeedFraction * target.v : 0;
    const command = Math.min(
      Math.max(meanTargetSpeed + (error >= 0 ? catchUp : -catchUp), floor),
      ceiling,
    );
    const room = target.cap - s;
    const braked = room > 0 ? Math.min(command, Math.sqrt(2 * p.brakingDeceleration * room)) : 0;
    const maxChange = p.accelerationLimit * h;
    const nextV = v + Math.min(Math.max(braked - v, -maxChange), maxChange);
    const next = s + nextV * h;
    const canStop = nextV * nextV <= 2 * p.accelerationLimit * room;
    const nextS = room >= 0 && canStop && next > target.cap ? target.cap : next;
    this.v[slot] = nextV;
    this.s[slot] = nextS;
    if (nextV === 0 && target.v === 0 && nextS === target.s && this.phase[slot] === PHASE_NONE) {
      this.restUntil[slot] = this.nextDeparture(slot, target.leg, t);
    }
  }

  /** Where the display comes to rest when it brakes at the acceleration limit from now on. */
  private stoppingPoint(slot: number): number {
    const v = this.v[slot] as number;
    return (this.s[slot] as number) + (v * v) / (2 * this.params.accelerationLimit);
  }

  /**
   * Time until which a display resting on its resting target stays exactly where it is: the next
   * departure after t, or Infinity after the last arrival. Until then a frame changes only time.
   */
  private nextDeparture(slot: number, leg: number, t: number): number {
    const base = this.legOffset[slot] as number;
    const count = this.legCount[slot] as number;
    const departure = this.legPool[base + leg * LEG_STRIDE] as number;
    if (t <= departure) return departure;
    return leg + 1 < count
      ? (this.legPool[base + (leg + 1) * LEG_STRIDE] as number)
      : Number.POSITIVE_INFINITY;
  }

  private evaluateSlot(slot: number, t: number, out: TargetState): void {
    evaluateLegsAt(
      this.legPool,
      this.legOffset[slot] as number,
      this.legCount[slot] as number,
      t,
      out,
    );
    clampToShape(out, this.shapeLength[slot] as number);
  }

  private refreshSample(slot: number): void {
    const sample = this.scratchSample;
    this.shapeHint[slot] = sampleShapeArrays(
      this.shapeRecords[slot] as Float64Array,
      this.shapeAttributes[slot] as Float32Array,
      this.shapeVertexCount[slot] as number,
      this.shapeLength[slot] as number,
      this.s[slot] as number,
      sample,
      this.shapeHint[slot] as number,
    );
    this.x[slot] = sample.x;
    this.y[slot] = sample.y;
    this.z[slot] = sample.z;
    this.tangentX[slot] = sample.tangentX;
    this.tangentY[slot] = sample.tangentY;
    this.beyondEnd[slot] = sample.beyondEnd;
  }
}
