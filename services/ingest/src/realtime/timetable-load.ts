import type { DB } from "@gerlines/db";
import { normalizeTrainNumber } from "@gerlines/schema/ids";
import { type Kysely, sql } from "kysely";
import {
  type CalendarInfo,
  NO_TIME,
  type RouteInfo,
  type StaticTrip,
  type StopPlaceInfo,
  type StopPointInfo,
  Timetable,
} from "./timetable.ts";

export const TIMETABLE_SOURCE = "delfi-gtfs";

const isoDate = (value: Date | string | null): string | null => {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
};

async function latestFeedVersion(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("feed_version")
    .select("feed_version_id")
    .where("source_id", "=", TIMETABLE_SOURCE)
    .where("status", "=", "loaded")
    .orderBy("published_on", "desc")
    .executeTakeFirst();
  if (!row) throw new Error(`no loaded ${TIMETABLE_SOURCE} feed version in the database`);
  return row.feed_version_id;
}

async function loadCalendars(
  db: Kysely<DB>,
  feedVersionId: number,
): Promise<Map<string, CalendarInfo>> {
  const calendars = await db
    .selectFrom("service_calendar")
    .select([
      "service_key",
      "weekdays",
      sql<string>`start_date::text`.as("start"),
      sql<string>`end_date::text`.as("end"),
    ])
    .where("feed_version_id", "=", feedVersionId)
    .execute();
  const dates = await db
    .selectFrom("service_calendar_date")
    .select(["service_key", sql<string>`service_date::text`.as("date"), "exception_type"])
    .where("feed_version_id", "=", feedVersionId)
    .execute();
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  for (const row of dates) {
    const target = row.exception_type === 1 ? added : removed;
    const set = target.get(row.service_key) ?? new Set<string>();
    set.add(row.date);
    target.set(row.service_key, set);
  }
  return new Map(
    calendars.map((row) => [
      row.service_key,
      {
        weekdays: row.weekdays,
        startDate: isoDate(row.start),
        endDate: isoDate(row.end),
        added: added.get(row.service_key) ?? new Set(),
        removed: removed.get(row.service_key) ?? new Set(),
      },
    ]),
  );
}

async function loadStops(db: Kysely<DB>): Promise<{
  points: Map<string, StopPointInfo>;
  places: Map<string, StopPlaceInfo>;
}> {
  const points = await db
    .selectFrom("stop_point")
    .select(["stop_point_id", "stop_place_id", "platform_code"])
    .execute();
  const places = await db
    .selectFrom("stop_place")
    .select([
      "stop_place_id",
      "name",
      "eva",
      "uic",
      "country_code",
      "dhid",
      sql<number | null>`ST_X(geom)`.as("lon"),
      sql<number | null>`ST_Y(geom)`.as("lat"),
    ])
    .execute();
  return {
    points: new Map(
      points.map((row) => [
        row.stop_point_id,
        { stopPlaceId: row.stop_place_id, platform: row.platform_code },
      ]),
    ),
    places: new Map(
      places.map((row) => [
        row.stop_place_id,
        {
          name: row.name,
          eva: row.eva,
          uic: row.uic,
          lon: row.lon,
          lat: row.lat,
          countryCode: row.country_code,
          dhid: row.dhid,
        },
      ]),
    ),
  };
}

async function loadIdMap(db: Kysely<DB>, entity: string): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom("id_map")
    .select(["source_key", "canonical_id"])
    .where("source_id", "=", TIMETABLE_SOURCE)
    .where("entity", "=", entity)
    .execute();
  return new Map(rows.map((row) => [row.source_key, row.canonical_id]));
}

interface TripRow {
  trip_key: string;
  route_key: string;
  service_key: string;
  trip_pattern_id: string;
  short_name: string | null;
  category_code: string;
  is_foreign: boolean;
  sequences: number[];
  arrivals: (number | null)[];
  departures: (number | null)[];
}

interface PatternStops {
  readonly points: string[];
  readonly places: string[];
}

const TRIP_PAGES = 8;

async function loadPatterns(
  db: Kysely<DB>,
  feedVersionId: number,
  points: ReadonlyMap<string, StopPointInfo>,
): Promise<Map<string, PatternStops>> {
  const result = await sql<{ trip_pattern_id: string; stop_points: string[] }>`
    SELECT trip_pattern_id, array_agg(stop_point_id ORDER BY stop_index) AS stop_points
      FROM trip_pattern_stop WHERE feed_version_id = ${feedVersionId}
     GROUP BY trip_pattern_id`.execute(db);
  const pointIds = new Map<string, string>();
  for (const id of points.keys()) pointIds.set(id, id);
  return new Map(
    result.rows.map((row) => {
      const ids = row.stop_points.map((point) => pointIds.get(point) ?? point);
      return [
        row.trip_pattern_id,
        { points: ids, places: ids.map((point) => points.get(point)?.stopPlaceId ?? "") },
      ];
    }),
  );
}

/** A growing column of 32-bit integers; `views` cuts it into one subarray per trip at the end. */
class IntColumn {
  private values = new Int32Array(1 << 20);
  length = 0;

  push(value: number): void {
    if (this.length === this.values.length) {
      const grown = new Int32Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[this.length] = value;
    this.length += 1;
  }

  /** The filled part in one buffer of its own size, so no grown slack stays in memory. */
  packed(): Int32Array {
    return this.values.slice(0, this.length);
  }
}

class StopTimeColumns {
  readonly sequences = new IntColumn();
  readonly arrivals = new IntColumn();
  readonly departures = new IntColumn();

  /** Appends one trip's stop times and returns where they start. */
  add(row: Pick<TripRow, "sequences" | "arrivals" | "departures">): number {
    const start = this.sequences.length;
    for (let index = 0; index < row.sequences.length; index += 1) {
      this.sequences.push(row.sequences[index] ?? 0);
      this.arrivals.push(row.arrivals[index] ?? NO_TIME);
      this.departures.push(row.departures[index] ?? NO_TIME);
    }
    return start;
  }
}

/** One string per distinct value: rows repeat route, service and category keys many times. */
function interner(): (text: string) => string {
  const values = new Map<string, string>();
  return (text) => {
    const known = values.get(text);
    if (known !== undefined) return known;
    values.set(text, text);
    return text;
  };
}

interface TripHead {
  readonly tripKey: string;
  readonly routeKey: string;
  readonly serviceKey: string;
  readonly operatorId: string | null;
  readonly trainNumber: string | null;
  readonly categoryCode: string;
  readonly isForeign: boolean;
  readonly stopPoints: readonly string[];
  readonly stopPlaces: readonly string[];
  readonly start: number;
  readonly count: number;
}

/**
 * Trips with their stop times, read in pages so the result never sits in memory at once. The stop
 * times of all trips share three buffers; each trip holds views into them (about half the memory of
 * three small arrays per trip).
 */
async function loadTrips(
  db: Kysely<DB>,
  feedVersionId: number,
  routes: ReadonlyMap<string, RouteInfo>,
  points: ReadonlyMap<string, StopPointInfo>,
): Promise<StaticTrip[]> {
  const patterns = await loadPatterns(db, feedVersionId, points);
  const shared = interner();
  const columns = new StopTimeColumns();
  const heads: TripHead[] = [];
  for (let page = 0; page < TRIP_PAGES; page += 1) {
    const result = await sql<TripRow>`
      SELECT t.trip_key, t.route_key, t.service_key, t.trip_pattern_id, t.short_name, t.category_code,
             t.is_foreign, s.sequences, s.arrivals, s.departures
        FROM trip t
        JOIN (SELECT trip_key, array_agg(stop_sequence ORDER BY stop_index) AS sequences,
                     array_agg(arrival_s ORDER BY stop_index) AS arrivals,
                     array_agg(departure_s ORDER BY stop_index) AS departures
                FROM stop_time
               WHERE feed_version_id = ${feedVersionId}
                 AND abs(hashtext(trip_key)) % ${TRIP_PAGES} = ${page}
               GROUP BY trip_key) s USING (trip_key)
       WHERE t.feed_version_id = ${feedVersionId}`.execute(db);
    for (const row of result.rows) {
      const pattern = patterns.get(row.trip_pattern_id);
      if (!pattern) continue;
      const start = columns.add(row);
      const trainNumber = normalizeTrainNumber(row.short_name);
      heads.push({
        tripKey: row.trip_key,
        routeKey: shared(row.route_key),
        serviceKey: shared(row.service_key),
        operatorId: routes.get(row.route_key)?.operatorId ?? null,
        trainNumber: trainNumber === null ? null : shared(trainNumber),
        categoryCode: shared(row.category_code),
        isForeign: row.is_foreign,
        stopPoints: pattern.points,
        stopPlaces: pattern.places,
        start,
        count: row.sequences.length,
      });
    }
  }
  const sequenceValues = columns.sequences.packed();
  const arrivalValues = columns.arrivals.packed();
  const departureValues = columns.departures.packed();
  const trips = heads.map((head): StaticTrip => {
    const end = head.start + head.count;
    return {
      tripKey: head.tripKey,
      routeKey: head.routeKey,
      serviceKey: head.serviceKey,
      operatorId: head.operatorId,
      trainNumber: head.trainNumber,
      categoryCode: head.categoryCode,
      isForeign: head.isForeign,
      stopPoints: head.stopPoints,
      stopPlaces: head.stopPlaces,
      stopSequences: sequenceValues.subarray(head.start, end),
      arrivals: arrivalValues.subarray(head.start, end),
      departures: departureValues.subarray(head.start, end),
    };
  });
  return trips.sort((a, b) => a.tripKey.localeCompare(b.tripKey));
}

/** Stops and DELFI stop ids: not versioned, so every loaded version shares one copy. */
export interface SharedStops {
  readonly points: Map<string, StopPointInfo>;
  readonly places: Map<string, StopPlaceInfo>;
  readonly delfiStopPoints: Map<string, string>;
  readonly delfiStopPlaces: Map<string, string>;
}

export async function loadSharedStops(db: Kysely<DB>): Promise<SharedStops> {
  const stops = await loadStops(db);
  return {
    ...stops,
    delfiStopPoints: await loadIdMap(db, "stop_point"),
    delfiStopPlaces: await loadIdMap(db, "stop_place"),
  };
}

/**
 * The loaded DELFI versions realtime around `at` may refer to: the newest `max` published on or
 * before that day, oldest first (or exactly the given ids).
 */
export async function loadTimetables(
  db: Kysely<DB>,
  options: { readonly at: number; readonly max: number; readonly ids?: readonly number[] },
): Promise<Timetable[]> {
  const day = new Date(options.at).toISOString().slice(0, 10);
  const ids =
    options.ids ??
    (
      await db
        .selectFrom("feed_version")
        .select("feed_version_id")
        .where("source_id", "=", TIMETABLE_SOURCE)
        .where("status", "=", "loaded")
        .where(sql<boolean>`published_on <= ${day}::date`)
        .orderBy("published_on", "desc")
        .orderBy("feed_version_id", "desc")
        .limit(options.max)
        .execute()
    ).map((row) => row.feed_version_id);
  if (ids.length === 0) throw new Error(`no loaded ${TIMETABLE_SOURCE} feed version on ${day}`);
  const shared = await loadSharedStops(db);
  const tables: Timetable[] = [];
  for (const id of [...ids].reverse()) tables.push(await loadTimetable(db, id, shared));
  return tables;
}

/** Reads one loaded timetable version (trains only, as WP-2.1 loads it) into memory. */
export async function loadTimetable(
  db: Kysely<DB>,
  feedVersionId?: number,
  shared?: SharedStops,
): Promise<Timetable> {
  const id = feedVersionId ?? (await latestFeedVersion(db));
  const version = await db
    .selectFrom("feed_version")
    .select(["feed_version", sql<string>`published_on::text`.as("published_on")])
    .where("feed_version_id", "=", id)
    .executeTakeFirstOrThrow();
  const routeRows = await db
    .selectFrom("route")
    .select(["route_key", "operator_id", "category_code"])
    .where("feed_version_id", "=", id)
    .execute();
  const routes = new Map(
    routeRows.map((row) => [
      row.route_key,
      { operatorId: row.operator_id, categoryCode: row.category_code },
    ]),
  );
  const stops = shared ?? (await loadSharedStops(db));
  return new Timetable({
    feedVersionId: id,
    feedVersion: version.feed_version,
    publishedOn: version.published_on,
    trips: await loadTrips(db, id, routes, stops.points),
    calendars: await loadCalendars(db, id),
    routes,
    stopPoints: stops.points,
    stopPlaces: stops.places,
    delfiStopPoints: stops.delfiStopPoints,
    delfiStopPlaces: stops.delfiStopPlaces,
  });
}
