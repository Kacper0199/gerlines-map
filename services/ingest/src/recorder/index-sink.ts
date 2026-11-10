import type { Gap } from "../gaps.ts";
import type { IndexWriter, RunRow } from "../index-db.ts";
import { errorMessage, type Logger } from "../log.ts";
import type { SourceDefinition } from "../sources.ts";
import type { FetchRecord } from "../storage/sidecar.ts";

interface StaleRuns {
  readonly source: string;
  readonly job: string;
  readonly exceptRun: string;
  readonly at: Date;
}

export type ReconcileOutcome = "clean" | "failed" | "aborted";

/** What a reconcile started from: whether the index was dirty, and the rows then waiting to be written. */
export class ReconcileTicket {
  readonly wasDirty: boolean;
  readonly sources: ReadonlyMap<string, SourceDefinition>;
  readonly stale: ReadonlyMap<string, StaleRuns>;
  readonly runs: ReadonlyMap<string, RunRow>;

  constructor(sink: {
    dirty: boolean;
    sources: ReadonlyMap<string, SourceDefinition>;
    stale: ReadonlyMap<string, StaleRuns>;
    runs: ReadonlyMap<string, RunRow>;
  }) {
    this.wasDirty = sink.dirty;
    this.sources = new Map(sink.sources);
    this.stale = new Map(sink.stale);
    this.runs = new Map(sink.runs);
  }
}

function dropUnchanged<T>(pending: Map<string, T>, before: ReadonlyMap<string, T>): void {
  for (const [key, row] of before) {
    if (pending.get(key) === row) pending.delete(key);
  }
}

const staleKey = (source: string, job: string) => `${source}\u0000${job}`;

/**
 * The recorder's view of the database: the files are the truth, so a failed index write is logged,
 * marks the index dirty for the next reconcile, and never stops recording. Source, stale run and run
 * rows the database refused are kept and written again before the next write that depends on them
 * (the run of the objects written, the source of a gap), one write per row at a time, so objects and
 * gaps land once the database accepts connections and a row refused for good blocks only its own source.
 */
export class IndexSink {
  readonly index: IndexWriter | null;
  private readonly logger: Logger;
  private readonly pendingSources = new Map<string, SourceDefinition>();
  private readonly pendingStale = new Map<string, StaleRuns>();
  private readonly pendingRuns = new Map<string, RunRow>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private failing = false;
  private recovered = false;
  private isDirty = false;

  constructor(index: IndexWriter | null, logger: Logger) {
    this.index = index;
    this.logger = logger;
  }

  /** A write failed since the last reconcile that left the index clean. */
  get dirty(): boolean {
    return this.isDirty;
  }

  /** Whether a write succeeded after writes had failed, once per recovery. */
  takeRecovered(): boolean {
    const recovered = this.recovered;
    this.recovered = false;
    return recovered;
  }

  beginReconcile(): ReconcileTicket {
    const ticket = new ReconcileTicket({
      dirty: this.isDirty,
      sources: this.pendingSources,
      stale: this.pendingStale,
      runs: this.pendingRuns,
    });
    this.isDirty = false;
    return ticket;
  }

  /**
   * Ends a reconcile; resolves whether the index is clean. A clean reconcile wrote every row that was
   * pending when it began (the reindex reads them from the files), so those rows are dropped unless a
   * newer row replaced them meanwhile; a write that failed during it keeps the index dirty.
   */
  endReconcile(ticket: ReconcileTicket, outcome: ReconcileOutcome): boolean {
    if (outcome === "failed") this.isDirty = true;
    if (outcome === "aborted") this.isDirty ||= ticket.wasDirty;
    if (outcome === "clean") {
      dropUnchanged(this.pendingSources, ticket.sources);
      dropUnchanged(this.pendingStale, ticket.stale);
      dropUnchanged(this.pendingRuns, ticket.runs);
    }
    return !this.isDirty;
  }

  private async settle<T>(
    key: string,
    pending: Map<string, T>,
    id: string,
    write: (row: T) => Promise<unknown>,
  ): Promise<void> {
    for (;;) {
      const running = this.inFlight.get(key);
      if (running) {
        await running;
        continue;
      }
      const row = pending.get(id);
      if (row === undefined) return;
      const attempt = write(row).then(() => {
        if (pending.get(id) === row) pending.delete(id);
      });
      this.inFlight.set(key, attempt);
      try {
        await attempt;
      } finally {
        if (this.inFlight.get(key) === attempt) this.inFlight.delete(key);
      }
    }
  }

  private async writeDependencies(
    index: IndexWriter,
    sourceIds: Iterable<string>,
    runIds: Iterable<string>,
  ): Promise<void> {
    const runs = [...runIds];
    const sources = new Set(sourceIds);
    for (const id of runs) {
      const run = this.pendingRuns.get(id);
      if (run) sources.add(run.source);
    }
    let failure: unknown = null;
    for (const id of sources) {
      await this.settle(`source:${id}`, this.pendingSources, id, (source) =>
        index.upsertSources([source]),
      ).catch((error: unknown) => {
        failure ??= error;
      });
    }
    if (failure) throw failure;
    for (const [key, stale] of [...this.pendingStale]) {
      if (!sources.has(stale.source)) continue;
      await this.settle(`stale:${key}`, this.pendingStale, key, (row) =>
        index.failStaleRuns(row.source, row.job, row.exceptRun, row.at),
      );
    }
    for (const id of runs) {
      await this.settle(`run:${id}`, this.pendingRuns, id, (run) => index.upsertRun(run));
    }
  }

  private async guard(
    what: string,
    dependsOn: { readonly sources?: Iterable<string>; readonly runs?: Iterable<string> },
    write?: (index: IndexWriter) => Promise<unknown>,
  ): Promise<void> {
    if (!this.index) return;
    try {
      await this.writeDependencies(this.index, dependsOn.sources ?? [], dependsOn.runs ?? []);
      await write?.(this.index);
      if (this.failing) {
        this.failing = false;
        this.recovered = true;
      }
    } catch (error) {
      this.isDirty = true;
      this.failing = true;
      this.logger.log("warn", "database index write failed, will reconcile from files", {
        what,
        error: errorMessage(error),
      });
    }
  }

  sources(sources: readonly SourceDefinition[]): Promise<void> {
    if (!this.index) return Promise.resolve();
    for (const source of sources) this.pendingSources.set(source.id, source);
    return this.guard("sources", { sources: sources.map((source) => source.id) });
  }

  run(run: RunRow): Promise<void> {
    if (!this.index) return Promise.resolve();
    this.pendingRuns.set(run.id, run);
    return this.guard("run", { runs: [run.id] });
  }

  failStaleRuns(source: string, job: string, exceptRun: string, at: Date): Promise<void> {
    if (!this.index) return Promise.resolve();
    this.pendingStale.set(staleKey(source, job), { source, job, exceptRun, at });
    return this.guard("stale runs", { sources: [source] });
  }

  objects(records: readonly FetchRecord[]): Promise<void> {
    return this.guard(
      "objects",
      {
        sources: records.map((record) => record.source),
        runs: records.filter((record) => record.object).map((record) => record.run),
      },
      (index) => index.insertObjects(records),
    );
  }

  gap(source: string, gap: Gap): Promise<void> {
    return this.guard("gap", { sources: [source] }, (index) => index.upsertGap(source, gap));
  }

  replaceGaps(source: string, gaps: readonly Gap[], since?: Date): Promise<void> {
    return this.guard("gaps", { sources: [source] }, (index) =>
      index.replaceGaps(source, gaps, since),
    );
  }
}
