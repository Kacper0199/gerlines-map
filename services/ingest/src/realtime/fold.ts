import type { StopTimeObservation, TripObservation } from "@gerlines/schema";
import { uuidv5 } from "@gerlines/schema/ids";
import { isDistrictStopNumber, normalizePlatform } from "@gerlines/schema/platform";
import { serviceInstant } from "@gerlines/schema/service-day";
import { IRIS_SOURCE } from "./iris.ts";
import type { MatchedTrip, StopPlacement } from "./matcher.ts";
import type { EventRow, RowBatch, SegmentRow, StopEventRow } from "./rows.ts";
import { NO_TIME, type StaticTrip, type Timetable, type TripRun } from "./timetable.ts";

/** A train counts as delayed in the outbox once its delay moves by a minute or more. */
export const DELAY_EVENT_STEP_S = 60;
/** Instances leave memory this long after their last scheduled arrival and last observation. */
export const EVICT_AFTER_MS = 3 * 3_600_000;
/** A train is never half an hour ahead of its timetable: earlier delays are read as no data. */
export const EARLIEST_DELAY_S = -1800;

/**
 * The track a source names when it differs from the planned one; where DELFI plans a stop number,
 * only against the track the source planned.
 */
function changedTrack(
  actual: string | null,
  scheduled: string | null,
  plannedStopNumber: boolean,
): string | null {
  if (actual === null || actual === scheduled) return null;
  return plannedStopNumber && scheduled === null ? null : actual;
}

export interface StopState {
  readonly placeId: string;
  readonly schedArr: number | null;
  readonly schedDep: number | null;
  readonly platformScheduled: string | null;
  predArr: number | null;
  predDep: number | null;
  arrDelay: number | null;
  depDelay: number | null;
  kind: "explicit" | "propagated" | null;
  cancelled: boolean;
  platformActual: string | null;
  finalArr: number | null;
  finalDep: number | null;
  arrFinal: boolean;
  depFinal: boolean;
  quality: "live" | "carried" | null;
  /** Inside a written leg (cancelled when the train passed it): later updates are ignored. */
  passedOver: boolean;
  observedAt: number;
  rawObjectId: string;
  dirty: boolean;
}

interface InstanceState {
  readonly run: TripRun;
  readonly stops: StopState[];
  readonly legs: Set<number>;
  readonly lastScheduled: number;
  cancelled: boolean;
  cancelEmitted: boolean;
  delayEmitted: number;
  lastSeenAt: number;
}

interface Prediction {
  arrDelay: number | null;
  depDelay: number | null;
  kind: "explicit" | "propagated" | null;
  cancelled: boolean;
  /** The source sent a delay earlier than `EARLIEST_DELAY_S` here, read as no data. */
  implausible: boolean;
}

/** What one applied trip update did beyond its rows, for the per-payload counts. */
export interface ApplyResult {
  readonly implausibleDelays: number;
  readonly reordered: number;
}

const plausible = (delay: number | null): number | null =>
  delay !== null && delay < EARLIEST_DELAY_S ? null : delay;

const toEpochS = (serviceDate: string, seconds: number | undefined): number | null =>
  seconds === undefined || seconds === NO_TIME ? null : serviceInstant(serviceDate, seconds) / 1000;

const plus = (base: number | null, delay: number | null): number | null =>
  base === null || delay === null ? null : base + delay;

function explicitDelay(
  observed: StopTimeObservation["arrival"],
  scheduled: number | null,
): number | null {
  if (!observed) return null;
  if (observed.delaySeconds !== null) return observed.delaySeconds;
  if (observed.time !== null && scheduled !== null) return observed.time - scheduled;
  return null;
}

/**
 * GTFS-RT reading of one trip update: explicit values where the source names a stop, the last
 * departure delay carried forward to later stops it leaves out, nothing before the first named stop,
 * no carry past a stop without data, skipped stops cancelled. With `carryBack` (IRIS, which names
 * only the stations it covers) a positive delay of the first stop with an explicit delay is also
 * carried back to the stops before it that the source leaves out, so a train is not on time
 * upstream and then late at the first station IRIS reports; final times stay as they are.
 */
export function predictStops(
  stops: readonly Pick<StopState, "schedArr" | "schedDep">[],
  placements: readonly StopPlacement[],
  tripDelay: number | null,
  carryBack = false,
): Prediction[] {
  const byIndex = new Map(placements.map((placement) => [placement.index, placement.observed]));
  const carry = { value: placements.length === 0 ? plausible(tripDelay) : null };
  const predictions = stops.map((stop, index) => predictStop(stop, byIndex.get(index), carry));
  if (carryBack) carryBackwards(stops, byIndex, predictions);
  return predictions;
}

function carryBackwards(
  stops: readonly Pick<StopState, "schedArr" | "schedDep">[],
  observed: ReadonlyMap<number, StopTimeObservation>,
  predictions: Prediction[],
): void {
  const first = predictions.findIndex(
    (prediction, index) => observed.has(index) && prediction.kind === "explicit",
  );
  const found = predictions[first];
  const delay = found ? (found.arrDelay ?? found.depDelay) : null;
  if (delay === null || delay <= 0) return;
  for (let index = 0; index < first; index += 1) {
    const stop = stops[index];
    if (!stop || observed.has(index)) continue;
    predictions[index] = carriedPrediction(stop, { value: delay });
  }
}

function carriedPrediction(
  stop: Pick<StopState, "schedArr" | "schedDep">,
  carry: { value: number | null },
): Prediction {
  return {
    arrDelay: stop.schedArr === null ? null : carry.value,
    depDelay: stop.schedDep === null ? null : carry.value,
    kind: carry.value === null ? null : "propagated",
    cancelled: false,
    implausible: false,
  };
}

const NO_DATA = { arrDelay: null, depDelay: null, kind: null, cancelled: false } as const;

function predictStop(
  stop: Pick<StopState, "schedArr" | "schedDep">,
  observed: StopTimeObservation | undefined,
  carry: { value: number | null },
): Prediction {
  if (!observed) return carriedPrediction(stop, carry);
  if (observed.relationship === "skipped")
    return { ...NO_DATA, cancelled: true, implausible: false };
  if (observed.relationship === "no_data") {
    carry.value = null;
    return { ...NO_DATA, implausible: false };
  }
  return explicitPrediction(stop, observed, carry);
}

function explicitPrediction(
  stop: Pick<StopState, "schedArr" | "schedDep">,
  observed: StopTimeObservation,
  carry: { value: number | null },
): Prediction {
  const arrSent = explicitDelay(observed.arrival, stop.schedArr);
  const depSent = explicitDelay(observed.departure, stop.schedDep);
  const arrExplicit = plausible(arrSent);
  const depExplicit = plausible(depSent);
  const implausible = arrExplicit !== arrSent || depExplicit !== depSent;
  if (implausible && arrExplicit === null && depExplicit === null) {
    carry.value = null;
    return { ...NO_DATA, implausible };
  }
  const arrDelay = stop.schedArr === null ? null : (arrExplicit ?? carry.value ?? depExplicit);
  const depDelay = stop.schedDep === null ? null : (depExplicit ?? arrExplicit ?? carry.value);
  carry.value = depDelay ?? arrDelay ?? carry.value;
  return { arrDelay, depDelay, kind: "explicit", cancelled: false, implausible };
}

interface TimeSlot {
  readonly final: boolean;
  readonly scheduled: number;
  value: number;
  moved: boolean;
}

/**
 * Keeps predicted times in order along the run: no stop is left after the next one was reached
 * (a time later than a later final time moves back to it) and none is reached before the stop
 * before it was left (a time earlier than an earlier time moves forward to it). Final times stay as
 * they are and bound the others, also at a stop the source now calls skipped or cancelled. Writes
 * the moved delays into `predictions` and returns how many times it moved.
 */
function keepInOrder(stops: readonly StopState[], predictions: Prediction[]): number {
  const slots: { slot: TimeSlot; write: (delay: number) => void }[] = [];
  const add = (
    final: boolean,
    finalValue: number | null,
    scheduled: number | null,
    delay: number | null,
    write: (delay: number) => void,
  ) => {
    const value = final ? finalValue : plus(scheduled, delay);
    if (value === null || scheduled === null) return;
    slots.push({ slot: { final, scheduled, value, moved: false }, write });
  };
  predictions.forEach((prediction, index) => {
    const stop = stops[index];
    if (!stop) return;
    const served = !stop.passedOver && !prediction.cancelled;
    if (served || stop.arrFinal) {
      add(stop.arrFinal, stop.predArr, stop.schedArr, prediction.arrDelay, (delay) => {
        prediction.arrDelay = delay;
      });
    }
    if (served || stop.depFinal) {
      add(stop.depFinal, stop.predDep, stop.schedDep, prediction.depDelay, (delay) => {
        prediction.depDelay = delay;
      });
    }
  });
  let moves = 0;
  let ceiling = Number.POSITIVE_INFINITY;
  for (const { slot } of [...slots].reverse()) {
    if (slot.final) ceiling = Math.min(ceiling, slot.value);
    else if (slot.value > ceiling) {
      slot.value = ceiling;
      slot.moved = true;
      moves += 1;
    }
  }
  let floor = Number.NEGATIVE_INFINITY;
  for (const { slot } of slots) {
    if (!slot.final && slot.value < floor) {
      slot.value = floor;
      slot.moved = true;
      moves += 1;
    }
    floor = Math.max(floor, slot.value);
  }
  for (const { slot, write } of slots) if (slot.moved) write(slot.value - slot.scheduled);
  return moves;
}

/**
 * Placements of a match on the instance's own stop list. A later feed version may file the same
 * train with other stops; its placements then move to the instance's stops by place, in order.
 */
function placementsOn(own: TripRun, match: MatchedTrip): readonly StopPlacement[] {
  const ownPlaces = own.trip.stopPlaces;
  const matchedPlaces = match.run.trip.stopPlaces;
  if (sameTuple(ownPlaces, matchedPlaces)) return match.placements;
  const placements: StopPlacement[] = [];
  let after = -1;
  for (const placement of match.placements) {
    const place = matchedPlaces[placement.index];
    const index = ownPlaces.findIndex((candidate, at) => at > after && candidate === place);
    if (index < 0) continue;
    after = index;
    placements.push({ ...placement, index });
  }
  return placements;
}

function sameTuple(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** How a checkpoint names an instance's run: by version and trip, or in full for an added trip. */
export type RunRef =
  | {
      readonly kind: "timetable";
      readonly instanceId: string;
      readonly serviceDate: string;
      readonly feedVersionId: number;
      readonly tripKey: string;
    }
  | {
      readonly kind: "added";
      readonly run: Omit<TripRun, "trip"> & {
        readonly trip: Omit<StaticTrip, "stopSequences" | "arrivals" | "departures"> & {
          readonly stopSequences: number[];
          readonly arrivals: number[];
          readonly departures: number[];
        };
      };
    };

function runRef(run: TripRun): RunRef {
  if (run.added) {
    return {
      kind: "added",
      run: {
        ...run,
        trip: {
          ...run.trip,
          stopSequences: [...run.trip.stopSequences],
          arrivals: [...run.trip.arrivals],
          departures: [...run.trip.departures],
        },
      },
    };
  }
  return {
    kind: "timetable",
    instanceId: run.instanceId,
    serviceDate: run.serviceDate,
    feedVersionId: run.feedVersionId ?? -1,
    tripKey: run.trip.tripKey,
  };
}

/** An added trip's run rebuilt from its checkpoint form. */
export function addedRun(ref: Extract<RunRef, { kind: "added" }>): TripRun {
  const trip = ref.run.trip;
  return {
    ...ref.run,
    trip: {
      ...trip,
      stopSequences: Int32Array.from(trip.stopSequences),
      arrivals: Int32Array.from(trip.arrivals),
      departures: Int32Array.from(trip.departures),
    },
  };
}

export interface FoldSnapshot {
  readonly source: string;
  readonly ignoredAfterEviction: number;
  readonly evicted: readonly (readonly [string, string])[];
  readonly instances: readonly {
    readonly run: RunRef;
    readonly stops: readonly StopState[];
    readonly legs: readonly number[];
    readonly lastScheduled: number;
    readonly cancelled: boolean;
    readonly cancelEmitted: boolean;
    readonly delayEmitted: number;
    readonly lastSeenAt: number;
  }[];
}

/**
 * The state of one realtime source, folded over its payloads in observation order. Every write it
 * asks for depends only on the payloads seen so far, so folding the same payloads in the same order
 * always yields the same rows (the processor rebuilds a source when a payload arrives late).
 */
export class SourceFold {
  readonly source: string;
  private timetable: Timetable;
  private readonly instances = new Map<string, InstanceState>();
  /** Instances that left memory, by id, with their service day. */
  private readonly evicted = new Map<string, string>();
  ignoredAfterEviction = 0;
  /** Write every stop row of an instance as it leaves memory (a staged rebuild needs its final rows). */
  rowsOnEviction = false;

  constructor(source: string, timetable: Timetable) {
    this.source = source;
    this.timetable = timetable;
  }

  /** The current row of every stop of the instances in memory, one at a time. */
  *stopRows(): Generator<StopEventRow> {
    for (const state of this.instances.values()) {
      for (let index = 0; index < state.stops.length; index += 1) {
        yield this.stopRow(state, index, state.stops[index] as StopState);
      }
    }
  }

  get activeInstances(): number {
    return this.instances.size;
  }

  get evictedInstances(): number {
    return this.evicted.size;
  }

  /** Service days of the instances in memory. */
  activeDays(): Set<string> {
    const days = new Set<string>();
    for (const state of this.instances.values()) days.add(state.run.serviceDate);
    return days;
  }

  /**
   * Replaces everything this fold knows about the instances of `days` with what `rebuilt` knows:
   * after a rebuild of those days, `rebuilt` folded every payload that touches them.
   */
  takeDays(days: ReadonlySet<string>, rebuilt: SourceFold): void {
    for (const [id, state] of [...this.instances]) {
      if (days.has(state.run.serviceDate)) this.instances.delete(id);
    }
    for (const [id, day] of [...this.evicted]) if (days.has(day)) this.evicted.delete(id);
    for (const [id, state] of rebuilt.instances) {
      if (days.has(state.run.serviceDate)) this.instances.set(id, state);
    }
    for (const [id, day] of rebuilt.evicted) if (days.has(day)) this.evicted.set(id, day);
  }

  /** Platforms are read from this version from now on (the newest loaded). */
  useTimetable(timetable: Timetable): void {
    this.timetable = timetable;
  }

  /** Plain data of the fold state, for a checkpoint. */
  snapshot(): FoldSnapshot {
    return { ...this.snapshotHead(), instances: [...this.instanceSnapshots()] };
  }

  snapshotHead(): Omit<FoldSnapshot, "instances"> {
    return {
      source: this.source,
      ignoredAfterEviction: this.ignoredAfterEviction,
      evicted: [...this.evicted],
    };
  }

  /** The instances of a snapshot one at a time, so a checkpoint can stream them. */
  *instanceSnapshots(): Generator<FoldSnapshot["instances"][number]> {
    for (const state of this.instances.values()) {
      yield {
        run: runRef(state.run),
        stops: state.stops.map((stop) => ({ ...stop })),
        legs: [...state.legs],
        lastScheduled: state.lastScheduled,
        cancelled: state.cancelled,
        cancelEmitted: state.cancelEmitted,
        delayEmitted: state.delayEmitted,
        lastSeenAt: state.lastSeenAt,
      };
    }
  }

  /**
   * A fold in the state of a snapshot; `resolve` finds each instance's run in the loaded versions.
   * Returns undefined when a run cannot be found, since the state would then be incomplete.
   */
  static restore(
    snapshot: FoldSnapshot,
    timetable: Timetable,
    resolve: (ref: RunRef) => TripRun | undefined,
  ): SourceFold | undefined {
    const fold = new SourceFold(snapshot.source, timetable);
    fold.ignoredAfterEviction = snapshot.ignoredAfterEviction;
    for (const [id, day] of snapshot.evicted) fold.evicted.set(id, day);
    for (const item of snapshot.instances) {
      const run = resolve(item.run);
      if (!run) return undefined;
      fold.instances.set(run.instanceId, {
        run,
        stops: item.stops.map((stop) => ({ ...stop })),
        legs: new Set(item.legs),
        lastScheduled: item.lastScheduled,
        cancelled: item.cancelled,
        cancelEmitted: item.cancelEmitted,
        delayEmitted: item.delayEmitted,
        lastSeenAt: item.lastSeenAt,
      });
    }
    return fold;
  }

  /** Forgets evicted instances of service days before `day`: no source names them any more. */
  pruneBefore(day: string): void {
    for (const [id, evictedDay] of [...this.evicted]) {
      if (evictedDay < day) this.evicted.delete(id);
    }
  }

  /**
   * Applies one matched trip update observed at `observedAt` (epoch ms) from payload `rawObjectId`.
   * An instance that already left memory is not started again, so its stored finals stay as they are.
   */
  apply(
    match: MatchedTrip,
    observation: TripObservation,
    observedAt: number,
    rawObjectId: string,
    batch: RowBatch,
  ): ApplyResult {
    if (this.evicted.has(match.run.instanceId)) {
      this.ignoredAfterEviction += 1;
      return { implausibleDelays: 0, reordered: 0 };
    }
    const state = this.stateOf(match.run, observedAt, rawObjectId);
    state.lastSeenAt = observedAt;
    const cancelledTrip = observation.relationship === "cancelled";
    const placements = placementsOn(state.run, match);
    const predictions: Prediction[] = cancelledTrip
      ? state.stops.map(() => ({
          arrDelay: null,
          depDelay: null,
          kind: null,
          cancelled: true,
          implausible: false,
        }))
      : predictStops(
          state.stops,
          placements,
          observation.delaySeconds,
          observation.source === IRIS_SOURCE,
        );
    const reordered = keepInOrder(state.stops, predictions);
    const actual = new Map(placements.map((placement) => [placement.index, placement]));
    predictions.forEach((prediction, index) => {
      const stop = state.stops[index];
      if (stop)
        this.update(
          state,
          index,
          stop,
          prediction,
          actual.get(index),
          observedAt,
          rawObjectId,
          batch,
        );
    });
    if (cancelledTrip && !state.cancelEmitted) {
      state.cancelEmitted = true;
      batch.events.push(this.event("TripCancelled", state, null, observedAt, rawObjectId, {}));
    }
    state.cancelled = cancelledTrip;
    this.emitDelay(state, observedAt, rawObjectId, batch);
    const tripImplausible =
      placements.length === 0 && plausible(observation.delaySeconds) !== observation.delaySeconds;
    const implausibleDelays =
      predictions.filter((prediction) => prediction.implausible).length + (tripImplausible ? 1 : 0);
    return { implausibleDelays, reordered };
  }

  /** Marks stops reached by `observedAt`, writes finished legs and the changed stop rows. */
  advance(observedAt: number, rawObjectId: string, batch: RowBatch): void {
    for (const [id, state] of this.instances) {
      this.finalize(state, observedAt, rawObjectId);
      this.writeLegs(state, observedAt, rawObjectId, batch);
      const leaving = this.finished(state, observedAt);
      for (let index = 0; index < state.stops.length; index += 1) {
        const stop = state.stops[index];
        if (stop?.dirty || (stop && leaving && this.rowsOnEviction)) {
          batch.stopEvents.push(this.stopRow(state, index, stop));
          stop.dirty = false;
        }
      }
      if (leaving) {
        this.instances.delete(id);
        this.evicted.set(id, state.run.serviceDate);
      }
    }
  }

  private stateOf(run: TripRun, observedAt: number, rawObjectId: string): InstanceState {
    const existing = this.instances.get(run.instanceId);
    if (existing) return existing;
    const trip = run.trip;
    const stops: StopState[] = trip.stopPlaces.map((placeId, index) => ({
      placeId,
      schedArr: toEpochS(run.serviceDate, trip.arrivals[index]),
      schedDep: toEpochS(run.serviceDate, trip.departures[index]),
      platformScheduled: this.platform(trip.stopPoints[index]),
      predArr: null,
      predDep: null,
      arrDelay: null,
      depDelay: null,
      kind: null,
      cancelled: false,
      platformActual: null,
      finalArr: null,
      finalDep: null,
      arrFinal: false,
      depFinal: false,
      quality: null,
      passedOver: false,
      observedAt,
      rawObjectId,
      dirty: true,
    }));
    const lastScheduled = Math.max(...stops.map((stop) => stop.schedArr ?? stop.schedDep ?? 0));
    const state: InstanceState = {
      run,
      stops,
      legs: new Set(),
      lastScheduled,
      cancelled: false,
      cancelEmitted: false,
      delayEmitted: 0,
      lastSeenAt: observedAt,
    };
    this.instances.set(run.instanceId, state);
    return state;
  }

  private platform(stopPointId: string | undefined): string | null {
    return stopPointId ? (this.timetable.data.stopPoints.get(stopPointId)?.platform ?? null) : null;
  }

  private update(
    state: InstanceState,
    index: number,
    stop: StopState,
    prediction: Prediction,
    placement: StopPlacement | undefined,
    observedAt: number,
    rawObjectId: string,
    batch: RowBatch,
  ): void {
    if (stop.passedOver || (stop.arrFinal && stop.depFinal)) return;
    const before = [stop.predArr, stop.predDep, stop.cancelled, stop.kind];
    const predArr = stop.arrFinal ? stop.predArr : plus(stop.schedArr, prediction.arrDelay);
    const predDep = stop.depFinal ? stop.predDep : plus(stop.schedDep, prediction.depDelay);
    const after = [predArr, predDep, prediction.cancelled, prediction.kind];
    const platformActual = this.actualPlatform(stop, placement);
    const platformChanged = platformActual !== stop.platformActual;
    if (sameTuple(before, after) && !platformChanged) return;
    if (!sameTuple(before, after)) {
      stop.predArr = predArr;
      stop.predDep = predDep;
      stop.arrDelay = stop.arrFinal ? stop.arrDelay : prediction.arrDelay;
      stop.depDelay = stop.depFinal ? stop.depDelay : prediction.depDelay;
      stop.kind = prediction.kind;
      stop.cancelled = prediction.cancelled;
      batch.forecasts.push({
        tripInstanceId: state.run.instanceId,
        stopIndex: index,
        sourceId: this.source,
        observedAt,
        serviceDate: state.run.serviceDate,
        predictedArrival: stop.predArr,
        predictedDeparture: stop.predDep,
        arrivalDelay: stop.arrDelay,
        departureDelay: stop.depDelay,
        cancelled: stop.cancelled,
        explicit: stop.kind === "explicit",
        rawObjectId,
      });
    }
    if (platformChanged) {
      stop.platformActual = platformActual;
      if (platformActual !== null) {
        batch.events.push(
          this.event("PlatformChanged", state, index, observedAt, rawObjectId, {
            scheduled: stop.platformScheduled,
            actual: platformActual,
          }),
        );
      }
    }
    stop.observedAt = observedAt;
    stop.rawObjectId = rawObjectId;
    stop.dirty = true;
  }

  /**
   * The platform a placed stop reports when it differs from the scheduled one. A source that names
   * platforms itself (IRIS) gives its changed track, compared with the DELFI track as
   * `normalizePlatform` reads it with the stop place's DHID; where the stop's district numbers its
   * stop points (VRS, OWL) and DELFI plans such a number, it is compared with the track the source
   * planned, and without one nothing is reported. A DELFI source names the stop point it serves,
   * compared by its raw code; where the stop's district numbers its stop points, a stop number on
   * either side is no change.
   */
  private actualPlatform(stop: StopState, placement: StopPlacement | undefined): string | null {
    const named = placement?.observed.platform;
    const dhid = this.timetable.data.stopPlaces.get(stop.placeId)?.dhid;
    if (named) {
      const plannedStopNumber = isDistrictStopNumber(stop.platformScheduled, dhid);
      const scheduled = plannedStopNumber
        ? named.scheduled
        : normalizePlatform(stop.platformScheduled, dhid);
      return changedTrack(named.actual, scheduled, plannedStopNumber);
    }
    const actualPoint = placement?.actualStopPointId ?? null;
    if (actualPoint === null) return stop.platformActual;
    const point = this.timetable.data.stopPoints.get(actualPoint);
    if (!point || point.stopPlaceId !== stop.placeId) return stop.platformActual;
    if (point.platform === stop.platformScheduled) return null;
    const stopNumber =
      isDistrictStopNumber(stop.platformScheduled, dhid) ||
      isDistrictStopNumber(point.platform, dhid);
    return stopNumber ? null : point.platform;
  }

  private currentDelay(state: InstanceState): number | null {
    let last: number | null = null;
    for (const stop of state.stops) {
      if (stop.cancelled) continue;
      const delay = stop.arrDelay ?? stop.depDelay;
      if (!stop.arrFinal && delay !== null) return delay;
      if (delay !== null) last = delay;
    }
    return last;
  }

  private emitDelay(
    state: InstanceState,
    observedAt: number,
    rawObjectId: string,
    batch: RowBatch,
  ) {
    const delay = this.currentDelay(state);
    if (delay === null || Math.abs(delay - state.delayEmitted) < DELAY_EVENT_STEP_S) return;
    batch.events.push(
      this.event("TripDelayChanged", state, null, observedAt, rawObjectId, {
        delaySeconds: delay,
        previousDelaySeconds: state.delayEmitted,
      }),
    );
    state.delayEmitted = delay;
  }

  private finalize(state: InstanceState, observedAt: number, rawObjectId: string): void {
    const now = observedAt / 1000;
    const quality = state.lastSeenAt === observedAt ? "live" : "carried";
    for (const stop of state.stops) {
      if (stop.cancelled) continue;
      let changed = false;
      if (!stop.arrFinal && stop.predArr !== null && stop.predArr <= now) {
        stop.arrFinal = true;
        stop.finalArr = stop.predArr;
        changed = true;
      }
      if (!stop.depFinal && stop.predDep !== null && stop.predDep <= now) {
        stop.depFinal = true;
        stop.finalDep = stop.predDep;
        changed = true;
      }
      if (changed) {
        stop.quality ??= quality;
        stop.observedAt = observedAt;
        stop.rawObjectId = rawObjectId;
        stop.dirty = true;
      }
    }
  }

  private writeLegs(
    state: InstanceState,
    observedAt: number,
    rawObjectId: string,
    batch: RowBatch,
  ) {
    const served = state.stops
      .map((stop, index) => ({ stop, index }))
      .filter(({ stop }) => !stop.cancelled && (stop.schedArr !== null || stop.schedDep !== null));
    for (let position = 0; position + 1 < served.length; position += 1) {
      const from = served[position];
      const to = served[position + 1];
      if (!from || !to || state.legs.has(from.index)) continue;
      const leg = this.leg(
        state,
        from.index,
        from.stop,
        to.index,
        to.stop,
        observedAt,
        rawObjectId,
      );
      if (!leg) continue;
      state.legs.add(from.index);
      for (let index = from.index + 1; index < to.index; index += 1) {
        const skipped = state.stops[index];
        if (skipped) skipped.passedOver = true;
      }
      batch.segments.push(leg);
    }
  }

  private leg(
    state: InstanceState,
    fromIndex: number,
    from: StopState,
    toIndex: number,
    to: StopState,
    observedAt: number,
    rawObjectId: string,
  ): SegmentRow | null {
    if (!from.depFinal || !to.arrFinal) return null;
    if (from.finalDep === null || from.schedDep === null) return null;
    if (to.finalArr === null || to.schedArr === null) return null;
    const depDelayFrom = from.finalDep - from.schedDep;
    const arrDelayTo = to.finalArr - to.schedArr;
    const dwellDelay =
      from.finalArr !== null && from.schedArr !== null
        ? from.finalDep - from.finalArr - (from.schedDep - from.schedArr)
        : null;
    return {
      serviceDate: state.run.serviceDate,
      tripInstanceId: state.run.instanceId,
      fromIndex,
      sourceId: this.source,
      toIndex,
      fromStopPlaceId: from.placeId,
      toStopPlaceId: to.placeId,
      depDelayFrom,
      arrDelayTo,
      runSched: to.schedArr - from.schedDep,
      runAct: to.finalArr - from.finalDep,
      dwellDelay,
      observedAt,
      rawObjectId,
    };
  }

  /** An instance leaves memory once its source has not named it for a while and its day is over. */
  private finished(state: InstanceState, observedAt: number): boolean {
    const quiet = observedAt - state.lastSeenAt > EVICT_AFTER_MS;
    return quiet && observedAt > state.lastScheduled * 1000 + EVICT_AFTER_MS;
  }

  private stopRow(state: InstanceState, index: number, stop: StopState): StopEventRow {
    return {
      serviceDate: state.run.serviceDate,
      tripInstanceId: state.run.instanceId,
      stopIndex: index,
      sourceId: this.source,
      stopPlaceId: stop.placeId,
      scheduledArrival: stop.schedArr,
      scheduledDeparture: stop.schedDep,
      predictedArrival: stop.predArr,
      predictedDeparture: stop.predDep,
      arrivalDelay: stop.arrDelay,
      departureDelay: stop.depDelay,
      predictionKind: stop.kind,
      finalArrival: stop.finalArr,
      finalDeparture: stop.finalDep,
      finalQuality: stop.finalArr === null && stop.finalDep === null ? null : stop.quality,
      platformScheduled: stop.platformScheduled,
      platformActual: stop.platformActual,
      cancelled: stop.cancelled,
      additional: false,
      observedAt: stop.observedAt,
      rawObjectId: stop.rawObjectId,
    };
  }

  private event(
    eventType: EventRow["eventType"],
    state: InstanceState,
    stopIndex: number | null,
    observedAt: number,
    rawObjectId: string,
    payload: EventRow["payload"],
  ): EventRow {
    const name = [eventType, state.run.instanceId, stopIndex ?? "", this.source, observedAt].join(
      "\x1f",
    );
    return {
      eventId: uuidv5(`event:${name}`),
      occurredAt: observedAt,
      eventType,
      sourceId: this.source,
      tripInstanceId: state.run.instanceId,
      stopIndex,
      payload: { serviceDate: state.run.serviceDate, ...payload },
      rawObjectId,
    };
  }
}
