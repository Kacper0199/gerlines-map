import { createHash } from "node:crypto";
import { normalizeTrainNumber } from "@gerlines/schema/ids";
import type {
  Journey,
  JourneyLeg,
  JourneyRemovalReason,
  JourneyStop,
  JourneysResponse,
  LegRun,
} from "@gerlines/schema/journeys";
import { normalizePlatform } from "@gerlines/schema/platform";
import { serviceInstant } from "@gerlines/schema/service-day";
import { CATEGORY_CODES, categoryOfLeg, transitModesFor } from "../router/categories.ts";
import {
  type MotisItinerary,
  type MotisLeg,
  type MotisPlace,
  type PlanRequest,
  type PlanResponse,
  RouterBusyError,
  type RouterClient,
  RouterRejectedError,
  RouterUnavailableError,
} from "../router/motis.ts";
import type { TripRunMatch } from "../search/records.ts";
import { createJourneyFilter, isStreetLeg, type JourneyFilter } from "./filters.ts";
import { legGeometryOf } from "./geometry.ts";
import type { JourneyQuery } from "./query.ts";
import { defaultSort, rankJourneys } from "./rank.ts";

const BASE_ITINERARIES = 5;
const FILTERED_ITINERARIES = 12;
export const MAX_ROUTER_CALLS = 3;
export const FILL_BUDGET_MS = 4_000;
export const FILL_PAGE_MIN_TIMEOUT_MS = 1_000;

/** The display name of the station a DELFI stop id belongs to, null when unknown. */
export type StopName = (stopId: string) => string | null;

/**
 * A stops.txt row of the station a stop id belongs to, for a place the router does not
 * hold; null when there is none other than the id itself.
 */
export type RoutableStop = (stopId: string) => string | null;

/** The run of the train a timetable trip of a service day belongs to, null when unknown. */
export type TrainRun = (serviceDate: string, tripKey: string) => TripRunMatch | null;

export interface JourneyContext {
  readonly client: RouterClient;
  readonly datasetTag: string;
  readonly now: () => number;
  readonly elapsed?: () => number;
  /** The request's signal: when the client goes away, the router calls stop. */
  readonly signal?: AbortSignal | undefined;
  readonly stopName?: StopName | undefined;
  readonly trainRun?: TrainRun | undefined;
  readonly routableStop?: RoutableStop | undefined;
}

type Direction = "EARLIER" | "LATER";

function stopIdWithoutTag(stopId: string | undefined, prefix: string): string | null {
  if (!stopId) {
    return null;
  }
  return stopId.startsWith(prefix) ? stopId.slice(prefix.length) : stopId;
}

function toStop(place: MotisPlace, naming: Naming, side: "from" | "to"): JourneyStop {
  const time = side === "from" ? place.departure : place.arrival;
  const scheduledTime = side === "from" ? place.scheduledDeparture : place.scheduledArrival;
  const stopId = present(stopIdWithoutTag(place.stopId, naming.prefix) ?? undefined);
  return {
    stopId,
    name: (stopId === null ? null : naming.stopName?.(stopId)) ?? place.name,
    lat: place.lat,
    lon: place.lon,
    time: time ?? null,
    scheduledTime: scheduledTime ?? null,
    track: normalizePlatform(place.track, stopId),
    scheduledTrack: normalizePlatform(place.scheduledTrack, stopId),
    cancelled: place.cancelled ?? false,
  };
}

function present(text: string | undefined): string | null {
  return text && text.trim() !== "" ? text : null;
}

interface Naming {
  readonly prefix: string;
  readonly stopName?: StopName | undefined;
  readonly trainRun?: TrainRun | undefined;
}

const TRIP_ID = /^(\d{4})(\d{2})(\d{2})_(\d{2,}):(\d{2})_(.+)$/u;

/**
 * Whether the index's run is the leg's train: DELFI trip ids belong to one feed version,
 * and the index may load a newer version than MOTIS routes on, where the same id can name another
 * trip. The run must start at the trip id's first departure, hold the leg's planned departure, and
 * carry the leg's train number when both have one.
 */
function sameTrain(run: TripRunMatch, leg: MotisLeg, firstDepartureMs: number): boolean {
  const from = Date.parse(run.departure);
  const to = Date.parse(run.arrival);
  const leaves = Date.parse(leg.scheduledStartTime);
  if (from !== firstDepartureMs || leaves < from || leaves > to) return false;
  const number = normalizeTrainNumber(leg.tripShortName);
  return number === null || run.trainNumber === null || number === run.trainNumber;
}

/**
 * The run of a leg's train: MOTIS names a GTFS trip `<service date>_<first departure>_<tag>_<trip
 * id>`, and the trip id of the DELFI timetable is our trip key. Null when the index lacks the trip
 * or holds another train under its key (`sameTrain`).
 */
function runOf(leg: MotisLeg, naming: Naming): LegRun | null {
  const match = leg.tripId === undefined ? null : TRIP_ID.exec(leg.tripId);
  if (!match || !naming.trainRun) return null;
  const [, year, month, day, hours = "", minutes = "", rest = ""] = match;
  if (!rest.startsWith(naming.prefix)) return null;
  const tripKey = rest.slice(naming.prefix.length);
  const serviceDate = `${year}-${month}-${day}`;
  const found = tripKey === "" ? null : naming.trainRun(serviceDate, tripKey);
  const firstDeparture = serviceInstant(serviceDate, Number(hours) * 3600 + Number(minutes) * 60);
  if (!found || !sameTrain(found, leg, firstDeparture)) return null;
  return {
    tripInstanceId: found.tripInstanceId,
    departure: found.departure,
    arrival: found.arrival,
  };
}

/**
 * A headsign is a local name (Hauptbahnhof) that misleads on a national map, so a leg reads as
 * the display name of its trip's last stop, the way the train card names its destination. A
 * headsign that is the name of one of this leg's own stops reads as that stop. Without a last
 * stop the headsign stays as written.
 */
function headsignOf(leg: MotisLeg, naming: Naming): string | null {
  const { headsign } = leg;
  const own = [leg.tripTo, leg.to, leg.from].filter((place) => place !== undefined);
  const named = headsign === undefined ? undefined : own.find((stop) => stop.name === headsign);
  const place = named ?? leg.tripTo;
  return place ? toStop(place, naming, "to").name : (headsign ?? null);
}

function toLeg(leg: MotisLeg, naming: Naming, geometry: boolean): JourneyLeg {
  const from = toStop(leg.from, naming, "from");
  const to = toStop(leg.to, naming, "to");
  if (isStreetLeg(leg)) {
    return {
      kind: "walk",
      from,
      to,
      departure: leg.startTime,
      arrival: leg.endTime,
      durationS: leg.duration,
    };
  }
  return {
    kind: "transit",
    category: categoryOfLeg(leg),
    motisMode: leg.mode,
    line: present(leg.displayName) ?? present(leg.routeShortName),
    tripNumber: present(leg.tripShortName),
    headsign: headsignOf(leg, naming),
    operator: present(leg.agencyName),
    tripId: present(leg.tripId),
    run: runOf(leg, naming),
    realtime: leg.realTime,
    cancelled: leg.cancelled ?? false,
    staySeated: leg.interlineWithPreviousLeg ?? false,
    from,
    to,
    departure: leg.startTime,
    arrival: leg.endTime,
    scheduledDeparture: leg.scheduledStartTime,
    scheduledArrival: leg.scheduledEndTime,
    durationS: leg.duration,
    ...(geometry ? { geometry: legGeometryOf(leg.legGeometry) } : {}),
  };
}

/** Same trips between the same stops at the same times: one journey, whichever page it came on. */
export function itineraryKey(itinerary: MotisItinerary): string {
  const legs = itinerary.legs.map((leg) =>
    [
      isStreetLeg(leg) ? leg.mode : (leg.tripId ?? leg.displayName ?? ""),
      leg.from.stopId ?? leg.from.name,
      leg.to.stopId ?? leg.to.name,
      leg.startTime,
      leg.endTime,
    ].join("|"),
  );
  return [itinerary.startTime, itinerary.endTime, ...legs].join("\n");
}

function journeyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function unique<T>(values: readonly (T | null)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== null))];
}

function toJourney(
  itinerary: MotisItinerary,
  naming: Naming,
  geometry: boolean,
): Omit<Journey, "tags"> {
  const legs = itinerary.legs.map((leg) => toLeg(leg, naming, geometry));
  const transit = legs.flatMap((leg) => (leg.kind === "transit" ? [leg] : []));
  return {
    id: journeyId(itineraryKey(itinerary)),
    departure: itinerary.startTime,
    arrival: itinerary.endTime,
    durationS: itinerary.duration,
    transfers: itinerary.transfers,
    categories: unique(transit.map((leg) => leg.category)),
    operators: unique(transit.map((leg) => leg.operator)),
    legs,
  };
}

function directionOf(query: JourneyQuery): Direction {
  if (query.cursor) {
    return query.cursor.startsWith("EARLIER") ? "EARLIER" : "LATER";
  }
  return query.arriveBy ? "EARLIER" : "LATER";
}

function isRouterError(error: unknown): boolean {
  return (
    error instanceof RouterBusyError ||
    error instanceof RouterUnavailableError ||
    error instanceof RouterRejectedError
  );
}

interface Collected {
  readonly kept: MotisItinerary[];
  readonly removedBy: Record<JourneyRemovalReason, number>;
  /** Adds the itineraries not seen before; answers how many were new. */
  absorb(page: PlanResponse): number;
}

function collector(filter: JourneyFilter): Collected {
  const seen = new Set<string>();
  const kept: MotisItinerary[] = [];
  const removedBy: Record<JourneyRemovalReason, number> = { category: 0, product: 0, operator: 0 };
  return {
    kept,
    removedBy,
    absorb(page) {
      const fresh = page.itineraries.filter((itinerary) => {
        const key = itineraryKey(itinerary);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      for (const itinerary of fresh) {
        const reason = filter.removalReason(itinerary);
        if (reason) {
          removedBy[reason] += 1;
        } else {
          kept.push(itinerary);
        }
      }
      return fresh.length;
    },
  };
}

interface Pages {
  earlierCursor: string | null;
  laterCursor: string | null;
  routerCalls: number;
  partial: boolean;
}

async function nextPage(client: RouterClient, request: PlanRequest): Promise<PlanResponse | null> {
  try {
    return await client.plan(request);
  } catch (error) {
    if (isRouterError(error)) {
      return null;
    }
    throw error;
  }
}

function fillPageRequest(
  base: PlanRequest,
  pageCursor: string,
  remainingMs: number | undefined,
): PlanRequest {
  if (remainingMs === undefined) {
    return { ...base, pageCursor };
  }
  return {
    ...base,
    pageCursor,
    timeoutMs: Math.max(FILL_PAGE_MIN_TIMEOUT_MS, Math.round(remainingMs)),
  };
}

function advance(pages: Pages, direction: Direction, page: PlanResponse): void {
  pages.routerCalls += 1;
  if (direction === "LATER") {
    pages.laterCursor = page.nextPageCursor ?? null;
  } else {
    pages.earlierCursor = page.previousPageCursor ?? null;
  }
}

async function fillUp(
  query: JourneyQuery,
  base: PlanRequest,
  collected: Collected,
  pages: Pages,
  { client, elapsed }: Pick<JourneyContext, "client" | "elapsed">,
  started: number,
): Promise<void> {
  const direction = directionOf(query);
  while (collected.kept.length < query.results && pages.routerCalls < MAX_ROUTER_CALLS) {
    const cursor = direction === "LATER" ? pages.laterCursor : pages.earlierCursor;
    if (!cursor) {
      return;
    }
    const remaining = elapsed === undefined ? undefined : FILL_BUDGET_MS - (elapsed() - started);
    const page =
      remaining !== undefined && remaining < 0
        ? null
        : await nextPage(client, fillPageRequest(base, cursor, remaining));
    if (!page) {
      pages.partial = true;
      return;
    }
    advance(pages, direction, page);
    if (collected.absorb(page) === 0) {
      return;
    }
  }
}

type Side = "fromPlace" | "toPlace";

const SIDES: readonly Side[] = ["fromPlace", "toPlace"];
const MISSING_PLACE = /Could not find timetable location "([^"]+)"/;

/** The sides a 404 names; none when the answer names no place, as one that is not MOTIS's. */
function missingSides(error: RouterRejectedError, request: PlanRequest): readonly Side[] {
  const place = MISSING_PLACE.exec(error.message)?.[1];
  return place === undefined ? [] : SIDES.filter((side) => request[side] === place);
}

function withRoutableStops(
  error: unknown,
  request: PlanRequest,
  replaced: Set<Side>,
  routableStop: RoutableStop | undefined,
  prefix: string,
): PlanRequest | null {
  if (!(routableStop && error instanceof RouterRejectedError && error.status === 404)) {
    return null;
  }
  let next: PlanRequest | null = null;
  for (const side of missingSides(error, request)) {
    const stopId = replaced.has(side) ? null : stopIdWithoutTag(request[side], prefix);
    const row = stopId === null ? null : routableStop(stopId);
    if (row !== null) {
      replaced.add(side);
      next = { ...(next ?? request), [side]: `${prefix}${row}` };
    }
  }
  return next;
}

/**
 * The first page, the request that got it and the router calls it took. A station the
 * importer built from platform ids has no stops.txt row, so MOTIS answers 404 naming it; then the
 * request is repeated with a row of that station, each side at most once.
 */
async function firstPage(
  base: PlanRequest,
  { client, routableStop }: Pick<JourneyContext, "client" | "routableStop">,
  prefix: string,
): Promise<{ request: PlanRequest; page: PlanResponse; attempts: number }> {
  const replaced = new Set<Side>();
  let request = base;
  for (let attempts = 1; ; attempts += 1) {
    try {
      return { request, page: await client.plan(request), attempts };
    } catch (error) {
      const next = withRoutableStops(error, request, replaced, routableStop, prefix);
      if (next === null) throw error;
      request = next;
    }
  }
}

/**
 * Journeys from A to B over MOTIS. Categories become `transitModes`; what MOTIS cannot filter
 * (IC against FLX, RE against RB, operators, a category inside a stay-seated block) is filtered
 * here over a wider search. When filters leave fewer journeys than asked for, the next pages in
 * the search direction are searched, at most three router calls within the fill budget; each such
 * page may take only what is left of the budget (at least a second), so it cannot hold a router
 * slot for the full plan timeout. A page that fails or runs out of time after the first one ends
 * the search with what was found (`partial`). A stop the router does not hold is asked for again
 * with a stops.txt row of its station; those calls count toward the three.
 */
export async function searchJourneys(
  query: JourneyQuery,
  context: JourneyContext,
): Promise<JourneysResponse> {
  const started = context.elapsed?.() ?? 0;
  const categories = query.categories ?? [...CATEGORY_CODES];
  const filter = createJourneyFilter({
    categories,
    exclude: query.exclude,
    operators: query.operators,
    avoidOperators: query.avoidOperators,
  });
  const time = new Date(query.time ?? context.now()).toISOString();
  const prefix = `${context.datasetTag}_`;
  const base: PlanRequest = {
    fromPlace: `${prefix}${query.from}`,
    toPlace: `${prefix}${query.to}`,
    time,
    arriveBy: query.arriveBy,
    transitModes: transitModesFor(categories),
    numItineraries: Math.max(
      filter.postFilters ? FILTERED_ITINERARIES : BASE_ITINERARIES,
      query.results,
    ),
    maxTransfers: query.maxChanges,
    pageCursor: query.cursor,
    detailedLegs: query.geometry,
    signal: context.signal,
  };

  const collected = collector(filter);
  const { request: held, page: first, attempts } = await firstPage(base, context, prefix);
  collected.absorb(first);
  const pages: Pages = {
    earlierCursor: first.previousPageCursor ?? null,
    laterCursor: first.nextPageCursor ?? null,
    routerCalls: attempts,
    partial: false,
  };
  await fillUp(query, held, collected, pages, context, started);

  const sort = query.sort ?? defaultSort(query.arriveBy);
  const { removedBy } = collected;
  const naming: Naming = { prefix, stopName: context.stopName, trainRun: context.trainRun };
  return {
    query: {
      from: query.from,
      to: query.to,
      time: query.cursor ? null : time,
      arriveBy: query.arriveBy,
      categories,
      exclude: query.exclude,
      operators: query.operators,
      avoidOperators: query.avoidOperators,
      maxChanges: query.maxChanges ?? null,
      sort,
      results: query.results,
      geometry: query.geometry,
    },
    journeys: rankJourneys(
      collected.kept.map((itinerary) => toJourney(itinerary, naming, query.geometry)),
      sort,
    ),
    removedByFilter: removedBy.category + removedBy.product + removedBy.operator,
    removedBy,
    ...pages,
  };
}
