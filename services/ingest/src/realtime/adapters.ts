import type {
  AdapterResult,
  AlertObservation,
  AlertSelector,
  LocalizedText,
  RealtimeEvent,
  StopRef,
  StopRelationship,
  StopTimeObservation,
  TimeObservation,
  TripObservation,
  TripRelationship,
  VehicleObservation,
} from "@gerlines/schema";
import { gtfsDateToIso } from "@gerlines/schema/service-day";
import {
  decodeFeed,
  type RtAlert,
  type RtEntity,
  type RtStopTimeEvent,
  type RtStopTimeUpdate,
  type RtTranslation,
  type RtTripUpdate,
  type RtVehiclePosition,
} from "../gtfs-rt/decode.ts";
import { IRIS_SOURCE, irisRecording } from "./iris.ts";

/** Source-specific reading rules on top of plain GTFS-RT. */
export interface SourceProfile {
  /** The source the rows are folded under: one logical source may have several recorded feeds. */
  readonly source: string;
  /** Trip, route and stop ids are DELFI's, read against the DELFI timetable. */
  readonly delfi: boolean;
  /** One of several recorded feeds of the same data: the primary wins a tie on the header time. */
  readonly feed?: { readonly primary: boolean };
  /** Alert entity ids change every payload: alerts are keyed by their content instead. */
  readonly alertKeyByContent?: boolean;
  stopRef(stopId: string): StopRef | null;
  trainNumber(entity: RtEntity, context: FeedContext): string | null;
}

export interface FeedContext {
  readonly vehicleLabelsByTrip: ReadonlyMap<string, string>;
}

const TRIP_RELATIONSHIPS: Record<number, TripRelationship> = {
  0: "scheduled",
  1: "added",
  2: "unscheduled",
  3: "cancelled",
  5: "replacement",
  6: "duplicated",
  7: "deleted",
  8: "new",
};

const STOP_RELATIONSHIPS: Record<number, StopRelationship> = {
  0: "scheduled",
  1: "skipped",
  2: "no_data",
  3: "unscheduled",
};

/** Some feeds send the largest uint32 as a stop sequence they do not know (D-041). */
const UNSET_STOP_SEQUENCE = 4_294_967_295;

/** Longest id (trip, route, stop, entity, vehicle, feed version) kept from a feed, in characters. */
export const MAX_ID_LENGTH = 1024;
/** Longest text (alert header, description, url) kept from a feed, in characters. */
export const MAX_TEXT_LENGTH = 65_536;
/** Stop times further than this from the observation are not read as times. */
const MAX_TIME_DISTANCE_S = 2 * 86_400;
/** Delays beyond a day either way are not read as delays. */
const MAX_DELAY_S = 86_400;

const withoutNul = (value: string): string =>
  value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;

/** A feed id without NUL characters, cut to `MAX_ID_LENGTH`. */
const cleanId = (value: string): string => withoutNul(value).slice(0, MAX_ID_LENGTH);

function idOrNull(value: string | undefined): string | null {
  return value === undefined ? null : cleanId(value);
}

const sourceStop = (stopId: string): StopRef | null => {
  const id = cleanId(stopId);
  return id.trim() === "" ? null : { kind: "source", id };
};

/** A seven-digit UIC or EVA station code as a stop, else the source's own id. */
function uicOrSource(stopId: string): StopRef | null {
  if (/^\d{7}$/.test(stopId)) return { kind: "uic", code: Number(stopId) };
  return sourceStop(stopId);
}

/** SNCF `StopPoint:OCE<mode>-<8 digits>`: the UIC station code followed by its check digit. */
function sncfStop(stopId: string): StopRef | null {
  const match = /-(\d{8})$/.exec(stopId);
  if (match) return { kind: "uic", code: Math.floor(Number(match[1]) / 10) };
  return sourceStop(stopId);
}

const noTrainNumber = (): string | null => null;

function vehicleLabelNumber(entity: RtEntity, context: FeedContext): string | null {
  const tripId = entity.tripUpdate?.trip.tripId ?? entity.vehicle?.trip?.tripId;
  const label =
    entity.vehicle?.vehicle?.label ??
    entity.tripUpdate?.vehicle?.label ??
    (tripId ? context.vehicleLabelsByTrip.get(tripId) : undefined);
  return label && /^\d{1,6}$/.test(label) ? label : null;
}

function tripIdNumber(pattern: RegExp) {
  return (entity: RtEntity): string | null => {
    const tripId = entity.tripUpdate?.trip.tripId ?? entity.vehicle?.trip?.tripId ?? "";
    return pattern.exec(tripId)?.[1] ?? null;
  };
}

/** DELFI realtime: the official Mobilithek feed is primary, the traines mirror its fallback (D-041). */
export const DELFI_RT = "delfi-gtfs-rt";
export const DELFI_MOBILITHEK_RT = "delfi-mobilithek-rt";

const delfiProfile = (source: string, feed?: { primary: boolean }): SourceProfile => ({
  source,
  delfi: true,
  ...(feed ? { feed } : {}),
  stopRef: sourceStop,
  trainNumber: noTrainNumber,
});

const plainProfile = (source: string): SourceProfile => ({
  source,
  delfi: false,
  stopRef: sourceStop,
  trainNumber: noTrainNumber,
});

const PROFILES: Record<string, SourceProfile> = {
  [DELFI_MOBILITHEK_RT]: delfiProfile(DELFI_RT, { primary: true }),
  [DELFI_RT]: delfiProfile(DELFI_RT, { primary: false }),
  "delfi-gtfs-rt-deincr": delfiProfile("delfi-gtfs-rt-deincr"),
  "delfi-gtfs-sa": delfiProfile("delfi-gtfs-sa"),
  "gtfsde-rt": plainProfile("gtfsde-rt"),
  "vbb-gtfs-rt": plainProfile("vbb-gtfs-rt"),
  "vbn-gtfs-rt": plainProfile("vbn-gtfs-rt"),
  "fr-sncf-gtfs-rt": {
    source: "fr-sncf-gtfs-rt",
    delfi: false,
    stopRef: sncfStop,
    trainNumber: tripIdNumber(/^OCESN(\d{1,6})F/),
  },
  "ch-otd-gtfs-rt": {
    source: "ch-otd-gtfs-rt",
    delfi: false,
    stopRef: uicOrSource,
    trainNumber: noTrainNumber,
  },
  "cz-czptt-gtfs-rt": {
    source: "cz-czptt-gtfs-rt",
    delfi: false,
    stopRef: sourceStop,
    trainNumber: vehicleLabelNumber,
  },
  "pl-pkpic-gtfs-rt": {
    source: "pl-pkpic-gtfs-rt",
    delfi: false,
    alertKeyByContent: true,
    stopRef: sourceStop,
    trainNumber: tripIdNumber(/^\d{4}-\d{2}-\d{2}_(\d{1,6})(?:-\d+)?$/),
  },
  "pl-trains-gtfs-rt": plainProfile("pl-trains-gtfs-rt"),
  "ovapi-train-updates": plainProfile("ovapi-train-updates"),
  "be-sncb-gtfs-rt": plainProfile("be-sncb-gtfs-rt"),
};

/** The reading rules of a recorded source, by its recorder id. */
export function profileFor(source: string): SourceProfile | undefined {
  return PROFILES[source];
}

/** The logical source a recorded source folds under (itself when it has no profile). */
export function foldSourceOf(source: string): string {
  if (irisRecording(source)) return IRIS_SOURCE;
  return PROFILES[source]?.source ?? source;
}

/** Logical sources whose ids are DELFI's. */
export const DELFI_FOLD_SOURCES: ReadonlySet<string> = new Set(
  Object.values(PROFILES)
    .filter((profile) => profile.delfi)
    .map((profile) => profile.source),
);

/**
 * Sources the replay processes by default: DELFI, its alerts, the gtfs.de fallback and the
 * neighbours. VBB (matched by its DHID stops and times, trains DELFI also carries), VBN (stop ids
 * that name no DELFI stop) and the hourly de-incremented DELFI feed (the same data as the minute
 * feed) have profiles but are processed only when named.
 */
export const REALTIME_SOURCES: readonly string[] = [
  DELFI_MOBILITHEK_RT,
  DELFI_RT,
  "delfi-gtfs-sa",
  "gtfsde-rt",
  "fr-sncf-gtfs-rt",
  "ch-otd-gtfs-rt",
  "cz-czptt-gtfs-rt",
  "pl-pkpic-gtfs-rt",
  "pl-trains-gtfs-rt",
  "ovapi-train-updates",
  "be-sncb-gtfs-rt",
];

function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function plausibleDelay(delay: number | undefined): number | null {
  return delay !== undefined && Math.abs(delay) <= MAX_DELAY_S ? delay : null;
}

/** A stop time event, with times far from the observation and delays beyond a day left out. */
function timeObservation(
  event: RtStopTimeEvent | undefined,
  observedAt: number,
): TimeObservation | null {
  if (!event) return null;
  const delay = plausibleDelay(event.delay);
  const near =
    event.time !== undefined &&
    event.time > 0 &&
    Math.abs(event.time - observedAt / 1000) <= MAX_TIME_DISTANCE_S;
  const time = near ? (event.time as number) : null;
  if (delay === null && time === null) return null;
  return { delaySeconds: delay, time, uncertaintySeconds: orNull(event.uncertainty) };
}

function stopObservation(
  update: RtStopTimeUpdate,
  profile: SourceProfile,
  observedAt: number,
): StopTimeObservation {
  return {
    stopSequence:
      update.stopSequence === undefined || update.stopSequence === UNSET_STOP_SEQUENCE
        ? null
        : update.stopSequence,
    stop: update.stopId ? profile.stopRef(update.stopId) : null,
    arrival: timeObservation(update.arrival, observedAt),
    departure: timeObservation(update.departure, observedAt),
    relationship: STOP_RELATIONSHIPS[update.scheduleRelationship ?? 0] ?? "scheduled",
    assignedStop: update.assignedStopId ? profile.stopRef(update.assignedStopId) : null,
  };
}

function tripObservation(
  entity: RtEntity,
  update: RtTripUpdate,
  observedAt: number,
  feedTimestamp: number | null,
  profile: SourceProfile,
  context: FeedContext,
): TripObservation {
  const trip = update.trip;
  return {
    kind: "trip",
    source: profile.source,
    entityId: cleanId(entity.id),
    observedAt,
    feedTimestamp,
    updateTimestamp: orNull(update.timestamp),
    sourceTripId: idOrNull(trip.tripId ?? update.tripProperties?.tripId),
    routeId: idOrNull(trip.routeId),
    directionId: orNull(trip.directionId),
    startDate: trip.startDate ? gtfsDateToIso(trip.startDate) : null,
    startTime: idOrNull(trip.startTime),
    trainNumber: idOrNull(
      profile.trainNumber(entity, context) ?? update.tripProperties?.tripShortName,
    ),
    relationship: TRIP_RELATIONSHIPS[trip.scheduleRelationship ?? 0] ?? "scheduled",
    vehicleId: idOrNull(update.vehicle?.id),
    vehicleLabel: idOrNull(update.vehicle?.label),
    delaySeconds: plausibleDelay(update.delay),
    stops: update.stopTimeUpdates.map((stop) => stopObservation(stop, profile, observedAt)),
  };
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function vehicleObservation(
  entity: RtEntity,
  vehicle: RtVehiclePosition,
  observedAt: number,
  profile: SourceProfile,
  context: FeedContext,
): VehicleObservation {
  return {
    kind: "vehicle",
    source: profile.source,
    entityId: cleanId(entity.id),
    observedAt,
    sourceTripId: idOrNull(vehicle.trip?.tripId),
    startDate: vehicle.trip?.startDate ? gtfsDateToIso(vehicle.trip.startDate) : null,
    trainNumber: idOrNull(profile.trainNumber(entity, context) ?? undefined),
    vehicleId: idOrNull(vehicle.vehicle?.id),
    latitude: finiteOrNull(vehicle.position?.latitude),
    longitude: finiteOrNull(vehicle.position?.longitude),
    bearing: finiteOrNull(vehicle.position?.bearing),
    speedMetresPerSecond: finiteOrNull(vehicle.position?.speed),
    positionTimestamp: orNull(vehicle.timestamp),
  };
}

const texts = (values: readonly RtTranslation[]): LocalizedText[] =>
  values.map((value) => ({
    text: withoutNul(value.text).slice(0, MAX_TEXT_LENGTH),
    language: idOrNull(value.language),
  }));

function alertObservation(
  entity: RtEntity,
  alert: RtAlert,
  observedAt: number,
  profile: SourceProfile,
): AlertObservation {
  const selectors: AlertSelector[] = alert.informedEntities.map((selector) => ({
    agencyId: idOrNull(selector.agencyId),
    routeId: idOrNull(selector.routeId),
    routeType: orNull(selector.routeType),
    sourceTripId: idOrNull(selector.trip?.tripId),
    startDate: selector.trip?.startDate ? gtfsDateToIso(selector.trip.startDate) : null,
    stop: selector.stopId ? profile.stopRef(selector.stopId) : null,
  }));
  return {
    kind: "alert",
    source: profile.source,
    entityId: cleanId(entity.id),
    observedAt,
    cause: orNull(alert.cause),
    effect: orNull(alert.effect),
    severity: orNull(alert.severityLevel),
    activePeriods: alert.activePeriods.map((period) => ({
      start: orNull(period.start),
      end: orNull(period.end),
    })),
    selectors,
    header: texts(alert.headerText),
    description: texts(alert.descriptionText),
    url: texts(alert.url),
  };
}

function feedContext(entities: readonly RtEntity[]): FeedContext {
  const vehicleLabelsByTrip = new Map<string, string>();
  for (const entity of entities) {
    const tripId = entity.vehicle?.trip?.tripId;
    const label = entity.vehicle?.vehicle?.label;
    if (tripId && label) vehicleLabelsByTrip.set(tripId, label);
  }
  return { vehicleLabelsByTrip };
}

/**
 * Adapter for every GTFS-RT source we record: a pure function of the payload bytes, the instant the
 * payload represents (`observedAt`, epoch ms, from the recorder's sidecar) and the source's profile.
 * It reads no clock and no database; matching to the timetable happens later.
 */
export function adaptGtfsRt(
  payload: Uint8Array,
  observedAt: number,
  profile: SourceProfile,
): AdapterResult {
  const decoded = decodeFeed(payload);
  if (!decoded.ok) {
    return { ok: false, failure: { source: profile.source, observedAt, error: decoded.error } };
  }
  const { header, entities } = decoded.feed;
  const feedTimestamp = orNull(header.timestamp);
  const context = feedContext(entities);
  const events: RealtimeEvent[] = [];
  for (const entity of entities) {
    if (entity.isDeleted) continue;
    if (entity.tripUpdate) {
      events.push(
        tripObservation(entity, entity.tripUpdate, observedAt, feedTimestamp, profile, context),
      );
    }
    if (entity.vehicle) {
      events.push(vehicleObservation(entity, entity.vehicle, observedAt, profile, context));
    }
    if (entity.alert) events.push(alertObservation(entity, entity.alert, observedAt, profile));
  }
  return { ok: true, feedVersion: idOrNull(header.feedVersion), feedTimestamp, events };
}
