import type { DB } from "@gerlines/db";
import { type Kysely, sql, type Transaction } from "kysely";
import type { RowBatch } from "./rows.ts";

type Executor = Kysely<DB> | Transaction<DB>;

const CHUNK = 5000;

function chunks<T>(rows: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += CHUNK)
    result.push(rows.slice(start, start + CHUNK));
  return result;
}

const seconds = (value: number | null): number | null => value;
const millis = (value: number): number => value / 1000;

async function writeInstances(db: Executor, rows: RowBatch["instances"]): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO trip_instance (trip_instance_id, service_date, feed_version_id, trip_key, operator_id,
        train_number, category_code, origin_stop_place_id, origin_departure, is_added, first_source_id,
        first_observed_at, first_raw_object_id)
      SELECT u.id, u.service_date, u.feed_version_id, u.trip_key, u.operator_id, u.train_number,
             u.category_code, u.origin, to_timestamp(u.origin_departure), u.is_added, u.source_id,
             to_timestamp(u.observed_at), u.raw_object_id
        FROM unnest(${part.map((r) => r.tripInstanceId)}::uuid[], ${part.map((r) => r.serviceDate)}::date[],
          ${part.map((r) => r.feedVersionId)}::integer[], ${part.map((r) => r.tripKey)}::text[],
          ${part.map((r) => r.operatorId)}::text[], ${part.map((r) => r.trainNumber)}::text[],
          ${part.map((r) => r.categoryCode)}::text[], ${part.map((r) => r.originStopPlaceId)}::uuid[],
          ${part.map((r) => r.originDeparture / 1000)}::float8[], ${part.map((r) => r.isAdded)}::boolean[],
          ${part.map((r) => r.sourceId)}::text[], ${part.map((r) => millis(r.observedAt))}::float8[],
          ${part.map((r) => r.rawObjectId)}::uuid[])
          AS u(id, service_date, feed_version_id, trip_key, operator_id, train_number, category_code,
               origin, origin_departure, is_added, source_id, observed_at, raw_object_id)
      ON CONFLICT (trip_instance_id) DO UPDATE SET
        feed_version_id = excluded.feed_version_id,
        trip_key = excluded.trip_key,
        category_code = excluded.category_code,
        first_source_id = excluded.first_source_id,
        first_observed_at = excluded.first_observed_at,
        first_raw_object_id = excluded.first_raw_object_id
      WHERE (excluded.first_observed_at, excluded.first_source_id)
          < (trip_instance.first_observed_at, trip_instance.first_source_id)`.execute(db);
  }
}

/** The staging tables of a rebuild, beside the tables they stand in for. */
export const STAGING = {
  stop_event: "rt_rebuild_stop_event",
  stop_event_forecast: "rt_rebuild_forecast",
  segment_obs: "rt_rebuild_segment",
} as const;

async function writeStopEvents(
  db: Executor,
  rows: RowBatch["stopEvents"],
  table: string = "stop_event",
): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO ${sql.table(table)} AS t (service_date, trip_instance_id, stop_index, source_id, stop_place_id,
        scheduled_arrival, scheduled_departure, predicted_arrival, predicted_departure, arrival_delay_s,
        departure_delay_s, prediction_kind, final_arrival, final_departure, final_quality,
        platform_scheduled, platform_actual, cancelled, additional, observed_at, raw_object_id)
      SELECT u.service_date, u.instance, u.stop_index, u.source_id, u.place, to_timestamp(u.sa),
             to_timestamp(u.sd), to_timestamp(u.pa), to_timestamp(u.pd), u.ad, u.dd, u.kind,
             to_timestamp(u.fa), to_timestamp(u.fd), u.quality, u.ps, u.pa2, u.cancelled, u.additional,
             to_timestamp(u.observed_at), u.raw_object_id
        FROM unnest(${part.map((r) => r.serviceDate)}::date[], ${part.map((r) => r.tripInstanceId)}::uuid[],
          ${part.map((r) => r.stopIndex)}::smallint[], ${part.map((r) => r.sourceId)}::text[],
          ${part.map((r) => r.stopPlaceId)}::uuid[], ${part.map((r) => seconds(r.scheduledArrival))}::float8[],
          ${part.map((r) => seconds(r.scheduledDeparture))}::float8[],
          ${part.map((r) => seconds(r.predictedArrival))}::float8[],
          ${part.map((r) => seconds(r.predictedDeparture))}::float8[],
          ${part.map((r) => r.arrivalDelay)}::integer[], ${part.map((r) => r.departureDelay)}::integer[],
          ${part.map((r) => r.predictionKind)}::text[], ${part.map((r) => seconds(r.finalArrival))}::float8[],
          ${part.map((r) => seconds(r.finalDeparture))}::float8[], ${part.map((r) => r.finalQuality)}::text[],
          ${part.map((r) => r.platformScheduled)}::text[], ${part.map((r) => r.platformActual)}::text[],
          ${part.map((r) => r.cancelled)}::boolean[], ${part.map((r) => r.additional)}::boolean[],
          ${part.map((r) => millis(r.observedAt))}::float8[], ${part.map((r) => r.rawObjectId)}::uuid[])
          AS u(service_date, instance, stop_index, source_id, place, sa, sd, pa, pd, ad, dd, kind, fa, fd,
               quality, ps, pa2, cancelled, additional, observed_at, raw_object_id)
      ON CONFLICT (service_date, trip_instance_id, stop_index, source_id) DO UPDATE SET
        predicted_arrival = excluded.predicted_arrival,
        predicted_departure = excluded.predicted_departure,
        arrival_delay_s = excluded.arrival_delay_s,
        departure_delay_s = excluded.departure_delay_s,
        prediction_kind = excluded.prediction_kind,
        final_arrival = excluded.final_arrival,
        final_departure = excluded.final_departure,
        final_quality = excluded.final_quality,
        platform_actual = excluded.platform_actual,
        cancelled = excluded.cancelled,
        additional = excluded.additional,
        observed_at = excluded.observed_at,
        raw_object_id = excluded.raw_object_id
      WHERE excluded.observed_at > t.observed_at`.execute(db);
  }
}

async function writeForecasts(
  db: Executor,
  rows: RowBatch["forecasts"],
  table: string = "stop_event_forecast",
): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO ${sql.table(table)} (trip_instance_id, stop_index, source_id, observed_at, service_date,
        predicted_arrival, predicted_departure, arrival_delay_s, departure_delay_s, cancelled, explicit,
        raw_object_id)
      SELECT u.instance, u.stop_index, u.source_id, to_timestamp(u.observed_at), u.service_date,
             to_timestamp(u.pa), to_timestamp(u.pd), u.ad, u.dd, u.cancelled, u.explicit, u.raw_object_id
        FROM unnest(${part.map((r) => r.tripInstanceId)}::uuid[], ${part.map((r) => r.stopIndex)}::smallint[],
          ${part.map((r) => r.sourceId)}::text[], ${part.map((r) => millis(r.observedAt))}::float8[],
          ${part.map((r) => r.serviceDate)}::date[], ${part.map((r) => r.predictedArrival)}::float8[],
          ${part.map((r) => r.predictedDeparture)}::float8[], ${part.map((r) => r.arrivalDelay)}::integer[],
          ${part.map((r) => r.departureDelay)}::integer[], ${part.map((r) => r.cancelled)}::boolean[],
          ${part.map((r) => r.explicit)}::boolean[], ${part.map((r) => r.rawObjectId)}::uuid[])
          AS u(instance, stop_index, source_id, observed_at, service_date, pa, pd, ad, dd, cancelled,
               explicit, raw_object_id)
      ON CONFLICT DO NOTHING`.execute(db);
  }
}

async function writeSegments(
  db: Executor,
  rows: RowBatch["segments"],
  table: string = "segment_obs",
): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO ${sql.table(table)} (service_date, trip_instance_id, from_index, source_id, to_index,
        from_stop_place_id, to_stop_place_id, dep_delay_from_s, arr_delay_to_s, delay_gain_s, run_sched_s,
        run_act_s, dwell_delay_s, observed_at, raw_object_id)
      SELECT u.service_date, u.instance, u.from_index, u.source_id, u.to_index, u.from_place, u.to_place,
             u.dep_delay, u.arr_delay, u.arr_delay - u.dep_delay, u.run_sched, u.run_act, u.dwell,
             to_timestamp(u.observed_at), u.raw_object_id
        FROM unnest(${part.map((r) => r.serviceDate)}::date[], ${part.map((r) => r.tripInstanceId)}::uuid[],
          ${part.map((r) => r.fromIndex)}::smallint[], ${part.map((r) => r.sourceId)}::text[],
          ${part.map((r) => r.toIndex)}::smallint[], ${part.map((r) => r.fromStopPlaceId)}::uuid[],
          ${part.map((r) => r.toStopPlaceId)}::uuid[], ${part.map((r) => r.depDelayFrom)}::integer[],
          ${part.map((r) => r.arrDelayTo)}::integer[], ${part.map((r) => r.runSched)}::integer[],
          ${part.map((r) => r.runAct)}::integer[], ${part.map((r) => r.dwellDelay)}::integer[],
          ${part.map((r) => millis(r.observedAt))}::float8[], ${part.map((r) => r.rawObjectId)}::uuid[])
          AS u(service_date, instance, from_index, source_id, to_index, from_place, to_place, dep_delay,
               arr_delay, run_sched, run_act, dwell, observed_at, raw_object_id)
      ON CONFLICT DO NOTHING`.execute(db);
  }
}

async function writeEvents(db: Executor, rows: RowBatch["events"]): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO event (event_id, occurred_at, event_type, source_id, trip_instance_id, stop_index, payload,
        raw_object_id)
      SELECT u.id, to_timestamp(u.occurred_at), u.event_type, u.source_id, u.instance, u.stop_index,
             u.payload::jsonb, u.raw_object_id
        FROM unnest(${part.map((r) => r.eventId)}::uuid[], ${part.map((r) => millis(r.occurredAt))}::float8[],
          ${part.map((r) => r.eventType)}::text[], ${part.map((r) => r.sourceId)}::text[],
          ${part.map((r) => r.tripInstanceId)}::uuid[], ${part.map((r) => r.stopIndex)}::smallint[],
          ${part.map((r) => JSON.stringify(r.payload))}::text[], ${part.map((r) => r.rawObjectId)}::uuid[])
          AS u(id, occurred_at, event_type, source_id, instance, stop_index, payload, raw_object_id)
      ON CONFLICT DO NOTHING`.execute(db);
  }
}

async function writeBacklog(db: Executor, rows: RowBatch["backlog"]): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO match_backlog (source_id, entity_key, service_date, reason, detail, first_observed_at,
        first_raw_object_id, last_seen_hour)
      SELECT u.source_id, u.entity_key, u.service_date, u.reason, u.detail::jsonb,
             to_timestamp(u.first_observed_at), u.raw_object_id, to_timestamp(u.last_seen_hour)
        FROM unnest(${part.map((r) => r.sourceId)}::text[], ${part.map((r) => r.entityKey)}::text[],
          ${part.map((r) => r.serviceDate)}::date[], ${part.map((r) => r.reason)}::text[],
          ${part.map((r) => JSON.stringify(r.detail))}::text[],
          ${part.map((r) => millis(r.firstObservedAt))}::float8[],
          ${part.map((r) => r.firstRawObjectId)}::uuid[], ${part.map((r) => millis(r.lastSeenHour))}::float8[])
          AS u(source_id, entity_key, service_date, reason, detail, first_observed_at, raw_object_id,
               last_seen_hour)
      ON CONFLICT (source_id, entity_key, service_date, reason) DO UPDATE SET
        detail = CASE WHEN excluded.first_observed_at < match_backlog.first_observed_at
                      THEN excluded.detail ELSE match_backlog.detail END,
        first_raw_object_id = CASE WHEN excluded.first_observed_at < match_backlog.first_observed_at
                      THEN excluded.first_raw_object_id ELSE match_backlog.first_raw_object_id END,
        first_observed_at = LEAST(excluded.first_observed_at, match_backlog.first_observed_at),
        last_seen_hour = GREATEST(excluded.last_seen_hour, match_backlog.last_seen_hour)
      WHERE excluded.first_observed_at < match_backlog.first_observed_at
         OR excluded.last_seen_hour > match_backlog.last_seen_hour`.execute(db);
  }
}

async function writeAlertMessages(db: Executor, rows: RowBatch["alertMessages"]): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO alert_message (source_id, alert_key, content_hash, cause, effect, severity,
        active_periods, header, description, url, selector_count, first_observed_at,
        first_raw_object_id, last_seen_hour)
      SELECT u.source_id, u.alert_key, u.content_hash, u.cause, u.effect, u.severity,
             u.active_periods::jsonb, u.header::jsonb, u.description::jsonb, u.url::jsonb,
             u.selector_count, to_timestamp(u.first_observed_at), u.raw_object_id,
             to_timestamp(u.last_seen_hour)
        FROM unnest(${part.map((r) => r.sourceId)}::text[], ${part.map((r) => r.alertKey)}::text[],
          ${part.map((r) => r.contentHash)}::text[], ${part.map((r) => r.cause)}::smallint[],
          ${part.map((r) => r.effect)}::smallint[], ${part.map((r) => r.severity)}::smallint[],
          ${part.map((r) => JSON.stringify(r.activePeriods))}::text[],
          ${part.map((r) => JSON.stringify(r.header))}::text[],
          ${part.map((r) => JSON.stringify(r.description))}::text[],
          ${part.map((r) => JSON.stringify(r.url))}::text[],
          ${part.map((r) => r.selectorCount)}::integer[],
          ${part.map((r) => millis(r.firstObservedAt))}::float8[],
          ${part.map((r) => r.firstRawObjectId)}::uuid[], ${part.map((r) => millis(r.lastSeenHour))}::float8[])
          AS u(source_id, alert_key, content_hash, cause, effect, severity, active_periods, header,
               description, url, selector_count, first_observed_at, raw_object_id, last_seen_hour)
      ON CONFLICT (source_id, alert_key, content_hash) DO UPDATE SET
        first_raw_object_id = CASE WHEN excluded.first_observed_at < alert_message.first_observed_at
                      THEN excluded.first_raw_object_id ELSE alert_message.first_raw_object_id END,
        first_observed_at = LEAST(excluded.first_observed_at, alert_message.first_observed_at),
        last_seen_hour = GREATEST(excluded.last_seen_hour, alert_message.last_seen_hour)
      WHERE excluded.first_observed_at < alert_message.first_observed_at
         OR excluded.last_seen_hour > alert_message.last_seen_hour`.execute(db);
  }
}

async function writeAlertScopes(db: Executor, rows: RowBatch["alertScopes"]): Promise<void> {
  const byTarget = (kind: "trip" | "place") =>
    rows.filter((row) => (kind === "trip" ? row.tripInstanceId : row.stopPlaceId) !== null);
  for (const kind of ["trip", "place"] as const) {
    const column = kind === "trip" ? "trip_instance_id" : "stop_place_id";
    for (const part of chunks(byTarget(kind))) {
      await sql`
        INSERT INTO alert_scope (source_id, alert_key, content_hash, ${sql.ref(column)},
          first_observed_at, first_raw_object_id, last_seen_hour)
        SELECT u.source_id, u.alert_key, u.content_hash, u.target, to_timestamp(u.first_observed_at),
               u.raw_object_id, to_timestamp(u.last_seen_hour)
          FROM unnest(${part.map((r) => r.sourceId)}::text[], ${part.map((r) => r.alertKey)}::text[],
            ${part.map((r) => r.contentHash)}::text[],
            ${part.map((r) => (kind === "trip" ? r.tripInstanceId : r.stopPlaceId))}::uuid[],
            ${part.map((r) => millis(r.firstObservedAt))}::float8[],
            ${part.map((r) => r.firstRawObjectId)}::uuid[],
            ${part.map((r) => millis(r.lastSeenHour))}::float8[])
            AS u(source_id, alert_key, content_hash, target, first_observed_at, raw_object_id,
                 last_seen_hour)
        ON CONFLICT (source_id, alert_key, content_hash, ${sql.ref(column)})
          WHERE ${sql.ref(column)} IS NOT NULL
        DO UPDATE SET
          first_raw_object_id = CASE WHEN excluded.first_observed_at < alert_scope.first_observed_at
                        THEN excluded.first_raw_object_id ELSE alert_scope.first_raw_object_id END,
          first_observed_at = LEAST(excluded.first_observed_at, alert_scope.first_observed_at),
          last_seen_hour = GREATEST(excluded.last_seen_hour, alert_scope.last_seen_hour)
        WHERE excluded.first_observed_at < alert_scope.first_observed_at
           OR excluded.last_seen_hour > alert_scope.last_seen_hour`.execute(db);
    }
  }
}

async function writeInstanceSeen(db: Executor, rows: RowBatch["instanceSeen"]): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO trip_instance_source (trip_instance_id, source_id, first_observed_at,
        last_observed_at, last_raw_object_id)
      SELECT u.instance, u.source_id, to_timestamp(u.observed_at), to_timestamp(u.observed_at),
             u.raw_object_id
        FROM unnest(${part.map((r) => r.tripInstanceId)}::uuid[], ${part.map((r) => r.sourceId)}::text[],
          ${part.map((r) => millis(r.observedAt))}::float8[], ${part.map((r) => r.rawObjectId)}::uuid[])
          AS u(instance, source_id, observed_at, raw_object_id)
      ON CONFLICT (trip_instance_id, source_id) DO UPDATE SET
        first_observed_at = LEAST(excluded.first_observed_at, trip_instance_source.first_observed_at),
        last_raw_object_id = CASE WHEN excluded.last_observed_at > trip_instance_source.last_observed_at
                      THEN excluded.last_raw_object_id ELSE trip_instance_source.last_raw_object_id END,
        last_observed_at = GREATEST(excluded.last_observed_at, trip_instance_source.last_observed_at)
      WHERE excluded.first_observed_at < trip_instance_source.first_observed_at
         OR excluded.last_observed_at > trip_instance_source.last_observed_at`.execute(db);
  }
}

/** Channel of the notice sent when a payload's rows are committed (D-038 item 7). */
export const PAYLOAD_CHANNEL = "realtime_payload";
/** Channel of the notice sent when a source's rows of some service days were rebuilt. */
export const REBUILD_CHANNEL = "realtime_rebuild";

export interface PayloadLogRow {
  readonly rawObjectId: string;
  /** The recorded source the payload came from. */
  readonly sourceId: string;
  /** The logical source its rows carry. */
  readonly foldSourceId: string;
  readonly observedAt: number;
  readonly processedAt: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly error: string | null;
}

async function writeOrderFree(trx: Executor, batch: RowBatch): Promise<void> {
  await writeInstances(trx, batch.instances);
  await writeInstanceSeen(trx, batch.instanceSeen);
  await writeEvents(trx, batch.events);
  await writeBacklog(trx, batch.backlog);
  await writeAlertMessages(trx, batch.alertMessages);
  await writeAlertScopes(trx, batch.alertScopes);
}

async function writeRows(trx: Executor, batch: RowBatch): Promise<void> {
  await writeInstances(trx, batch.instances);
  await writeInstanceSeen(trx, batch.instanceSeen);
  await writeStopEvents(trx, batch.stopEvents);
  await writeForecasts(trx, batch.forecasts);
  await writeSegments(trx, batch.segments);
  await writeEvents(trx, batch.events);
  await writeBacklog(trx, batch.backlog);
  await writeAlertMessages(trx, batch.alertMessages);
  await writeAlertScopes(trx, batch.alertScopes);
}

async function writeLogLine(trx: Executor, log: PayloadLogRow, rows: number): Promise<void> {
  await sql`
    INSERT INTO rt_payload (raw_object_id, source_id, fold_source_id, observed_at, processed_at,
      counts, error)
    VALUES (${log.rawObjectId}::uuid, ${log.sourceId}, ${log.foldSourceId},
            to_timestamp(${log.observedAt / 1000}), to_timestamp(${log.processedAt / 1000}),
            ${JSON.stringify(log.counts)}::jsonb, ${log.error})
    ON CONFLICT (raw_object_id) DO UPDATE SET processed_at = excluded.processed_at,
      fold_source_id = excluded.fold_source_id, counts = excluded.counts, error = excluded.error`.execute(
    trx,
  );
  const notice = {
    rawObjectId: log.rawObjectId,
    sourceId: log.sourceId,
    foldSourceId: log.foldSourceId,
    observedAt: new Date(log.observedAt).toISOString(),
    processedAt: new Date(log.processedAt).toISOString(),
    rows: log.error ? 0 : rows,
  };
  await sql`SELECT pg_notify(${PAYLOAD_CHANNEL}, ${JSON.stringify(notice)})`.execute(trx);
}

/**
 * Writes one payload's rows and its processing log line in a single transaction, and a notice on
 * `PAYLOAD_CHANNEL` that Postgres delivers when it commits. Without a log line (a payload folded
 * again in a rebuild) only the rows are written.
 */
export async function writeBatch(
  db: Kysely<DB>,
  batch: RowBatch,
  log: PayloadLogRow | null,
): Promise<void> {
  await inTransaction(db, async (trx) => {
    await writeRows(trx, batch);
    if (log) await writeLogLine(trx, log, batch.forecasts.length + batch.stopEvents.length);
  });
}

/** Postgres error codes after which the same transaction may simply be run again. */
const RETRYABLE = new Set(["40P01", "40001"]);
const RETRIES = 3;

const retryable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  RETRYABLE.has(String((error as { code?: unknown }).code));

/**
 * Runs `work` in a transaction, or in the caller's when `db` already is one. A transaction of its
 * own that loses a deadlock (for example against a timetable load) is run again a few times.
 */
export async function inTransaction<T>(
  db: Kysely<DB>,
  work: (trx: Kysely<DB>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return work(db);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction().execute(work);
    } catch (error) {
      if (attempt >= RETRIES || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

const DAY_MS = 86_400_000;

/** The staged rows a swap finds are not those of its rebuild (another writer, or a database restart). */
export class StagingLostError extends Error {
  constructor() {
    super("the staging tables no longer hold this rebuild's rows");
    this.name = "StagingLostError";
  }
}

/** Empties the staging tables and the mark of the rebuild they belong to. */
export async function clearStaging(db: Kysely<DB>): Promise<void> {
  await sql`TRUNCATE rt_rebuild_job, ${sql.table(STAGING.stop_event)},
    ${sql.table(STAGING.stop_event_forecast)}, ${sql.table(STAGING.segment_obs)}`.execute(db);
}

/**
 * Empties the staging tables before a rebuild stages its rows and marks them as the rebuild's
 * (`token`, and the server's start, since a crash recovery empties unlogged tables).
 */
export async function startStaging(db: Kysely<DB>, token: string): Promise<void> {
  await inTransaction(db, async (trx) => {
    await clearStaging(trx);
    await sql`INSERT INTO rt_rebuild_job (token, postmaster_start)
              VALUES (${token}::uuid, pg_postmaster_start_time())`.execute(trx);
  });
}

/**
 * Stages the day-bound rows of one refolded payload (stop rows, and forecasts and segments observed
 * from `cut` on) and writes its order-free rows (instances, seen rows, outbox, backlog, alerts) in
 * place, since those merge to the same result in any order.
 */
export async function stageBatch(db: Kysely<DB>, batch: RowBatch, cut: number): Promise<void> {
  await inTransaction(db, async (trx) => {
    await writeOrderFree(trx, batch);
    await writeStopEvents(trx, batch.stopEvents, STAGING.stop_event);
    await writeForecasts(
      trx,
      batch.forecasts.filter((row) => row.observedAt >= cut),
      STAGING.stop_event_forecast,
    );
    await writeSegments(
      trx,
      batch.segments.filter((row) => row.observedAt >= cut),
      STAGING.segment_obs,
    );
  });
}

/**
 * A late payload's log line, written when its rebuild is swapped in, with its row count. Its
 * `processed_at` is the swap's start: one writer commits nothing else meanwhile, so for readers that
 * follow `rt_payload` by `processed_at` (WP-3.2a's FollowReader) its order is the commit order.
 */
export interface StagedLog {
  readonly log: PayloadLogRow;
  readonly rows: number;
}

export interface SwapCounts {
  readonly deleted: {
    readonly stopEvents: number;
    readonly forecasts: number;
    readonly segments: number;
  };
  readonly inserted: {
    readonly stopEvents: number;
    readonly forecasts: number;
    readonly segments: number;
  };
}

const count = async (db: Executor, query: ReturnType<typeof sql>): Promise<number> => {
  const result = await sql<{
    n: string;
  }>`WITH changed AS (${query}) SELECT count(*)::text AS n FROM changed`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
};

/**
 * Puts a rebuild's staged rows in place, in one transaction: a source's rows of `days` that the
 * rebuild may have changed (stop rows it staged or observed from `cut` on, forecasts and segments
 * observed from `cut` on) and that differ from the staged ones are deleted, the staged rows are
 * inserted where missing, the late payloads' log lines are written, and a notice on `REBUILD_CHANNEL`
 * follows at commit. Rows equal in both orders are left alone, so the transaction stays short.
 * Forecasts are looked for in the observation window the days can have (a service day is observed
 * from two days before to four days after it), so old chunks are not scanned.
 */
export async function swapStaged(
  db: Kysely<DB>,
  token: string,
  sourceId: string,
  days: readonly string[],
  cut: number,
  logs: readonly StagedLog[],
): Promise<SwapCounts> {
  const sorted = [...days].sort();
  const from = new Date(Date.parse(`${sorted[0]}T00:00:00Z`) - 2 * DAY_MS);
  const to = new Date(Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`) + 4 * DAY_MS);
  const cutAt = sql`to_timestamp(${cut / 1000})`;
  const stopEvent = sql.table(STAGING.stop_event);
  const forecast = sql.table(STAGING.stop_event_forecast);
  const segment = sql.table(STAGING.segment_obs);
  await sql`ANALYZE ${stopEvent}, ${forecast}, ${segment}`.execute(db);
  return inTransaction(db, async (trx) => {
    const mark = await sql<{ ours: boolean }>`
      SELECT token = ${token}::uuid AND postmaster_start = pg_postmaster_start_time() AS ours
        FROM rt_rebuild_job FOR UPDATE`.execute(trx);
    if (mark.rows[0]?.ours !== true) throw new StagingLostError();
    const stopEventsDeleted = await count(
      trx,
      sql`DELETE FROM stop_event t
           WHERE t.source_id = ${sourceId} AND t.service_date = ANY(${sorted}::date[])
             AND (t.observed_at >= ${cutAt} OR EXISTS (
                   SELECT 1 FROM ${stopEvent} s
                    WHERE s.service_date = t.service_date AND s.trip_instance_id = t.trip_instance_id
                      AND s.stop_index = t.stop_index AND s.source_id = t.source_id))
             AND NOT EXISTS (
                   SELECT 1 FROM ${stopEvent} s
                    WHERE s.service_date = t.service_date AND s.trip_instance_id = t.trip_instance_id
                      AND s.stop_index = t.stop_index AND s.source_id = t.source_id
                      AND (s.stop_place_id, s.scheduled_arrival, s.scheduled_departure,
                           s.predicted_arrival, s.predicted_departure, s.arrival_delay_s,
                           s.departure_delay_s, s.prediction_kind, s.final_arrival, s.final_departure,
                           s.final_quality, s.platform_scheduled, s.platform_actual, s.cancelled,
                           s.additional, s.observed_at, s.raw_object_id)
                          IS NOT DISTINCT FROM
                          (t.stop_place_id, t.scheduled_arrival, t.scheduled_departure,
                           t.predicted_arrival, t.predicted_departure, t.arrival_delay_s,
                           t.departure_delay_s, t.prediction_kind, t.final_arrival, t.final_departure,
                           t.final_quality, t.platform_scheduled, t.platform_actual, t.cancelled,
                           t.additional, t.observed_at, t.raw_object_id))
          RETURNING 1`,
    );
    const stopEventsInserted = await count(
      trx,
      sql`INSERT INTO stop_event (service_date, trip_instance_id, stop_index, source_id, stop_place_id,
            scheduled_arrival, scheduled_departure, predicted_arrival, predicted_departure,
            arrival_delay_s, departure_delay_s, prediction_kind, final_arrival, final_departure,
            final_quality, platform_scheduled, platform_actual, cancelled, additional, observed_at,
            raw_object_id)
          SELECT service_date, trip_instance_id, stop_index, source_id, stop_place_id,
            scheduled_arrival, scheduled_departure, predicted_arrival, predicted_departure,
            arrival_delay_s, departure_delay_s, prediction_kind, final_arrival, final_departure,
            final_quality, platform_scheduled, platform_actual, cancelled, additional, observed_at,
            raw_object_id
            FROM ${stopEvent}
          ON CONFLICT DO NOTHING RETURNING 1`,
    );
    const forecastsDeleted = await count(
      trx,
      sql`DELETE FROM stop_event_forecast t
           WHERE t.source_id = ${sourceId} AND t.service_date = ANY(${sorted}::date[])
             AND t.observed_at >= ${cutAt} AND t.observed_at >= ${from} AND t.observed_at < ${to}
             AND NOT EXISTS (
                   SELECT 1 FROM ${forecast} s
                    WHERE s.trip_instance_id = t.trip_instance_id AND s.stop_index = t.stop_index
                      AND s.source_id = t.source_id AND s.observed_at = t.observed_at
                      AND (s.service_date, s.predicted_arrival, s.predicted_departure,
                           s.arrival_delay_s, s.departure_delay_s, s.cancelled, s.explicit,
                           s.raw_object_id)
                          IS NOT DISTINCT FROM
                          (t.service_date, t.predicted_arrival, t.predicted_departure,
                           t.arrival_delay_s, t.departure_delay_s, t.cancelled, t.explicit,
                           t.raw_object_id))
          RETURNING 1`,
    );
    const forecastsInserted = await count(
      trx,
      sql`INSERT INTO stop_event_forecast (trip_instance_id, stop_index, source_id, observed_at,
            service_date, predicted_arrival, predicted_departure, arrival_delay_s,
            departure_delay_s, cancelled, explicit, raw_object_id)
          SELECT trip_instance_id, stop_index, source_id, observed_at, service_date,
            predicted_arrival, predicted_departure, arrival_delay_s, departure_delay_s, cancelled,
            explicit, raw_object_id
            FROM ${forecast}
          ON CONFLICT DO NOTHING RETURNING 1`,
    );
    const segmentsDeleted = await count(
      trx,
      sql`DELETE FROM segment_obs t
           WHERE t.source_id = ${sourceId} AND t.service_date = ANY(${sorted}::date[])
             AND t.observed_at >= ${cutAt}
             AND NOT EXISTS (
                   SELECT 1 FROM ${segment} s
                    WHERE s.service_date = t.service_date AND s.trip_instance_id = t.trip_instance_id
                      AND s.from_index = t.from_index AND s.source_id = t.source_id
                      AND (s.to_index, s.from_stop_place_id, s.to_stop_place_id, s.dep_delay_from_s,
                           s.arr_delay_to_s, s.delay_gain_s, s.run_sched_s, s.run_act_s,
                           s.dwell_delay_s, s.observed_at, s.raw_object_id)
                          IS NOT DISTINCT FROM
                          (t.to_index, t.from_stop_place_id, t.to_stop_place_id, t.dep_delay_from_s,
                           t.arr_delay_to_s, t.delay_gain_s, t.run_sched_s, t.run_act_s,
                           t.dwell_delay_s, t.observed_at, t.raw_object_id))
          RETURNING 1`,
    );
    const segmentsInserted = await count(
      trx,
      sql`INSERT INTO segment_obs (service_date, trip_instance_id, from_index, source_id, to_index,
            from_stop_place_id, to_stop_place_id, dep_delay_from_s, arr_delay_to_s, delay_gain_s,
            run_sched_s, run_act_s, dwell_delay_s, observed_at, raw_object_id)
          SELECT service_date, trip_instance_id, from_index, source_id, to_index,
            from_stop_place_id, to_stop_place_id, dep_delay_from_s, arr_delay_to_s, delay_gain_s,
            run_sched_s, run_act_s, dwell_delay_s, observed_at, raw_object_id
            FROM ${segment}
          ON CONFLICT DO NOTHING RETURNING 1`,
    );
    for (const { log, rows } of logs) await writeLogLine(trx, log, rows);
    await notifyRebuilt(trx, sourceId, sorted);
    return {
      deleted: {
        stopEvents: stopEventsDeleted,
        forecasts: forecastsDeleted,
        segments: segmentsDeleted,
      },
      inserted: {
        stopEvents: stopEventsInserted,
        forecasts: forecastsInserted,
        segments: segmentsInserted,
      },
    };
  });
}

/** Tells listeners that a source's rows of these service days were written again. */
export async function notifyRebuilt(
  db: Executor,
  sourceId: string,
  days: readonly string[],
): Promise<void> {
  const notice = { foldSourceId: sourceId, serviceDates: [...days].sort() };
  await sql`SELECT pg_notify(${REBUILD_CHANNEL}, ${JSON.stringify(notice)})`.execute(db);
}
