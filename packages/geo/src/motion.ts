import {
  type ControllerParams,
  type CrossfadeReason,
  DEFAULT_CONTROLLER,
  type UpdateResult,
} from "./controller.ts";
import { MotionFleet } from "./fleet.ts";
import { createTargetState, type MotionPlan, type TargetState } from "./plan.ts";
import { createShapeSample, type Shape, type ShapeSample } from "./shape.ts";

export { type ControllerParams, type CrossfadeReason, DEFAULT_CONTROLLER, type UpdateResult };

const SLOT = 0;

/**
 * One running trip on its own: the same controller as MotionFleet (a fleet of one), with the state
 * as properties. Use MotionFleet for many trips; this is for single trains, tools and tests.
 */
export class TrainMotion {
  private readonly fleet: MotionFleet;
  private readonly targetView: TargetState = createTargetState();
  private readonly sampleView: ShapeSample = createShapeSample();

  constructor(
    shape: Shape,
    plan: MotionPlan,
    now: number,
    params: ControllerParams = DEFAULT_CONTROLLER,
  ) {
    this.fleet = new MotionFleet(params);
    this.fleet.add(shape, plan, now);
  }

  get s(): number {
    return this.fleet.s[SLOT] as number;
  }

  get v(): number {
    return this.fleet.v[SLOT] as number;
  }

  get alpha(): number {
    return this.fleet.alpha[SLOT] as number;
  }

  get time(): number {
    return this.fleet.time[SLOT] as number;
  }

  get shape(): Shape {
    return this.fleet.shapeOf(SLOT);
  }

  get plan(): MotionPlan {
    return this.fleet.planOf(SLOT);
  }

  get lastCrossfade(): CrossfadeReason {
    return this.fleet.lastCrossfade(SLOT);
  }

  get swapCount(): number {
    return this.fleet.swaps[SLOT] as number;
  }

  /** The current target (a view refreshed on each read). */
  get target(): TargetState {
    const view = this.targetView;
    view.s = this.fleet.targetS[SLOT] as number;
    view.v = this.fleet.targetV[SLOT] as number;
    view.cap = this.fleet.cap[SLOT] as number;
    return view;
  }

  /** The current head position on the shape (a view refreshed on each read). */
  get sample(): ShapeSample {
    const view = this.sampleView;
    const fleet = this.fleet;
    view.x = fleet.x[SLOT] as number;
    view.y = fleet.y[SLOT] as number;
    view.z = fleet.z[SLOT] as number;
    view.tangentX = fleet.tangentX[SLOT] as number;
    view.tangentY = fleet.tangentY[SLOT] as number;
    view.beyondEnd = fleet.beyondEnd[SLOT] as number;
    return view;
  }

  /** See MotionFleet.timeScale. */
  get timeScale(): number {
    return this.fleet.timeScale;
  }

  set timeScale(value: number) {
    this.fleet.timeScale = value;
  }

  /** See MotionFleet.update. */
  update(plan: MotionPlan, now: number, shape?: Shape): UpdateResult {
    return this.fleet.update(SLOT, plan, now, shape);
  }

  /** Advances the display to time `now` (seconds, the plan's clock). */
  advance(now: number): void {
    this.fleet.advanceSlot(SLOT, now);
  }
}
