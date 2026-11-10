import type { DB } from "@gerlines/db";
import { TRAIN_CATEGORIES } from "@gerlines/schema";
import { normalizeTrainNumber, tripInstanceId } from "@gerlines/schema/ids";
import { addDays, serviceInstant, weekdayIndex } from "@gerlines/schema/service-day";
import { type Kysely, sql } from "kysely";
import type {
  LineRecord,
  StationRecord,
  StopIdRecord,
  TimetableSearchData,
  TrainRecord,
  TripRunRecord,
} from "./records.ts";
import { familyStopIds } from "./stop-ids.ts";

export const TIMETABLE_SOURCE = "delfi-gtfs";
const DAY_S = 86_400;
const STATION_LINES = 24;
/**
 * The importer places a station without a stops.txt row at the mean of the platforms of the load;
 * a parent station row keeps its own position. Against the centroid of the platforms the
 * newest load saw: gerlines_wp32 (feed 2026-10-19) all 820 such places within this distance and
 * 55 of 3,625 parent rows, gerlines_t084 (two feeds) all 735 and 56 of 2,734.
 */
const SYNTHESISED_WITHIN_M = 0.05;
const LONG_DISTANCE = new Set(["hsr", "ld", "night"]);
const ALPHABETIC = /^\p{L}+$/u;
const NAMED_LINE = /^(?=.*\p{L})(?=.*\d)/u;

export interface TimetableSearchSource {
  /** Starts no further query once `signal` is aborted. */
  load(serviceDate: string, signal?: AbortSignal): Promise<TimetableSearchData>;
  /** The timetable version that covers the day, to notice a version loaded after the index. */
  version?(serviceDate: string): Promise<string>;
}

export class NoTimetableError extends Error {
  override readonly name = "NoTimetableError";
}

export interface TrainRow {
  readonly trip_key: string;
  readonly service_date: string;
  readonly short_name: string | null;
  readonly category_code: string;
  readonly is_foreign: boolean;
  readonly line: string | null;
  readonly product: string | null;
  readonly operator_id: string | null;
  readonly operator_name: string | null;
  readonly first_departure_s: number;
  readonly last_arrival_s: number;
  readonly origin_id: string;
  readonly origin_name: string;
  readonly destination_id: string;
  readonly destination_name: string;
}

export interface StationRow {
  readonly stop_place_id: string;
  readonly name: string;
  readonly other_names: readonly string[] | null;
  readonly eva: number | null;
  readonly dhid: string | null;
  readonly stop_id: string | null;
  readonly lon: number;
  readonly lat: number;
  readonly trains: number;
  readonly lines: readonly string[] | null;
  readonly in_newest_feed: boolean;
  readonly stop_id_seen_ms: number | null;
  readonly stop_id_is_row: boolean;
  readonly stop_id_synthesised: boolean;
}

interface LineRow {
  readonly operator_id: string | null;
  readonly operator_name: string | null;
  readonly line: string;
  readonly product: string | null;
  readonly category_code: string;
  readonly trains: number;
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

function category(code: string): TrainRecord["category"] {
  return (TRAIN_CATEGORIES as readonly string[]).includes(code)
    ? (code as TrainRecord["category"])
    : "other";
}

function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** The card's naming rule (DESIGN.md train card rules) without the words a client adds. */
export function trainTitle(fields: {
  readonly productName: string | null;
  readonly trainNumber: string | null;
  readonly line: string | null;
  readonly category: string;
}): string | null {
  const { productName, trainNumber, line } = fields;
  const productAndNumber =
    productName !== null && trainNumber !== null ? `${productName} ${trainNumber}` : null;
  if (LONG_DISTANCE.has(fields.category)) {
    return productAndNumber ?? line ?? trainNumber ?? productName;
  }
  return line ?? productAndNumber ?? productName ?? trainNumber;
}

function productOf(row: { product: string | null; line: string | null }): string | null {
  const product = text(row.product);
  if (product !== null) return product;
  const line = text(row.line);
  return line !== null && ALPHABETIC.test(line) ? line : null;
}

export function trainRecordOf(row: TrainRow): TrainRecord | null {
  const trainNumber = normalizeTrainNumber(row.short_name);
  const productName = productOf(row);
  const rawLine = text(row.line);
  const line = rawLine !== null && rawLine !== productName ? rawLine : null;
  const categoryCode = category(row.category_code);
  const title = trainTitle({ productName, trainNumber, line, category: categoryCode });
  if (title === null) return null;
  const departureMs = serviceInstant(row.service_date, row.first_departure_s);
  return {
    id: tripInstanceId({
      serviceDate: row.service_date,
      operatorId: row.operator_id,
      trainNumber,
      originStopPlaceId: row.origin_id,
      originDeparture: departureMs,
    }),
    title,
    productName,
    trainNumber,
    line,
    category: categoryCode,
    foreign: row.is_foreign,
    operator: text(row.operator_name),
    origin: { stopPlaceId: row.origin_id, name: row.origin_name },
    destination: { stopPlaceId: row.destination_id, name: row.destination_name },
    departure: new Date(departureMs).toISOString(),
    arrival: new Date(serviceInstant(row.service_date, row.last_arrival_s)).toISOString(),
    serviceDate: row.service_date,
  };
}

/** One record per trip instance: a train filed twice keeps its smallest trip key (as the live engine). */
export function canonicalTrains(rows: readonly TrainRow[]): TrainRecord[] {
  const byId = new Map<string, { key: string; record: TrainRecord }>();
  for (const row of rows) {
    const record = trainRecordOf(row);
    if (record === null) continue;
    const held = byId.get(record.id);
    if (!held || row.trip_key < held.key) byId.set(record.id, { key: row.trip_key, record });
  }
  return [...byId.values()].map((entry) => entry.record);
}

/** Each trip key of the day with the train record of its run, for journey legs. */
export function tripRunsOf(rows: readonly TrainRow[]): TripRunRecord[] {
  return rows.flatMap((row) => {
    const record = trainRecordOf(row);
    return record === null
      ? []
      : [{ serviceDate: row.service_date, tripKey: row.trip_key, trainId: record.id }];
  });
}

function lineRecordOf(row: LineRow): LineRecord | null {
  const line = text(row.line);
  if (line === null || !NAMED_LINE.test(line)) return null;
  return {
    id: `${row.operator_id ?? "unknown"}:${line}`,
    line,
    productName: text(row.product),
    category: category(row.category_code),
    operator: text(row.operator_name),
    trainsToday: row.trains,
    bbox: [row.west, row.south, row.east, row.north],
  };
}

function stationRecordOf(row: StationRow, stopId: string | null): StationRecord {
  return {
    id: row.stop_place_id,
    name: row.name,
    otherNames: row.other_names ?? [],
    lon: row.lon,
    lat: row.lat,
    eva: row.eva,
    dhid: row.dhid,
    stopId,
    lines: (row.lines ?? []).slice(0, STATION_LINES),
    trainsToday: row.trains,
  };
}

/** The station records, each with the stop id the router knows best among its station's places. */
export function stationRecordsOf(rows: readonly StationRow[]): StationRecord[] {
  const chosen = familyStopIds(
    rows.map((row) => ({
      row,
      id: row.stop_place_id,
      name: row.name,
      eva: row.eva,
      dhid: row.dhid,
      lon: row.lon,
      lat: row.lat,
      stopId: row.stop_id,
      inNewestFeed: row.in_newest_feed,
      stopIdSeenMs: row.stop_id_seen_ms,
      stopIdIsRow: row.stop_id_is_row,
      stopIdSynthesised: row.stop_id_synthesised,
      trainsToday: row.trains,
    })),
  );
  return chosen.map((station) => stationRecordOf(station.row, station.stopId));
}

/**
 * Reads what search needs for one service day from the timetable tables (WP-2.1): the newest
 * loaded DELFI version published by that day, its stop places with display names and the
 * stop id journeys take (the DHID, else the newest feed id of the station; the best known
 * router stop among the places of one station), the DELFI stop
 * ids that belong to them, the trips of the day and of the evening before that run past
 * midnight, and their lines.
 */
export class DatabaseSearchSource implements TimetableSearchSource {
  private readonly db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.db = db;
  }

  async load(serviceDate: string, signal?: AbortSignal): Promise<TimetableSearchData> {
    signal?.throwIfAborted();
    const version = await this.versionId(serviceDate);
    signal?.throwIfAborted();
    const previous = addDays(serviceDate, -1);
    const [stations, today, evening, lines, stopIds] = await Promise.all([
      this.stations(version, serviceDate),
      this.trains(version, serviceDate, 0),
      this.trains(version, previous, DAY_S),
      this.lines(version, serviceDate),
      this.stopIds(version),
    ]);
    return {
      serviceDate,
      timetableVersion: String(version),
      stations: stationRecordsOf(stations),
      trains: canonicalTrains([...evening, ...today]),
      tripRuns: tripRunsOf([...evening, ...today]),
      lines: lines.flatMap((row) => lineRecordOf(row) ?? []),
      stopIds,
    };
  }

  async version(serviceDate: string): Promise<string> {
    return String(await this.versionId(serviceDate));
  }

  private async versionId(serviceDate: string): Promise<number> {
    const rows = await sql<{ feed_version_id: number }>`
      SELECT feed_version_id FROM feed_version
       WHERE source_id = ${TIMETABLE_SOURCE} AND status = 'loaded'
         AND published_on <= ${serviceDate}::date
         AND (valid_to IS NULL OR valid_to >= ${serviceDate}::date)
       ORDER BY published_on DESC, feed_version_id DESC
       LIMIT 1`.execute(this.db);
    const id = rows.rows[0]?.feed_version_id;
    if (id === undefined) throw new NoTimetableError(`no loaded timetable covers ${serviceDate}`);
    return id;
  }

  private active(version: number, serviceDate: string) {
    return sql`
      SELECT t.trip_key FROM trip t
        JOIN service_calendar c USING (feed_version_id, service_key)
        LEFT JOIN service_calendar_date x
          ON x.feed_version_id = t.feed_version_id AND x.service_key = t.service_key
         AND x.service_date = ${serviceDate}::date
       WHERE t.feed_version_id = ${version}
         AND coalesce(
               x.exception_type = 1,
               c.start_date <= ${serviceDate}::date AND c.end_date >= ${serviceDate}::date
                 AND (c.weekdays >> ${weekdayIndex(serviceDate)}) & 1 = 1,
               false)`;
  }

  private async trains(version: number, serviceDate: string, endsAfterS: number) {
    const rows = await sql<TrainRow>`
      WITH active AS (${this.active(version, serviceDate)})
      SELECT t.trip_key, ${serviceDate}::text AS service_date, t.short_name, t.category_code,
             t.is_foreign, r.short_name AS line, tp.product, r.operator_id,
             coalesce(o.brand_name, o.name) AS operator_name,
             t.first_departure_s, t.last_arrival_s,
             op.stop_place_id::text AS origin_id, coalesce(odn.name, opl.name) AS origin_name,
             dp.stop_place_id::text AS destination_id, coalesce(ddn.name, dpl.name) AS destination_name
        FROM active a
        JOIN trip t ON t.feed_version_id = ${version} AND t.trip_key = a.trip_key
        JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
        JOIN trip_pattern p
          ON p.feed_version_id = t.feed_version_id AND p.trip_pattern_id = t.trip_pattern_id
        JOIN trip_pattern_stop os ON os.feed_version_id = t.feed_version_id
         AND os.trip_pattern_id = t.trip_pattern_id AND os.stop_index = 0
        JOIN stop_point op ON op.stop_point_id = os.stop_point_id
        JOIN stop_place opl ON opl.stop_place_id = op.stop_place_id
        LEFT JOIN stop_place_display_name odn ON odn.stop_place_id = op.stop_place_id
        JOIN trip_pattern_stop ds ON ds.feed_version_id = t.feed_version_id
         AND ds.trip_pattern_id = t.trip_pattern_id AND ds.stop_index = p.stop_count - 1
        JOIN stop_point dp ON dp.stop_point_id = ds.stop_point_id
        JOIN stop_place dpl ON dpl.stop_place_id = dp.stop_place_id
        LEFT JOIN stop_place_display_name ddn ON ddn.stop_place_id = dp.stop_place_id
        LEFT JOIN trip_product tp ON tp.feed_version_id = t.feed_version_id AND tp.trip_key = t.trip_key
        LEFT JOIN operator o ON o.operator_id = r.operator_id
       WHERE t.last_arrival_s > ${endsAfterS}`.execute(this.db);
    return rows.rows;
  }

  private async stations(version: number, serviceDate: string) {
    const rows = await sql<StationRow>`
      WITH active AS (${this.active(version, serviceDate)}),
      calls AS (
        SELECT sp.stop_place_id, count(DISTINCT t.trip_key)::int AS trains,
               array_agg(DISTINCT r.short_name ORDER BY r.short_name)
                 FILTER (WHERE r.short_name ~ '[A-Za-z]' AND r.short_name ~ '\\d') AS lines
          FROM active a
          JOIN trip t ON t.feed_version_id = ${version} AND t.trip_key = a.trip_key
          JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
          JOIN trip_pattern_stop tps
            ON tps.feed_version_id = t.feed_version_id AND tps.trip_pattern_id = t.trip_pattern_id
          JOIN stop_point sp ON sp.stop_point_id = tps.stop_point_id
         GROUP BY sp.stop_place_id
      ),
      served AS (
        SELECT DISTINCT sp.stop_place_id
          FROM trip_pattern_stop tps JOIN stop_point sp ON sp.stop_point_id = tps.stop_point_id
         WHERE tps.feed_version_id = ${version}
      ),
      newest AS (
        SELECT feed_version_id FROM feed_version
         WHERE source_id = ${TIMETABLE_SOURCE} AND status = 'loaded'
         ORDER BY published_on DESC, feed_version_id DESC
         LIMIT 1
      ),
      served_newest AS (
        SELECT DISTINCT sp.stop_place_id
          FROM newest n
          JOIN trip_pattern_stop tps ON tps.feed_version_id = n.feed_version_id
          JOIN stop_point sp ON sp.stop_point_id = tps.stop_point_id
         WHERE n.feed_version_id <> ${version}
      ),
      station AS (
      SELECT p.stop_place_id::text AS stop_place_id, coalesce(d.name, p.name) AS name,
             (SELECT array_agg(n.name ORDER BY n.name) FROM stop_place_search_name n
               WHERE n.stop_place_id = p.stop_place_id) AS other_names, p.eva, p.dhid,
             coalesce(p.dhid, (
               SELECT m.source_key FROM id_map m
                WHERE m.source_id = ${TIMETABLE_SOURCE} AND m.entity = 'stop_place'
                  AND m.canonical_id = p.stop_place_id
                ORDER BY m.last_seen_at DESC, m.source_key ~ '^[a-z]{2}:[0-9]{5}:' DESC, m.source_key
                LIMIT 1)) AS stop_id,
             ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat, coalesce(c.trains, 0) AS trains, c.lines
        FROM served s
        JOIN stop_place p ON p.stop_place_id = s.stop_place_id
        LEFT JOIN stop_place_display_name d ON d.stop_place_id = p.stop_place_id
        LEFT JOIN calls c ON c.stop_place_id = p.stop_place_id
       WHERE p.geom IS NOT NULL
      )
      SELECT s.*,
             (SELECT feed_version_id FROM newest) = ${version}
               OR s.stop_place_id::uuid IN (SELECT stop_place_id FROM served_newest) AS in_newest_feed,
             (SELECT (extract(epoch FROM max(m.last_seen_at)) * 1000)::float8 FROM id_map m
               WHERE m.source_id = ${TIMETABLE_SOURCE} AND m.entity IN ('stop_place', 'stop_point')
                 AND m.source_key = s.stop_id) AS stop_id_seen_ms,
             EXISTS (SELECT 1 FROM id_map m
                      WHERE m.source_id = ${TIMETABLE_SOURCE} AND m.entity = 'stop_point'
                        AND m.source_key = s.stop_id) AS stop_id_is_row,
             NOT EXISTS (SELECT 1 FROM id_map m
                          WHERE m.source_id = ${TIMETABLE_SOURCE} AND m.entity = 'stop_point'
                            AND m.source_key = s.stop_id)
               AND coalesce((
                 SELECT ST_Distance(ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326)::geography,
                                    ST_Centroid(ST_Collect(sp.geom))::geography) < ${SYNTHESISED_WITHIN_M}
                   FROM (SELECT sp.geom, k.last_seen_at, max(k.last_seen_at) OVER () AS newest
                           FROM stop_point sp
                           JOIN id_map k ON k.source_id = ${TIMETABLE_SOURCE} AND k.entity = 'stop_point'
                            AND k.canonical_id = sp.stop_point_id
                          WHERE sp.stop_place_id = s.stop_place_id::uuid AND sp.geom IS NOT NULL) sp
                  WHERE sp.last_seen_at = sp.newest), false)
               AS stop_id_synthesised
        FROM station s`.execute(this.db);
    return rows.rows;
  }

  /**
   * Every DELFI stop id with its station; a stop point id (a stops.txt row) also with when a load
   * last saw it and the trip patterns that stop there in the version, to pick the row a router
   * holds.
   */
  private async stopIds(version: number): Promise<StopIdRecord[]> {
    const rows = await sql<StopIdRecord>`
      WITH patterns AS (
        SELECT stop_point_id, count(*)::int AS patterns FROM trip_pattern_stop
         WHERE feed_version_id = ${version}
         GROUP BY stop_point_id
      )
      SELECT m.source_key AS "stopId", coalesce(sp.stop_place_id, m.canonical_id)::text AS "stationId",
             sp.stop_point_id IS NOT NULL AS "stopPoint",
             (extract(epoch FROM m.last_seen_at) * 1000)::float8 AS "seenMs",
             coalesce(c.patterns, 0) AS patterns
        FROM id_map m
        LEFT JOIN stop_point sp ON m.entity = 'stop_point' AND sp.stop_point_id = m.canonical_id
        LEFT JOIN patterns c ON c.stop_point_id = sp.stop_point_id
       WHERE m.source_id = ${TIMETABLE_SOURCE}
         AND (m.entity = 'stop_place' OR sp.stop_point_id IS NOT NULL)`.execute(this.db);
    return rows.rows;
  }

  private async lines(version: number, serviceDate: string) {
    const rows = await sql<LineRow>`
      WITH active AS (${this.active(version, serviceDate)})
      SELECT r.operator_id, coalesce(o.brand_name, o.name) AS operator_name, r.short_name AS line,
             mode() WITHIN GROUP (ORDER BY tp.product) AS product,
             mode() WITHIN GROUP (ORDER BY t.category_code) AS category_code,
             count(DISTINCT t.trip_key)::int AS trains,
             min(ST_X(pl.geom)) AS west, min(ST_Y(pl.geom)) AS south,
             max(ST_X(pl.geom)) AS east, max(ST_Y(pl.geom)) AS north
        FROM active a
        JOIN trip t ON t.feed_version_id = ${version} AND t.trip_key = a.trip_key
        JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
        LEFT JOIN trip_product tp ON tp.feed_version_id = t.feed_version_id AND tp.trip_key = t.trip_key
        LEFT JOIN operator o ON o.operator_id = r.operator_id
        JOIN trip_pattern_stop tps
          ON tps.feed_version_id = t.feed_version_id AND tps.trip_pattern_id = t.trip_pattern_id
        JOIN stop_point sp ON sp.stop_point_id = tps.stop_point_id
        JOIN stop_place pl ON pl.stop_place_id = sp.stop_place_id
       WHERE r.short_name IS NOT NULL AND pl.geom IS NOT NULL
       GROUP BY r.operator_id, o.brand_name, o.name, r.short_name`.execute(this.db);
    return rows.rows;
  }
}
