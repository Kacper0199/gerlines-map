import type { DB } from "@gerlines/db";
import { localDate } from "@gerlines/schema/service-day";
import { type Kysely, sql } from "kysely";
import type { Clock } from "../clock.ts";
import { errorMessage, type Logger } from "../log.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { writeCheckpoint } from "./checkpoint.ts";
import type { RecordingFollower } from "./follow.ts";
import { type ForeignTimetable, GtfsdeTimetable, recordedStaticFile } from "./foreign-timetable.ts";
import { compareRecords } from "./payload-stream.ts";
import { keptFromDay, type Processor } from "./processor.ts";
import type { Timetable } from "./timetable.ts";
import { loadTimetable, TIMETABLE_SOURCE } from "./timetable-load.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Longest text of a value written to the log, so feed values never flood it. */
export const LOG_TEXT_LIMIT = 300;
/** A timetable version leaves memory once no payload has named it for this long. */
export const VERSION_UNUSED_MS = 30 * HOUR;

/** At most `limit` UTF-16 units of `text`, never ending inside a surrogate pair. */
export const truncated = (text: string, limit = LOG_TEXT_LIMIT): string => {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, end)}…`;
};

export interface LiveOptions {
  readonly db: Kysely<DB>;
  readonly root: string;
  readonly processor: Processor;
  readonly follower: RecordingFollower;
  /** The processing clock: day changes, version checks and the horizon follow it. */
  readonly clock: Clock;
  /** The clock of the memory lines and checkpoints (the processing clock when absent). */
  readonly wallClock?: Clock;
  /** Told the observed instant of each payload before it is handed on. */
  readonly observe?: (epochMs: number) => void;
  readonly logger: Logger;
  readonly index: (
    records: readonly FetchRecord[],
  ) => Promise<{ indexed: FetchRecord[]; unregistered: FetchRecord[] }>;
  readonly checkpointPath: string | null;
  /** The database written to, named in each checkpoint so it is never restored against another. */
  readonly database?: string;
  readonly horizonMs: number;
  readonly pollMs?: number;
  readonly checkpointEveryMs?: number;
  readonly versionCheckEveryMs?: number;
  readonly memoryLogEveryMs?: number;
  /** Wall time a rebuild may take per step before the tail looks for new payloads again. */
  readonly rebuildSliceMs?: number;
}

/** A rebuild works this long per step, so new payloads wait at most about this plus one poll. */
export const REBUILD_SLICE_MS = 5_000;

/**
 * Payloads of sources the recorder has not registered yet: indexed again with every later batch, so
 * they are processed once the source row exists, and forgotten past the horizon.
 */
export class WaitingForSource {
  private waiting: FetchRecord[] = [];

  get size(): number {
    return this.waiting.length;
  }

  /** The batch to index: the waiting payloads and the new ones, in order. */
  withWaiting(records: readonly FetchRecord[]): FetchRecord[] {
    if (this.waiting.length === 0) return [...records];
    return [...this.waiting, ...records].sort(compareRecords);
  }

  /** Keeps the still unregistered payloads observed from `oldest` on; returns those new to the wait. */
  settle(unregistered: readonly FetchRecord[], oldest: number): FetchRecord[] {
    const before = new Set(this.waiting);
    this.waiting = unregistered.filter((record) => Date.parse(record.observedAt) >= oldest);
    return unregistered.filter((record) => !before.has(record));
  }
}

interface Due {
  memory: number;
  version: number;
  checkpoint: number;
  hourly: number;
}

/**
 * The live processor: follows the recordings as the recorder writes them and hands every stored
 * payload to the processor once, oldest first; runs the rebuilds that late payloads ask for; takes
 * new timetable versions as they reach `loaded` and drops unused ones; drops per-day caches when the
 * day changes; writes a checkpoint every few minutes and logs its memory every minute (with the
 * live heap after a full collection when node runs with `--expose-gc`, for measurement runs only).
 */
export class LiveRunner {
  private readonly options: LiveOptions;
  private readonly due: Due;
  private keptFrom: string | null = null;
  private processed = 0;
  private processedTotal = 0;
  private rebuildsBefore = 0;
  private newestObserved = 0;
  private lastPollWall: number | null = null;
  /** Longest wall time between two polls since the last memory line: how long new payloads could wait. */
  private pollGapMaxMs = 0;
  private readonly unregistered = new WaitingForSource();
  /** Data instant the run started at: a version is not dropped as unused before it has had its span. */
  private readonly startedAt: number;

  constructor(options: LiveOptions) {
    this.options = options;
    const now = options.clock.now();
    this.startedAt = now;
    const wallNow = this.wall.now();
    this.due = {
      memory: wallNow,
      version: now,
      checkpoint: wallNow + this.every("checkpoint"),
      hourly: now,
    };
  }

  private get wall(): Clock {
    return this.options.wallClock ?? this.options.clock;
  }

  private every(task: keyof Due): number {
    const options = this.options;
    if (task === "memory") return options.memoryLogEveryMs ?? MINUTE;
    if (task === "version") return options.versionCheckEveryMs ?? 5 * MINUTE;
    if (task === "checkpoint") return options.checkpointEveryMs ?? 10 * MINUTE;
    return HOUR;
  }

  /** Payloads handed on in this run. */
  get total(): number {
    return this.processedTotal;
  }

  /** One round: new payloads in order, then the rebuilds they asked for, then due upkeep. */
  async step(signal?: AbortSignal): Promise<number> {
    const polledAt = this.wall.now();
    if (this.lastPollWall !== null) {
      this.pollGapMaxMs = Math.max(this.pollGapMaxMs, polledAt - this.lastPollWall);
    }
    this.lastPollWall = polledAt;
    const records = await this.options.follower.poll();
    const skipped = this.options.follower.takeSkippedLines();
    if (skipped > 0) {
      this.options.logger.log("warn", "sidecar lines skipped as too long or unreadable", {
        lines: skipped,
      });
    }
    return this.processWaiting(records, signal);
  }

  /** Hands on payloads already found (the first poll, made before a checkpoint is restored). */
  async processWaiting(records: readonly FetchRecord[], signal?: AbortSignal): Promise<number> {
    const { follower, processor, index, logger, clock, horizonMs } = this.options;
    const { indexed, unregistered } = await index(this.unregistered.withWaiting(records));
    const fresh = this.unregistered.settle(unregistered, clock.now() - horizonMs);
    if (fresh.length > 0) {
      logger.log("warn", "payloads of sources the recorder has not registered wait for it", {
        sources: [...new Set(fresh.map((record) => truncated(record.source, 60)))].slice(0, 20),
        payloads: fresh.length,
        waiting: this.unregistered.size,
      });
    }
    let handed = 0;
    for (const record of indexed) {
      if (signal?.aborted) break;
      handed += 1;
      const observedAt = Date.parse(record.observedAt);
      this.options.observe?.(observedAt);
      let payload: Buffer | undefined;
      try {
        payload = await follower.decode(record);
      } catch (error) {
        logger.log("warn", "payload not readable", {
          source: record.source,
          key: record.object?.key,
          error: truncated(errorMessage(error)),
        });
        await processor.unreadable(record, error);
      }
      if (payload !== undefined) await processor.processBatch([{ record, payload }]);
      this.processed += 1;
      this.processedTotal += 1;
      this.newestObserved = Math.max(this.newestObserved, observedAt);
      await this.upkeep();
    }
    await processor.flush({ budgetMs: this.options.rebuildSliceMs ?? REBUILD_SLICE_MS });
    this.logRebuilds();
    await this.upkeep();
    return handed;
  }

  private logRebuilds(): void {
    for (const report of this.options.processor.takeRebuildReports()) {
      if (report.counts) {
        this.options.logger.log("info", "realtime rebuild swapped in", { ...report });
      } else {
        this.options.logger.log("warn", "realtime rebuild lost its staged rows; it starts again", {
          ...report,
        });
      }
    }
  }

  /** Steps until `signal` aborts, then a last flush and checkpoint. */
  async run(signal: AbortSignal): Promise<void> {
    const { clock, processor, logger } = this.options;
    logger.log("info", "live processing started", { versions: processor.matcher.versions() });
    while (!signal.aborted) {
      try {
        await this.step(signal);
      } catch (error) {
        logger.log("error", "live step failed", { error: truncated(errorMessage(error)) });
        throw error;
      }
      if (!processor.rebuilding()) await clock.sleep(this.options.pollMs ?? 5_000, signal);
    }
    await processor.flush({ budgetMs: 0 });
    await this.checkpoint();
    this.logMemory();
    logger.log("info", "live processing stopped", { payloads: this.processedTotal });
  }

  private async upkeep(): Promise<void> {
    const now = this.options.clock.now();
    const wallNow = this.wall.now();
    if (wallNow >= this.due.memory) {
      this.due.memory = wallNow + this.every("memory");
      this.logMemory();
    }
    if (now >= this.due.version) {
      this.due.version = now + this.every("version");
      await this.takeNewVersions();
    }
    if (now >= this.due.hourly) {
      this.due.hourly = now + this.every("hourly");
      await this.hourly(now);
    }
    if (wallNow >= this.due.checkpoint) {
      this.due.checkpoint = wallNow + this.every("checkpoint");
      await this.checkpoint();
    }
  }

  logMemory(): void {
    const { processor, follower, logger, clock } = this.options;
    const memory = process.memoryUsage();
    const mb = (bytes: number) => Math.round(bytes / 1_048_576);
    const collect = (globalThis as { gc?: () => void }).gc;
    collect?.();
    const live = collect ? { heapLiveMb: mb(process.memoryUsage().heapUsed) } : {};
    let rebuilds = 0;
    for (const coverage of processor.coverage.values()) rebuilds += coverage.rebuilds;
    logger.log("info", "memory", {
      heapUsedMb: mb(memory.heapUsed),
      heapTotalMb: mb(memory.heapTotal),
      rssMb: mb(memory.rss),
      externalMb: mb(memory.external),
      arrayBuffersMb: mb(memory.arrayBuffers),
      payloads: this.processed,
      payloadsTotal: this.processedTotal,
      rebuilds: rebuilds - this.rebuildsBefore,
      dataTime: new Date(clock.now()).toISOString(),
      lagS:
        this.newestObserved === 0
          ? null
          : Math.round((this.wall.now() - this.newestObserved) / 1000),
      pollGapMaxS: Math.round(this.pollGapMaxMs / 100) / 10,
      rebuild: processor.rebuildProgress(),
      followedFiles: follower.trackedFiles(),
      followedRecords: follower.knownRecords(),
      decodedMb: mb(follower.decodedBytes()),
      ...live,
      ...processor.stats(),
    });
    this.processed = 0;
    this.pollGapMaxMs = 0;
    this.rebuildsBefore = rebuilds;
  }

  /** Loads DELFI versions that reached `loaded` since the start and are newer than the newest held. */
  async takeNewVersions(): Promise<void> {
    const { db, processor, logger, clock } = this.options;
    const matcher = processor.matcher;
    const held = matcher.timetables.map((table) => table.feedVersionId);
    const newest = matcher.timetable.data.publishedOn ?? "";
    const today = localDate(clock.now());
    const rows = await sql<{ id: number }>`
      SELECT feed_version_id AS id FROM feed_version
       WHERE source_id = ${TIMETABLE_SOURCE} AND status = 'loaded'
         AND published_on::text > ${newest} AND published_on <= ${today}::date
         AND NOT (feed_version_id = ANY(${held}::integer[]))
       ORDER BY published_on, feed_version_id`.execute(db);
    for (const row of rows.rows) {
      const started = this.wall.now();
      const table: Timetable = await loadTimetable(db, row.id);
      processor.timetableLoaded(table);
      logger.log("info", "timetable version loaded", {
        feedVersionId: row.id,
        feedVersion: table.data.feedVersion,
        publishedOn: table.data.publishedOn ?? null,
        seconds: Math.round((this.wall.now() - started) / 1000),
        versions: matcher.versions(),
      });
    }
  }

  private async hourly(now: number): Promise<void> {
    const { processor, follower, logger, horizonMs } = this.options;
    const day = keptFromDay(now);
    if (day !== this.keptFrom) {
      this.keptFrom = day;
      processor.dropBefore(day, now);
      logger.log("info", "per-day state before this day dropped", { day, ...processor.stats() });
    }
    follower.forget(now - horizonMs);
    this.dropUnusedVersion(now);
    await this.reloadForeign(now);
    await this.logDatabaseSize();
  }

  private dropUnusedVersion(now: number): void {
    const { processor, logger } = this.options;
    const tables = processor.matcher.timetables;
    if (tables.length < 2) return;
    const oldest = tables[0] as Timetable;
    const named = Math.max(
      processor.versionLastNamed.get(oldest.data.feedVersion ?? "") ?? 0,
      this.startedAt,
    );
    if (now - named < VERSION_UNUSED_MS) return;
    processor.matcher.removeTimetable(oldest.feedVersionId);
    logger.log("info", "timetable version dropped from memory", {
      feedVersionId: oldest.feedVersionId,
      lastNamed: new Date(named).toISOString(),
      versions: processor.matcher.versions(),
    });
  }

  /**
   * Takes newer recorded gtfs.de statics once the recorder has stored them, and the first ones when
   * the run started before any was recorded.
   */
  async reloadForeign(now: number): Promise<void> {
    const { processor, follower, root, logger } = this.options;
    if (!follower.sources.includes("gtfsde-rt")) return;
    const files = (
      await Promise.all(
        ["gtfsde-static-rv", "gtfsde-static-fv"].map((source) =>
          recordedStaticFile(root, source, now),
        ),
      )
    ).filter((file): file is string => file !== undefined);
    const current = processor.matcher.foreign.get("gtfsde-rt");
    const loaded = current instanceof GtfsdeTimetable ? current.files : [];
    if (files.length === 0 || files.join("\n") === loaded.join("\n")) return;
    const foreign = new Map<string, ForeignTimetable>([
      ["gtfsde-rt", await GtfsdeTimetable.load(files, processor.matcher.timetable)],
    ]);
    processor.matcher.replaceForeign(foreign);
    logger.log("info", current ? "gtfs.de statics reloaded" : "gtfs.de statics loaded", {
      files: files.length,
    });
  }

  private async logDatabaseSize(): Promise<void> {
    const row = await sql<{ bytes: string }>`
      SELECT pg_database_size(current_database())::text AS bytes`.execute(this.options.db);
    this.options.logger.log("info", "database size", {
      bytes: Number(row.rows[0]?.bytes ?? 0),
    });
  }

  /**
   * Writes a checkpoint; a running rebuild goes into it as pending work and starts again after a
   * restore. Held fallback payloads are not in it and not remembered by a restore, so the follower,
   * which reads again from the oldest processed payload within the horizon, delivers them again.
   */
  async checkpoint(): Promise<void> {
    const { checkpointPath, processor, logger } = this.options;
    if (!checkpointPath) return;
    await processor.flush({ budgetMs: 0 });
    const clock = this.wall;
    const started = clock.now();
    try {
      await writeCheckpoint(checkpointPath, processor.checkpointLines(this.options.database));
      logger.log("info", "checkpoint written", {
        ms: clock.now() - started,
        rebuildPending: processor.rebuilding(),
      });
    } catch (error) {
      logger.log("warn", "checkpoint not written", { error: truncated(errorMessage(error)) });
    }
  }
}
