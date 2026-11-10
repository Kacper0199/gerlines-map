import type { Gap } from "../gaps.ts";
import type { IndexWriter, RunRow } from "../index-db.ts";
import type { SourceDefinition } from "../sources.ts";
import type { FetchRecord } from "../storage/sidecar.ts";

/**
 * An index in memory with the foreign keys of the real one (run to source, object to run). It refuses
 * every write while `down` holds and the first `failFirst` writes, the way Postgres does before it
 * accepts connections. `refusedSources` are refused for good (a broken row), `gate` holds every run write
 * until it resolves, and `onWrite` sees each write as it starts.
 */
export class FakeIndex implements IndexWriter {
  down = false;
  failFirst: number;
  readonly calls: string[] = [];
  readonly sources = new Set<string>();
  readonly runs = new Map<string, RunRow>();
  readonly objects = new Map<string, FetchRecord>();
  readonly gaps: Gap[] = [];
  readonly refusedSources = new Set<string>();
  gate: Promise<void> | null = null;
  onWrite: ((what: string) => void) | null = null;
  runWritesInFlight = 0;
  maxRunWritesInFlight = 0;

  constructor(options: { readonly down?: boolean; readonly failFirst?: number } = {}) {
    this.down = options.down ?? false;
    this.failFirst = options.failFirst ?? 0;
  }

  private connect(what: string): void {
    this.calls.push(what);
    this.onWrite?.(what);
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    if (this.failFirst > 0) {
      this.failFirst -= 1;
      throw new Error("the database system is starting up");
    }
  }

  async upsertSources(sources: readonly SourceDefinition[]): Promise<void> {
    this.connect("sources");
    if (sources.some((source) => this.refusedSources.has(source.id))) {
      throw new Error(
        'new row for relation "source" violates check constraint "source_licence_check"',
      );
    }
    for (const source of sources) this.sources.add(source.id);
  }

  async failStaleRuns(source: string, job: string, exceptRun: string, at: Date): Promise<number> {
    this.connect("stale runs");
    let closed = 0;
    for (const run of this.runs.values()) {
      if (run.source !== source || run.job !== job || run.id === exceptRun) continue;
      if (run.status !== "running" || Date.parse(run.startedAt) > at.getTime()) continue;
      this.runs.set(run.id, { ...run, status: "failed", finishedAt: at.toISOString() });
      closed += 1;
    }
    return closed;
  }

  async upsertRun(run: RunRow): Promise<void> {
    this.connect("run");
    this.runWritesInFlight += 1;
    this.maxRunWritesInFlight = Math.max(this.maxRunWritesInFlight, this.runWritesInFlight);
    try {
      await this.gate;
    } finally {
      this.runWritesInFlight -= 1;
    }
    if (!this.sources.has(run.source)) {
      throw new Error(
        'insert on table "ingest_run" violates foreign key constraint "ingest_run_source_fkey"',
      );
    }
    this.runs.set(run.id, run);
  }

  async insertObjects(records: readonly FetchRecord[]): Promise<number> {
    this.connect("objects");
    const stored = records.filter((record) => record.object);
    if (stored.some((record) => !this.runs.has(record.run))) {
      throw new Error(
        'insert on table "raw_object" violates foreign key constraint "raw_object_run_fkey"',
      );
    }
    let inserted = 0;
    for (const record of stored) {
      const id = record.object?.id ?? "";
      if (!this.objects.has(id)) inserted += 1;
      this.objects.set(id, record);
    }
    return inserted;
  }

  async upsertGap(_source: string, gap: Gap): Promise<void> {
    this.connect("gap");
    this.gaps.push(gap);
  }

  async replaceGaps(_source: string, gaps: readonly Gap[]): Promise<void> {
    this.connect("gaps");
    this.gaps.splice(0, this.gaps.length, ...gaps);
  }
}
