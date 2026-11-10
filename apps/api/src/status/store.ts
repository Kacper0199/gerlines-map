import type { DB } from "@gerlines/db";
import { type Kysely, sql } from "kysely";
import type { LiveFreshness, RecordedSource } from "./build.ts";

/** The recorder's rows for the named sources and every source under one of the prefixes. */
export interface RecorderStore {
  recorded(sources: readonly string[], prefixes: readonly string[]): Promise<RecordedSource[]>;
}

/** The live engine's freshness in the live store. */
export interface LiveFreshnessReader {
  freshness(): Promise<LiveFreshness>;
}

/** The recorder's job name in `ingest_run` (services/ingest/src/recorder/recorder.ts). */
export const RECORD_JOB = "record";

interface Row {
  readonly source_id: string;
  readonly recorded_at: Date | string | null;
  readonly recording: boolean;
}

function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
}

function ms(value: Date | string | null): number | null {
  if (value === null) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/**
 * Reads `source`, `raw_object` and `ingest_run`, which only the recorder writes: the newest stored
 * payload per source by the `(source_id, observed_at)` index and whether its record run is running.
 */
export class DatabaseRecorderStore implements RecorderStore {
  private readonly db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.db = db;
  }

  async recorded(sources: readonly string[], prefixes: readonly string[]) {
    const result = await sql<Row>`
      SELECT s.source_id,
             (SELECT max(o.observed_at) FROM raw_object o WHERE o.source_id = s.source_id) AS recorded_at,
             EXISTS (SELECT 1 FROM ingest_run r
                      WHERE r.source_id = s.source_id AND r.job = ${RECORD_JOB}
                        AND r.status = 'running') AS recording
        FROM source s
       WHERE s.source_id = ANY(${[...sources]}::text[])
          OR s.source_id LIKE ANY(${prefixes.map(likePrefix)}::text[])`.execute(this.db);
    return result.rows.map((row) => ({
      source: row.source_id,
      recordedAt: ms(row.recorded_at),
      recording: row.recording,
    }));
  }
}
