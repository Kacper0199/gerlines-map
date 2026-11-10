import { reachedAt, type TrainDetail } from "@gerlines/schema";

/** What the API can serve from a written detail: its stored progress and when each stop is reached. */
export interface ServedTrace {
  readonly passed: number;
  readonly reached: readonly (readonly [index: number, at: number])[];
}

export function traceOf(detail: TrainDetail): ServedTrace {
  const reached: [number, number][] = [];
  for (const stop of detail.stops) {
    const at = stop.cancelled ? null : reachedAt(stop);
    if (at !== null) reached.push([stop.index, at]);
  }
  return { passed: detail.progress.lastPassedIndex ?? -1, reached };
}

/** The furthest stop `servedProgress` could have named from the trace by `at` (epoch ms), −1 for none. */
export function floorAt(trace: ServedTrace, at: number): number {
  let floor = trace.passed;
  for (const [index, reached] of trace.reached) if (reached <= at) floor = Math.max(floor, index);
  return floor;
}

/**
 * The detail with its progress at least at the floor, so a forecast that moves a reached stop later
 * never steps the card back. It holds at the last served stop at or before the floor, and the next
 * stop is the first served one after that. A cancelled train keeps
 * its own progress: what it showed before the cancellation was the timetable's guess.
 */
export function withFloor(detail: TrainDetail, floor: number): TrainDetail {
  if (detail.cancelled || !detail.stops.some((stop) => stop.index === floor)) return detail;
  const held = detail.stops.findLast((stop) => !stop.cancelled && stop.index <= floor)?.index;
  if (held === undefined || held <= (detail.progress.lastPassedIndex ?? -1)) return detail;
  const next = detail.stops.find((stop) => !stop.cancelled && stop.index > held);
  return { ...detail, progress: { lastPassedIndex: held, nextIndex: next?.index ?? null } };
}
