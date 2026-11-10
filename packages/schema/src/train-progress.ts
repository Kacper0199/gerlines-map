import type { DelayBasis, TrainProgress, TrainStop } from "./train-detail.ts";

function instant(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

/** When the train reaches a stop: its expected arrival, else its expected departure (epoch ms). */
export function reachedAt(stop: TrainStop): number | null {
  return (
    instant(stop.predictedArrival) ??
    instant(stop.scheduledArrival) ??
    instant(stop.predictedDeparture) ??
    instant(stop.scheduledDeparture)
  );
}

/**
 * Progress by arrival ("reached") at `asOf` (epoch ms): the last served stop reached at or before
 * `asOf` and the first served stop after it. The train stands at the last one until its departure.
 */
export function progressAt(stops: readonly TrainStop[], asOf: number): TrainProgress {
  const served = stops.filter((stop) => !stop.cancelled);
  let lastPassed: TrainStop | null = null;
  for (const stop of served) {
    const reached = reachedAt(stop);
    if (reached !== null && reached <= asOf) lastPassed = stop;
  }
  const next = served.find((stop) => lastPassed === null || stop.index > lastPassed.index) ?? null;
  return { lastPassedIndex: lastPassed?.index ?? null, nextIndex: next?.index ?? null };
}

/** The progress further along the run: the one that has reached more stops (none counts as −1). */
export function laterProgress(a: TrainProgress, b: TrainProgress): TrainProgress {
  return (b.lastPassedIndex ?? -1) > (a.lastPassedIndex ?? -1) ? b : a;
}

/**
 * Progress as served at `asOf`: recomputed from the stops, so it moves on between writes, and never
 * behind the progress stored with them, which is the live engine's view when it wrote the detail.
 * A forecast that moves a reached stop later then cannot step the card back, and the card agrees
 * with the map where the engine's held plan is ahead of the source's times. The next stop is the
 * first one served after it, so a stop cancelled after the write is never named.
 */
export function servedProgress(
  stored: TrainProgress,
  stops: readonly TrainStop[],
  asOf: number,
): TrainProgress {
  const { lastPassedIndex } = laterProgress(stored, progressAt(stops, asOf));
  const next = stops.find(
    (stop) => !stop.cancelled && (lastPassedIndex === null || stop.index > lastPassedIndex),
  );
  return { lastPassedIndex, nextIndex: next?.index ?? null };
}

function leftAt(stop: TrainStop): number | null {
  return instant(stop.predictedDeparture) ?? instant(stop.scheduledDeparture);
}

/**
 * The delay the source predicts at the stop the train leaves or reaches next at `asOf`: the
 * departure delay of the stop it stands at, else the arrival delay of the next stop, else the last
 * stop's arrival delay at the end of the run; null when that stop has none. A cancelled stop never
 * counts as the one passed.
 */
export function delayAt(
  stops: readonly TrainStop[],
  progress: TrainProgress,
  asOf: number,
): number | null {
  const { lastPassedIndex, nextIndex } = progress;
  const passed =
    lastPassedIndex === null
      ? null
      : (stops.findLast((stop) => !stop.cancelled && stop.index <= lastPassedIndex) ?? null);
  const next = nextIndex === null ? null : (stops.find((stop) => stop.index === nextIndex) ?? null);
  if (passed && next === null) return passed.arrivalDelaySeconds ?? passed.departureDelaySeconds;
  const departs = passed ? leftAt(passed) : null;
  if (passed && departs !== null && departs > asOf) {
    const standing = passed.departureDelaySeconds ?? passed.arrivalDelaySeconds;
    if (standing !== null) return standing;
  }
  return next ? (next.arrivalDelaySeconds ?? next.departureDelaySeconds) : null;
}

export interface HeadDelay {
  readonly delaySeconds: number | null;
  readonly delayBasis: DelayBasis | null;
}

/**
 * The card head's delay at `asOf`: the stop's prediction (`delayAt`) when the source is
 * realtime and has one, so the head agrees with the stop rows, else the live tick's `current` delay
 * marked as the delay now. The live writer and the API's served detail both call it, the API at
 * the served `asOf`, so the head moves on between writes as progress does.
 */
export function headDelay(input: {
  readonly stops: readonly TrainStop[];
  readonly progress: TrainProgress;
  readonly asOf: number;
  readonly realtime: boolean;
  readonly current: number | null;
}): HeadDelay {
  const atStop = input.realtime ? delayAt(input.stops, input.progress, input.asOf) : null;
  if (atStop !== null) return { delaySeconds: atStop, delayBasis: "stop" };
  if (input.current !== null) return { delaySeconds: input.current, delayBasis: "current" };
  return { delaySeconds: null, delayBasis: null };
}
