import type {
  AdapterResult,
  SourceMessage,
  StopRelationship,
  StopTimeObservation,
  TimeObservation,
  TripObservation,
  TripRelationship,
} from "@gerlines/schema";
import { normalizePlatform } from "@gerlines/schema/platform";
import { addDays } from "@gerlines/schema/service-day";
import { isCalendarDate } from "../db-apis/berlin-time.ts";
import {
  type IrisEvent,
  type IrisEventStatus,
  type IrisMessage,
  type IrisStop,
  type IrisTripLabel,
  parseIrisTimetable,
} from "../db-apis/iris.ts";
import { IRIS_LONG_DISTANCE_COVER, type IrisStation } from "../db-apis/stations.ts";

/** The logical source every DB Timetables (IRIS) recording folds under. */
export const IRIS_SOURCE = "db-iris";

export type IrisEndpoint = "plan" | "fchg" | "rchg";

const RECORDED_ID = /^db-iris-(plan|fchg|rchg)-(\d{7})$/;

/** The endpoint and station of a recorded IRIS source id (`db-iris-fchg-8000105`), else null. */
export function irisRecording(source: string): { endpoint: IrisEndpoint; eva: number } | null {
  const match = RECORDED_ID.exec(source);
  if (!match) return null;
  return { endpoint: match[1] as IrisEndpoint, eva: Number(match[2]) };
}

/** The recorded source ids of the recorder's IRIS lane: full changes and plan of every cover EVA. */
export function irisRecordedSources(
  stations: readonly IrisStation[] = IRIS_LONG_DISTANCE_COVER,
): string[] {
  return (["fchg", "plan"] as const).flatMap((endpoint) =>
    stations.map((station) => `db-iris-${endpoint}-${station.eva}`),
  );
}

/**
 * Meta EVAs to the EVA of the station they belong to: in the cover each meta EVA follows its main
 * station (Bahn-Vorhersage `meta_evas`). DELFI files those platforms under the main station's EVA.
 */
export function irisEvaAliases(
  stations: readonly IrisStation[] = IRIS_LONG_DISTANCE_COVER,
): Map<number, number> {
  const aliases = new Map<number, number>();
  let main: number | null = null;
  for (const station of stations) {
    if (station.role !== "meta") main = station.eva;
    else if (main !== null) aliases.set(station.eva, main);
  }
  return aliases;
}

export const IRIS_EVA_ALIASES: ReadonlyMap<number, number> = irisEvaAliases();

/** One trip of the planned book in a checkpoint: label and, per stop id, EVA and planned events. */
export interface IrisPlanTrip {
  readonly tripId: string;
  readonly label: IrisTripLabel | null;
  readonly labelSeenAt: number | null;
  readonly stops: readonly (readonly [
    string,
    number,
    PlannedEvent | null,
    PlannedEvent | null,
    number,
  ])[];
}

/** One trip of a changes book in a checkpoint: its first answer and, per stop id, its changes. */
export interface IrisChangeTrip {
  readonly tripId: string;
  readonly firstAt: number | null;
  readonly stops: readonly (readonly [
    string,
    number,
    ChangedEvent | null,
    ChangedEvent | null,
    readonly SourceMessage[],
  ])[];
}

/** What an IRIS stop id says: `<daily trip id>-<YYMMDDHHmm of the first departure>-<stop index>`. */
export interface IrisStopKey {
  readonly tripId: string;
  readonly startDate: string;
  readonly startTime: string;
  readonly index: number;
}

const STOP_ID = /^(-?\d{1,20})-((\d{2})(\d{2})(\d{2})(\d{2})(\d{2}))-(\d{1,4})$/;

export function parseIrisStopId(id: string): IrisStopKey | null {
  const match = STOP_ID.exec(id);
  if (!match) return null;
  const [, daily, stamp, yy, mm, dd, hh, mi, index] = match;
  if (!isCalendarDate(Number(yy), Number(mm), Number(dd)) || Number(hh) > 23 || Number(mi) > 59) {
    return null;
  }
  return {
    tripId: `${daily}-${stamp}`,
    startDate: `20${yy}-${mm}-${dd}`,
    startTime: `${hh}:${mi}:00`,
    index: Number(index),
  };
}

/** The start date of an IRIS trip id (`<daily id>-<YYMMDDHHmm>`), null when it does not read as one. */
export function irisTripStartDate(tripId: string): string | null {
  return parseIrisStopId(`${tripId}-0`)?.startDate ?? null;
}

const epochSeconds = (iso: string | null): number | null =>
  iso === null ? null : Math.round(Date.parse(iso) / 1000);

interface PlannedEvent {
  readonly time: number | null;
  readonly platform: string | null;
  readonly status: IrisEventStatus | null;
}

interface PlannedStop {
  readonly key: IrisStopKey;
  readonly eva: number;
  readonly arrival: PlannedEvent | null;
  readonly departure: PlannedEvent | null;
  /** The first answer that planned it (epoch ms): an observation built earlier does not see it. */
  readonly seenAt: number;
}

interface ChangedEvent {
  readonly time: number | null;
  readonly platform: string | null;
  readonly status: IrisEventStatus | null;
  readonly cancelledAt: number | null;
}

interface ChangedStop {
  readonly key: IrisStopKey;
  readonly eva: number;
  readonly arrival: ChangedEvent | null;
  readonly departure: ChangedEvent | null;
  readonly messages: readonly SourceMessage[];
}

/** A display name such as `ICE 619` read as category and number; line names such as `RE30` are not. */
function displayLabel(stop: IrisStop): IrisTripLabel | null {
  const name = stop.departure?.displayName ?? stop.arrival?.displayName ?? null;
  const match = name ? /^([A-Za-z]{1,5}) (\d{1,6})$/.exec(name) : null;
  if (!match) return null;
  return {
    category: match[1] ?? null,
    number: match[2] ?? null,
    owner: null,
    filter: null,
    tripType: null,
  };
}

function plannedEvent(event: IrisEvent | null): PlannedEvent | null {
  if (!event) return null;
  return {
    time: epochSeconds(event.plannedTime),
    platform: event.plannedPlatform,
    status: event.plannedStatus,
  };
}

function hasPlan(event: PlannedEvent | null): boolean {
  return (
    event !== null && (event.time !== null || event.platform !== null || event.status !== null)
  );
}

/** Planned fields of a newer answer win where it names them; the older ones stay where it does not. */
function mergePlanned(older: PlannedEvent | null, newer: PlannedEvent | null): PlannedEvent | null {
  if (!hasPlan(newer)) return older;
  if (!older) return newer;
  return {
    time: newer?.time ?? older.time,
    platform: newer?.platform ?? older.platform,
    status: newer?.status ?? older.status,
  };
}

function changedEvent(event: IrisEvent | null): ChangedEvent | null {
  if (!event) return null;
  const changed: ChangedEvent = {
    time: epochSeconds(event.changedTime),
    platform: event.changedPlatform,
    status: event.changedStatus ?? (event.plannedStatus === "added" ? "added" : null),
    cancelledAt: epochSeconds(event.cancellationTime),
  };
  const any =
    changed.time !== null ||
    changed.platform !== null ||
    changed.status !== null ||
    changed.cancelledAt !== null;
  return any ? changed : null;
}

function sourceMessage(message: IrisMessage): SourceMessage {
  return {
    id: message.id,
    kind: message.type,
    code: message.code,
    category: message.category,
    priority: message.priority,
    timestamp: epochSeconds(message.timestamp),
    validFrom: epochSeconds(message.validFrom),
    validTo: epochSeconds(message.validTo),
  };
}

/** Messages of a stop and its events, each id once, deleted ones left out. */
function stopMessages(stop: IrisStop): SourceMessage[] {
  const byId = new Map<string, SourceMessage>();
  for (const message of [
    ...stop.messages,
    ...(stop.arrival?.messages ?? []),
    ...(stop.departure?.messages ?? []),
  ]) {
    if (!message.deleted && !byId.has(message.id)) byId.set(message.id, sourceMessage(message));
  }
  return [...byId.values()];
}

/** Stop ids of each IRIS trip, for both books. */
class TripIndex {
  private readonly byTrip = new Map<string, Set<string>>();

  add(key: IrisStopKey, stopId: string): void {
    const ids = this.byTrip.get(key.tripId) ?? new Set<string>();
    ids.add(stopId);
    this.byTrip.set(key.tripId, ids);
  }

  idsOf(tripId: string): ReadonlySet<string> {
    return this.byTrip.get(tripId) ?? new Set();
  }

  remove(tripId: string): void {
    this.byTrip.delete(tripId);
  }

  trips(): IterableIterator<string> {
    return this.byTrip.keys();
  }
}

/**
 * The planned side of every IRIS stop seen so far: train label, planned times, platforms and statuses,
 * from plan answers and from the planned attributes change answers repeat. Planned facts do not depend
 * on the order answers arrive in, and each is known from the first answer that named it on, so one
 * book serves every rebuild of the source and a rebuild sees what an in-order run saw.
 */
export class IrisPlans {
  private readonly stops = new Map<string, PlannedStop>();
  private readonly labels = new Map<string, { label: IrisTripLabel; seenAt: number }>();
  private readonly trips = new TripIndex();

  /** Takes the planned side of one answer observed at `observedAt` (epoch ms); returns the trips it named. */
  add(stops: readonly IrisStop[], observedAt: number): Set<string> {
    const touched = new Set<string>();
    for (const stop of stops) {
      const key = parseIrisStopId(stop.id);
      if (!key || stop.eva === null) continue;
      touched.add(key.tripId);
      this.addLabel(key.tripId, stop, observedAt);
      const arrival = plannedEvent(stop.arrival);
      const departure = plannedEvent(stop.departure);
      const older = this.stops.get(stop.id);
      if (!hasPlan(arrival) && !hasPlan(departure)) continue;
      this.stops.set(stop.id, {
        key,
        eva: stop.eva,
        arrival: mergePlanned(older?.arrival ?? null, arrival),
        departure: mergePlanned(older?.departure ?? null, departure),
        seenAt: Math.min(older?.seenAt ?? observedAt, observedAt),
      });
      this.trips.add(key, stop.id);
    }
    return touched;
  }

  /** A trip's label from its stop: a `tl` label wins over a display name, the first seen stays its time. */
  private addLabel(tripId: string, stop: IrisStop, observedAt: number): void {
    const label = stop.tripLabel ?? displayLabel(stop);
    const known = this.labels.get(tripId);
    if (!label || (!stop.tripLabel && known)) return;
    this.labels.set(tripId, { label, seenAt: Math.min(known?.seenAt ?? observedAt, observedAt) });
  }

  /** A stop's plan as known at `at` (epoch ms): plans first seen later are not known yet. */
  get(stopId: string, at = Number.POSITIVE_INFINITY): PlannedStop | undefined {
    const stop = this.stops.get(stopId);
    return stop && stop.seenAt <= at ? stop : undefined;
  }

  labelOf(tripId: string, at = Number.POSITIVE_INFINITY): IrisTripLabel | null {
    const known = this.labels.get(tripId);
    return known && known.seenAt <= at ? known.label : null;
  }

  idsOf(tripId: string): ReadonlySet<string> {
    return this.trips.idsOf(tripId);
  }

  get size(): number {
    return this.stops.size;
  }

  /** Every trip of the book as plain data, for a checkpoint. */
  *snapshot(): Generator<IrisPlanTrip> {
    for (const tripId of this.trips.trips()) {
      const stops: IrisPlanTrip["stops"][number][] = [];
      for (const id of this.trips.idsOf(tripId)) {
        const stop = this.stops.get(id);
        if (stop) stops.push([id, stop.eva, stop.arrival, stop.departure, stop.seenAt]);
      }
      const known = this.labels.get(tripId);
      yield { tripId, label: known?.label ?? null, labelSeenAt: known?.seenAt ?? null, stops };
    }
  }

  /** Takes back one trip of a checkpoint; stop ids that do not parse are left out. */
  restoreTrip(trip: IrisPlanTrip): void {
    if (trip.label) {
      this.labels.set(trip.tripId, { label: trip.label, seenAt: trip.labelSeenAt ?? 0 });
    }
    for (const [id, eva, arrival, departure, seenAt] of trip.stops) {
      const key = parseIrisStopId(id);
      if (!key) continue;
      this.stops.set(id, { key, eva, arrival, departure, seenAt });
      this.trips.add(key, id);
    }
  }

  /** Forgets trips that started before `day`. */
  dropBefore(day: string): void {
    for (const tripId of [...this.trips.trips()]) {
      const first = this.trips.idsOf(tripId).values().next().value;
      const key = first === undefined ? undefined : this.stops.get(first)?.key;
      if (!key || key.startDate >= day) continue;
      for (const id of this.trips.idsOf(tripId)) this.stops.delete(id);
      this.trips.remove(tripId);
      this.labels.delete(tripId);
    }
  }
}

/**
 * The changed side of IRIS stops, folded in observation order: each change answer replaces what it
 * names, stop by stop; a stop it leaves out keeps its last known change. Belongs to one fold of the
 * source, so a rebuild starts it again from the payloads it folds.
 */
export class IrisChanges {
  private readonly stops = new Map<string, ChangedStop>();
  private readonly trips = new TripIndex();
  /** When an answer first named each trip with a change (epoch ms): where a rebuild must start. */
  private readonly firstAt = new Map<string, number>();

  /** Takes the changed side of one answer observed at `observedAt` (epoch ms); returns the trips it touched. */
  add(stops: readonly IrisStop[], observedAt: number): Set<string> {
    const touched = new Set<string>();
    for (const stop of stops) {
      const key = parseIrisStopId(stop.id);
      if (!key || stop.eva === null) continue;
      const arrival = changedEvent(stop.arrival);
      const departure = changedEvent(stop.departure);
      const messages = stopMessages(stop);
      if (!arrival && !departure && messages.length === 0 && !this.stops.has(stop.id)) continue;
      touched.add(key.tripId);
      this.stops.set(stop.id, { key, eva: stop.eva, arrival, departure, messages });
      this.trips.add(key, stop.id);
      const first = this.firstAt.get(key.tripId);
      if (first === undefined || observedAt < first) this.firstAt.set(key.tripId, observedAt);
    }
    return touched;
  }

  /**
   * The first answer that named a change of a trip starting on one of `days` or the day after (a
   * run's service day can be the day before its first departure); infinity when none did.
   */
  firstAnswerFor(days: ReadonlySet<string>): number {
    let first = Number.POSITIVE_INFINITY;
    for (const [tripId, at] of this.firstAt) {
      if (this.onDays(tripId, days)) first = Math.min(first, at);
    }
    return first;
  }

  /**
   * Takes the trips of `days` (as `firstAnswerFor` reads them) from the book of a rebuild, which
   * folded every answer about them in order, in place of this book's own.
   */
  takeDays(days: ReadonlySet<string>, rebuilt: IrisChanges): void {
    for (const tripId of [...this.trips.trips()]) {
      if (this.onDays(tripId, days)) this.removeTrip(tripId);
    }
    for (const tripId of rebuilt.trips.trips()) {
      if (!rebuilt.onDays(tripId, days)) continue;
      for (const id of rebuilt.trips.idsOf(tripId)) {
        const stop = rebuilt.stops.get(id);
        if (!stop) continue;
        this.stops.set(id, stop);
        this.trips.add(stop.key, id);
      }
      const first = rebuilt.firstAt.get(tripId);
      if (first !== undefined) this.firstAt.set(tripId, first);
    }
  }

  private onDays(tripId: string, days: ReadonlySet<string>): boolean {
    const start = this.startDateOf(tripId);
    return start !== null && (days.has(start) || days.has(addDays(start, -1)));
  }

  private removeTrip(tripId: string): void {
    for (const id of this.trips.idsOf(tripId)) this.stops.delete(id);
    this.trips.remove(tripId);
    this.firstAt.delete(tripId);
  }

  /** The first answer that named any trip still in the book; infinity for an empty book. */
  firstAnswer(): number {
    let first = Number.POSITIVE_INFINITY;
    for (const at of this.firstAt.values()) first = Math.min(first, at);
    return first;
  }

  private startDateOf(tripId: string): string | null {
    const id = this.trips.idsOf(tripId).values().next().value;
    return id === undefined ? null : (this.stops.get(id)?.key.startDate ?? null);
  }

  /** Every trip of the book as plain data, for a checkpoint. */
  *snapshot(): Generator<IrisChangeTrip> {
    for (const tripId of this.trips.trips()) {
      const stops: IrisChangeTrip["stops"][number][] = [];
      for (const id of this.trips.idsOf(tripId)) {
        const stop = this.stops.get(id);
        if (stop) stops.push([id, stop.eva, stop.arrival, stop.departure, stop.messages]);
      }
      yield { tripId, firstAt: this.firstAt.get(tripId) ?? null, stops };
    }
  }

  /** Takes back one trip of a checkpoint; stop ids that do not parse are left out. */
  restoreTrip(trip: IrisChangeTrip): void {
    for (const [id, eva, arrival, departure, messages] of trip.stops) {
      const key = parseIrisStopId(id);
      if (!key) continue;
      this.stops.set(id, { key, eva, arrival, departure, messages });
      this.trips.add(key, id);
    }
    if (trip.firstAt !== null) this.firstAt.set(trip.tripId, trip.firstAt);
  }

  get(stopId: string): ChangedStop | undefined {
    return this.stops.get(stopId);
  }

  idsOf(tripId: string): ReadonlySet<string> {
    return this.trips.idsOf(tripId);
  }

  /** Forgets trips that started before `day`. */
  dropBefore(day: string): void {
    for (const tripId of [...this.trips.trips()]) {
      const ids = [...this.trips.idsOf(tripId)];
      const key = ids[0] === undefined ? undefined : this.stops.get(ids[0])?.key;
      if (!key || key.startDate >= day) continue;
      this.removeTrip(tripId);
    }
  }
}

function timeObservation(
  changed: ChangedEvent | null,
  planned: PlannedEvent | null,
): TimeObservation | null {
  if (changed?.time == null) return null;
  const scheduled = planned?.time ?? null;
  return {
    time: changed.time,
    delaySeconds: scheduled === null ? null : changed.time - scheduled,
    uncertaintySeconds: null,
  };
}

const statusOf = (changed: ChangedEvent | null, planned: PlannedEvent | null) =>
  changed?.status ?? planned?.status ?? null;

function relationship(
  events: readonly { changed: ChangedEvent | null; planned: PlannedEvent | null }[],
): StopRelationship {
  const present = events.filter(({ changed, planned }) => changed !== null || planned !== null);
  const statuses = present.map(({ changed, planned }) => statusOf(changed, planned));
  if (statuses.length > 0 && statuses.every((status) => status === "cancelled")) return "skipped";
  if (statuses.some((status) => status === "added")) return "unscheduled";
  if (present.some(({ changed }) => changed !== null)) return "scheduled";
  return "no_data";
}

function stopObservation(planned: PlannedStop | undefined, changed: ChangedStop | undefined) {
  const eva = (changed?.eva ?? planned?.eva) as number;
  const arrival = { changed: changed?.arrival ?? null, planned: planned?.arrival ?? null };
  const departure = { changed: changed?.departure ?? null, planned: planned?.departure ?? null };
  const scheduledPlatform = normalizePlatform(
    departure.planned?.platform ?? arrival.planned?.platform,
  );
  const changedPlatform = normalizePlatform(
    departure.changed?.platform ?? arrival.changed?.platform,
  );
  const observation: StopTimeObservation = {
    stopSequence: null,
    stop: { kind: "uic", code: eva },
    arrival: timeObservation(arrival.changed, arrival.planned),
    departure: timeObservation(departure.changed, departure.planned),
    relationship: relationship([arrival, departure]),
    assignedStop: null,
    scheduled: {
      arrival: arrival.planned?.time ?? null,
      departure: departure.planned?.time ?? null,
    },
    platform: {
      scheduled: scheduledPlatform,
      actual: changedPlatform === scheduledPlatform ? null : changedPlatform,
    },
    messages: changed?.messages ?? [],
  };
  return observation;
}

function tripRelationship(stops: readonly StopTimeObservation[]): TripRelationship {
  return stops.length > 0 && stops.every((stop) => stop.relationship === "unscheduled")
    ? "added"
    : "scheduled";
}

/**
 * The canonical trip observation of one IRIS trip from both books, in the trip's stop order: the stops
 * with a change (times with their delay against the planned ones, platforms, cancellations, added
 * stops, messages) and, apart, the stops IRIS names with planned times only, for matching. Null while
 * no stop carries a change, so a plan alone never claims realtime for a train.
 */
export function irisObservation(
  tripId: string,
  plans: IrisPlans,
  changes: IrisChanges,
  observedAt: number,
): TripObservation | null {
  const ids = [...new Set([...plans.idsOf(tripId), ...changes.idsOf(tripId)])];
  const rows = ids
    .map((id) => ({ id, planned: plans.get(id, observedAt), changed: changes.get(id) }))
    .filter((row) => row.planned !== undefined || row.changed !== undefined)
    .map((row) => ({ ...row, key: (row.changed?.key ?? row.planned?.key) as IrisStopKey }))
    .sort((a, b) => a.key.index - b.key.index || a.id.localeCompare(b.id));
  const changedStops = rows.filter(
    ({ changed }) => changed && (changed.arrival !== null || changed.departure !== null),
  );
  const first = rows[0];
  if (!first || changedStops.length === 0) return null;
  const label = plans.labelOf(tripId, observedAt);
  const all = rows.map(({ planned, changed }) => stopObservation(planned, changed));
  const stops = all.filter((stop) => stop.relationship !== "no_data");
  const messages = new Map<string, SourceMessage>();
  for (const stop of all)
    for (const message of stop.messages ?? []) messages.set(message.id, message);
  return {
    kind: "trip",
    source: IRIS_SOURCE,
    entityId: tripId,
    observedAt,
    feedTimestamp: null,
    updateTimestamp: null,
    sourceTripId: tripId,
    routeId: null,
    directionId: null,
    startDate: first.key.startDate,
    startTime: first.key.startTime,
    trainNumber: label?.number ?? null,
    categoryLabel: label?.category ?? null,
    longDistance: label?.filter ? label.filter === "F" : null,
    relationship: tripRelationship(stops),
    vehicleId: null,
    vehicleLabel: null,
    delaySeconds: null,
    stops,
    plannedStops: all.filter((stop) => stop.relationship === "no_data"),
    messages: [...messages.values()],
  };
}

/** The IRIS state one fold reads: the shared planned book and the fold's own changes. */
export interface IrisState {
  readonly plans: IrisPlans;
  readonly changes: IrisChanges;
  /** Collects every trip an answer names, with a change or not. */
  readonly touched?: Set<string>;
}

/**
 * Adapter for one recorded DB Timetables answer: the plan answer feeds the planned book, a change
 * answer the planned book (what it repeats) and the changes; every trip the answer names comes back
 * as a canonical observation built from both books, trips without any change left out. `eva` is the
 * station the answer was asked for (a plan answer names none). Reads no clock and no database.
 */
export function adaptIris(
  payload: Uint8Array,
  endpoint: IrisEndpoint,
  eva: number,
  observedAt: number,
  state: IrisState,
): AdapterResult {
  let stops: readonly IrisStop[];
  try {
    stops = parseIrisTimetable(Buffer.from(payload), eva, observedAt).stops;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: { source: IRIS_SOURCE, observedAt, error: text.slice(0, 200) } };
  }
  const touched = state.plans.add(stops, observedAt);
  if (endpoint !== "plan") {
    for (const tripId of state.changes.add(stops, observedAt)) touched.add(tripId);
  }
  for (const tripId of touched) state.touched?.add(tripId);
  const events = [...touched]
    .sort()
    .map((tripId) => irisObservation(tripId, state.plans, state.changes, observedAt))
    .filter((event): event is TripObservation => event !== null);
  return { ok: true, feedVersion: null, feedTimestamp: null, events };
}
