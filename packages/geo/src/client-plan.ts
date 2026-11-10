import { buildMotionPlan, type MotionPlan, type PlanStop } from "./plan.ts";
import { CATEGORY_DYNAMICS, type TrainDynamics } from "./profile.ts";

/** The trip categories of a live frame (packages/live-frame FORMAT.md, category codes 0 to 8). */
export const FRAME_CATEGORIES = [
  "unknown",
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
  "urban",
  "bus",
] as const;
export type FrameCategory = (typeof FRAME_CATEGORIES)[number];

/**
 * Display dynamics per frame category, the same on the server (hold rule) and in the client worker
 * (WP-3.3): the kernel's category dynamics, regional ones for categories the kernel lacks. The
 * foreign flag does not change dynamics (a foreign ICE is still high speed).
 */
export function dynamicsFor(category: FrameCategory): TrainDynamics {
  switch (category) {
    case "hsr":
    case "ld":
    case "night":
    case "rfast":
    case "reg":
    case "sbahn":
      return CATEGORY_DYNAMICS[category];
    default:
      return CATEGORY_DYNAMICS.reg;
  }
}

/** A plan stop as a client reads it from a frame: arc length in metres, times in Unix seconds. */
export interface MotionStop {
  readonly s: number;
  readonly arrival: number;
  readonly departure: number;
  readonly cancelled: boolean;
}

/**
 * The motion plan a client builds from a trip of a frame: every stop the train serves (cancelled
 * stops, stop flag bit 2, are left out), arc lengths clamped to the shape. Null when fewer than two
 * served stops remain.
 */
export function motionPlanOf(
  stops: readonly MotionStop[],
  category: FrameCategory,
  shapeLength: number,
): MotionPlan | null {
  const served: PlanStop[] = [];
  for (const stop of stops) {
    if (!stop.cancelled)
      served.push({ s: stop.s, arrival: stop.arrival, departure: stop.departure });
  }
  if (served.length < 2) return null;
  return buildMotionPlan({ stops: served, dynamics: dynamicsFor(category), shapeLength });
}
