import type { TrainDetail } from "@gerlines/schema";
import type { SelectionStops } from "../motion/protocol.ts";

const seconds = (iso: string | null) => (iso === null ? Number.NaN : Date.parse(iso) / 1000);

/** What the worker would send for a detail's stops: every stop on the route, the times of those from `firstStop` on. */
export function selectionFrom(
  stops: TrainDetail["stops"],
  firstStop: number,
  vertexCount = stops.length,
): SelectionStops {
  const ahead = stops.slice(firstStop);
  return {
    vertices: Float32Array.from({ length: vertexCount }, (_, i) => i * 10),
    firstStop,
    arrivals: Float64Array.from(
      ahead.map((stop) => seconds(stop.predictedArrival ?? stop.scheduledArrival)),
    ),
    departures: Float64Array.from(
      ahead.map((stop) => seconds(stop.predictedDeparture ?? stop.scheduledDeparture)),
    ),
    cancelled: Uint8Array.from(ahead.map((stop) => (stop.cancelled ? 1 : 0))),
  };
}
