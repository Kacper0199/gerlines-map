import type { MotionPlan } from "@gerlines/geo";
import { type MotionStop, motionPlanOf } from "@gerlines/geo/client-plan";
import type { TripRecord } from "@gerlines/live-frame";
import type { LoadedShape } from "./shape-store.ts";

/** Plan stops of a frame trip on its shape: explicit arcs, else the shape's stop list. */
export function stopsOf(trip: TripRecord, shapeStops: ArrayLike<number>): MotionStop[] {
  return trip.stops.map((stop, j) => {
    const s = stop.s ?? shapeStops[trip.firstStop + j];
    if (s === undefined) {
      throw new RangeError(
        `trip ${trip.key} needs stop ${trip.firstStop + j} of ${shapeStops.length}`,
      );
    }
    return {
      s,
      arrival: stop.arrival ?? (stop.departure as number),
      departure: stop.departure ?? (stop.arrival as number),
      cancelled: stop.cancelled,
    };
  });
}

/** The motion plan of a trip on its shape, null when it has no usable one (counted by the caller). */
export function planOfTrip(trip: TripRecord, shape: LoadedShape): MotionPlan | null {
  try {
    return motionPlanOf(stopsOf(trip, shape.stops), trip.category, shape.length);
  } catch {
    return null;
  }
}
