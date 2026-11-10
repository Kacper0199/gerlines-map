import ice379 from "../../../design/variants/data/ice379.json" with { type: "json" };
import { lonLatToMercator } from "../src/mercator.ts";
import { buildMotionPlan, type MotionPlan, type PlanStop } from "../src/plan.ts";
import { CATEGORY_DYNAMICS, type TrainDynamics } from "../src/profile.ts";
import { projectOntoShape, type Shape, shapeFromLonLat } from "../src/shape.ts";

/**
 * ICE 379 Berlin Hbf to Basel SBB on Friday 2026-10-23 (design/variants/data/ice379.json:
 * Transitous over DELFI realtime, CC BY-SA 4.0). Times are realtime predictions as captured at
 * 21:34 local time, in seconds since 2026-10-23 00:00 local time (CEST); times after midnight are
 * on the next day.
 */
export interface Ice379Stop {
  readonly name: string;
  readonly s: number;
  readonly projectionDistance: number;
  readonly arrival: number | undefined;
  readonly departure: number | undefined;
}

export interface Ice379 {
  readonly shape: Shape;
  readonly stops: readonly Ice379Stop[];
  readonly dynamics: TrainDynamics;
  readonly trainLength: number;
  readonly cars: number;
}

const NOON = 12 * 3600;

function clockSeconds(clock: string | null, previous: number): number | undefined {
  if (clock === null) return undefined;
  const [hours, minutes] = clock.split(":").map(Number) as [number, number];
  let seconds = hours * 3600 + minutes * 60;
  while (seconds < previous - NOON) seconds += 24 * 3600;
  return seconds;
}

export function loadIce379(): Ice379 {
  const shape = shapeFromLonLat(ice379.route as [number, number][]);
  const stops: Ice379Stop[] = [];
  let windowStart = 0;
  let lastTime = 0;
  for (const stop of ice379.stops) {
    const point = lonLatToMercator(stop.lon, stop.lat);
    const projection = projectOntoShape(shape, point.x, point.y, windowStart, shape.length);
    const arrival = clockSeconds(stop.arr, lastTime);
    lastTime = arrival ?? lastTime;
    const departure = clockSeconds(stop.dep, lastTime);
    lastTime = departure ?? lastTime;
    stops.push({
      name: stop.name,
      s: projection.s,
      projectionDistance: projection.distance,
      arrival,
      departure,
    });
    windowStart = projection.s;
  }
  const vehicleMaxSpeed = ice379.vehicle.maxSpeedKmh / 3.6;
  const dynamics = {
    ...CATEGORY_DYNAMICS.hsr,
    maxSpeed: Math.min(CATEGORY_DYNAMICS.hsr.maxSpeed, vehicleMaxSpeed),
  };
  return { shape, stops, dynamics, trainLength: ice379.vehicle.lengthM, cars: ice379.vehicle.cars };
}

export function planFor(train: Ice379, stops: readonly PlanStop[]): MotionPlan {
  return buildMotionPlan({ stops, dynamics: train.dynamics });
}

export interface DelayStep {
  readonly time: number;
  readonly delay: number;
}

/** Applies delay steps in order: each shifts every arrival and departure still in the future. */
export function stopsAfterSteps(
  base: readonly PlanStop[],
  steps: readonly DelayStep[],
): PlanStop[][] {
  const result: PlanStop[][] = [];
  let current: PlanStop[] = base.map((stop) => ({ ...stop }));
  for (const step of steps) {
    current = current.map((stop) => ({
      s: stop.s,
      arrival:
        stop.arrival !== undefined && stop.arrival > step.time
          ? stop.arrival + step.delay
          : stop.arrival,
      departure:
        stop.departure !== undefined && stop.departure > step.time
          ? stop.departure + step.delay
          : stop.departure,
    }));
    result.push(current);
  }
  return result;
}

/** mulberry32: a small seeded generator so every scenario is reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DELAY_STEPS_SECONDS = [-900, -300, -120, 120, 300, 900] as const;
