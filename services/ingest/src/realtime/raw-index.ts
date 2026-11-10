import type { DB } from "@gerlines/db";
import { type Kysely, sql } from "kysely";
import { APP_VERSION } from "../env.ts";
import { RecorderIndex } from "../index-db.ts";
import type { FetchRecord } from "../storage/sidecar.ts";

/**
 * Makes sure the recorder's index rows of these payloads exist before rows refer to them: the
 * recorder writes them too, a moment later or not at all when its index write failed, so this only
 * adds what is missing and never changes a row the recorder wrote. Sources must be registered by the
 * recorder (their licence and attribution come from it): payloads of an unregistered source are
 * returned apart and not processed.
 */
export async function ensureIndexed(
  db: Kysely<DB>,
  records: readonly FetchRecord[],
): Promise<{ indexed: FetchRecord[]; unregistered: FetchRecord[] }> {
  if (records.length === 0) return { indexed: [], unregistered: [] };
  const sources = [...new Set(records.map((record) => record.source))];
  const known = await sql<{ source_id: string }>`
    SELECT source_id FROM source WHERE source_id = ANY(${sources}::text[])`.execute(db);
  const registered = new Set(known.rows.map((row) => row.source_id));
  const indexed = records.filter((record) => registered.has(record.source));
  const unregistered = records.filter((record) => !registered.has(record.source));
  if (indexed.length === 0) return { indexed, unregistered };
  const runs = new Map<string, FetchRecord>();
  for (const record of indexed) if (!runs.has(record.run)) runs.set(record.run, record);
  const list = [...runs.values()];
  await sql`
    INSERT INTO ingest_run (ingest_run_id, source_id, job, app_version, status, started_at)
    SELECT u.id, u.source_id, u.job, ${APP_VERSION}, 'running', u.started_at
      FROM unnest(${list.map((record) => record.run)}::uuid[], ${list.map((record) => record.source)}::text[],
        ${list.map((record) => (record.writer === "backfill" ? "backfill" : "record"))}::text[],
        ${list.map((record) => record.startedAt)}::timestamptz[])
        AS u(id, source_id, job, started_at)
    ON CONFLICT DO NOTHING`.execute(db);
  await new RecorderIndex(db).insertObjects(indexed);
  return { indexed, unregistered };
}
