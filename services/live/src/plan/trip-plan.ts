import {
  createTargetState,
  evaluatePlan,
  type MotionPlan,
  minimumLegDuration,
} from "@gerlines/geo";
import { dynamicsFor, motionPlanOf } from "@gerlines/geo/client-plan";
import type { TripRecord } from "@gerlines/live-frame";
import type { StaticRun } from "../model.ts";
import type { HeldForecast, SourceView } from "../realtime/store.ts";
import type { RunVehicle } from "../vehicle/identities.ts";
import { approachDistance, HOLD_THRESHOLD_S, holdAtApproach } from "./hold.ts";
import { placeRows, plannedTime, type RowKey, type SameStation } from "./place-rows.ts";

/** A plan stop in the engine: a station of the trip (stopIndex) or a hold point (stopIndex −1). */
export interface PlanStopState {
  readonly stopIndex: number;
  readonly s: number;
  readonly arrival: number;
  readonly departure: number;
  /** The train passes without stopping (cancelled stop or a pass-through in the timetable). */
  readonly cancelled: boolean;
  /** The chosen source predicted this stop explicitly (stop flag bit 3). */
  readonly realtime: boolean;
}

/** What the engine publishes for one trip instance (before it becomes a frame TripRecord). */
export interface LivePlan {
  readonly stops: readonly PlanStopState[];
  readonly realtime: boolean;
  readonly delay: number | null;
}

/** Re-emit only when a future time moves by this much (s), a flag changes or a stop is departed. */
export const REEMIT_SECONDS = 15;
/** A train stays in the frame this long (s) after its last arrival. */
export const END_GRACE_S = 30;
const MAX_DELAY = 32_767;

export type PlanOutcome =
  | { readonly kind: "plan"; readonly plan: LivePlan }
  | { readonly kind: "ended" }
  | { readonly kind: "cancelled" };

export type HoldKind = "hold" | "absorb" | "refit" | "kept";

export interface PlanStats {
  repairs: number;
  /** Source rows that fit no stop of the run in the alignment. */
  placeMismatches: number;
  /** Source rows placed on another stop index than their own, or on a stop of another place. */
  placesRealigned: number;
  /** Of those, rows naming a place the run lacks, placed on the stop of the same planned time. */
  placesRenamed: number;
  /** Pass times of cancelled stops capped so the stop list stays monotone. */
  cancelledCapped: number;
  holds: Record<HoldKind, number>;
}

export function createPlanStats(): PlanStats {
  return {
    repairs: 0,
    placeMismatches: 0,
    placesRealigned: 0,
    placesRenamed: 0,
    cancelledCapped: 0,
    holds: { hold: 0, absorb: 0, refit: 0, kept: 0 },
  };
}

export interface PlanContext {
  readonly run: StaticRun;
  readonly source: SourceView | undefined;
  readonly now: number;
  readonly published: LivePlan | null;
  /** The published plan as clients build it (cached by the caller), when published is set. */
  readonly publishedMotion: MotionPlan | null;
  readonly holdRule: boolean;
  readonly stats: PlanStats;
  /** Whether a place the run lacks is the same station as a stop of the run. */
  readonly sameStation?: SameStation | undefined;
}

interface Desired {
  arrival: Float64Array;
  departure: Float64Array;
  cancelled: Uint8Array;
  explicit: Uint8Array;
  row: (HeldForecast | undefined)[];
  sourceCancelled: number;
}

function rowKey(row: HeldForecast): RowKey {
  return {
    place: row.stopPlaceId,
    arrival: plannedTime(row.predictedArrival, row.arrivalDelay),
    departure: plannedTime(row.predictedDeparture, row.departureDelay),
  };
}

/** The source's row per stop of the run, aligned by stop place and planned time. */
function rowsOfRun(
  run: StaticRun,
  source: SourceView | undefined,
  stats: PlanStats,
  sameStation: SameStation | undefined,
): (HeldForecast | undefined)[] {
  if (!source) return new Array<HeldForecast | undefined>(run.stopPlaces.length);
  const placed = placeRows(
    { places: run.stopPlaces, arrivals: run.arrivals, departures: run.departures },
    source.stops,
    rowKey,
    sameStation,
  );
  stats.placeMismatches += placed.dropped;
  stats.placesRealigned += placed.realigned;
  stats.placesRenamed += placed.renamed;
  return placed.rows;
}

/**
 * Times per stop from the chosen source (predicted, else scheduled plus the last known delay so a
 * delay carries forward as GTFS-RT propagation does), cancellations and explicit predictions.
 */
function desiredTimes(context: PlanContext): Desired {
  const { run, source, stats, sameStation } = context;
  const n = run.arrivals.length;
  const out: Desired = {
    arrival: new Float64Array(n),
    departure: new Float64Array(n),
    cancelled: new Uint8Array(n),
    explicit: new Uint8Array(n),
    row: new Array(n),
    sourceCancelled: 0,
  };
  const rows = rowsOfRun(run, source, stats, sameStation);
  let carried = 0;
  for (let j = 0; j < n; j++) {
    const row = rows[j];
    out.row[j] = row;
    const delays = row ? rowDelays(run, row, j, carried) : { arrival: carried, departure: carried };
    carried = delays.departure;
    if (row?.explicit) out.explicit[j] = 1;
    if (row?.cancelled) {
      out.cancelled[j] = 1;
      out.sourceCancelled++;
    }
    if (run.passThrough[j]) out.cancelled[j] = 1;
    out.arrival[j] = Math.round((run.arrivals[j] as number) + delays.arrival);
    out.departure[j] = Math.round((run.departures[j] as number) + delays.departure);
  }
  return out;
}

/** A stop as the detail feed sees it: static stop index, expected arrival, served or not. */
export interface ExpectedStop {
  readonly stopIndex: number;
  readonly arrival: number;
  readonly departure: number;
  readonly cancelled: boolean;
}

/**
 * Expected times of a run the engine does not draw (no geometry, cancelled): the source's times as
 * a plan would take them, and the delay at the next served stop (null without a source).
 */
export function expectedTimes(
  run: StaticRun,
  source: SourceView | undefined,
  now: number,
  sameStation?: SameStation,
): { readonly stops: ExpectedStop[]; readonly delay: number | null } {
  const desired = desiredTimes({
    run,
    source,
    now,
    published: null,
    publishedMotion: null,
    holdRule: false,
    stats: createPlanStats(),
    sameStation,
  });
  const stops = Array.from(desired.arrival, (arrival, j) => ({
    stopIndex: j,
    arrival,
    departure: desired.departure[j] as number,
    cancelled: desired.cancelled[j] === 1,
  }));
  if (!source) return { stops, delay: null };
  const next = stops.find((stop) => !stop.cancelled && stop.arrival > now) ?? stops.at(-1);
  if (!next) return { stops, delay: null };
  const row = desired.row[next.stopIndex];
  const delay =
    row?.arrivalDelay ??
    row?.departureDelay ??
    next.arrival - (run.arrivals[next.stopIndex] as number);
  return { stops, delay: Math.max(-MAX_DELAY, Math.min(MAX_DELAY, Math.round(delay))) };
}

/** Arrival and departure delay of a row; a missing time takes the other one's, then the carry. */
function rowDelays(run: StaticRun, row: HeldForecast, j: number, carried: number) {
  const fromArrival =
    row.predictedArrival === null ? null : row.predictedArrival - (run.arrivals[j] as number);
  const fromDeparture =
    row.predictedDeparture === null ? null : row.predictedDeparture - (run.departures[j] as number);
  return {
    arrival: fromArrival ?? fromDeparture ?? carried,
    departure: fromDeparture ?? fromArrival ?? carried,
  };
}

/** The last served plan stop the train has left (the destination is never left), −1 for none. */
function lastDepartedIndex(published: LivePlan, now: number): number {
  const final = lastServedAt(published.stops);
  let last = -1;
  published.stops.forEach((stop, i) => {
    if (i < final && stop.departure <= now && !stop.cancelled) last = i;
  });
  return last;
}

function lastServedAt(stops: readonly PlanStopState[]): number {
  for (let i = stops.length - 1; i >= 0; i--) if (!(stops[i] as PlanStopState).cancelled) return i;
  return -1;
}

function firstServedFrom(desired: Desired, from: number): number {
  for (let j = from; j < desired.cancelled.length; j++) if (!desired.cancelled[j]) return j;
  return -1;
}

function lastServed(desired: Desired): number {
  for (let j = desired.cancelled.length - 1; j >= 0; j--) if (!desired.cancelled[j]) return j;
  return -1;
}

interface Draft {
  stopIndex: number;
  s: number;
  arrival: number;
  departure: number;
  cancelled: boolean;
  realtime: boolean;
}

function stationDraft(run: StaticRun, desired: Desired, j: number): Draft {
  return {
    stopIndex: j,
    s: run.shape?.stopArcs[j] as number,
    arrival: desired.arrival[j] as number,
    departure: desired.departure[j] as number,
    cancelled: desired.cancelled[j] === 1,
    realtime: desired.explicit[j] === 1,
  };
}

/**
 * Times already passed under the published plan stay; times not passed cannot move before now. A
 * stop the train has reached keeps the state it was drawn with (D-071): one passed without stopping
 * stays passed with its time when served again, one reached as served stays served when cancelled,
 * so the train never moves back. Returns the passed cancelled stops.
 */
function freezeAgainst(drafts: Draft[], published: LivePlan | null, now: number): Set<Draft> {
  const passed = new Set<Draft>();
  const byIndex = new Map<number, PlanStopState>();
  for (const stop of published?.stops ?? [])
    if (stop.stopIndex >= 0) byIndex.set(stop.stopIndex, stop);
  for (const draft of drafts) {
    const before = byIndex.get(draft.stopIndex);
    if (before && freezeStop(draft, before, now)) passed.add(draft);
  }
  return passed;
}

/** One stop against its published self; true when the train has passed it without stopping. */
function freezeStop(draft: Draft, before: PlanStopState, now: number): boolean {
  const reached = before.arrival <= now;
  if (reached) draft.cancelled = before.cancelled;
  draft.arrival = reached ? before.arrival : Math.max(draft.arrival, now);
  draft.departure = before.departure <= now ? before.departure : Math.max(draft.departure, now);
  return reached && before.cancelled;
}

/** arr_j ≥ dep_{j−1} + 1 s and dep_j ≥ arr_j over the served stops; returns the repairs made. */
function repairMonotone(drafts: Draft[]): number {
  let repairs = 0;
  let previous: Draft | undefined;
  for (const draft of drafts) {
    if (draft.cancelled) continue;
    if (previous && draft.arrival < previous.departure + 1) {
      draft.arrival = previous.departure + 1;
      repairs++;
    }
    if (draft.departure < draft.arrival) {
      draft.departure = draft.arrival;
      repairs++;
    }
    previous = draft;
  }
  return repairs;
}

/**
 * Stops passed without stopping after a served stop get a pass time interpolated by arc length
 * between served stops, never before the previous stop's time nor after the next served arrival
 * (stop arcs may fall); one the train has already passed keeps its time within those bounds.
 * Returns how many were capped.
 */
function interpolatePassTimes(drafts: Draft[], passed: ReadonlySet<Draft>): number {
  let capped = 0;
  let before: Draft | undefined;
  let floor = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i] as Draft;
    if (!draft.cancelled) {
      before = draft;
      floor = draft.departure;
      continue;
    }
    if (!before) continue;
    const after = drafts.slice(i + 1).find((candidate) => !candidate.cancelled);
    if (!after) {
      draft.arrival = before.departure;
      draft.departure = before.departure;
      continue;
    }
    const span = after.s - before.s;
    const share = span > 0 ? Math.min(1, Math.max(0, (draft.s - before.s) / span)) : 0;
    const wanted = passed.has(draft)
      ? draft.arrival
      : Math.round(before.departure + share * (after.arrival - before.departure));
    const time = Math.min(after.arrival, Math.max(floor, wanted));
    if (time !== wanted) capped++;
    draft.arrival = time;
    draft.departure = time;
    floor = time;
  }
  return capped;
}

/**
 * Cancelled stops ahead of the first served stop keep their times only as far as the stop list
 * stays monotone, so a cancelled origin's schedule never runs past the first live stop;
 * returns how many were capped.
 */
function followFirstServed(drafts: Draft[]): number {
  const first = drafts.findIndex((draft) => !draft.cancelled);
  if (first <= 0) return 0;
  let capped = 0;
  let limit = (drafts[first] as Draft).arrival;
  for (let i = first - 1; i >= 0; i--) {
    const draft = drafts[i] as Draft;
    const departure = Math.min(draft.departure, limit);
    const arrival = Math.min(draft.arrival, departure);
    if (departure !== draft.departure || arrival !== draft.arrival) capped++;
    draft.departure = departure;
    draft.arrival = arrival;
    limit = arrival;
  }
  return capped;
}

function nominalRun(length: number, run: StaticRun): number {
  const dynamics = dynamicsFor(run.category);
  return minimumLegDuration(
    length,
    dynamics,
    undefined,
    Math.max(dynamics.acceleration, dynamics.deceleration),
  );
}

/**
 * The leg the train is in under the published plan, rebuilt with the hold rule (D-038 item 4).
 * Returns the drafts that replace the published leg's stops up to and including the next station,
 * or undefined when the train is not moving between stations.
 */
function currentLeg(
  context: PlanContext,
  published: LivePlan,
  fromAt: number,
  next: Draft,
): Draft[] | undefined {
  const { now, run, stats } = context;
  const from = published.stops[fromAt] as PlanStopState;
  const nextAt = published.stops.findIndex(
    (stop, i) => i > fromAt && stop.stopIndex === next.stopIndex,
  );
  if (nextAt < 0) return undefined;
  const publishedNext = published.stops[nextAt] as PlanStopState;
  if (!(from.departure <= now && now < publishedNext.arrival)) return undefined;
  const between = published.stops.slice(fromAt + 1, nextAt).filter((stop) => stop.stopIndex < 0);
  const hold = between[0];
  const newArrival = next.arrival;
  const delta = newArrival - publishedNext.arrival;
  const keep = (): Draft[] => {
    stats.holds.kept++;
    return [
      ...between.map((stop) => ({ ...stop })),
      {
        ...next,
        arrival: publishedNext.arrival,
        departure: Math.max(next.departure, publishedNext.arrival),
      },
    ];
  };
  if (Math.abs(delta) < REEMIT_SECONDS) return keep();
  if (hold && hold.arrival <= now && now < hold.departure) {
    const run2 = nominalRun(next.s - hold.s, run);
    const departure = Math.max(now, Math.floor(newArrival - run2));
    stats.holds.hold++;
    return [
      { ...hold, departure },
      { ...next, arrival: Math.max(newArrival, departure + Math.ceil(run2)) },
    ];
  }
  if (!context.holdRule || delta <= HOLD_THRESHOLD_S || !context.publishedMotion) {
    stats.holds.refit++;
    return [{ ...next }];
  }
  const decision = holdAtApproach({
    plan: context.publishedMotion,
    dynamics: dynamicsFor(run.category),
    approach: approachDistance(run.category),
    now,
    fromS: from.s,
    fromDeparture: from.departure,
    nextS: next.s,
    newArrival,
  });
  stats.holds[decision.kind]++;
  if (decision.kind === "absorb") {
    return [
      ...between.map((stop) => ({ ...stop })),
      {
        ...next,
        arrival: publishedNext.arrival,
        departure: Math.max(next.departure, publishedNext.arrival),
      },
    ];
  }
  if (decision.kind === "hold") {
    return [
      {
        stopIndex: -1,
        s: decision.s,
        arrival: decision.arrival,
        departure: decision.departure,
        cancelled: false,
        realtime: false,
      },
      { ...next },
    ];
  }
  return [{ ...next }];
}

function delayAt(run: StaticRun, desired: Desired, drafts: readonly Draft[], now: number) {
  const next = drafts.find(
    (draft) => draft.stopIndex >= 0 && !draft.cancelled && draft.arrival > now,
  );
  if (!next) return null;
  const row = desired.row[next.stopIndex];
  const delay =
    row?.arrivalDelay ??
    row?.departureDelay ??
    next.arrival - (run.arrivals[next.stopIndex] as number);
  return Math.max(-MAX_DELAY, Math.min(MAX_DELAY, Math.round(delay)));
}

/**
 * The plan of a running trip instance at `now` (design note §2): the chosen source's times (frozen
 * once passed, repaired to be monotone), stops from the last one departed to the destination,
 * pass-through and cancelled stops kept with an interpolated time (those ahead of the first served
 * stop with their own times, capped at the next stop's), the hold rule for a delay that
 * arrives mid-leg. Ended after the last served arrival plus END_GRACE_S; cancelled when the source
 * cancels every stop or fewer than two stops are served.
 */
export function buildPlan(context: PlanContext): PlanOutcome {
  const { run, now, published, stats } = context;
  if (!run.shape) return { kind: "ended" };
  const desired = desiredTimes(context);
  const last = lastServed(desired);
  const first = firstServedFrom(desired, 0);
  if (desired.sourceCancelled === desired.cancelled.length || last < 0 || first === last) {
    return { kind: "cancelled" };
  }
  const { drafts, passed } = published
    ? draftsAgainst(context, desired, published, first)
    : { drafts: freshDrafts(run, desired, first, last, now), passed: new Set<Draft>() };
  const ordered = placeHoldPoints(drafts);
  stats.repairs += repairMonotone(ordered);
  stats.cancelledCapped += interpolatePassTimes(ordered, passed);
  stats.cancelledCapped += followFirstServed(ordered);
  const served = ordered.filter((draft) => !draft.cancelled);
  const final = served.at(-1);
  if (!final || served.length < 2 || now >= final.arrival + END_GRACE_S) return { kind: "ended" };
  const future = ordered.filter((draft) => draft.stopIndex >= 0 && draft.departure > now);
  const realtime = future.some((draft) => desired.row[draft.stopIndex] !== undefined);
  return {
    kind: "plan",
    plan: {
      stops: ordered,
      realtime,
      delay: realtime ? delayAt(run, desired, ordered, now) : null,
    },
  };
}

/**
 * Stations stay in stop order; each hold point (stop index −1) goes after the stations whose arc
 * lies before it (ties keep their place), so stop arcs that fall can never reorder stations.
 */
export function placeHoldPoints<T extends { readonly stopIndex: number; readonly s: number }>(
  drafts: readonly T[],
): T[] {
  const stations: T[] = [];
  const holds: { draft: T; after: number; order: number }[] = [];
  for (const draft of drafts) {
    if (draft.stopIndex >= 0) stations.push(draft);
    else holds.push({ draft, after: stations.length, order: holds.length });
  }
  if (holds.length === 0) return stations;
  const placed = holds
    .map((hold) => ({
      ...hold,
      slot: stations.filter(
        (station, i) => station.s < hold.draft.s || (station.s === hold.draft.s && i < hold.after),
      ).length,
    }))
    .sort((a, b) => a.slot - b.slot || a.draft.s - b.draft.s || a.order - b.order);
  const out: T[] = [];
  let h = 0;
  for (let i = 0; i <= stations.length; i++) {
    while (h < placed.length && (placed[h] as { slot: number }).slot === i) {
      out.push((placed[h] as { draft: T }).draft);
      h++;
    }
    if (i < stations.length) out.push(stations[i] as T);
  }
  return out;
}

/** A trip seen for the first time: from the last stop it left by its times, or its origin. */
function freshDrafts(
  run: StaticRun,
  desired: Desired,
  first: number,
  last: number,
  now: number,
): Draft[] {
  let from = first;
  for (let j = first; j <= last; j++) {
    if (!desired.cancelled[j] && (desired.departure[j] as number) <= now) from = j;
  }
  const drafts: Draft[] = [];
  for (let j = from; j < run.arrivals.length; j++) drafts.push(stationDraft(run, desired, j));
  return drafts;
}

/** A trip already published: departed stops stay as published, the current leg by the hold rule. */
function draftsAgainst(
  context: PlanContext,
  desired: Desired,
  published: LivePlan,
  first: number,
): { drafts: Draft[]; passed: Set<Draft> } {
  const { run, now } = context;
  const fromAt = lastDepartedIndex(published, now);
  if (fromAt < 0) {
    const origin = published.stops.find((stop) => stop.stopIndex >= 0)?.stopIndex ?? first;
    const drafts: Draft[] = [];
    for (let j = origin; j < run.arrivals.length; j++) drafts.push(stationDraft(run, desired, j));
    return { drafts, passed: freezeAgainst(drafts, published, now) };
  }
  const from = published.stops[fromAt] as PlanStopState;
  const nextStation = published.stops.find((stop, i) => i > fromAt && stop.stopIndex >= 0);
  const startIndex = nextStation ? nextStation.stopIndex : run.arrivals.length;
  const rest: Draft[] = [];
  for (let j = startIndex; j < run.arrivals.length; j++) rest.push(stationDraft(run, desired, j));
  const passed = freezeAgainst(rest, published, now);
  const next = rest.find((draft) => !draft.cancelled);
  const leg = next ? currentLeg(context, published, fromAt, next) : undefined;
  if (leg && next) {
    const at = rest.indexOf(next);
    return { drafts: [{ ...from }, ...rest.slice(0, at), ...leg, ...rest.slice(at + 1)], passed };
  }
  const holdsAhead = published.stops
    .slice(fromAt + 1)
    .filter((stop) => stop.stopIndex < 0 && stop.departure > now);
  return { drafts: [{ ...from }, ...holdsAhead.map((stop) => ({ ...stop })), ...rest], passed };
}

/** True when a new plan must be emitted rather than the published one kept (design note §2). */
export function mustEmit(published: LivePlan | null, next: LivePlan): boolean {
  if (!published) return true;
  if (published.realtime !== next.realtime) return true;
  if (delayMoved(published.delay, next.delay)) return true;
  if (published.stops.length !== next.stops.length) return true;
  return next.stops.some((stop, i) => stopMoved(published.stops[i] as PlanStopState, stop));
}

function delayMoved(before: number | null, after: number | null): boolean {
  if (before === null || after === null) return before !== after;
  return Math.abs(before - after) >= REEMIT_SECONDS;
}

function stopMoved(a: PlanStopState, b: PlanStopState): boolean {
  return (
    a.stopIndex !== b.stopIndex ||
    a.cancelled !== b.cancelled ||
    a.realtime !== b.realtime ||
    a.s !== b.s ||
    Math.abs(a.arrival - b.arrival) >= REEMIT_SECONDS ||
    Math.abs(a.departure - b.departure) >= REEMIT_SECONDS
  );
}

/** The plan as the client builds its motion from it. */
export function motionOfPlan(plan: LivePlan, run: StaticRun): MotionPlan | null {
  return motionPlanOf(plan.stops, run.category, run.shape?.length ?? 0);
}

/**
 * The frame trip of a plan; explicit arc positions when it holds a hold point (flag bit 3), and the
 * trip's vehicle (FORMAT 1.3) when the engine resolves vehicles.
 */
export function tripRecordOf(
  key: number,
  run: StaticRun,
  plan: LivePlan,
  vehicle?: RunVehicle,
): TripRecord {
  const explicit = plan.stops.some((stop) => stop.stopIndex < 0);
  const firstStation = plan.stops.find((stop) => stop.stopIndex >= 0);
  return {
    key,
    shapeId: run.shape?.shapeNo ?? 0,
    category: run.category,
    realtime: plan.realtime,
    cancelled: false,
    foreign: run.foreign,
    delay: plan.delay,
    line: run.line,
    trainNumber: run.trainNumber,
    firstStop: explicit ? (firstStation?.stopIndex ?? 0) : (plan.stops[0]?.stopIndex ?? 0),
    stops: plan.stops.map((stop) => ({
      arrival: stop.arrival,
      departure: stop.departure,
      cancelled: stop.cancelled,
      realtime: stop.realtime,
      s: explicit ? stop.s : null,
    })),
    ...(vehicle
      ? { series: vehicle.series, operator: vehicle.operator, units: vehicle.units }
      : {}),
  };
}

/** The next instant (Unix s) at which time alone changes the plan: a departure or the end. */
export function nextWake(plan: LivePlan, now: number): number {
  let wake = Number.POSITIVE_INFINITY;
  const finalAt = lastServedAt(plan.stops);
  plan.stops.forEach((stop, i) => {
    if (i < finalAt && !stop.cancelled && stop.departure > now)
      wake = Math.min(wake, stop.departure);
  });
  const final = plan.stops[finalAt];
  if (final) wake = Math.min(wake, Math.max(now + 1, final.arrival + END_GRACE_S));
  return wake;
}

/** Target arc length of a published plan at t, for tests and diagnostics. */
export function targetOf(motion: MotionPlan, t: number): number {
  const target = createTargetState();
  evaluatePlan(motion, t, target);
  return target.s;
}
