import type { StopTimeObservation } from "@gerlines/schema";
import { serviceInstant } from "@gerlines/schema/service-day";
import { NO_TIME, type TripRun } from "./timetable.ts";

/**
 * How a source's stops line up with a run found by train number, when its stop ids name nothing we
 * know: by scheduled times (the source sends delays), by its own stop sequence shifted onto ours
 * (the source sends only predicted times), or not at all (the source sends no times).
 */
export type Alignment =
  | { readonly kind: "scheduled" }
  | { readonly kind: "sequence"; readonly shift: number }
  | { readonly kind: "none" };

type TimeKind = "arrival" | "departure";

const TIME_TOLERANCE_MS = 90_000;
const EARLIEST_DELAY_MS = -2 * 60_000;
const LATEST_DELAY_MS = 2 * 3_600_000;
const DELAY_SPREAD_MS = 20 * 60_000;
const SHARE = 0.8;

function scheduledAt(run: TripRun, kind: TimeKind, stop: number): number | null {
  const seconds = (kind === "arrival" ? run.trip.arrivals : run.trip.departures)[stop] ?? NO_TIME;
  return seconds === NO_TIME ? null : serviceInstant(run.serviceDate, seconds);
}

/** Reported times in epoch ms with their kind; `scheduled` when the source gave the delay. */
function reportedTimes(stop: StopTimeObservation) {
  return (["arrival", "departure"] as const).flatMap((kind) => {
    const time = stop[kind];
    if (time?.time == null) return [];
    const scheduled = time.delaySeconds !== null;
    return [{ kind, instant: (time.time - (time.delaySeconds ?? 0)) * 1000, scheduled }];
  });
}

function fitsScheduled(run: TripRun, stop: StopTimeObservation, index: number): boolean {
  return reportedTimes(stop).some((time) => {
    const own = scheduledAt(run, time.kind, index);
    return time.scheduled && own !== null && Math.abs(own - time.instant) <= TIME_TOLERANCE_MS;
  });
}

/**
 * Scheduled times agree when stops of the source that fall inside the run's span (90 seconds either
 * side) number at least one, at least two of them (or all, if fewer) fit an arrival or departure of
 * the same kind to 90 seconds, and four in five of them fit.
 */
function scheduledAgree(run: TripRun, stops: readonly StopTimeObservation[]): boolean {
  const own = run.trip.stopPlaces.flatMap((_, index) =>
    (["arrival", "departure"] as const).flatMap((kind) => scheduledAt(run, kind, index) ?? []),
  );
  if (own.length === 0) return false;
  const first = Math.min(...own) - TIME_TOLERANCE_MS;
  const last = Math.max(...own) + TIME_TOLERANCE_MS;
  const timed = stops.filter((stop) => reportedTimes(stop).some((time) => time.scheduled));
  const inside = timed.filter((stop) =>
    reportedTimes(stop).some(
      (time) => time.scheduled && time.instant >= first && time.instant <= last,
    ),
  );
  const fitting = inside.filter((stop) =>
    run.trip.stopPlaces.some((_, index) => fitsScheduled(run, stop, index)),
  ).length;
  return (
    inside.length > 0 && fitting >= Math.min(2, timed.length) && fitting >= SHARE * inside.length
  );
}

/** Predicted minus scheduled at a run stop, preferring the departure, or null when out of range. */
function delayAt(run: TripRun, stop: StopTimeObservation, index: number): number | null {
  for (const time of reportedTimes(stop).reverse()) {
    const own =
      scheduledAt(run, time.kind, index) ??
      scheduledAt(run, time.kind === "arrival" ? "departure" : "arrival", index);
    if (own === null) continue;
    const delay = time.instant - own;
    return delay >= EARLIEST_DELAY_MS && delay <= LATEST_DELAY_MS ? delay : null;
  }
  return null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Stops fitting a sequence shift: predicted times late by a delay in range, within 20 minutes of the median. */
function fitsAtShift(
  run: TripRun,
  stops: readonly StopTimeObservation[],
  shift: number,
): { inside: number; fits: number } {
  const inside = stops.filter((stop) => {
    const index = (stop.stopSequence ?? -1) - shift;
    return index >= 0 && index < run.trip.stopPlaces.length;
  });
  const delays = inside.flatMap(
    (stop) => delayAt(run, stop, (stop.stopSequence ?? 0) - shift) ?? [],
  );
  if (delays.length === 0) return { inside: inside.length, fits: 0 };
  const middle = median(delays);
  const fits = delays.filter((delay) => Math.abs(delay - middle) <= DELAY_SPREAD_MS).length;
  return { inside: inside.length, fits };
}

/** Shifts that put some stop on a run stop with a delay in range, nearest to zero first. */
function candidateShifts(run: TripRun, stops: readonly StopTimeObservation[]): number[] {
  const shifts = new Set<number>();
  for (const stop of stops) {
    for (let index = 0; index < run.trip.stopPlaces.length; index += 1) {
      if (delayAt(run, stop, index) !== null) shifts.add((stop.stopSequence ?? 0) - index);
    }
  }
  return [...shifts].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
}

/**
 * A shift of the source's stop sequence onto our stop indexes under which at least two stops (or
 * all, if fewer) and four in five of the stops that land on the run carry predicted times late by a
 * plausible and steady delay. Shifts are tried nearest to zero first; the one fitting most wins.
 */
function sequenceAlignment(run: TripRun, stops: readonly StopTimeObservation[]): number | null {
  const sequenced = stops.filter(
    (stop) => stop.stopSequence !== null && reportedTimes(stop).length > 0,
  );
  if (sequenced.length === 0) return null;
  let best: { shift: number; fits: number } | null = null;
  for (const shift of candidateShifts(run, sequenced)) {
    const { inside, fits } = fitsAtShift(run, sequenced, shift);
    if (fits < Math.min(2, sequenced.length) || fits < SHARE * inside) continue;
    if (!best || fits > best.fits) best = { shift, fits };
  }
  return best?.shift ?? null;
}

/** How the source's stops line up with the run, or null when its times contradict the run. */
export function alignTrainNumber(
  run: TripRun,
  stops: readonly StopTimeObservation[],
): Alignment | null {
  const times = stops.flatMap(reportedTimes);
  if (times.length === 0) return { kind: "none" };
  if (times.some((time) => time.scheduled))
    return scheduledAgree(run, stops) ? { kind: "scheduled" } : null;
  const shift = sequenceAlignment(run, stops);
  return shift === null ? null : { kind: "sequence", shift };
}

/** The run stop after `after` that a source stop lands on under an alignment, if any. */
export function indexByAlignment(
  run: TripRun,
  alignment: Alignment,
  stop: StopTimeObservation,
  after: number,
): number | undefined {
  if (alignment.kind === "sequence") {
    const index = (stop.stopSequence ?? -1) - alignment.shift;
    const valid = index > after && index < run.trip.stopPlaces.length;
    return valid && delayAt(run, stop, index) !== null ? index : undefined;
  }
  if (alignment.kind === "none") return undefined;
  for (let index = after + 1; index < run.trip.stopPlaces.length; index += 1) {
    if (fitsScheduled(run, stop, index)) return index;
  }
  return undefined;
}
