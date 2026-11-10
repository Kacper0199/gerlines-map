import type { DB } from "@gerlines/db";
import type { LonLat } from "@gerlines/geo";
import { weekdayIndex } from "@gerlines/schema/service-day";
import { type Kysely, sql } from "kysely";
import { timed } from "../metrics.ts";
import type { StaticRun } from "../model.ts";
import {
  canonicalRuns,
  type Pattern,
  PatternInterner,
  type PatternRow,
  patternOf,
  runOf,
  type TripRow,
} from "./runs.ts";

export const TIMETABLE_SOURCE = "delfi-gtfs";

export interface FeedVersionInfo {
  readonly feedVersionId: number;
  readonly publishedOn: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

/** How much of a service day a version can draw: its share of patterns with a shape, and its runs. */
export interface VersionCoverage {
  /** Share of the patterns running on the day that have a usable shape (0 to 1). */
  readonly coverage: number;
  /** Canonical runs of the version on the day. */
  readonly runs: number;
}

/** Where the engine reads the timetable from: the database, or a fixture in tests. */
export interface TimetableSource {
  versions(): Promise<readonly FeedVersionInfo[]>;
  /** Canonical runs of a version on a service day, ordered by instance id. */
  runsOn(feedVersionId: number, serviceDate: string): Promise<readonly StaticRun[]>;
  shapeCoverage(feedVersionId: number, serviceDate: string): Promise<VersionCoverage>;
  /**
   * Coordinates of every stop place with a position, of any version: a realtime row may name a
   * place of another version than the run's (a station under a new id).
   */
  placeCoordinates(): Promise<ReadonlyMap<string, LonLat>>;
}

/**
 * The lean timetable reader of the live engine: calendars are evaluated in SQL, so only the trips of
 * the service days in use are read (about 25,000 per day), with stop times as arrays.
 */
export class DatabaseTimetable implements TimetableSource {
  private readonly db: Kysely<DB>;
  private readonly shapesDb: Kysely<DB>;
  private readonly patterns = new Map<number, Promise<Map<string, Pattern>>>();

  /**
   * `shapesDb` holds `trip_pattern_shape` and `shape_pattern` (the same database unless shapes are
   * read from another build of the shape pipeline, such as a cleaned set under review).
   */
  constructor(db: Kysely<DB>, shapesDb: Kysely<DB> = db) {
    this.db = db;
    this.shapesDb = shapesDb;
  }

  async versions(): Promise<readonly FeedVersionInfo[]> {
    const rows = await timed("versions", () =>
      sql<{
        feed_version_id: number;
        published_on: string;
        valid_from: string | null;
        valid_to: string | null;
      }>`
        SELECT feed_version_id, published_on::text, valid_from::text, valid_to::text
          FROM feed_version
         WHERE source_id = ${TIMETABLE_SOURCE} AND status = 'loaded'
         ORDER BY published_on, feed_version_id`.execute(this.db),
    );
    return rows.rows.map((row) => ({
      feedVersionId: row.feed_version_id,
      publishedOn: row.published_on,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    }));
  }

  async runsOn(feedVersionId: number, serviceDate: string): Promise<readonly StaticRun[]> {
    const patterns = await this.patternsOf(feedVersionId);
    const trips = await timed("runs", () =>
      sql<TripRow>`
        WITH active AS (
          SELECT t.trip_key
            FROM trip t
            JOIN service_calendar c USING (feed_version_id, service_key)
            LEFT JOIN service_calendar_date x
              ON x.feed_version_id = t.feed_version_id AND x.service_key = t.service_key
             AND x.service_date = ${serviceDate}::date
           WHERE t.feed_version_id = ${feedVersionId}
             AND coalesce(
                   x.exception_type = 1,
                   c.start_date <= ${serviceDate}::date AND c.end_date >= ${serviceDate}::date
                     AND (c.weekdays >> ${weekdayIndex(serviceDate)}) & 1 = 1,
                   false)
        )
        SELECT t.trip_key, t.trip_pattern_id::text AS trip_pattern_id, t.short_name, t.category_code,
               t.is_foreign, r.short_name AS line, r.operator_id,
               array_agg(st.arrival_s ORDER BY st.stop_index) AS arrivals,
               array_agg(st.departure_s ORDER BY st.stop_index) AS departures,
               array_agg(st.pickup_type ORDER BY st.stop_index) AS pickups,
               array_agg(st.drop_off_type ORDER BY st.stop_index) AS drop_offs
          FROM active a
          JOIN trip t ON t.feed_version_id = ${feedVersionId} AND t.trip_key = a.trip_key
          JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
          JOIN stop_time st ON st.feed_version_id = t.feed_version_id AND st.trip_key = t.trip_key
         GROUP BY t.trip_key, t.trip_pattern_id, t.short_name, t.category_code, t.is_foreign,
                  r.short_name, r.operator_id`.execute(this.db),
    );
    const runs: StaticRun[] = [];
    for (const trip of trips.rows) {
      const pattern = patterns.get(trip.trip_pattern_id);
      if (pattern) runs.push(runOf(feedVersionId, serviceDate, trip, pattern));
    }
    return canonicalRuns(runs);
  }

  async shapeCoverage(feedVersionId: number, serviceDate: string): Promise<VersionCoverage> {
    const runs = await this.runsOn(feedVersionId, serviceDate);
    const patterns = new Map<string, boolean>();
    for (const run of runs) patterns.set(run.patternId, run.gap === null);
    const covered = [...patterns.values()].filter(Boolean).length;
    return { coverage: patterns.size === 0 ? 0 : covered / patterns.size, runs: runs.length };
  }

  async placeCoordinates(): Promise<ReadonlyMap<string, LonLat>> {
    const rows = await timed("place_coordinates", () =>
      sql<{ stop_place_id: string; lon: number; lat: number }>`
        SELECT stop_place_id::text AS stop_place_id, ST_X(geom) AS lon, ST_Y(geom) AS lat
          FROM stop_place
         WHERE geom IS NOT NULL`.execute(this.db),
    );
    return new Map(rows.rows.map((row) => [row.stop_place_id, { lon: row.lon, lat: row.lat }]));
  }

  private patternsOf(feedVersionId: number): Promise<Map<string, Pattern>> {
    const cached = this.patterns.get(feedVersionId);
    if (cached) return cached;
    const loading = this.loadPatterns(feedVersionId);
    this.patterns.set(feedVersionId, loading);
    loading.catch(() => this.patterns.delete(feedVersionId));
    return loading;
  }

  private async loadPatterns(feedVersionId: number): Promise<Map<string, Pattern>> {
    const stops = await timed("patterns", () =>
      sql<Pick<PatternRow, "trip_pattern_id" | "stop_places">>`
        SELECT tps.trip_pattern_id::text AS trip_pattern_id,
               array_agg(sp.stop_place_id::text ORDER BY tps.stop_index) AS stop_places
          FROM trip_pattern_stop tps
          JOIN stop_point sp ON sp.stop_point_id = tps.stop_point_id
         WHERE tps.feed_version_id = ${feedVersionId}
         GROUP BY tps.trip_pattern_id`.execute(this.db),
    );
    const shapes = await timed("pattern_shapes", () =>
      sql<Omit<PatternRow, "stop_places">>`
        SELECT link.trip_pattern_id::text AS trip_pattern_id, s.shape_no, s.shape_hash, s.length_m,
               ST_M(ST_EndPoint(s.geom)) AS end_m, s.stop_arc_m, s.qa_status
          FROM trip_pattern_shape link
          JOIN shape_pattern s ON s.shape_hash = link.shape_hash
         WHERE link.feed_version_id = ${feedVersionId}`.execute(this.shapesDb),
    );
    const byPattern = new Map(shapes.rows.map((row) => [row.trip_pattern_id, row]));
    const interner = new PatternInterner();
    const patterns = new Map<string, Pattern>();
    for (const row of stops.rows) {
      const shape = byPattern.get(row.trip_pattern_id);
      patterns.set(
        row.trip_pattern_id,
        patternOf(
          {
            trip_pattern_id: row.trip_pattern_id,
            stop_places: row.stop_places,
            shape_no: shape?.shape_no ?? null,
            shape_hash: shape?.shape_hash ?? null,
            length_m: shape?.length_m ?? null,
            end_m: shape?.end_m ?? null,
            stop_arc_m: shape?.stop_arc_m ?? null,
            qa_status: shape?.qa_status ?? null,
          },
          interner,
        ),
      );
    }
    return patterns;
  }

  /** Drops the cached patterns of versions that are no longer in use. */
  forget(keep: ReadonlySet<number>): void {
    for (const id of this.patterns.keys()) if (!keep.has(id)) this.patterns.delete(id);
  }
}
