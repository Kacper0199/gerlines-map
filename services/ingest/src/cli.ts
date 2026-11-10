import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { createDatabase, migrateUp, resolveDatabaseUrl } from "@gerlines/db";
import { archivePass, MANIFEST_DIR } from "./backfill/archive.ts";
import { backfillRecent } from "./backfill/backfill.ts";
import { systemClock } from "./clock.ts";
import { APP_VERSION, loadRecorderConfig, type RecorderConfig } from "./env.ts";
import { RecorderIndex } from "./index-db.ts";
import { errorMessage, jsonLogger, type Logger } from "./log.ts";
import { recorderDatabaseOptions } from "./recorder/database.ts";
import { IndexSink } from "./recorder/index-sink.ts";
import { HeartbeatLock } from "./recorder/lock.ts";
import { configuredSources, runRecorder, selectSources } from "./recorder/recorder.ts";
import { reindexAll } from "./reindex.ts";
import { runRetention } from "./retention-command.ts";
import type { SourceDefinition } from "./sources.ts";
import { formatStatus, recorderStatus } from "./status.ts";
import { isRecorderMode, readMode, writeMode } from "./storage/mode.ts";
import { processedInDatabase } from "./storage/processed-evidence.ts";
import { markGoldenDay, readGoldenDays } from "./storage/retention.ts";
import { verifySource } from "./verify.ts";

const USAGE = `gerlines recorder ${APP_VERSION}

Usage: node src/cli.ts <command> [options]

  run                         record every source until SIGTERM or SIGINT
  health                      exit 0 when the running recorder's heartbeat is under 120 s old
  status [--json] [--days N]  per source: last success, last error, today's objects and bytes, staleness, gaps
  verify [--source ID] [--from ISO] [--to ISO] [--json]
                              recover every stored payload and compare its sha256 with its sidecar
  reindex [--since YYYY-MM-DD] rebuild the database index from the recording files (idempotent)
  backfill-archive --day YYYY-MM-DD [--dry-run] [--max-rate MIB_PER_S] [--store-root DIR]
                   [--manifest-root DIR]
                              stream the mirror's day archive once (German date): write its sha256
                              manifest and store the minutes the recordings miss (writer archive)
  retention [--keep-days N] [--as-of ISO] [--manifest-root DIR]... [--processed-db] [--out FILE]
            [--apply]
                              plan (dry run, the default) or apply the deletion of old recorded files
                              that a complete archive manifest or the database (rt_payload) backs;
                              never golden days, sidecars, sameAs targets or the newest object
  golden [add YYYY-MM-DD --reason TEXT]
                              list the golden days retention keeps whole, or mark one more
  mode [full|travel|paused] [--reason TEXT]
                              show or set what the running recorder records, read within a
                              minute: full, travel (DELFI every 5 min and alerts only) or paused
  backfill-recent [--days N | --from ISO] [--dry-run]
                              fill delfi-gtfs-rt gaps from the mirror's minute folders; a mirror
                              file that is not a feed is stored as invalid and the run continues

Environment: RECORDINGS_DIR (absolute), APP_NAME, APP_CONTACT, OTD_CH_API_KEY, SNCB_API_KEY,
DB_CLIENT_ID and DB_API_KEY (read only with RECORDER_DB_APIS=1, default 0),
DATABASE_URL or POSTGRES_*, RECORDER_DISK_FLOOR_GIB (20), RECORDER_MAX_IN_FLIGHT (3),
RECORDER_SOURCES (comma list), RECORDER_SEED_DIR, RECORDER_DATABASE (on or off),
RECORDER_MIGRATIONS_DIR (apply migrations from this folder at start).`;

const logger: Logger = jsonLogger(() => Date.now());

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function allSources(config: RecorderConfig): SourceDefinition[] {
  return configuredSources(config);
}

function openIndex(config: RecorderConfig): RecorderIndex | null {
  if (config.database === "off") return null;
  return new RecorderIndex(
    createDatabase(recorderDatabaseOptions(resolveDatabaseUrl(process.env), logger)),
  );
}

function shutdownSignal(): AbortSignal {
  const controller = new AbortController();
  let requested = false;
  const stop = (signal: string) => {
    if (requested) process.exit(130);
    requested = true;
    logger.log("info", "shutdown requested, finishing current writes", { signal });
    controller.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  return controller.signal;
}

async function applyMigrations(): Promise<void> {
  const migrationsDir = process.env.RECORDER_MIGRATIONS_DIR?.trim();
  if (!migrationsDir) return;
  const databaseUrl = resolveDatabaseUrl(process.env);
  try {
    const applied = await migrateUp({ databaseUrl, migrationsDir, lockWaitMs: 30_000 });
    logger.log("info", "migrations checked", {
      database: `${new URL(databaseUrl).host}${new URL(databaseUrl).pathname}`,
      applied: applied.map((m) => m.version),
    });
  } catch (error) {
    logger.log(
      "warn",
      "migrations not applied, recording continues and the index reconciles later",
      { error: errorMessage(error) },
    );
  }
}

async function commandRun(config: RecorderConfig): Promise<number> {
  const signal = shutdownSignal();
  if (config.database === "on") await applyMigrations();
  const index = openIndex(config);
  try {
    await runRecorder({
      config,
      clock: systemClock,
      logger,
      index,
      signal,
      ...(config.database === "on" ? { migrate: applyMigrations } : {}),
    });
  } finally {
    await index?.db.destroy();
  }
  return 0;
}

async function commandStatus(config: RecorderConfig, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" }, days: { type: "string" } },
  });
  const status = await recorderStatus(
    config.recordingsDir,
    selectSources(config, { log: () => undefined }),
    Date.now(),
    Number(values.days ?? 3),
  );
  print(values.json ? JSON.stringify(status, null, 2) : formatStatus(status));
  return 0;
}

async function commandVerify(config: RecorderConfig, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const window = {
    ...(values.from ? { from: Date.parse(values.from) } : {}),
    ...(values.to ? { to: Date.parse(values.to) } : {}),
  };
  const ids = values.source ? [values.source] : allSources(config).map((source) => source.id);
  let failed = false;
  for (const id of ids) {
    const report = await verifySource(config.recordingsDir, id, window);
    failed ||= report.mismatched.length > 0 || report.errors.length > 0;
    print(
      values.json
        ? JSON.stringify(report)
        : `${id}: ${report.records} records, ${report.checked} payloads recovered, ${report.matched} sha256 equal, ${report.mismatched.length} mismatched, ${report.errors.length} errors, ${report.unchangedResolved} unchanged resolved, ${report.unchangedOutsideWindow} unchanged refer outside the window; payload ${report.payloadBytes} B, stored ${report.storedBytes} B`,
    );
    for (const line of [...report.mismatched, ...report.errors]) print(`  ${line}`);
  }
  return failed ? 1 : 0;
}

async function commandReindex(config: RecorderConfig, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { since: { type: "string" } } });
  const index = openIndex(config);
  if (!index) throw new Error("reindex needs the database (RECORDER_DATABASE=on)");
  try {
    const reports = await reindexAll(
      config.recordingsDir,
      index,
      allSources(config),
      values.since ? { sinceDate: values.since } : {},
    );
    for (const report of reports) print(JSON.stringify(report));
  } finally {
    await index.db.destroy();
  }
  return 0;
}

async function commandBackfill(config: RecorderConfig, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { days: { type: "string" }, from: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const source = allSources(config).find((candidate) => candidate.id === "delfi-gtfs-rt");
  if (!source) throw new Error("delfi-gtfs-rt is not defined");
  const signal = shutdownSignal();
  const lock = new HeartbeatLock({
    root: config.recordingsDir,
    path: ".backfill.lock",
    clock: systemClock,
    staleAfterMs: 10 * 60_000,
  });
  const blocker = await lock.tryAcquire();
  if (blocker) throw new Error(`another backfill runs (pid ${blocker.pid} on ${blocker.host})`);
  const keepAlive = setInterval(() => {
    lock.heartbeat().catch((error: unknown) => {
      logger.log("error", "backfill lock lost", { error: errorMessage(error) });
    });
  }, 60_000);
  const index = openIndex(config);
  const sink = new IndexSink(index, logger);
  try {
    const report = await backfillRecent({
      root: config.recordingsDir,
      source,
      userAgent: config.userAgent,
      clock: systemClock,
      logger,
      index: sink,
      signal,
      days: Number(values.days ?? 2),
      ...(values.from ? { from: Date.parse(values.from) } : {}),
      dryRun: values["dry-run"] ?? false,
      appVersion: config.appVersion,
    });
    if (!values["dry-run"]) {
      await sink.replaceGaps(
        source.id,
        report.gapsAfter.map((gap) => ({ start: Date.parse(gap.from), end: Date.parse(gap.to) })),
        new Date(report.since),
      );
    }
    print(JSON.stringify(report, null, 2));
    return report.stoppedOn ? 1 : 0;
  } finally {
    clearInterval(keepAlive);
    await lock.release();
    await index?.db.destroy();
  }
}

async function commandMode(config: RecorderConfig, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { reason: { type: "string" } },
  });
  const wanted = positionals[0];
  if (wanted === undefined) {
    const current = await readMode(config.recordingsDir);
    print(JSON.stringify(current));
    return 0;
  }
  if (!isRecorderMode(wanted)) {
    print(`unknown mode ${JSON.stringify(wanted)}: use full, travel or paused`);
    return 2;
  }
  const setting = await writeMode(config.recordingsDir, wanted, new Date(), values.reason ?? null);
  print(JSON.stringify(setting));
  return 0;
}

function absoluteOption(value: string | undefined, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function commandBackfillArchive(config: RecorderConfig, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      day: { type: "string" },
      "dry-run": { type: "boolean" },
      "max-rate": { type: "string" },
      "store-root": { type: "string" },
      "manifest-root": { type: "string" },
    },
  });
  const day = values.day ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day YYYY-MM-DD is required");
  const rate = Number(values["max-rate"] ?? 8);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("--max-rate must be a positive number");
  const source = allSources(config).find((candidate) => candidate.id === "delfi-gtfs-rt");
  if (!source) throw new Error("delfi-gtfs-rt is not defined");
  const storeRoot = absoluteOption(values["store-root"], config.recordingsDir, "--store-root");
  const manifestRoot = absoluteOption(
    values["manifest-root"],
    join(config.recordingsDir, MANIFEST_DIR),
    "--manifest-root",
  );
  const lock = new HeartbeatLock({
    root: storeRoot,
    path: ".backfill.lock",
    clock: systemClock,
    staleAfterMs: 10 * 60_000,
  });
  const blocker = await lock.tryAcquire();
  if (blocker) throw new Error(`another backfill runs (pid ${blocker.pid} on ${blocker.host})`);
  const keepAlive = setInterval(() => {
    lock.heartbeat().catch((error: unknown) => {
      logger.log("error", "backfill lock lost", { error: errorMessage(error) });
    });
  }, 60_000);
  const index = storeRoot === config.recordingsDir ? openIndex(config) : null;
  try {
    const report = await archivePass({
      root: config.recordingsDir,
      storeRoot,
      manifestRoot,
      day,
      source,
      userAgent: config.userAgent,
      clock: systemClock,
      logger,
      index: new IndexSink(index, logger),
      signal: shutdownSignal(),
      dryRun: values["dry-run"] ?? false,
      maxBytesPerSecond: rate * 1024 * 1024,
      appVersion: config.appVersion,
      diskFloorBytes: config.diskFloorBytes,
    });
    print(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    clearInterval(keepAlive);
    await lock.release();
    await index?.db.destroy();
  }
}

function databaseName(): string | null {
  try {
    return new URL(resolveDatabaseUrl(process.env)).pathname.slice(1) || null;
  } catch {
    return null;
  }
}

async function commandRetention(config: RecorderConfig, args: string[]): Promise<number> {
  return runRetention(args, {
    recordingsDir: config.recordingsDir,
    clock: systemClock,
    logger,
    print,
    databaseName: databaseName(),
    openProcessed: () => {
      const index = openIndex(config);
      if (!index)
        throw new Error("--processed-db needs the database, but RECORDER_DATABASE is off");
      return {
        lookup: processedInDatabase(index.db, databaseName() ?? "unknown"),
        close: () => index.db.destroy(),
      };
    },
  });
}

async function commandGolden(config: RecorderConfig, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { reason: { type: "string" } },
  });
  if (positionals[0] === "add") {
    const day = positionals[1] ?? "";
    if (!values.reason) throw new Error("golden add needs --reason");
    await markGoldenDay(config.recordingsDir, day, values.reason, new Date());
  } else if (positionals.length > 0 && positionals[0] !== "list") {
    print("usage: golden [list] | golden add YYYY-MM-DD --reason TEXT");
    return 2;
  }
  print(JSON.stringify(Object.fromEntries(await readGoldenDays(config.recordingsDir)), null, 2));
  return 0;
}

const HEALTHY_HEARTBEAT_MS = 120_000;

async function commandHealth(config: RecorderConfig): Promise<number> {
  const lock = new HeartbeatLock({
    root: config.recordingsDir,
    path: ".recorder.lock",
    clock: systemClock,
    staleAfterMs: HEALTHY_HEARTBEAT_MS,
  });
  const owner = await lock.read();
  const age = owner ? Date.now() - Date.parse(owner.heartbeatAt) : null;
  print(age === null ? "no heartbeat" : `heartbeat ${Math.round(age / 1000)} s ago`);
  return age !== null && age < HEALTHY_HEARTBEAT_MS ? 0 : 1;
}

const COMMANDS: Record<string, (config: RecorderConfig, args: string[]) => Promise<number>> = {
  run: (config) => commandRun(config),
  health: (config) => commandHealth(config),
  status: commandStatus,
  verify: commandVerify,
  reindex: commandReindex,
  "backfill-recent": commandBackfill,
  mode: commandMode,
  "backfill-archive": commandBackfillArchive,
  retention: commandRetention,
  golden: commandGolden,
};

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    print(USAGE);
    return name ? 2 : 0;
  }
  return command(loadRecorderConfig(process.env), args);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    logger.log("error", "recorder command failed", { error: errorMessage(error) });
    process.exitCode = 1;
  },
);
