import type { DB } from "@gerlines/db";
import { normalizeTrainNumber, tripInstanceId } from "@gerlines/schema/ids";
import { addDays, localDate, serviceInstant } from "@gerlines/schema/service-day";
import { type Kysely, sql } from "kysely";
import type { DetailRef } from "./model.ts";

/** Minutes before the first departure a train counts as running (design note §1). */
const LEAD_MS = 10 * 60_000;
/** After the last arrival a train still counts as running (design note §1). */
const TRAIL_MS = 30_000;

interface TimetableRun {
  feed_version_id: number;
  trip_key: string;
  operator_id: string | null;
  short_name: string | null;
  origin_place: string;
  first_departure_s: number;
  service_date: string;
}

/**
 * The feed version a service day reads: the newest loaded version published before that day
 * (realtime refers to a new DELFI feed from the day after its Monday), else the oldest loaded one.
 */
export async function versionForDay(db: Kysely<DB>, serviceDate: string): Promise<number | null> {
  const result = await sql<{ feed_version_id: number }>`
    SELECT feed_version_id FROM feed_version
     WHERE status = 'loaded' AND source_id = 'delfi-gtfs'
     ORDER BY (published_on < ${serviceDate}::date) DESC,
              CASE WHEN published_on < ${serviceDate}::date THEN published_on END DESC NULLS LAST,
              published_on ASC
     LIMIT 1`.execute(db);
  return result.rows[0]?.feed_version_id ?? null;
}

export interface ProductCoverage {
  readonly category: string;
  readonly trips: number;
  readonly withProduct: number;
}

/**
 * Trips of a feed version per category and how many carry a `trip_product` row: a weekly load that
 * skipped `gerlines-static-import products` shows up as zero products before any card is wrong.
 */
export async function productCoverage(
  db: Kysely<DB>,
  feedVersionId: number,
): Promise<ProductCoverage[]> {
  const result = await sql<{ category: string; trips: string; with_product: string }>`
    SELECT t.category_code AS category, count(*) AS trips, count(p.trip_key) AS with_product
      FROM trip t
      LEFT JOIN trip_product p USING (feed_version_id, trip_key)
     WHERE t.feed_version_id = ${feedVersionId}
     GROUP BY t.category_code
     ORDER BY t.category_code`.execute(db);
  return result.rows.map((row) => ({
    category: row.category,
    trips: Number(row.trips),
    withProduct: Number(row.with_product),
  }));
}

async function timetableRuns(
  db: Kysely<DB>,
  feedVersionId: number,
  serviceDate: string,
  at: number,
): Promise<TimetableRun[]> {
  const from = Math.floor((at - serviceInstant(serviceDate, 0) - TRAIL_MS) / 1000);
  const to = Math.ceil((at - serviceInstant(serviceDate, 0) + LEAD_MS) / 1000);
  const result = await sql<TimetableRun>`
    SELECT t.feed_version_id, t.trip_key, r.operator_id, t.short_name,
           pt.stop_place_id AS origin_place, t.first_departure_s, ${serviceDate}::text AS service_date
      FROM trip t
      JOIN route r USING (feed_version_id, route_key)
      JOIN service_calendar c USING (feed_version_id, service_key)
      JOIN trip_pattern_stop s0
        ON s0.feed_version_id = t.feed_version_id AND s0.trip_pattern_id = t.trip_pattern_id
       AND s0.stop_index = 0
      JOIN stop_point pt ON pt.stop_point_id = s0.stop_point_id
     WHERE t.feed_version_id = ${feedVersionId}
       AND t.first_departure_s <= ${to} AND t.last_arrival_s >= ${from}
       AND NOT EXISTS (
             SELECT 1 FROM service_calendar_date x
              WHERE x.feed_version_id = c.feed_version_id AND x.service_key = c.service_key
                AND x.service_date = ${serviceDate}::date AND x.exception_type = 2)
       AND (EXISTS (
             SELECT 1 FROM service_calendar_date x
              WHERE x.feed_version_id = c.feed_version_id AND x.service_key = c.service_key
                AND x.service_date = ${serviceDate}::date AND x.exception_type = 1)
            OR (${serviceDate}::date BETWEEN c.start_date AND c.end_date
                AND (c.weekdays >> (extract(isodow FROM ${serviceDate}::date)::int - 1)) & 1 = 1))
     ORDER BY t.trip_key`.execute(db);
  return result.rows;
}

/**
 * Every trip instance running at `at` (epoch milliseconds): timetable runs of the service day and
 * the day before, from the first departure minus ten minutes to the last arrival plus 30 seconds,
 * plus the instances realtime knows (added trips included). A run filed twice counts once, under its
 * smallest trip key, as ingest counts it.
 */
export async function runningAt(db: Kysely<DB>, at: number): Promise<DetailRef[]> {
  const today = localDate(at);
  const refs = new Map<string, DetailRef>();
  for (const serviceDate of [addDays(today, -1), today]) {
    const version = await versionForDay(db, serviceDate);
    if (version === null) continue;
    for (const run of await timetableRuns(db, version, serviceDate, at)) {
      const id = tripInstanceId({
        serviceDate,
        operatorId: run.operator_id,
        trainNumber: normalizeTrainNumber(run.short_name),
        originStopPlaceId: run.origin_place,
        originDeparture: serviceInstant(serviceDate, run.first_departure_s),
      });
      const held = refs.get(id);
      if (held && held.tripKey !== null && held.tripKey <= run.trip_key) continue;
      refs.set(id, {
        tripInstanceId: id,
        serviceDate,
        feedVersionId: run.feed_version_id,
        tripKey: run.trip_key,
        frameKey: null,
      });
    }
  }
  const known = await sql<{
    trip_instance_id: string;
    service_date: string;
    feed_version_id: number | null;
    trip_key: string | null;
  }>`
    SELECT i.trip_instance_id, i.service_date::text AS service_date, i.feed_version_id, i.trip_key
      FROM trip_instance i
     WHERE i.service_date = ANY(${[addDays(today, -1), today]}::date[])
       AND i.origin_departure <= ${new Date(at + LEAD_MS)}
       AND i.first_observed_at <= ${new Date(at)}
       AND EXISTS (
             SELECT 1 FROM stop_event e
              WHERE e.service_date = i.service_date AND e.trip_instance_id = i.trip_instance_id
              GROUP BY e.trip_instance_id
             HAVING max(coalesce(e.predicted_arrival, e.scheduled_arrival)) >= ${new Date(at - TRAIL_MS)})`.execute(
    db,
  );
  for (const row of known.rows) {
    refs.set(row.trip_instance_id, {
      tripInstanceId: row.trip_instance_id,
      serviceDate: row.service_date,
      feedVersionId: row.feed_version_id,
      tripKey: row.trip_key,
      frameKey: null,
    });
  }
  return [...refs.values()].sort((a, b) => a.tripInstanceId.localeCompare(b.tripInstanceId));
}
