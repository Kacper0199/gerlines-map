import type { DB } from "@gerlines/db";
import type { Kysely } from "kysely";
import type { Gap } from "./gaps.ts";
import type { SourceDefinition } from "./sources.ts";
import { STORAGE_FORMAT_VERSION } from "./storage/frame.ts";
import type { FetchRecord } from "./storage/sidecar.ts";

export interface RunRow {
  readonly id: string;
  readonly source: string;
  readonly job: string;
  readonly appVersion: string;
  readonly startedAt: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly finishedAt: string | null;
  readonly error: string | null;
}

const BATCH = 500;

/** The index writes the recorder and the reindex make; every write is idempotent. */
export interface IndexWriter {
  upsertSources(sources: readonly SourceDefinition[]): Promise<void>;
  failStaleRuns(source: string, job: string, exceptRun: string, at: Date): Promise<number>;
  upsertRun(run: RunRow): Promise<void>;
  insertObjects(records: readonly FetchRecord[]): Promise<number>;
  upsertGap(source: string, gap: Gap): Promise<void>;
  replaceGaps(source: string, gaps: readonly Gap[], since?: Date): Promise<void>;
}

/** Writes the database index of the recording files; every write is idempotent. */
export class RecorderIndex implements IndexWriter {
  readonly db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.db = db;
  }

  async upsertSources(sources: readonly SourceDefinition[]): Promise<void> {
    for (const source of sources) {
      const row = {
        source_id: source.id,
        name: source.metadata.name,
        homepage_url: source.metadata.homepageUrl,
        licence: source.metadata.licence,
        licence_url: source.metadata.licenceUrl,
        attribution: source.metadata.attribution,
      };
      await this.db
        .insertInto("source")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("source_id").doUpdateSet({
            name: row.name,
            homepage_url: row.homepage_url,
            licence: row.licence,
            licence_url: row.licence_url,
            attribution: row.attribution,
          }),
        )
        .execute();
    }
  }

  /** Closes runs of this job left `running` by a process that ended without shutting down. */
  async failStaleRuns(source: string, job: string, exceptRun: string, at: Date): Promise<number> {
    const result = await this.db
      .updateTable("ingest_run")
      .set({
        status: "failed",
        finished_at: at,
        error_message: "process ended without a clean shutdown",
      })
      .where("source_id", "=", source)
      .where("job", "=", job)
      .where("status", "=", "running")
      .where("ingest_run_id", "!=", exceptRun)
      .where("started_at", "<=", at)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async upsertRun(run: RunRow): Promise<void> {
    await this.db
      .insertInto("ingest_run")
      .values({
        ingest_run_id: run.id,
        source_id: run.source,
        job: run.job,
        app_version: run.appVersion,
        status: run.status,
        started_at: new Date(run.startedAt),
        finished_at: run.finishedAt ? new Date(run.finishedAt) : null,
        error_message: run.error,
      })
      .onConflict((conflict) =>
        conflict.column("ingest_run_id").doUpdateSet({
          app_version: run.appVersion,
          status: run.status,
          finished_at: run.finishedAt ? new Date(run.finishedAt) : null,
          error_message: run.error,
        }),
      )
      .execute();
  }

  async insertObjects(records: readonly FetchRecord[]): Promise<number> {
    const stored = records.filter(
      (record) => record.object && record.sha256 && record.bytes !== undefined,
    );
    let inserted = 0;
    for (let start = 0; start < stored.length; start += BATCH) {
      inserted += await this.insertBatch(stored.slice(start, start + BATCH));
    }
    return inserted;
  }

  async upsertGap(source: string, gap: Gap): Promise<void> {
    await this.db
      .insertInto("recording_gap")
      .values({ source_id: source, gap_start: new Date(gap.start), gap_end: new Date(gap.end) })
      .onConflict((conflict) =>
        conflict.columns(["source_id", "gap_start"]).doUpdateSet({ gap_end: new Date(gap.end) }),
      )
      .execute();
  }

  /**
   * Replaces the gaps of a source that reach into the window from `since` on (all of them without
   * `since`); gaps that ended before the window stay, since `gaps` was computed for the window only.
   */
  async replaceGaps(source: string, gaps: readonly Gap[], since?: Date): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      let removal = trx.deleteFrom("recording_gap").where("source_id", "=", source);
      if (since) removal = removal.where("gap_end", ">", since);
      await removal.execute();
      if (gaps.length > 0) {
        await trx
          .insertInto("recording_gap")
          .values(
            gaps.map((gap) => ({
              source_id: source,
              gap_start: new Date(gap.start),
              gap_end: new Date(gap.end),
            })),
          )
          .onConflict((conflict) =>
            conflict
              .columns(["source_id", "gap_start"])
              .doUpdateSet((eb) => ({ gap_end: eb.ref("excluded.gap_end") })),
          )
          .execute();
      }
    });
  }

  private async insertBatch(records: readonly FetchRecord[]): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const rows = records.map((record) => ({
        raw_object_id: record.object?.id ?? "",
        source_id: record.source,
        ingest_run_id: record.run,
        object_key: record.object?.key ?? "",
        sha256: record.sha256 ?? "",
        bytes: record.bytes ?? 0,
        content_type: record.object?.contentType ?? "application/octet-stream",
        content_encoding: record.object?.encoding ?? null,
        fetched_at: new Date(record.startedAt),
        observed_at: new Date(record.observedAt),
        http_status: record.status,
        request_url: record.url,
      }));
      const inserted = await trx
        .insertInto("raw_object")
        .values(rows)
        .onConflict((conflict) =>
          conflict
            .column("object_key")
            .doUpdateSet((eb) => ({ observed_at: eb.ref("excluded.observed_at") }))
            .where((eb) =>
              eb("raw_object.observed_at", "is distinct from", eb.ref("excluded.observed_at")),
            ),
        )
        .returning("raw_object_id")
        .execute();
      const segments = records.flatMap((record) => {
        const object = record.object;
        if (
          !object ||
          object.seq === undefined ||
          object.offset === undefined ||
          object.length === undefined
        ) {
          return [];
        }
        return [
          {
            raw_object_id: object.id,
            segment_key: object.file,
            seq: object.seq,
            base_seq: object.base ?? null,
            frame_offset: object.offset,
            frame_bytes: object.length,
            format_version: record.v ?? STORAGE_FORMAT_VERSION,
          },
        ];
      });
      if (segments.length > 0) {
        await trx
          .insertInto("raw_object_segment")
          .values(segments)
          .onConflict((conflict) => conflict.column("raw_object_id").doNothing())
          .execute();
      }
      return inserted.length;
    });
  }
}
