import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { createDatabase, type DB, redactDatabaseUrl, resolveDatabaseUrl } from "@gerlines/db";
import { type Kysely, sql } from "kysely";
import { systemClock } from "../clock.ts";
import { errorMessage, jsonLogger, type Logger } from "../log.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { instantArg, irisMatchArgs, numberArg, sourcesArg } from "./args.ts";
import {
  fingerprints,
  type InvariantResult,
  invariants,
  quality,
  sizes,
  type TableFingerprint,
  type TableSize,
} from "./check.ts";
import { readCheckpoint } from "./checkpoint.ts";
import { DataClock } from "./data-clock.ts";
import { assertThrowawayDatabase, databaseNameOf } from "./database-guard.ts";
import { registerFoldSources } from "./fold-sources.ts";
import { RecordingFollower } from "./follow.ts";
import { type ForeignTimetable, GtfsdeTimetable, recordedStaticFile } from "./foreign-timetable.ts";
import { LiveRunner, truncated } from "./live.ts";
import { MAX_TIMETABLES, Matcher } from "./matcher.ts";
import { payloadsInOrder, recordsInWindow } from "./payload-stream.ts";
import { Processor, type ProcessorSnapshot } from "./processor.ts";
import { ensureIndexed } from "./raw-index.ts";
import { replay, seededRandom, shuffledPlan, VirtualClock } from "./replay.ts";
import { coverageReport, timetableCoverage } from "./report.ts";
import { probeWritable, waitForSchema } from "./startup.ts";
import type { Timetable } from "./timetable.ts";
import { loadTimetables, TIMETABLE_SOURCE } from "./timetable-load.ts";

const USAGE = `gerlines realtime processing

Usage: node src/realtime/cli.ts <command> [options]

  live [--sources a,b] [--since ISO] [--horizon-hours 48] [--checkpoint ABSOLUTE_FILE]
       [--poll-seconds 5] [--duration-minutes N] [--allow-shared]
      follow the recordings as the recorder writes them and process every stored payload once
      into DATABASE_URL; late payloads fold the service days they touch again; new timetable
      versions are taken when they reach loaded; a checkpoint (when named) lets a restart go on
      where it stopped; JSON log lines on stdout, a memory line every minute

  replay --from ISO --to ISO [--sources a,b] [--speed N] [--shuffle-seed N] [--rounds 3]
         [--duplicates 0.1] [--split-at ISO] [--feed-version-ids 1,2]
         [--report FILE] [--allow-shared]
      stream recorded payloads through adapters, matcher and writers into DATABASE_URL,
      with a virtual clock at N times real time (0: no waiting); a database that already holds
      processed payloads is resumed (its payloads are folded again first); the newest two DELFI
      versions published by --to are loaded unless --feed-version-ids names them; --split-at
      also reports coverage before and after an instant
  check [--json] [--allow-shared]
      invariants, data quality counts, table fingerprints and sizes of the realtime tables
  reset --yes [--allow-shared]
      empty the realtime tables of DATABASE_URL (a throwaway database) before a fresh replay
  iris-match --dir ABSOLUTE_DIR --feed-version-ids N[,M] [--allow-shared]
      match the IRIS trips of a db-apis probe or iris-run folder against the named DELFI versions
      of DATABASE_URL, in read-only transactions, and print the matched share by category (JSON)

Environment: RECORDINGS_DIR (absolute), DATABASE_URL or POSTGRES_HOST, _PORT, _USER, _PASSWORD,
_DB (a throwaway database such as gerlines_rt or gerlines_wp23; any other, the shared gerlines above
all, only with --allow-shared).`;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * Connects to DATABASE_URL after checking, by name and again by the server's `current_database()`,
 * that it is a throwaway database (or that `allowShared` says otherwise on purpose).
 */
async function openDatabase(allowShared: boolean, readOnly = false): Promise<Kysely<DB>> {
  const databaseUrl =
    process.env.DATABASE_URL?.trim() ||
    (process.env.POSTGRES_HOST?.trim() ? resolveDatabaseUrl(process.env) : undefined);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or POSTGRES_HOST and the other POSTGRES_ settings) is required");
  }
  assertThrowawayDatabase(databaseNameOf(databaseUrl), allowShared);
  const url = new URL(resolveDatabaseUrl({ DATABASE_URL: databaseUrl }));
  if (readOnly) url.searchParams.set("options", "-c default_transaction_read_only=on");
  const db = createDatabase({
    databaseUrl: url.toString(),
    applicationName: "gerlines-realtime",
    maxConnections: 4,
  });
  try {
    const row = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
    assertThrowawayDatabase(row.rows[0]?.name ?? null, allowShared);
    return db;
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

function recordingsDir(): string {
  const dir = process.env.RECORDINGS_DIR?.trim() ?? "";
  if (!isAbsolute(dir)) throw new Error("RECORDINGS_DIR must be an absolute path");
  return dir;
}

async function foreignTimetables(
  sources: readonly string[],
  root: string,
  to: number,
  matcherTimetable: Timetable,
): Promise<Map<string, ForeignTimetable>> {
  if (!sources.includes("gtfsde-rt")) return new Map();
  const files = (
    await Promise.all(
      ["gtfsde-static-rv", "gtfsde-static-fv"].map((source) =>
        recordedStaticFile(root, source, to),
      ),
    )
  ).filter((file): file is string => file !== undefined);
  const result = new Map<string, ForeignTimetable>();
  if (files.length > 0)
    result.set("gtfsde-rt", await GtfsdeTimetable.load(files, matcherTimetable));
  return result;
}

async function processedRecords(
  db: Kysely<DB>,
  bySegment: ReadonlyMap<string, readonly FetchRecord[]>,
): Promise<{ records: FetchRecord[]; missing: number }> {
  const rows = await sql<{ raw_object_id: string }>`SELECT raw_object_id FROM rt_payload`.execute(
    db,
  );
  const byId = new Map<string, FetchRecord>();
  for (const list of bySegment.values()) {
    for (const record of list) if (record.object) byId.set(record.object.id, record);
  }
  const records = rows.rows.flatMap((row) => byId.get(row.raw_object_id) ?? []);
  return { records, missing: rows.rows.length - records.length };
}

function replayArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      sources: { type: "string" },
      speed: { type: "string" },
      "shuffle-seed": { type: "string" },
      rounds: { type: "string" },
      duplicates: { type: "string" },
      "split-at": { type: "string" },
      "feed-version-ids": { type: "string" },
      report: { type: "string" },
      "allow-shared": { type: "boolean" },
    },
  });
  if (!values.from || !values.to) throw new Error("replay needs --from and --to");
  const seed = values["shuffle-seed"];
  return {
    from: instantArg("from", values.from),
    to: instantArg("to", values.to),
    sources: sourcesArg(values.sources),
    speed: numberArg("speed", values.speed, 0, { min: 0 }),
    random:
      seed === undefined ? undefined : seededRandom(numberArg("shuffle-seed", seed, 0, { min: 0 })),
    rounds: numberArg("rounds", values.rounds, 3, { min: 1 }),
    duplicates: numberArg("duplicates", values.duplicates, 0.1, { min: 0, max: 1 }),
    splitAt: values["split-at"] ? instantArg("split-at", values["split-at"]) : undefined,
    feedVersionIds: values["feed-version-ids"]?.split(",").map(Number),
    report: values.report,
    allowShared: values["allow-shared"] === true,
  };
}

async function commandReplay(args: string[]): Promise<number> {
  const {
    from,
    to,
    sources,
    speed,
    random,
    rounds,
    duplicates,
    splitAt,
    feedVersionIds,
    report: reportPath,
    allowShared,
  } = replayArgs(args);
  const root = recordingsDir();
  const db = await openDatabase(allowShared);
  const started = Date.now();
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await holdWriterLock(db);
    await registerFoldSources(db, sources);
    const timetables = await loadTimetables(db, {
      at: to,
      max: MAX_TIMETABLES,
      ...(feedVersionIds ? { ids: feedVersionIds } : {}),
    });
    const heapAfterTimetables = process.memoryUsage().heapUsed;
    const newest = timetables[timetables.length - 1] as Timetable;
    const foreign = await foreignTimetables(sources, root, to, newest);
    const matcher = new Matcher(timetables, foreign);
    const { wanted, bySegment } = await recordsInWindow(root, sources, from, to);
    const clock = new VirtualClock(from, speed, systemClock);
    const processor = new Processor(
      db,
      matcher,
      clock,
      (records) => payloadsInOrder(root, records, bySegment),
      { sources, ...(splitAt === undefined ? {} : { splitAt }) },
    );
    const earlier = await processedRecords(db, bySegment);
    await processor.resume(earlier.records);
    const done = new Set(earlier.records.map((record) => record.object?.id));
    const fresh = wanted.filter((record) => !done.has(record.object?.id));
    const plan = random ? shuffledPlan(fresh, rounds, duplicates, random) : undefined;
    const result = await replay({
      root,
      processor,
      records: fresh,
      bySegment,
      clock,
      ...(plan ? { plan } : {}),
      ...(random ? { random } : {}),
    });
    const report = {
      database: redactDatabaseUrl(process.env.DATABASE_URL ?? ""),
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      sources,
      feedVersions: matcher.timetables.map((table) => ({
        feedVersionId: table.feedVersionId,
        feedVersion: table.data.feedVersion,
        publishedOn: table.data.publishedOn ?? null,
      })),
      heapAfterTimetablesMb: Math.round(heapAfterTimetables / 1_048_576),
      splitAt: splitAt === undefined ? null : new Date(splitAt).toISOString(),
      foreignTimetables: Object.fromEntries(
        [...foreign.entries()].map(([source, value]) => [source, (value as GtfsdeTimetable).files]),
      ),
      payloadsInWindow: wanted.length,
      resumed: earlier.records.length,
      resumedMissing: earlier.missing,
      payloadsDelivered: fresh.length,
      plan: plan
        ? { rounds: plan.rounds.map((round) => round.length), duplicates: plan.duplicates }
        : null,
      ...result,
      virtualStart: new Date(result.virtualStart).toISOString(),
      virtualEnd: new Date(result.virtualEnd).toISOString(),
      wallSeconds: Math.round((Date.now() - started) / 100) / 10,
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      coverage: coverageReport(processor),
      timetableCoverage: timetableCoverage(processor, matcher, { from, to }),
    };
    if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    print(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    await releaseLock?.();
    await db.destroy();
  }
}

function printCheck(result: {
  invariants: InvariantResult[];
  quality: InvariantResult[];
  fingerprints: TableFingerprint[];
  sizes: { database: number; tables: TableSize[] };
}): void {
  for (const item of result.invariants)
    print(`${item.violations === 0 ? "ok  " : "FAIL"} ${item.name} ${item.violations}`);
  for (const item of result.quality)
    print(`data ${item.name}${item.source ? ` ${item.source}` : ""} ${item.violations}`);
  for (const item of result.fingerprints) print(`${item.table} ${item.rows} ${item.md5}`);
  for (const item of result.sizes.tables) print(`size ${item.table} ${item.bytes}`);
  print(`size database ${result.sizes.database}`);
}

async function commandCheck(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" }, "allow-shared": { type: "boolean" } },
  });
  const db = await openDatabase(values["allow-shared"] === true);
  try {
    const result = {
      invariants: await invariants(db),
      quality: await quality(db),
      fingerprints: await fingerprints(db),
      sizes: await sizes(db),
    };
    if (values.json) print(JSON.stringify(result, null, 2));
    else printCheck(result);
    return result.invariants.some((item) => item.violations > 0) ? 1 : 0;
  } finally {
    await db.destroy();
  }
}

const REALTIME_TABLES = [
  "event",
  "segment_obs",
  "stop_event_forecast",
  "stop_event",
  "alert_scope",
  "alert_message",
  "trip_instance_source",
  "match_backlog",
  "rt_payload",
  "trip_instance",
  "rt_rebuild_job",
  "rt_rebuild_stop_event",
  "rt_rebuild_forecast",
  "rt_rebuild_segment",
];

async function commandReset(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { yes: { type: "boolean" }, "allow-shared": { type: "boolean" } },
  });
  if (values.yes !== true) {
    throw new Error("reset empties every realtime table; pass --yes to confirm");
  }
  const db = await openDatabase(values["allow-shared"] === true);
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await holdWriterLock(db);
    await sql`TRUNCATE ${sql.join(REALTIME_TABLES.map((table) => sql.table(table)))}`.execute(db);
    print(`emptied ${REALTIME_TABLES.join(", ")}`);
    return 0;
  } finally {
    await releaseLock?.();
    await db.destroy();
  }
}

function liveArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      sources: { type: "string" },
      since: { type: "string" },
      "horizon-hours": { type: "string" },
      checkpoint: { type: "string" },
      "poll-seconds": { type: "string" },
      "duration-minutes": { type: "string" },
      "allow-shared": { type: "boolean" },
    },
  });
  const checkpoint = values.checkpoint?.trim() || null;
  if (checkpoint && !isAbsolute(checkpoint))
    throw new Error("--checkpoint must be an absolute path");
  return {
    sources: sourcesArg(values.sources),
    since: values.since ? instantArg("since", values.since) : null,
    horizonMs: numberArg("horizon-hours", values["horizon-hours"], 48, { min: 1 }) * 3_600_000,
    checkpoint,
    pollMs:
      numberArg("poll-seconds", values["poll-seconds"], 5, { min: 0, exclusiveMin: true }) * 1000,
    durationMs: values["duration-minutes"]
      ? numberArg("duration-minutes", values["duration-minutes"], 0, {
          min: 0,
          exclusiveMin: true,
        }) * 60_000
      : null,
    allowShared: values["allow-shared"] === true,
  };
}

/** Where a live run starts: the given instant, else the oldest payload processed within the horizon, else ten minutes ago. */
async function liveStart(db: Kysely<DB>, horizonMs: number, given: number | null): Promise<number> {
  if (given !== null) return given;
  const horizon = Date.now() - horizonMs;
  const row = await sql<{ first: Date | null }>`
    SELECT min(observed_at) AS first FROM rt_payload WHERE observed_at >= ${new Date(horizon)}`.execute(
    db,
  );
  const first = row.rows[0]?.first;
  return first ? new Date(first).getTime() : Date.now() - 10 * 60_000;
}

/** The checkpoint at `path` when it was written against `database` (older ones name none). */
async function usableCheckpoint(
  path: string | null,
  database: string,
  logger: Logger,
): Promise<ProcessorSnapshot | undefined> {
  const read = path ? await readCheckpoint(path) : undefined;
  if (!read || (read.database ?? database) === database) return read;
  logger.log("warn", "checkpoint of another database ignored", {
    checkpointDatabase: truncated(read.database ?? ""),
  });
  return undefined;
}

async function currentDatabase(db: Kysely<DB>): Promise<string> {
  const row = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  return row.rows[0]?.name ?? "";
}

/** Advisory lock key that makes one realtime writer (live, replay, reset) the only one of a database. */
const WRITER_LOCK = "gerlines-realtime-live";

/**
 * Holds the single-writer lock on one pooled connection until the returned release is called;
 * throws when another live run holds it.
 */
async function holdWriterLock(db: Kysely<DB>): Promise<() => Promise<void>> {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settle: (ok: boolean | Error) => void = () => {};
  const acquired = new Promise<boolean | Error>((resolve) => {
    settle = resolve;
  });
  const held = db
    .connection()
    .execute(async (connection) => {
      const row = await sql<{ ok: boolean }>`
        SELECT pg_try_advisory_lock(hashtext(${WRITER_LOCK})) AS ok`.execute(connection);
      const ok = row.rows[0]?.ok === true;
      settle(ok);
      if (!ok) return;
      await released;
      await sql`SELECT pg_advisory_unlock(hashtext(${WRITER_LOCK}))`.execute(connection);
    })
    .catch((error: unknown) => settle(error instanceof Error ? error : new Error(String(error))));
  const outcome = await acquired;
  if (outcome instanceof Error) throw outcome;
  if (!outcome)
    throw new Error(
      "another realtime writer (live, replay or reset) holds this database; refusing to start",
    );
  return async () => {
    release();
    await held;
  };
}

/** The loaded DELFI versions a checkpoint names, newest first; undefined when one is not loaded. */
async function loadedVersionIds(
  db: Kysely<DB>,
  names: readonly string[],
): Promise<number[] | undefined> {
  if (names.length === 0) return undefined;
  const rows = await sql<{ id: number }>`
    SELECT feed_version_id AS id FROM feed_version
     WHERE source_id = ${TIMETABLE_SOURCE} AND status = 'loaded'
       AND feed_version = ANY(${[...names]}::text[])
     ORDER BY published_on DESC, feed_version_id DESC`.execute(db);
  return rows.rows.length === names.length ? rows.rows.map((row) => row.id) : undefined;
}

async function processedWithin(db: Kysely<DB>, since: number): Promise<string[]> {
  const rows = await sql<{ raw_object_id: string }>`
    SELECT raw_object_id FROM rt_payload WHERE observed_at >= ${new Date(since)}`.execute(db);
  return rows.rows.map((row) => row.raw_object_id);
}

async function commandLive(args: string[]): Promise<number> {
  const options = liveArgs(args);
  const root = recordingsDir();
  const db = await openDatabase(options.allowShared);
  const logger = jsonLogger(() => Date.now());
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const timer =
    options.durationMs === null ? undefined : setTimeout(stop, options.durationMs).unref();
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await holdWriterLock(db);
    if (options.checkpoint) await probeWritable(options.checkpoint);
    if (!(await waitForSchema(db, systemClock, logger, controller.signal))) return 0;
    await registerFoldSources(db, options.sources);
    const since = await liveStart(db, options.horizonMs, options.since);
    const clock = new DataClock(systemClock, since);
    const database = await currentDatabase(db);
    const snapshot = await usableCheckpoint(options.checkpoint, database, logger);
    const ids = snapshot ? await loadedVersionIds(db, snapshot.feedVersions) : undefined;
    const timetables = await loadTimetables(db, {
      at: since,
      max: MAX_TIMETABLES,
      ...(ids ? { ids } : {}),
    });
    const newest = timetables[timetables.length - 1] as Timetable;
    const foreign = await foreignTimetables(options.sources, root, since, newest);
    const matcher = new Matcher(timetables, foreign);
    const follower = new RecordingFollower(root, options.sources, since);
    const processor = new Processor(
      db,
      matcher,
      clock,
      (records) => payloadsInOrder(root, records, follower.bySegment),
      {
        sources: options.sources,
        coverage: false,
        horizonMs: options.horizonMs,
        wallClock: systemClock,
      },
    );
    const first = await follower.poll();
    const processed = await processedWithin(db, since);
    const restored = snapshot ? processor.restore(snapshot, (id) => follower.find(id)) : false;
    if (!restored && processed.length > 0) {
      const records = processed.flatMap((id) => follower.find(id) ?? []);
      logger.log("info", "no usable checkpoint: folding the processed payloads again", {
        payloads: records.length,
      });
      await processor.resume(records);
    }
    clock.observe(processor.newestObserved());
    logger.log("info", "live start", {
      database: redactDatabaseUrl(process.env.DATABASE_URL ?? ""),
      since: new Date(since).toISOString(),
      sources: options.sources,
      restoredFromCheckpoint: restored,
      processedBefore: processed.length,
      waiting: first.length,
      heapAfterTimetablesMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
    });
    const runner = new LiveRunner({
      db,
      root,
      processor,
      follower,
      clock,
      wallClock: systemClock,
      observe: (epochMs) => clock.observe(epochMs),
      logger,
      index: (records) => ensureIndexed(db, records),
      checkpointPath: options.checkpoint,
      database,
      horizonMs: options.horizonMs,
      pollMs: options.pollMs,
    });
    await runner.processWaiting(first, controller.signal);
    await runner.run(controller.signal);
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await releaseLock?.();
    await db.destroy();
  }
}

async function commandIrisMatch(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      "feed-version-ids": { type: "string" },
      "allow-shared": { type: "boolean" },
    },
  });
  const { dir, feedVersionIds: ids, allowShared } = irisMatchArgs(values);
  const { evaluateIris, readProbeAnswers } = await import("./iris-evaluate.ts");
  const answers = await readProbeAnswers(dir);
  const db = await openDatabase(allowShared, true);
  try {
    const at = Math.max(...answers.map((answer) => answer.observedAt));
    const timetables = await loadTimetables(db, { at, max: MAX_TIMETABLES, ids });
    print(JSON.stringify(evaluateIris(answers, new Matcher(timetables)), null, 2));
    return 0;
  } finally {
    await db.destroy();
  }
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  "iris-match": commandIrisMatch,
  live: commandLive,
  replay: commandReplay,
  check: commandCheck,
  reset: commandReset,
};

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    print(USAGE);
    return name ? 2 : 0;
  }
  return command(args);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`realtime command failed: ${truncated(errorMessage(error))}\n`);
    const frames = error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 11) : [];
    for (const frame of frames) process.stderr.write(`${truncated(frame)}\n`);
    process.exitCode = 1;
  },
);
