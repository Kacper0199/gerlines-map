import type { SelectionStops } from "../motion/protocol.ts";
import type { StopRef } from "./model.ts";

/** How far the worker's time for a stop may lie from the detail's, in seconds: the two are read at different moments. */
const TIME_TOLERANCE_S = 60;

function matches(known: number, candidates: readonly number[] | undefined): boolean {
  if (Number.isNaN(known)) return true;
  return (candidates ?? []).some((time) => Math.abs(time - known) <= TIME_TOLERANCE_S);
}

/**
 * The stop positions on the drawn route, only when they belong to the detail's stops: the detail's stop `i` is the
 * shape's stop `i` only while both describe one run. The worker holds the times of the stops ahead, starting at
 * stop `firstStop` of the shape's list; the detail's tail from that index must reach the same end and carry the same
 * times (scheduled or predicted, within a minute) and the same cancelled flags. A cancelled stop dropped on one
 * side and another one added on the other, or a changed pattern, keep the count but fail here.
 */
export function placeStops(
  stops: readonly StopRef[],
  selection: SelectionStops | undefined,
): Float32Array | undefined {
  if (selection === undefined || selection.vertices.length !== stops.length) return undefined;
  const ahead = selection.arrivals.length;
  if (ahead === 0 || selection.firstStop + ahead !== stops.length) return undefined;
  for (let j = 0; j < ahead; j++) {
    const stop = stops[selection.firstStop + j] as StopRef;
    if ((selection.cancelled[j] === 1) !== (stop.cancelled === true)) return undefined;
    if (!matches(selection.arrivals[j] as number, stop.times)) return undefined;
    if (!matches(selection.departures[j] as number, stop.times)) return undefined;
  }
  return selection.vertices;
}
