import { APP_VERSION } from "./env.ts";
import { findGaps } from "./gaps.ts";
import type { IndexWriter, RunRow } from "./index-db.ts";
import type { SourceDefinition } from "./sources.ts";
import { listSidecars, readFetchRecords } from "./storage/reader.ts";
import { RunLog } from "./storage/runs.ts";
import { type FetchRecord, isSuccess } from "./storage/sidecar.ts";

export interface ReindexSourceReport {
  readonly source: string;
  readonly runs: number;
  readonly records: number;
  readonly objects: number;
  readonly inserted: number;
  readonly gaps: number;
}

export interface ReindexOptions {
  readonly sinceDate?: string;
  /** Stops between sources once it aborts; the sources not reached are left as they were. */
  readonly signal?: AbortSignal;
}

function runsReferencedButUnlogged(
  records: readonly FetchRecord[],
  runs: readonly RunRow[],
): RunRow[] {
  const known = new Set(runs.map((run) => run.id));
  const missing = new Map<string, RunRow>();
  for (const record of records) {
    if (known.has(record.run) || missing.has(record.run)) continue;
    missing.set(record.run, {
      id: record.run,
      source: record.source,
      job:
        record.writer === "live"
          ? "record"
          : record.writer === "archive"
            ? "archive-backfill"
            : "backfill",
      appVersion: APP_VERSION,
      startedAt: record.startedAt,
      status: "failed",
      finishedAt: record.startedAt,
      error: "run start missing from runs.jsonl",
    });
  }
  return [...missing.values()];
}

/**
 * Rebuilds the database index of one source from its files: source row, runs, raw objects with their
 * segment positions, and gaps. Safe to repeat; a full run (no `sinceDate`) replaces the gap rows.
 */
export async function reindexSource(
  root: string,
  index: IndexWriter,
  source: SourceDefinition,
  options: ReindexOptions = {},
): Promise<ReindexSourceReport> {
  const runs = await new RunLog(root).read(source.id);
  const records = await readFetchRecords(
    root,
    await listSidecars(root, source.id, options.sinceDate),
  );
  if (runs.length === 0 && records.length === 0) {
    return { source: source.id, runs: 0, records: 0, objects: 0, inserted: 0, gaps: 0 };
  }
  await index.upsertSources([source]);
  const allRuns = [...runs, ...runsReferencedButUnlogged(records, runs)];
  for (const run of allRuns) {
    await index.upsertRun(run);
  }
  const inserted = await index.insertObjects(records);
  const gaps = findGaps(
    records.filter(isSuccess).map((record) => Date.parse(record.observedAt)),
    source.periodMs,
  );
  if (options.sinceDate === undefined) {
    await index.replaceGaps(source.id, gaps);
  } else {
    for (const gap of gaps) await index.upsertGap(source.id, gap);
  }
  return {
    source: source.id,
    runs: allRuns.length,
    records: records.length,
    objects: records.filter((record) => record.object).length,
    inserted,
    gaps: gaps.length,
  };
}

export async function reindexAll(
  root: string,
  index: IndexWriter,
  sources: readonly SourceDefinition[],
  options: ReindexOptions = {},
): Promise<ReindexSourceReport[]> {
  const reports: ReindexSourceReport[] = [];
  for (const source of sources) {
    if (options.signal?.aborted) break;
    reports.push(await reindexSource(root, index, source, options));
  }
  return reports;
}
