import { normalizeTrainNumber, tripInstanceId } from "@gerlines/schema/ids";
import { serviceInstant, weekdayIndex } from "@gerlines/schema/service-day";

export const NO_TIME = -1;

/**
 * One flat string for an ASCII id built from pieces: a template string is kept as a tree of its
 * parts (about 350 bytes for a uuid against 56 flat), and every run of a day holds one.
 */
export const flatAscii = (text: string): string => Buffer.from(text, "latin1").toString("latin1");

export interface StopPointInfo {
  readonly stopPlaceId: string;
  readonly platform: string | null;
}

export interface StopPlaceInfo {
  readonly name: string;
  readonly eva: number | null;
  readonly uic: number | null;
  readonly lon: number | null;
  readonly lat: number | null;
  readonly countryCode: string | null;
  /** The DELFI id, whose district tells whether its platform codes are tracks (`normalizePlatform`). */
  readonly dhid: string | null;
}

export interface CalendarInfo {
  readonly weekdays: number;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
}

export interface RouteInfo {
  readonly operatorId: string | null;
  readonly categoryCode: string;
}

export interface StaticTrip {
  readonly tripKey: string;
  readonly routeKey: string;
  readonly serviceKey: string;
  readonly operatorId: string | null;
  readonly trainNumber: string | null;
  readonly categoryCode: string;
  readonly isForeign: boolean;
  readonly stopPoints: readonly string[];
  readonly stopPlaces: readonly string[];
  readonly stopSequences: Int32Array;
  readonly arrivals: Int32Array;
  readonly departures: Int32Array;
}

export interface TimetableData {
  readonly feedVersionId: number;
  readonly feedVersion: string | null;
  /** The Monday the feed was published; realtime refers to it from the next service day on. */
  readonly publishedOn?: string | null;
  readonly trips: readonly StaticTrip[];
  readonly calendars: ReadonlyMap<string, CalendarInfo>;
  readonly routes: ReadonlyMap<string, RouteInfo>;
  readonly stopPoints: ReadonlyMap<string, StopPointInfo>;
  readonly stopPlaces: ReadonlyMap<string, StopPlaceInfo>;
  /** DELFI stop ids (platform and station level) to canonical stop point or place ids. */
  readonly delfiStopPoints: ReadonlyMap<string, string>;
  readonly delfiStopPlaces: ReadonlyMap<string, string>;
}

/** One trip of the timetable on one service day: the unit a realtime record is matched to. */
export interface TripRun {
  readonly instanceId: string;
  readonly serviceDate: string;
  readonly trip: StaticTrip;
  readonly originDeparture: number;
  /** The feed version the run comes from; absent for trips a source added. */
  readonly feedVersionId?: number;
  /** A trip the source added: no timetable trip, its stops and times come from the realtime record. */
  readonly added?: boolean;
}

/** In-memory index of one loaded feed version, for matching realtime records to trip runs. */
export class Timetable {
  readonly data: TimetableData;
  readonly tripsByKey = new Map<string, StaticTrip>();
  readonly tripsByNumber = new Map<string, StaticTrip[]>();
  readonly placesByUic = new Map<number, string[]>();
  private readonly runsByDate = new Map<string, Map<string, TripRun>>();
  private readonly canonicalByDate = new Map<string, Map<string, TripRun>>();

  constructor(data: TimetableData) {
    this.data = data;
    for (const trip of data.trips) {
      this.tripsByKey.set(trip.tripKey, trip);
      if (trip.trainNumber) {
        const list = this.tripsByNumber.get(trip.trainNumber) ?? [];
        list.push(trip);
        this.tripsByNumber.set(trip.trainNumber, list);
      }
    }
    for (const [placeId, place] of data.stopPlaces) {
      for (const code of new Set([place.eva, place.uic])) {
        if (code === null) continue;
        const list = this.placesByUic.get(code) ?? [];
        list.push(placeId);
        this.placesByUic.set(code, list);
      }
    }
  }

  get feedVersionId(): number {
    return this.data.feedVersionId;
  }

  get cachedDays(): number {
    return this.runsByDate.size;
  }

  /** Forgets the runs built for service days before `day`. */
  dropBefore(day: string): void {
    for (const date of [...this.runsByDate.keys()]) {
      if (date < day) {
        this.runsByDate.delete(date);
        this.canonicalByDate.delete(date);
      }
    }
  }

  isActive(serviceKey: string, date: string): boolean {
    const calendar = this.data.calendars.get(serviceKey);
    if (!calendar) return false;
    if (calendar.removed.has(date)) return false;
    if (calendar.added.has(date)) return true;
    if (calendar.startDate === null || calendar.endDate === null) return false;
    if (date < calendar.startDate || date > calendar.endDate) return false;
    return ((calendar.weekdays >> weekdayIndex(date)) & 1) === 1;
  }

  firstDeparture(trip: StaticTrip): number {
    const departure = trip.departures[0] ?? NO_TIME;
    return departure === NO_TIME ? (trip.arrivals[0] ?? 0) : departure;
  }

  instanceIdOf(trip: StaticTrip, serviceDate: string): string {
    return tripInstanceId({
      serviceDate,
      operatorId: trip.operatorId,
      trainNumber: trip.trainNumber,
      originStopPlaceId: trip.stopPlaces[0] ?? "",
      originDeparture: serviceInstant(serviceDate, this.firstDeparture(trip)),
    });
  }

  /** Every trip run of a service day by trip key, built once per day. */
  runsOn(serviceDate: string): Map<string, TripRun> {
    const cached = this.runsByDate.get(serviceDate);
    if (cached) return cached;
    const runs = new Map<string, TripRun>();
    const canonical = new Map<string, TripRun>();
    for (const trip of this.data.trips) {
      if (!this.isActive(trip.serviceKey, serviceDate)) continue;
      const run: TripRun = {
        instanceId: flatAscii(this.instanceIdOf(trip, serviceDate)),
        serviceDate,
        trip,
        originDeparture: serviceInstant(serviceDate, this.firstDeparture(trip)),
        feedVersionId: this.data.feedVersionId,
      };
      runs.set(trip.tripKey, run);
      const existing = canonical.get(run.instanceId);
      if (!existing || trip.tripKey < existing.trip.tripKey) canonical.set(run.instanceId, run);
    }
    this.runsByDate.set(serviceDate, runs);
    this.canonicalByDate.set(serviceDate, canonical);
    return runs;
  }

  /**
   * The run that stands for a real train: when several timetable trips share one instance key (the
   * same train filed twice), the one with the smallest trip key.
   */
  canonicalRun(instanceId: string, serviceDate: string): TripRun | undefined {
    this.runsOn(serviceDate);
    return this.canonicalByDate.get(serviceDate)?.get(instanceId);
  }

  tripsWithNumber(trainNumber: string | null): readonly StaticTrip[] {
    const normalized = normalizeTrainNumber(trainNumber);
    return normalized ? (this.tripsByNumber.get(normalized) ?? []) : [];
  }

  placeOfPoint(stopPointId: string): string | undefined {
    return this.data.stopPoints.get(stopPointId)?.stopPlaceId;
  }
}
