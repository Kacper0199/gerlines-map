import type { LonLat } from "@gerlines/geo";
import {
  TRAIN_CATEGORIES,
  type TrainCategory,
  type TrainDetail,
  type TrainGeometry,
  type TrainOperator,
  type TrainProgress,
  type TrainProvenance,
  type TrainStop,
} from "@gerlines/schema";
import { normalizePlatform } from "@gerlines/schema/platform";
import { chooseSource } from "@gerlines/schema/source-priority";
import { headDelay, progressAt } from "@gerlines/schema/train-progress";
import {
  displayTrainNumber,
  keyOperatorId,
  operatorNameOf,
} from "@gerlines/schema/vehicle-resolver";
import { placeRows, placesWithin, plannedTime } from "../plan/place-rows.ts";
import {
  type DetailInput,
  type SourceRow,
  type StopEventRow,
  TIMETABLE_SOURCE_ID,
} from "./model.ts";
import { routeProduct } from "./product.ts";

export type BuildFailure = "no_stops" | "too_few_stops" | "unknown_place";

export type BuildResult =
  | { readonly ok: true; readonly detail: TrainDetail; readonly placeMismatches: number }
  | { readonly ok: false; readonly reason: BuildFailure };

const CATEGORIES: ReadonlySet<string> = new Set(TRAIN_CATEGORIES);
const HTTPS = /^https:\/\/[^\s/?#@]+(\/\S*)?$/;

interface StopTimes {
  readonly index: number;
  readonly stopPlaceId: string;
  readonly scheduledArrival: number | null;
  readonly scheduledDeparture: number | null;
  readonly platform: string | null;
  readonly event: StopEventRow | null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function seconds(ms: number | null): number | null {
  return ms === null ? null : ms / 1000;
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function categoryOf(input: DetailInput): TrainCategory {
  const code = input.trip?.categoryCode ?? input.instance?.categoryCode ?? "other";
  return (CATEGORIES.has(code) ? code : "other") as TrainCategory;
}

function chosenSourceId(input: DetailInput, category: TrainCategory): string | null {
  const reporting = new Set(input.events.map((event) => event.sourceId));
  const held = input.tick?.sourceId ?? null;
  if (input.tick) return held !== null && reporting.has(held) ? held : null;
  const activity = input.activity
    .filter((entry) => reporting.has(entry.sourceId))
    .map((entry) => ({
      sourceId: entry.sourceId,
      firstSeen: Math.floor(entry.firstSeen / 1000),
      lastSeen: Math.floor(entry.lastSeen / 1000),
    }));
  return chooseSource(category, null, activity, Math.floor(input.asOf / 1000))?.sourceId ?? null;
}

function locationsOf(input: DetailInput): Map<string, LonLat> {
  const locations = new Map<string, LonLat>();
  for (const [id, place] of input.places) if (place.location) locations.set(id, place.location);
  return locations;
}

function stopTimes(
  input: DetailInput,
  sourceId: string | null,
): { stops: StopTimes[]; mismatches: number } {
  const events = new Map<number, StopEventRow>();
  for (const event of input.events) {
    if (event.sourceId === sourceId) events.set(event.index, event);
  }
  if (input.staticStops.length === 0) {
    const stops = [...events.values()]
      .sort((a, b) => a.index - b.index)
      .map((event) => ({
        index: event.index,
        stopPlaceId: event.stopPlaceId,
        scheduledArrival: event.scheduledArrival,
        scheduledDeparture: event.scheduledDeparture,
        platform: null,
        event,
      }));
    return { stops, mismatches: 0 };
  }
  const length = Math.max(...input.staticStops.map((stop) => stop.index)) + 1;
  const places = new Array<string | undefined>(length);
  const arrivals = new Array<number | null>(length).fill(null);
  const departures = new Array<number | null>(length).fill(null);
  for (const stop of input.staticStops) {
    places[stop.index] = stop.stopPlaceId;
    arrivals[stop.index] = seconds(stop.scheduledArrival ?? stop.scheduledDeparture);
    departures[stop.index] = seconds(stop.scheduledDeparture ?? stop.scheduledArrival);
  }
  const placed = placeRows(
    { places, arrivals, departures },
    events,
    (event) => ({
      place: event.stopPlaceId,
      arrival: plannedTime(seconds(event.predictedArrival), event.arrivalDelaySeconds),
      departure: plannedTime(seconds(event.predictedDeparture), event.departureDelaySeconds),
    }),
    placesWithin(locationsOf(input)),
  );
  const stops = [...input.staticStops]
    .filter((stop) => stop.passenger)
    .sort((a, b) => a.index - b.index)
    .map(({ passenger: _, ...stop }) => ({ ...stop, event: placed.rows[stop.index] ?? null }));
  return { stops, mismatches: placed.dropped };
}

interface Side {
  readonly scheduled: string | null;
  readonly predicted: string | null;
  readonly delay: number | null;
}

const NO_SIDE: Side = { scheduled: null, predicted: null, delay: null };

function arrivalSide(stop: StopTimes): Side {
  return {
    scheduled: iso(stop.scheduledArrival),
    predicted: iso(stop.event?.predictedArrival ?? null),
    delay: stop.event?.arrivalDelaySeconds ?? null,
  };
}

function departureSide(stop: StopTimes): Side {
  return {
    scheduled: iso(stop.scheduledDeparture),
    predicted: iso(stop.event?.predictedDeparture ?? null),
    delay: stop.event?.departureDelaySeconds ?? null,
  };
}

function trainStop(
  stop: StopTimes,
  place: { readonly name: string; readonly dhid: string | null },
  first: boolean,
  final: boolean,
): TrainStop {
  const arrival = first ? NO_SIDE : arrivalSide(stop);
  const departure = final ? NO_SIDE : departureSide(stop);
  const event = stop.event;
  const predicted = arrival.predicted !== null || departure.predicted !== null;
  return {
    index: stop.index,
    stopPlaceId: stop.stopPlaceId,
    name: place.name,
    scheduledArrival: arrival.scheduled,
    scheduledDeparture: departure.scheduled,
    predictedArrival: arrival.predicted,
    predictedDeparture: departure.predicted,
    arrivalDelaySeconds: arrival.delay,
    departureDelaySeconds: departure.delay,
    platformScheduled: normalizePlatform(event?.platformScheduled ?? stop.platform, place.dhid),
    platformActual: normalizePlatform(event?.platformActual ?? null, place.dhid),
    cancelled: event?.cancelled ?? false,
    prediction: predicted ? (event?.predictionKind ?? null) : null,
  };
}

function trainStops(stops: readonly StopTimes[], input: DetailInput): TrainStop[] | null {
  const result: TrainStop[] = [];
  for (const [position, stop] of stops.entries()) {
    const place = input.places.get(stop.stopPlaceId);
    const name = text(place?.displayName) ?? text(place?.name);
    if (name === null) return null;
    const dhid = place?.dhid ?? null;
    result.push(trainStop(stop, { name, dhid }, position === 0, position === stops.length - 1));
  }
  return result;
}

function geometryOf(input: DetailInput): TrainGeometry {
  if (input.tick) return input.tick.geometry;
  switch (input.trip?.shapeQaStatus ?? null) {
    case "pass":
      return { available: true, reason: null };
    case "unmeasured":
      return { available: false, reason: "unmeasured" };
    case "low_quality":
    case "fail":
      return { available: false, reason: "low_quality" };
    default:
      return { available: false, reason: "no_shape" };
  }
}

function operatorOf(input: DetailInput): TrainOperator | null {
  const nameOf = (id: string) => {
    const row = input.operators.get(id);
    return row ? operatorNameOf(row) : null;
  };
  const id = keyOperatorId(
    input.instance?.operatorId ?? null,
    input.trip?.operatorId ?? null,
    (operatorId) => nameOf(operatorId) !== null,
  );
  const row = id === null ? undefined : input.operators.get(id);
  const name = id === null ? null : nameOf(id);
  return row && name !== null ? { id: row.operatorId, name, wikidataQid: row.wikidataQid } : null;
}

function https(url: string | null): string | null {
  return url !== null && HTTPS.test(url) ? url : null;
}

function provenanceOf(
  source: SourceRow | undefined,
  sourceId: string,
  kind: TrainProvenance["kind"],
  predictionChangedAt: number | null,
  feedObservedAt: number | null,
): TrainProvenance {
  const name = text(source?.name) ?? sourceId;
  const attribution = text(source?.attribution) ?? name;
  const holders =
    source && source.holders.length > 0
      ? source.holders.map((holder) => ({ ...holder, url: https(holder.url) }))
      : [{ name: attribution, role: "publisher" as const, url: null }];
  return {
    kind,
    sourceId,
    sourceName: name,
    attribution,
    predictionChangedAt: iso(predictionChangedAt),
    feedObservedAt: iso(feedObservedAt),
    holders,
    ...(source ? { licence: { id: source.licence, url: https(source.licenceUrl) } } : {}),
  };
}

function realtimeProvenance(
  input: DetailInput,
  sourceId: string | null,
  times: readonly StopTimes[],
): TrainProvenance | null {
  const used = times.map((stop) => stop.event).filter((event) => event !== null);
  if (sourceId === null || used.length === 0) return null;
  const changedAt = Math.max(...used.map((event) => event.observedAt));
  const feedObservedAt = input.feedObservedAt.get(sourceId) ?? null;
  return provenanceOf(input.sources.get(sourceId), sourceId, "realtime", changedAt, feedObservedAt);
}

function timetableProvenance(input: DetailInput): TrainProvenance {
  const source = input.sources.get(TIMETABLE_SOURCE_ID);
  return provenanceOf(source, TIMETABLE_SOURCE_ID, "timetable", null, null);
}

/**
 * The tick's progress on the listed stops. The engine may name a stop the card leaves out (an
 * operational halt or a pass-through): its last passed one maps back to the passenger stop before
 * it, its next one on to the served passenger stop after it (never one the source cancelled since
 * the tick). An index the timetable does not have, or progress running backwards, falls back to
 * progress by arrival.
 */
function progressOf(input: DetailInput, stops: readonly TrainStop[]): TrainProgress {
  const listed = stops.map((stop) => stop.index);
  const known = new Set([...listed, ...input.staticStops.map((stop) => stop.index)]);
  const tick = input.tick;
  const valid = (index: number | null) => index === null || known.has(index);
  const forward =
    tick?.lastPassedIndex == null ||
    tick.nextIndex === null ||
    tick.nextIndex > tick.lastPassedIndex;
  if (tick && forward && valid(tick.lastPassedIndex) && valid(tick.nextIndex)) {
    const passed = tick.lastPassedIndex;
    const next = tick.nextIndex;
    const lastPassedIndex = passed === null ? null : (listed.findLast((i) => i <= passed) ?? null);
    const served = stops.find(
      (stop) =>
        next !== null &&
        !stop.cancelled &&
        stop.index >= next &&
        (lastPassedIndex === null || stop.index > lastPassedIndex),
    );
    return { lastPassedIndex, nextIndex: served?.index ?? null };
  }
  return progressAt(stops, input.asOf);
}

function delayOf(
  input: DetailInput,
  realtime: boolean,
  stops: readonly TrainStop[],
  progress: TrainProgress,
) {
  const current = input.tick?.delaySeconds ?? null;
  const head = headDelay({ stops, progress, asOf: input.asOf, realtime, current });
  return { ...head, currentDelaySeconds: current };
}

function trainIdentity(input: DetailInput) {
  const line = text(input.trip?.line);
  return {
    productName: text(input.trip?.product) ?? routeProduct(line),
    line,
    trainNumber: displayTrainNumber(
      input.instance?.trainNumber ?? null,
      input.trip?.tripShortName ?? null,
    ),
    foreign: input.trip?.isForeign ?? false,
    added: input.instance?.isAdded ?? false,
    headsign: text(input.trip?.headsign),
  };
}

/**
 * The train card's view of one trip instance as of `input.asOf`: the timetable trip with the chosen
 * source's predictions laid over it stop by stop (one source, never mixed), names with their town,
 * platforms as on the sign, and nulls wherever a value is not known.
 */
export function buildTrainDetail(input: DetailInput): BuildResult {
  const category = categoryOf(input);
  const sourceId = chosenSourceId(input, category);
  const { stops: times, mismatches } = stopTimes(input, sourceId);
  if (times.length === 0) return { ok: false, reason: "no_stops" };
  if (times.length < 2) return { ok: false, reason: "too_few_stops" };
  const stops = trainStops(times, input);
  const destination = stops?.[stops.length - 1];
  if (!stops || !destination) return { ok: false, reason: "unknown_place" };

  const realtimeSource = realtimeProvenance(input, sourceId, times);
  const progress = progressOf(input, stops);
  const detail: TrainDetail = {
    tripInstanceId: input.ref.tripInstanceId,
    frameKey: input.ref.frameKey,
    serviceDate: input.ref.serviceDate,
    timetableVersion: input.timetableVersion,
    version: input.version,
    asOf: new Date(input.asOf).toISOString(),
    category,
    ...trainIdentity(input),
    cancelled: input.tick?.cancelled ?? stops.every((stop) => stop.cancelled),
    operator: operatorOf(input),
    destination: { stopPlaceId: destination.stopPlaceId, name: destination.name },
    ...delayOf(input, realtimeSource !== null, stops, progress),
    provenance: realtimeSource ?? timetableProvenance(input),
    geometry: geometryOf(input),
    progress,
    stops,
    vehicle: null,
    photo: null,
  };
  return { ok: true, detail, placeMismatches: mismatches };
}
