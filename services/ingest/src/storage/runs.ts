import type { RunRow } from "../index-db.ts";
import { appendJsonLine, readJsonLinesFile, resolveInside } from "./files.ts";
import { STORAGE_FORMAT_VERSION } from "./frame.ts";
import { runsPath } from "./paths.ts";
import type { RunEndRecord, RunRecord, RunStartRecord } from "./sidecar.ts";

const CRASH_MESSAGE = "process ended without a clean shutdown";

export class RunLog {
  readonly root: string;
  private readonly repaired = new Set<string>();

  constructor(root: string) {
    this.root = root;
  }

  async read(source: string): Promise<RunRow[]> {
    const records = await readJsonLinesFile<RunRecord>(resolveInside(this.root, runsPath(source)));
    return foldRuns(records);
  }

  async start(record: Omit<RunStartRecord, "v" | "type">): Promise<void> {
    await this.append(record.source, { v: STORAGE_FORMAT_VERSION, type: "run-start", ...record });
  }

  async end(record: Omit<RunEndRecord, "v" | "type">): Promise<void> {
    await this.append(record.source, { v: STORAGE_FORMAT_VERSION, type: "run-end", ...record });
  }

  /** Marks runs of a job that never wrote an end line as failed; returns their ids. */
  async closeUnfinished(source: string, job: string, at: string): Promise<string[]> {
    const open = (await this.read(source)).filter(
      (run) => run.job === job && run.status === "running",
    );
    for (const run of open) {
      await this.end({ run: run.id, source, status: "failed", at, error: CRASH_MESSAGE });
    }
    return open.map((run) => run.id);
  }

  private async append(source: string, record: RunRecord): Promise<void> {
    await appendJsonLine(resolveInside(this.root, runsPath(source)), record, this.repaired);
  }
}

export function foldRuns(records: readonly RunRecord[]): RunRow[] {
  const runs = new Map<string, RunRow>();
  for (const record of records) {
    if (record.type === "run-start") {
      runs.set(record.run, {
        id: record.run,
        source: record.source,
        job: record.job,
        appVersion: record.appVersion,
        startedAt: record.at,
        status: "running",
        finishedAt: null,
        error: null,
      });
      continue;
    }
    const run = runs.get(record.run);
    if (run) {
      const finishedAt =
        Date.parse(record.at) < Date.parse(run.startedAt) ? run.startedAt : record.at;
      runs.set(record.run, {
        ...run,
        status: record.status,
        finishedAt,
        error: record.error ?? null,
      });
    }
  }
  return [...runs.values()];
}
