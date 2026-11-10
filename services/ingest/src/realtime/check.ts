import type { DB } from "@gerlines/db";
import { type Kysely, sql } from "kysely";

/**
 * Error text of a payload the adapter refused (bytes that are no valid feed, as the source sent
 * them): a defect of the source, reported under quality, not a failure of the processor.
 */
export const FEED_REJECTED = "feed rejected: ";

/**
 * Error text of a payload refused for our own decode limits (entities, messages, list or string
 * caps): the processor drops a whole feed, so it stays an invariant failure.
 */
export const FEED_OVER_LIMIT = "feed over decode limit: ";

const LIMIT_REFUSAL =
  /^(feed has more than \d+ (entities|messages)|string longer than \d+ bytes|[\w ]+: more than \d+)$/;

/** The log line's error for a feed the adapter refused. */
export function refusal(reason: string): string {
  return `${LIMIT_REFUSAL.test(reason) ? FEED_OVER_LIMIT : FEED_REJECTED}${reason}`;
}

/**
 * Row order and columns of each realtime table's fingerprint; processing times are left out. The
 * fingerprint hashes the ordered row hashes, so a day of forecasts stays under the 1 GB text limit.
 */
const FINGERPRINTS: Record<string, { readonly columns: string; readonly order: string }> = {
  trip_instance: { columns: "t.*", order: "trip_instance_id" },
  match_backlog: { columns: "t.*", order: "source_id, entity_key, service_date, reason" },
  stop_event: { columns: "t.*", order: "service_date, trip_instance_id, stop_index, source_id" },
  stop_event_forecast: {
    columns: "t.*",
    order: "trip_instance_id, stop_index, source_id, observed_at",
  },
  segment_obs: { columns: "t.*", order: "service_date, trip_instance_id, from_index, source_id" },
  trip_instance_source: {
    columns: "t.trip_instance_id, t.source_id, t.first_observed_at",
    order: "trip_instance_id, source_id",
  },
  alert_message: { columns: "t.*", order: "source_id, alert_key, content_hash" },
  alert_scope: {
    columns: "t.*",
    order: "source_id, alert_key, content_hash, trip_instance_id, stop_place_id",
  },
  event: { columns: "t.*", order: "event_id, occurred_at" },
  rt_payload: {
    columns: "t.raw_object_id, t.source_id, t.fold_source_id, t.observed_at, t.counts, t.error",
    order: "raw_object_id",
  },
};

export interface TableFingerprint {
  readonly table: string;
  readonly rows: number;
  readonly md5: string;
}

export async function fingerprints(db: Kysely<DB>): Promise<TableFingerprint[]> {
  const result: TableFingerprint[] = [];
  for (const [table, spec] of Object.entries(FINGERPRINTS)) {
    const row = await sql<{ rows: string; md5: string | null }>`
      SELECT count(*)::text AS rows,
             md5(coalesce(string_agg(md5(r::text), '' ORDER BY ${sql.raw(spec.order)}), '')) AS md5
        FROM (SELECT ${sql.raw(spec.columns)} FROM ${sql.table(table)} t) r`.execute(db);
    const first = row.rows[0];
    result.push({ table, rows: Number(first?.rows ?? 0), md5: first?.md5 ?? "" });
  }
  return result;
}

export interface InvariantResult {
  readonly name: string;
  readonly violations: number;
  /** The source a quality count is about, when it is counted per source. */
  readonly source?: string;
}

const INVARIANTS: Record<string, string> = {
  stop_event_without_instance: `SELECT count(*) FROM stop_event s LEFT JOIN trip_instance i USING (trip_instance_id) WHERE i.trip_instance_id IS NULL`,
  forecast_without_instance: `SELECT count(*) FROM stop_event_forecast s LEFT JOIN trip_instance i USING (trip_instance_id) WHERE i.trip_instance_id IS NULL`,
  segment_without_instance: `SELECT count(*) FROM segment_obs s LEFT JOIN trip_instance i USING (trip_instance_id) WHERE i.trip_instance_id IS NULL`,
  event_without_instance: `SELECT count(*) FROM event s LEFT JOIN trip_instance i USING (trip_instance_id) WHERE s.trip_instance_id IS NOT NULL AND i.trip_instance_id IS NULL`,
  rows_without_raw_object: `SELECT (SELECT count(*) FROM stop_event s LEFT JOIN raw_object r USING (raw_object_id) WHERE r.raw_object_id IS NULL)
      + (SELECT count(*) FROM stop_event_forecast s LEFT JOIN raw_object r USING (raw_object_id) WHERE r.raw_object_id IS NULL)
      + (SELECT count(*) FROM segment_obs s LEFT JOIN raw_object r USING (raw_object_id) WHERE r.raw_object_id IS NULL)
      + (SELECT count(*) FROM event s LEFT JOIN raw_object r USING (raw_object_id) WHERE r.raw_object_id IS NULL)
      + (SELECT count(*) FROM trip_instance s LEFT JOIN raw_object r ON r.raw_object_id = s.first_raw_object_id WHERE r.raw_object_id IS NULL)
      + (SELECT count(*) FROM match_backlog s LEFT JOIN raw_object r ON r.raw_object_id = s.first_raw_object_id WHERE r.raw_object_id IS NULL)
      + (SELECT count(*) FROM alert_message s LEFT JOIN raw_object r ON r.raw_object_id = s.first_raw_object_id WHERE r.raw_object_id IS NULL)
      + (SELECT count(*) FROM alert_scope s LEFT JOIN raw_object r ON r.raw_object_id = s.first_raw_object_id WHERE r.raw_object_id IS NULL)
      + (SELECT count(*) FROM trip_instance_source s LEFT JOIN raw_object r ON r.raw_object_id = s.last_raw_object_id WHERE r.raw_object_id IS NULL)`,
  rows_without_last_seen: `SELECT count(*) FROM (SELECT DISTINCT trip_instance_id, source_id FROM stop_event) e WHERE NOT EXISTS (SELECT 1 FROM trip_instance_source s WHERE s.trip_instance_id = e.trip_instance_id AND s.source_id = e.source_id)`,
  segment_not_once_per_leg: `SELECT count(*) FROM (SELECT trip_instance_id, from_index, source_id FROM segment_obs GROUP BY 1, 2, 3 HAVING count(*) > 1) d`,
  segment_legs_overlap: `SELECT count(*) FROM (SELECT to_index, lead(from_index) OVER (PARTITION BY trip_instance_id, source_id ORDER BY from_index) AS next_from FROM segment_obs) l WHERE next_from IS NOT NULL AND next_from < to_index`,
  segment_skips_served_stop: `SELECT count(*) FROM segment_obs g WHERE EXISTS (SELECT 1 FROM stop_event e WHERE e.trip_instance_id = g.trip_instance_id AND e.source_id = g.source_id AND e.service_date = g.service_date AND e.stop_index > g.from_index AND e.stop_index < g.to_index AND NOT e.cancelled)`,
  forecast_without_change: `SELECT count(*) FROM (SELECT (predicted_arrival, predicted_departure, cancelled, explicit) IS NOT DISTINCT FROM lag((predicted_arrival, predicted_departure, cancelled, explicit)) OVER w AS same, row_number() OVER w AS n FROM stop_event_forecast WINDOW w AS (PARTITION BY trip_instance_id, stop_index, source_id ORDER BY observed_at)) f WHERE n > 1 AND same`,
  stop_event_not_last_forecast: `SELECT count(*) FROM stop_event e JOIN LATERAL (SELECT predicted_arrival, predicted_departure FROM stop_event_forecast f WHERE f.trip_instance_id = e.trip_instance_id AND f.stop_index = e.stop_index AND f.source_id = e.source_id ORDER BY observed_at DESC LIMIT 1) last ON true WHERE (last.predicted_arrival, last.predicted_departure) IS DISTINCT FROM (e.predicted_arrival, e.predicted_departure)`,
  segment_negative_run: `SELECT count(*) FROM segment_obs WHERE run_act_s < 0`,
  forecast_backwards: `SELECT count(*) FROM (SELECT coalesce(predicted_arrival, predicted_departure) AS reached, coalesce(predicted_departure, predicted_arrival) AS left_at, lag(coalesce(predicted_departure, predicted_arrival)) OVER (PARTITION BY service_date, trip_instance_id, source_id ORDER BY stop_index) AS left_before FROM stop_event WHERE NOT cancelled AND coalesce(predicted_arrival, predicted_departure) IS NOT NULL) e WHERE left_at < reached OR reached < left_before`,
  payload_errors: `SELECT count(*) FROM rt_payload WHERE error IS NOT NULL AND error NOT LIKE '${FEED_REJECTED}%'`,
};

/** Facts about the source data, reported but not failures of the pipeline (values are kept as sent). */
const QUALITY: Record<string, string> = {
  departure_before_arrival: `SELECT count(*) FROM stop_event WHERE final_arrival IS NOT NULL AND final_departure IS NOT NULL AND final_departure < final_arrival`,
  final_carried_without_update: `SELECT count(*) FROM stop_event WHERE final_quality = 'carried'`,
  stops_cancelled: `SELECT count(*) FROM stop_event WHERE cancelled`,
  platform_changes: `SELECT count(*) FROM stop_event WHERE platform_actual IS NOT NULL`,
};

export async function quality(db: Kysely<DB>): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  for (const [name, query] of Object.entries(QUALITY)) {
    const row = await sql<{ count: string }>`${sql.raw(query)}`.execute(db);
    results.push({ name, violations: Number(Object.values(row.rows[0] ?? {})[0] ?? 0) });
  }
  const rejected = await sql<{ source: string; count: string }>`
    SELECT source_id AS source, count(*)::text AS count FROM rt_payload
     WHERE error LIKE ${`${FEED_REJECTED}%`} GROUP BY 1 ORDER BY 1`.execute(db);
  for (const row of rejected.rows) {
    results.push({ name: "feed_rejected", source: row.source, violations: Number(row.count) });
  }
  return results;
}

export async function invariants(db: Kysely<DB>): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  for (const [name, query] of Object.entries(INVARIANTS)) {
    const row = await sql<{ count: string }>`${sql.raw(query)}`.execute(db);
    const value = Object.values(row.rows[0] ?? {})[0];
    results.push({ name, violations: Number(value ?? 0) });
  }
  return results;
}

export interface TableSize {
  readonly table: string;
  readonly bytes: number;
}

/** Bytes per realtime table, hypertables with their chunks, and the whole database. */
export async function sizes(db: Kysely<DB>): Promise<{ database: number; tables: TableSize[] }> {
  const tables: TableSize[] = [];
  for (const table of Object.keys(FINGERPRINTS)) {
    const hyper = await sql<{ bytes: string | null }>`
      SELECT hypertable_size(${table}::text::regclass)::text AS bytes
       WHERE EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                      WHERE hypertable_name = ${table}::text)`.execute(db);
    const plain = await sql<{ bytes: string }>`
      SELECT pg_total_relation_size(${table}::text::regclass)::text AS bytes`.execute(db);
    tables.push({ table, bytes: Number(hyper.rows[0]?.bytes ?? plain.rows[0]?.bytes ?? 0) });
  }
  const database = await sql<{
    bytes: string;
  }>`SELECT pg_database_size(current_database())::text AS bytes`.execute(db);
  return { database: Number(database.rows[0]?.bytes ?? 0), tables };
}
