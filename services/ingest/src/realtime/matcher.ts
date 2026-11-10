import type { StopRef, StopTimeObservation, TripObservation } from "@gerlines/schema";
import { normalizeTrainNumber, tripInstanceId } from "@gerlines/schema/ids";
import {
  addDays,
  localDate,
  serviceDayReference,
  serviceInstant,
} from "@gerlines/schema/service-day";
import { DELFI_FOLD_SOURCES } from "./adapters.ts";
import type { ForeignTimetable } from "./foreign-timetable.ts";
import { IRIS_EVA_ALIASES, IRIS_SOURCE } from "./iris.ts";
import { NO_TIME, type StaticTrip, Timetable, type TripRun } from "./timetable.ts";
import { type Alignment, alignTrainNumber, indexByAlignment } from "./train-number-alignment.ts";

export type MatchMethod =
  | "trip_id"
  | "trip_id_other_version"
  | "stops_and_times"
  | "train_number"
  | "added";

/** Where one observed stop lands in the canonical trip run, by stop index. */
export interface StopPlacement {
  readonly index: number;
  readonly observed: StopTimeObservation;
  readonly actualStopPointId: string | null;
}

export interface MatchedTrip {
  readonly kind: "matched";
  readonly method: MatchMethod;
  readonly run: TripRun;
  readonly placements: readonly StopPlacement[];
  readonly unplacedStops: number;
}

export interface AddedRun {
  readonly instanceId: string;
  readonly serviceDate: string;
  readonly stopPlaces: readonly string[];
  readonly scheduled: readonly { arrival: number | null; departure: number | null }[];
}

export interface UnmatchedTrip {
  readonly kind: "unmatched";
  readonly reason: string;
  readonly serviceDate: string;
  readonly detail: Readonly<Record<string, string | number | null>>;
}

export interface OutOfScope {
  readonly kind: "out_of_scope";
  readonly reason: string;
}

export type MatchOutcome = MatchedTrip | UnmatchedTrip | OutOfScope;

/** Country of each neighbour feed, for train number matches. */
const SOURCE_COUNTRY: Record<string, string> = {
  "cz-czptt-gtfs-rt": "CZ",
  "fr-sncf-gtfs-rt": "FR",
  "pl-pkpic-gtfs-rt": "PL",
  "pl-trains-gtfs-rt": "PL",
  "ch-otd-gtfs-rt": "CH",
  "ovapi-train-updates": "NL",
  "be-sncb-gtfs-rt": "BE",
};

/**
 * Regional feeds whose stop ids are DELFI DHIDs and whose route ids end in the extended route type
 * like DELFI's; their own trip ids name nothing we load, so they match by stops and times.
 */
const DHID_SOURCES: ReadonlySet<string> = new Set(["vbb-gtfs-rt"]);

const RAIL_ROUTE_TYPE = /_(2|1(0\d|1[0-7]))$/;

/** DELFI route ids end in `_<extended route type>`; rail is 2 and 100 to 117. */
export function delfiRouteIsRail(routeId: string | null): boolean | null {
  if (!routeId) return null;
  const suffix = /_(\d{1,4})$/.exec(routeId);
  if (!suffix) return null;
  return RAIL_ROUTE_TYPE.test(routeId);
}

/** Timetable versions held in memory at once (about 235 MB of heap each, stops shared). */
export const MAX_TIMETABLES = 2;

const isDelfi = (source: string): boolean => DELFI_FOLD_SOURCES.has(source);

function observedServiceDate(observation: TripObservation): string {
  return observation.startDate ?? localDate(observation.observedAt);
}

function byPublication(a: Timetable, b: Timetable): number {
  const left = a.data.publishedOn ?? "";
  const right = b.data.publishedOn ?? "";
  return left.localeCompare(right) || a.feedVersionId - b.feedVersionId;
}

function unmatched(
  observation: TripObservation,
  reason: string,
  detail: Record<string, string | number | null> = {},
): UnmatchedTrip {
  return {
    kind: "unmatched",
    reason,
    serviceDate: observedServiceDate(observation),
    detail: {
      tripId: observation.sourceTripId,
      routeId: observation.routeId,
      trainNumber: observation.trainNumber,
      ...detail,
    },
  };
}

/** Index of each place in a trip's stop order, for placing observations by place. */
function placeIndexes(trip: StaticTrip): Map<string, number[]> {
  const indexes = new Map<string, number[]>();
  trip.stopPlaces.forEach((place, index) => {
    const list = indexes.get(place) ?? [];
    list.push(index);
    indexes.set(place, list);
  });
  return indexes;
}

/**
 * Matches realtime trips to trip runs of the loaded timetable versions (at most `MAX_TIMETABLES`);
 * id-based results are cached per trip and day.
 */
export class Matcher {
  private foreignTables: ReadonlyMap<string, ForeignTimetable>;
  private tables: Timetable[];
  private readonly sequenceIndex = new WeakMap<StaticTrip, Map<number, number>>();
  private readonly placeIndex = new WeakMap<StaticTrip, Map<string, number[]>>();
  private readonly cache = new Map<string, MatchOutcome>();
  private readonly signatureIndex = new Map<string, DayIndex>();

  constructor(
    timetables: Timetable | readonly Timetable[],
    foreign: ReadonlyMap<string, ForeignTimetable> = new Map(),
  ) {
    const list = timetables instanceof Timetable ? [timetables] : [...timetables];
    if (list.length === 0) throw new Error("the matcher needs at least one timetable version");
    this.tables = list.sort(byPublication).slice(-MAX_TIMETABLES);
    this.foreignTables = foreign;
  }

  get foreign(): ReadonlyMap<string, ForeignTimetable> {
    return this.foreignTables;
  }

  /** Takes newer recorded statics of the sources matched by their own timetable. */
  replaceForeign(foreign: ReadonlyMap<string, ForeignTimetable>): void {
    this.foreignTables = foreign;
    this.cache.clear();
  }

  /** Drops a version from memory; the newest one always stays. */
  removeTimetable(feedVersionId: number): void {
    if (this.tables.length < 2 || this.timetable.feedVersionId === feedVersionId) return;
    this.tables = this.tables.filter((table) => table.feedVersionId !== feedVersionId);
    this.cache.clear();
    this.signatureIndex.clear();
  }

  /** Forgets cached outcomes and the per-day indexes and runs of service days before `day`. */
  dropBefore(day: string): void {
    this.cache.clear();
    for (const key of [...this.signatureIndex.keys()]) {
      if ((key.split("|")[1] ?? "") < day) this.signatureIndex.delete(key);
    }
    for (const table of this.tables) table.dropBefore(day);
  }

  /** Match outcomes cached for the current days, for memory reports. */
  cachedOutcomes(): number {
    return this.cache.size;
  }

  /** Days held in the per-day indexes and run caches, for memory reports. */
  cachedDays(): number {
    return this.signatureIndex.size + this.tables.reduce((sum, table) => sum + table.cachedDays, 0);
  }

  /** The newest loaded version: stops, places and platforms are read from it. */
  get timetable(): Timetable {
    return this.tables[this.tables.length - 1] as Timetable;
  }

  get timetables(): readonly Timetable[] {
    return this.tables;
  }

  /** Feed version strings of the loaded versions, oldest first. */
  versions(): string[] {
    return this.tables.map((table) => table.data.feedVersion ?? `#${table.feedVersionId}`);
  }

  /**
   * Adds a version that reached `loaded`, keeping the newest `MAX_TIMETABLES`. Cached outcomes and
   * indexes are dropped, since the version chosen for a day may change.
   */
  addTimetable(table: Timetable): void {
    const others = this.tables.filter((other) => other.feedVersionId !== table.feedVersionId);
    this.tables = [...others, table].sort(byPublication).slice(-MAX_TIMETABLES);
    this.cache.clear();
    this.signatureIndex.clear();
  }

  byVersion(feedVersion: string): Timetable | undefined {
    return this.tables.find((table) => table.data.feedVersion === feedVersion);
  }

  /**
   * The version a service day is read against when the record names none: the newest one published
   * before that day (DELFI realtime moved to the 2026-10-26 feed during the night to 2026-10-27),
   * else the oldest loaded.
   */
  forServiceDate(serviceDate: string): Timetable {
    let chosen = this.tables[0] as Timetable;
    for (const table of this.tables) {
      if (table.data.publishedOn && table.data.publishedOn < serviceDate) chosen = table;
    }
    return chosen;
  }

  private tableOf(run: TripRun): Timetable {
    return this.tables.find((table) => table.feedVersionId === run.feedVersionId) ?? this.timetable;
  }

  /**
   * Matches one realtime trip. `feedVersion` is the static feed version the payload's ids refer to
   * (the GTFS-RT header's `feed_version`, when the source sends one): DELFI trip ids are read only
   * against that version, so a payload of a newer feed never matches the wrong trip.
   */
  match(observation: TripObservation, feedVersion: string | null = null): MatchOutcome {
    const key = `${observation.source}\x1f${observation.sourceTripId ?? observation.entityId}\x1f${observation.startDate ?? ""}\x1f${observation.trainNumber ?? ""}\x1f${feedVersion ?? ""}`;
    let outcome = this.cache.get(key);
    if (!outcome) {
      outcome = this.resolve(observation, feedVersion);
      const byIds = observation.relationship !== "added" && observation.startDate !== null;
      const versionKnown =
        feedVersion === null || !isDelfi(observation.source) || this.byVersion(feedVersion);
      const byStops = this.idInOtherVersionOnly(observation, feedVersion);
      if (byIds && versionKnown && !byStops && this.byIdsOnly(observation.source)) {
        this.cache.set(key, outcome);
      }
    }
    if (outcome.kind !== "matched" || outcome.method === "added") return outcome;
    return { ...outcome, ...this.place(outcome.run, observation, outcome.method) };
  }

  /**
   * Sources whose outcome follows from trip id and start date alone (DELFI, and gtfs.de through its
   * own timetable), so it may be cached; trips a source adds or sends without a start date are not. Others match by the stops and
   * times of each observation, which change from payload to payload; caching their first outcome
   * would make the result depend on the order payloads arrive in.
   */
  private byIdsOnly(source: string): boolean {
    return isDelfi(source) || this.foreign.has(source);
  }

  private resolve(observation: TripObservation, feedVersion: string | null): MatchOutcome {
    if (isDelfi(observation.source)) {
      if (feedVersion === null) {
        return this.resolveDelfi(
          observation,
          this.forServiceDate(observedServiceDate(observation)),
        );
      }
      const table = this.byVersion(feedVersion);
      if (table) return this.resolveDelfi(observation, table);
      return this.resolveUnloadedVersion(observation, feedVersion);
    }
    if (observation.source === IRIS_SOURCE) return this.resolveIris(observation);
    const foreign = this.foreign.get(observation.source);
    if (foreign) return this.resolveBySchedule(observation, foreign);
    if (DHID_SOURCES.has(observation.source) && delfiRouteIsRail(observation.routeId) === false)
      return { kind: "out_of_scope", reason: "not_rail" };
    return this.resolveNeighbour(observation);
  }

  /**
   * A DELFI record whose trip id the version it names lacks but another loaded version has: DELFI
   * realtime keeps sending some trips under the ids of the previous version for a while after it
   * moves on. Its outcome depends on the stops it reports, so it is never cached.
   */
  private idInOtherVersionOnly(observation: TripObservation, feedVersion: string | null): boolean {
    const id = observation.sourceTripId;
    if (!id || !isDelfi(observation.source)) return false;
    const named =
      feedVersion === null
        ? this.forServiceDate(observedServiceDate(observation))
        : this.byVersion(feedVersion);
    if (!named || named.tripsByKey.has(id)) return false;
    return this.tables.some((table) => table !== named && table.tripsByKey.has(id));
  }

  /** The trip a DELFI id names in another loaded version, if the stops the record reports agree. */
  private otherVersionTrip(
    observation: TripObservation,
    table: Timetable,
  ): { trip: StaticTrip; table: Timetable } | undefined {
    const id = observation.sourceTripId;
    if (!id) return undefined;
    for (const other of [...this.tables].reverse()) {
      if (other === table) continue;
      const trip = other.tripsByKey.get(id);
      if (trip && this.stopsAgree(observation, trip)) return { trip, table: other };
    }
    return undefined;
  }

  /** Whether at least three in four reported stops with a known place sit at that place in the trip. */
  private stopsAgree(observation: TripObservation, trip: StaticTrip): boolean {
    const sequences = this.sequenceToIndex(trip);
    let compared = 0;
    let agreeing = 0;
    for (const stop of observation.stops) {
      const places = this.placesOf(stop.stop, observation.source);
      if (places.length === 0) continue;
      compared += 1;
      const index = stop.stopSequence === null ? undefined : sequences.get(stop.stopSequence);
      const place = index === undefined ? undefined : trip.stopPlaces[index];
      if (place !== undefined && places.includes(place)) agreeing += 1;
    }
    return agreeing >= 0.75 * compared;
  }

  private resolveDelfi(observation: TripObservation, table: Timetable): MatchOutcome {
    const own = observation.sourceTripId
      ? table.tripsByKey.get(observation.sourceTripId)
      : undefined;
    const other = own ? undefined : this.otherVersionTrip(observation, table);
    const trip = own ?? other?.trip;
    const source = other?.table ?? table;
    if (!trip) {
      if (observation.relationship === "added") return this.resolveAdded(observation);
      const rail = delfiRouteIsRail(observation.routeId);
      if (rail === false) return { kind: "out_of_scope", reason: "not_rail" };
      return unmatched(observation, rail ? "trip_not_in_timetable" : "unknown_route_type");
    }
    const serviceDate = observation.startDate;
    if (!serviceDate) return unmatched(observation, "no_start_date");
    const run = source.runsOn(serviceDate).get(trip.tripKey);
    if (!run) return unmatched(observation, "service_not_active", { serviceDate });
    return this.matched(run, other ? "trip_id_other_version" : "trip_id", source);
  }

  /**
   * A DELFI record whose feed version is not loaded yet: its trip ids may name other trains, so it is
   * matched by its stops and times against the newest loaded version; what does not match waits in
   * the backlog until the version is loaded and the source is folded again.
   */
  private resolveUnloadedVersion(observation: TripObservation, feedVersion: string): MatchOutcome {
    if (observation.relationship === "added") return this.resolveAdded(observation);
    if (delfiRouteIsRail(observation.routeId) === false) {
      return { kind: "out_of_scope", reason: "not_rail" };
    }
    const fallback = this.byReportedStops(observation, this.timetable);
    if (fallback.kind === "matched") return fallback;
    return unmatched(observation, "feed_version_not_loaded", {
      feedVersion,
      loaded: this.versions().join(","),
      fallback: fallback.reason,
    });
  }

  private matched(run: TripRun, method: MatchMethod, table: Timetable): MatchedTrip {
    const canonical = table.canonicalRun(run.instanceId, run.serviceDate) ?? run;
    return { kind: "matched", method, run: canonical, placements: [], unplacedStops: 0 };
  }

  /**
   * A trip the source added: a run of its own when every stop is a rail stop point of the timetable
   * and the first stop has a time; its schedule is the source's time minus its delay.
   */
  private resolveAdded(observation: TripObservation): MatchOutcome {
    const points = observation.stops.map((stop) => this.delfiPoint(stop.stop));
    const resolved = points.filter((point): point is string => point !== null);
    if (resolved.length < 2) return { kind: "out_of_scope", reason: "added_not_rail" };
    if (resolved.length < points.length) {
      return unmatched(observation, "added_stops_unknown", {
        stops: points.length,
        resolved: resolved.length,
      });
    }
    const serviceDate = observation.startDate;
    if (!serviceDate) return unmatched(observation, "no_start_date");
    const reference = serviceDayReference(serviceDate) / 1000;
    const scheduled = (time: StopTimeObservation["arrival"]): number =>
      time?.time == null ? NO_TIME : time.time - (time.delaySeconds ?? 0) - reference;
    const arrivals = Int32Array.from(observation.stops, (stop) => scheduled(stop.arrival));
    const departures = Int32Array.from(observation.stops, (stop) => scheduled(stop.departure));
    const first = departures[0] !== NO_TIME ? departures[0] : arrivals[0];
    if (first === undefined || first === NO_TIME)
      return unmatched(observation, "added_without_times");
    const places = resolved.map((point) => this.timetable.placeOfPoint(point));
    const stopPlaces = places.filter((value): value is string => value !== undefined);
    if (stopPlaces.length < places.length) {
      return unmatched(observation, "added_stops_unknown", {
        stops: places.length,
        placed: stopPlaces.length,
      });
    }
    const trip: StaticTrip = {
      tripKey: `added:${observation.sourceTripId ?? observation.entityId}`,
      routeKey: observation.routeId ?? "",
      serviceKey: "",
      operatorId: null,
      trainNumber: null,
      categoryCode: "added",
      isForeign: false,
      stopPoints: resolved,
      stopPlaces,
      stopSequences: Int32Array.from(
        observation.stops,
        (stop, index) => stop.stopSequence ?? index,
      ),
      arrivals,
      departures,
    };
    const originDeparture = serviceInstant(serviceDate, first);
    const run: TripRun = {
      instanceId: tripInstanceId({
        serviceDate,
        operatorId: null,
        trainNumber: null,
        originStopPlaceId: stopPlaces[0] ?? "",
        originDeparture,
      }),
      serviceDate,
      trip,
      originDeparture,
      added: true,
    };
    const placements = observation.stops.map((stop, index) => ({
      index,
      observed: stop,
      actualStopPointId: null,
    }));
    return { kind: "matched", method: "added", run, placements, unplacedStops: 0 };
  }

  private delfiPoint(stop: StopRef | null): string | null {
    if (stop?.kind !== "source") return null;
    return this.timetable.data.delfiStopPoints.get(stop.id) ?? null;
  }

  /** Places of a UIC or EVA code; for IRIS a meta EVA without places of its own takes its main station's. */
  private placesOfCode(code: number, source: string): string[] {
    const own = this.timetable.placesByUic.get(code);
    if (own || source !== IRIS_SOURCE) return own ?? [];
    const main = IRIS_EVA_ALIASES.get(code);
    return main === undefined ? [] : (this.timetable.placesByUic.get(main) ?? []);
  }

  /** Stop places a source's stop reference stands for (DELFI ids, UIC or EVA codes, foreign ids). */
  placesOf(stop: StopRef | null, source: string): string[] {
    if (!stop) return [];
    if (stop.kind === "uic") return this.placesOfCode(stop.code, source);
    if (isDelfi(source) || DHID_SOURCES.has(source)) {
      const point = this.timetable.data.delfiStopPoints.get(stop.id);
      const place = point
        ? this.timetable.placeOfPoint(point)
        : this.timetable.data.delfiStopPlaces.get(stop.id);
      return place ? [place] : [];
    }
    const place = this.foreign.get(source)?.placeOfStop(stop.id);
    return place ? [place] : [];
  }

  /** Index of the trip runs of one service day by (place, scheduled minute), built on first use. */
  private dayIndex(table: Timetable, serviceDate: string): DayIndex {
    const key = `${table.feedVersionId}|${serviceDate}`;
    const cached = this.signatureIndex.get(key);
    if (cached) return cached;
    const index = new DayIndex(serviceDate, table.runsOn(serviceDate).values());
    this.signatureIndex.set(key, index);
    return index;
  }

  /**
   * Runs that may call on a local calendar day: those of the service day before (past midnight),
   * of the day itself, and of the day after (its first hour lies in the evening before when clocks
   * go forward).
   */
  private runsAround(table: Timetable, day: string): DayIndex[] {
    return [addDays(day, -1), day, addDays(day, 1)].map((date) => this.dayIndex(table, date));
  }

  /**
   * Matches by the stops and scheduled times a source reports: the run that fits most of them (place
   * and minute, one minute either way) wins, if it fits at least two stops and three quarters of the
   * resolvable ones. Among runs fitting as many, the one with the fewest stops left over wins, then
   * the one with the most exact minutes; runs still level are ambiguous unless they share every
   * place and time (the same train filed twice, or coupled units), when the smallest trip key wins.
   */
  private bySignature(
    observation: TripObservation,
    stops: readonly SignatureStop[],
    table: Timetable,
  ): MatchOutcome {
    const first = stops[0];
    if (!first || stops.length < 2) return unmatched(observation, "too_few_known_stops");
    const ranked = rankRuns(this.runsAround(table, localDate(first.instant)), stops);
    const best = ranked[0];
    if (!best || best.fits < 2 || best.fits < 0.75 * stops.length) {
      return unmatched(observation, "no_timetable_candidate", { knownStops: stops.length });
    }
    const bestRun = table.canonicalRun(best.run.instanceId, best.run.serviceDate);
    for (const other of ranked.slice(1)) {
      if (compareCandidates(best, other) !== 0) break;
      const otherRun = table.canonicalRun(other.run.instanceId, other.run.serviceDate);
      if (bestRun !== otherRun && !sameSchedule(best.run, other.run)) {
        return unmatched(observation, "ambiguous_candidates", { fits: best.fits });
      }
    }
    return this.matched(best.run, "stops_and_times", table);
  }

  private resolveBySchedule(observation: TripObservation, foreign: ForeignTimetable): MatchOutcome {
    const trip = observation.sourceTripId ? foreign.trip(observation.sourceTripId) : undefined;
    if (!trip) return { kind: "out_of_scope", reason: "not_rail" };
    const serviceDate = observation.startDate;
    if (!serviceDate) return unmatched(observation, "no_start_date");
    const stops = trip.stopIds.flatMap((stopId, index) => {
      const place = foreign.placeOfStop(stopId);
      const seconds = trip.times[index] ?? NO_TIME;
      if (!place || seconds === NO_TIME) return [];
      return [{ places: [place], instant: serviceInstant(serviceDate, seconds) }];
    });
    return this.bySignature(observation, stops, this.forServiceDate(serviceDate));
  }

  /** Scheduled place and instant of each stop a record reports (its time minus its delay). */
  private reportedStops(observation: TripObservation): SignatureStop[] {
    return observation.stops.flatMap((stop) => {
      const places = this.placesOf(stop.stop, observation.source);
      const time = stop.departure ?? stop.arrival;
      if (places.length === 0 || time?.time == null) return [];
      return [{ places, instant: (time.time - (time.delaySeconds ?? 0)) * 1000 }];
    });
  }

  private byReportedStops(observation: TripObservation, table: Timetable): MatchOutcome {
    return this.bySignature(observation, this.reportedStops(observation), table);
  }

  private resolveNeighbour(observation: TripObservation): MatchOutcome {
    const stops = this.reportedStops(observation);
    const first = stops[0];
    if (first && stops.length >= 2) {
      const day = observation.startDate ?? localDate(first.instant);
      return this.bySignature(observation, stops, this.forServiceDate(day));
    }
    if (observation.trainNumber) return this.byTrainNumber(observation);
    return unmatched(
      observation,
      observation.stops.length === 0 ? "no_stops" : "no_static_for_source",
    );
  }

  /**
   * A train number only identifies a cross-border train that calls in the source's own country and
   * whose schedule agrees with the times the source reports (see `alignTrainNumber`).
   */
  private byTrainNumber(observation: TripObservation): MatchOutcome {
    const country = SOURCE_COUNTRY[observation.source];
    if (!country) return unmatched(observation, "no_static_for_source");
    const serviceDate = observedServiceDate(observation);
    const table = this.forServiceDate(serviceDate);
    const days = observation.startDate ? [serviceDate] : [addDays(serviceDate, -1), serviceDate];
    const trips = table
      .tripsWithNumber(observation.trainNumber)
      .filter((trip) => trip.stopPlaces.some((place) => this.inCountry(place, country)));
    const candidates = days.flatMap((day) => {
      const runs = table.runsOn(day);
      return trips.flatMap((trip) => runs.get(trip.tripKey) ?? []);
    });
    if (candidates.length === 0) return unmatched(observation, "train_number_not_in_timetable");
    const agreeing = candidates.filter((run) => alignTrainNumber(run, observation.stops) !== null);
    const instances = new Set(agreeing.map((run) => run.instanceId));
    if (instances.size === 0) return unmatched(observation, "train_number_times_differ");
    if (instances.size > 1) return unmatched(observation, "ambiguous_train_number");
    const [run] = agreeing;
    return run ? this.matched(run, "train_number", table) : unmatched(observation, "no_candidate");
  }

  /** Planned place and instant of each IRIS stop at a place we know, departure first. */
  private plannedStops(observation: TripObservation): IrisPlannedStop[] {
    const stops = [...observation.stops, ...(observation.plannedStops ?? [])];
    return stops.flatMap((stop) => {
      const places = this.placesOf(stop.stop, observation.source);
      const arrival = stop.scheduled?.arrival ?? null;
      const departure = stop.scheduled?.departure ?? null;
      if (places.length === 0 || (arrival === null && departure === null)) return [];
      return [{ places, arrival, departure }];
    });
  }

  /**
   * A DB Timetables (IRIS) trip, matched as `matchIris` reads it; IRIS is a source for hsr, ld and
   * night runs only (D-041), so a match on any other run is out of scope.
   */
  private resolveIris(observation: TripObservation): MatchOutcome {
    const outcome = this.matchIris(observation);
    if (outcome.kind === "matched" && !LONG_DISTANCE_CATEGORIES.has(outcome.run.trip.categoryCode))
      return { kind: "out_of_scope", reason: "iris_not_long_distance" };
    return outcome;
  }

  /**
   * By train number on its start day or the day before, where the run calls at half of the planned
   * stops within a minute of IRIS's planned time; else by planned stops and times among runs with no
   * other number (two stops and three in four of them). One stop is enough only for exactly one run
   * of the kind IRIS names calling there then: for a train without a number of the long distance kind
   * IRIS files it under, for a numbered one of the category its label names (ICE an hsr run, FLX an
   * ld run). Runs of the kind IRIS names win a tie.
   */
  private matchIris(observation: TripObservation): MatchOutcome {
    const day = observation.startDate;
    if (!day) return unmatched(observation, "no_start_date");
    const stops = this.plannedStops(observation);
    if (stops.length === 0) return unmatched(observation, "no_planned_stop_known");
    const table = this.forServiceDate(day);
    const number = normalizeTrainNumber(observation.trainNumber);
    if (number !== null) {
      const runs = [addDays(day, -1), day].flatMap((date) => {
        const byKey = table.runsOn(date);
        return table.tripsWithNumber(number).flatMap((trip) => byKey.get(trip.tripKey) ?? []);
      });
      const fitting = this.irisFits(runs, stops).filter((fit) => fit.fits * 2 >= stops.length);
      if (fitting.length > 0) return this.irisChoice(observation, fitting, table, "train_number");
    }
    const single = stops.length === 1 && this.irisSingleStopRule(observation, number) !== null;
    const needed = single ? 1 : Math.max(2, Math.ceil(0.75 * stops.length));
    const fitting = this.irisFits(this.irisRunsNear(table, stops, number), stops).filter(
      (fit) =>
        fit.fits >= needed && (!single || this.irisSingleStopFits(observation, number, fit.run)),
    );
    if (fitting.length > 0) return this.irisChoice(observation, fitting, table, "stops_and_times");
    const reason =
      number === null
        ? "no_timetable_candidate"
        : table.tripsWithNumber(number).length > 0
          ? "train_number_times_differ"
          : "train_number_not_in_timetable";
    return unmatched(observation, reason, { knownStops: stops.length });
  }

  /** Runs calling at a planned stop around its planned time that carry no other train number. */
  private irisRunsNear(
    table: Timetable,
    stops: readonly IrisPlannedStop[],
    number: string | null,
  ): TripRun[] {
    const near = new Set<TripRun>();
    const visit = (run: TripRun) => {
      if (run.trip.trainNumber === null || run.trip.trainNumber === number) near.add(run);
    };
    for (const stop of stops) {
      const instant = (stop.departure ?? stop.arrival ?? 0) * 1000;
      const minute = Math.round(instant / 60_000);
      const after = stop.departure === null ? IRIS_LONGEST_DWELL_MIN : 1;
      for (const index of this.runsAround(table, localDate(instant))) {
        for (const place of stop.places) index.near(place, minute, visit, after);
      }
    }
    return [...near];
  }

  /** How many planned stops each run calls at within a minute of the planned arrival or departure. */
  private irisFits(runs: readonly TripRun[], stops: readonly IrisPlannedStop[]): IrisFit[] {
    return runs.flatMap((run) => {
      const places = this.placeIndexOf(run.trip);
      let fits = 0;
      for (const stop of stops) {
        const indexes = stop.places.flatMap((place) => places.get(place) ?? []);
        if (indexes.some((index) => callsAt(run, index, stop))) fits += 1;
      }
      return fits > 0 ? [{ run, fits }] : [];
    });
  }

  /** What a single known stop must agree on: the category a numbered train's label names, else the kind. */
  private irisSingleStopRule(
    observation: TripObservation,
    number: string | null,
  ): "category" | "kind" | null {
    if (number !== null) return irisLabelCategory(observation.categoryLabel) ? "category" : null;
    return typeof observation.longDistance === "boolean" ? "kind" : null;
  }

  private irisSingleStopFits(
    observation: TripObservation,
    number: string | null,
    run: TripRun,
  ): boolean {
    const rule = this.irisSingleStopRule(observation, number);
    if (rule === "category")
      return irisLabelCategory(observation.categoryLabel) === run.trip.categoryCode;
    return rule === "kind" && this.irisKind(observation, run);
  }

  private irisKind(observation: TripObservation, run: TripRun): boolean {
    if (typeof observation.longDistance !== "boolean") return true;
    return LONG_DISTANCE_CATEGORIES.has(run.trip.categoryCode) === observation.longDistance;
  }

  /** The one train among fitting runs: most stops fitted, then the kind IRIS names, else ambiguous. */
  private irisChoice(
    observation: TripObservation,
    fitting: readonly IrisFit[],
    table: Timetable,
    method: MatchMethod,
  ): MatchOutcome {
    const best = Math.max(...fitting.map((fit) => fit.fits));
    const top = fitting.filter((fit) => fit.fits === best);
    const ofKind = top.filter((fit) => this.irisKind(observation, fit.run));
    const chosen = ofKind.length > 0 ? ofKind : top;
    const trains = new Map<string, TripRun>();
    for (const { run } of chosen) {
      const canonical = table.canonicalRun(run.instanceId, run.serviceDate) ?? run;
      trains.set(canonical.instanceId, canonical);
    }
    if (trains.size > 1) {
      const reason = method === "train_number" ? "ambiguous_train_number" : "ambiguous_candidates";
      return unmatched(observation, reason, { fits: best, candidates: trains.size });
    }
    const [run] = trains.values();
    return run ? this.matched(run, method, table) : unmatched(observation, "no_candidate");
  }

  private inCountry(placeId: string, country: string): boolean {
    return this.timetable.data.stopPlaces.get(placeId)?.countryCode === country;
  }

  private sequenceToIndex(trip: StaticTrip): Map<number, number> {
    let map = this.sequenceIndex.get(trip);
    if (!map) {
      map = new Map(Array.from(trip.stopSequences, (sequence, index) => [sequence, index]));
      this.sequenceIndex.set(trip, map);
    }
    return map;
  }

  private placeIndexOf(trip: StaticTrip): Map<string, number[]> {
    let map = this.placeIndex.get(trip);
    if (!map) {
      map = placeIndexes(trip);
      this.placeIndex.set(trip, map);
    }
    return map;
  }

  /** Places observed stops on the canonical run: by stop sequence of the matched trip, else by place. */
  private place(
    run: TripRun,
    observation: TripObservation,
    method: MatchMethod,
  ): { placements: StopPlacement[]; unplacedStops: number } {
    const ownTrip =
      (method === "trip_id" || method === "trip_id_other_version") && observation.sourceTripId
        ? this.tableOf(run).tripsByKey.get(observation.sourceTripId)
        : undefined;
    const context: PlacementContext = {
      canonical: run.trip,
      ownTrip,
      sequences: ownTrip ? this.sequenceToIndex(ownTrip) : undefined,
      places: this.placeIndexOf(run.trip),
      source: observation.source,
      byTime: method === "train_number" ? this.timeOffset(run, observation) : undefined,
      planned: observation.source === IRIS_SOURCE ? run : undefined,
    };
    const placements: StopPlacement[] = [];
    let unplaced = 0;
    let after = -1;
    for (const stop of observation.stops) {
      const index = this.indexOf(stop, context, after);
      if (index === undefined) {
        unplaced += 1;
        continue;
      }
      after = index;
      placements.push({
        index,
        observed: stop,
        actualStopPointId: this.actualPoint(stop, context),
      });
    }
    return { placements, unplacedStops: unplaced };
  }

  private indexOf(
    stop: StopTimeObservation,
    context: PlacementContext,
    after: number,
  ): number | undefined {
    const ownIndex =
      context.sequences && stop.stopSequence !== null
        ? context.sequences.get(stop.stopSequence)
        : undefined;
    if (context.ownTrip === context.canonical && ownIndex !== undefined) return ownIndex;
    const candidates =
      context.ownTrip && ownIndex !== undefined
        ? [context.ownTrip.stopPlaces[ownIndex] ?? ""]
        : this.placesOf(stop.stop, context.source);
    const later = candidates
      .flatMap((place) => context.places.get(place) ?? [])
      .filter((value) => value > after)
      .sort((a, b) => a - b);
    const planned = context.planned;
    const scheduled = stop.scheduled;
    const onTime =
      planned && scheduled && later.length > 1
        ? later.find((index) => callsAt(planned, index, scheduled))
        : undefined;
    const byPlace = onTime ?? later[0];
    if (byPlace !== undefined || !context.byTime) return byPlace;
    return indexByAlignment(context.byTime.run, context.byTime.alignment, stop, after);
  }

  private timeOffset(
    run: TripRun,
    observation: TripObservation,
  ): { run: TripRun; alignment: Alignment } | undefined {
    const alignment = alignTrainNumber(run, observation.stops);
    return alignment === null ? undefined : { run, alignment };
  }

  private actualPoint(stop: StopTimeObservation, context: PlacementContext): string | null {
    return isDelfi(context.source) ? this.delfiPoint(stop.assignedStop ?? stop.stop) : null;
  }
}

interface PlacementContext {
  readonly canonical: StaticTrip;
  readonly ownTrip: StaticTrip | undefined;
  readonly sequences: Map<number, number> | undefined;
  readonly places: Map<string, number[]>;
  readonly source: string;
  /** For train number matches, whose stops carry no ids we know: how they line up with the run. */
  readonly byTime: { readonly run: TripRun; readonly alignment: Alignment } | undefined;
  /** For IRIS, whose stops carry planned times: the run, so a station called twice is told apart. */
  readonly planned: TripRun | undefined;
}

interface IrisPlannedStop {
  readonly places: readonly string[];
  readonly arrival: number | null;
  readonly departure: number | null;
}

interface IrisFit {
  readonly run: TripRun;
  readonly fits: number;
}

const LONG_DISTANCE_CATEGORIES: ReadonlySet<string> = new Set(["hsr", "ld", "night"]);

/** The category of the long distance labels IRIS uses, as the static import reads line names. */
const IRIS_LABEL_CATEGORY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(["ICE", "TGV", "THA", "RJX", "ES", "EST", "FR"].map((c) => [c, "hsr"])),
  ...Object.fromEntries(["IC", "EC", "ECE", "ECM", "FLX", "RJ", "D"].map((c) => [c, "ld"])),
  ...Object.fromEntries(["EN", "NJ"].map((c) => [c, "night"])),
};

function irisLabelCategory(label: string | null | undefined): string | null {
  return label ? (IRIS_LABEL_CATEGORY[label.toUpperCase()] ?? null) : null;
}
const IRIS_TIME_TOLERANCE_S = 60;
/** The day index files a call under its departure: an arrival-only stop looks this far ahead. */
const IRIS_LONGEST_DWELL_MIN = 20;

/** Whether a run's arrival or departure at a stop index is within a minute of the planned one. */
function callsAt(
  run: TripRun,
  index: number,
  stop: Pick<IrisPlannedStop, "arrival" | "departure">,
): boolean {
  const near = (seconds: number | undefined, planned: number | null) =>
    planned !== null &&
    seconds !== undefined &&
    seconds !== NO_TIME &&
    Math.abs(serviceInstant(run.serviceDate, seconds) / 1000 - planned) <= IRIS_TIME_TOLERANCE_S;
  return (
    near(run.trip.departures[index], stop.departure) || near(run.trip.arrivals[index], stop.arrival)
  );
}

interface SignatureStop {
  readonly places: readonly string[];
  readonly instant: number;
}

/**
 * The trip runs of one service day by place, each place's calls sorted by scheduled minute: about
 * 12 bytes per call (a day holds some 560,000), where string keys per place and minute took ten
 * times as much.
 */
class DayIndex {
  private readonly byPlace = new Map<string, { minutes: Int32Array; runs: TripRun[] }>();

  constructor(day: string, runs: Iterable<TripRun>) {
    const calls = new Map<string, { minute: number; run: TripRun }[]>();
    for (const run of runs) {
      const trip = run.trip;
      for (let stop = 0; stop < trip.stopPlaces.length; stop += 1) {
        const departure = trip.departures[stop] ?? NO_TIME;
        const seconds = departure !== NO_TIME ? departure : (trip.arrivals[stop] ?? NO_TIME);
        if (seconds === NO_TIME) continue;
        const place = trip.stopPlaces[stop] ?? "";
        const list = calls.get(place) ?? [];
        list.push({ minute: Math.round(serviceInstant(day, seconds) / 60_000), run });
        calls.set(place, list);
      }
    }
    for (const [place, list] of calls) {
      list.sort((a, b) => a.minute - b.minute);
      this.byPlace.set(place, {
        minutes: Int32Array.from(list, (call) => call.minute),
        runs: list.map((call) => call.run),
      });
    }
  }

  /** Calls `visit` for every run at `place` from `minute - 1` to `minute + after`. */
  near(
    place: string,
    minute: number,
    visit: (run: TripRun, exact: boolean) => void,
    after = 1,
  ): void {
    const calls = this.byPlace.get(place);
    if (!calls) return;
    let low = 0;
    let high = calls.minutes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((calls.minutes[middle] ?? 0) < minute - 1) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < calls.minutes.length; at += 1) {
      const value = calls.minutes[at] ?? 0;
      if (value > minute + after) break;
      const run = calls.runs[at];
      if (run) visit(run, value === minute);
    }
  }
}

/** Runs scheduled at a stop's place within a minute of its time, with whether the minute is exact. */
function runsNear(indexes: readonly DayIndex[], stop: SignatureStop): Map<TripRun, boolean> {
  const minute = Math.round(stop.instant / 60_000);
  const seen = new Map<TripRun, boolean>();
  for (const index of indexes) {
    for (const place of stop.places) {
      index.near(place, minute, (run, exact) => {
        seen.set(run, seen.get(run) === true || exact);
      });
    }
  }
  return seen;
}

interface Candidate {
  readonly run: TripRun;
  fits: number;
  exact: number;
}

const leftOver = (candidate: Candidate): number =>
  candidate.run.trip.stopPlaces.length - candidate.fits;

/** Orders candidates best first: most fitted stops, fewest left over, most exact minutes. */
function compareCandidates(a: Candidate, b: Candidate): number {
  return b.fits - a.fits || leftOver(a) - leftOver(b) || b.exact - a.exact;
}

/** Candidate runs, best first, ties by trip key. */
function rankRuns(indexes: readonly DayIndex[], stops: readonly SignatureStop[]): Candidate[] {
  const candidates = new Map<TripRun, Candidate>();
  for (const stop of stops) {
    for (const [run, exact] of runsNear(indexes, stop)) {
      const candidate = candidates.get(run) ?? { run, fits: 0, exact: 0 };
      candidate.fits += 1;
      if (exact) candidate.exact += 1;
      candidates.set(run, candidate);
    }
  }
  return [...candidates.values()].sort(
    (a, b) => compareCandidates(a, b) || a.run.trip.tripKey.localeCompare(b.run.trip.tripKey),
  );
}

function stopInstant(run: TripRun, stop: number): number {
  const departure = run.trip.departures[stop] ?? NO_TIME;
  const seconds = departure !== NO_TIME ? departure : (run.trip.arrivals[stop] ?? NO_TIME);
  return seconds === NO_TIME ? NO_TIME : serviceInstant(run.serviceDate, seconds);
}

/** Two runs that call at the same places at the same instants. */
function sameSchedule(a: TripRun, b: TripRun): boolean {
  const places = a.trip.stopPlaces;
  if (places.length !== b.trip.stopPlaces.length) return false;
  return places.every(
    (place, stop) =>
      place === b.trip.stopPlaces[stop] && stopInstant(a, stop) === stopInstant(b, stop),
  );
}
