import { mkdir, rm } from "node:fs/promises";
import { type Clock, utcDate } from "../clock.ts";
import { IRIS_PROVIDER, IrisLease } from "../db-apis/iris-lease.ts";
import type { RecorderConfig } from "../env.ts";
import type { IndexWriter } from "../index-db.ts";
import { errorMessage, type Logger } from "../log.ts";
import { travelPlan } from "../policy/travel.ts";
import { reindexAll } from "../reindex.ts";
import {
  dbApiSources,
  type MobilithekAccess,
  PROVIDER_LIMITS,
  type ProviderLimit,
  recorderSources,
  type SourceDefinition,
} from "../sources.ts";
import { appendJsonLine, resolveInside } from "../storage/files.ts";
import { STORAGE_FORMAT_VERSION } from "../storage/frame.ts";
import { type ModeSetting, readMode } from "../storage/mode.ts";
import { EVENTS_PATH, LOCK_PATH, TMP_DIR } from "../storage/paths.ts";
import { RunLog } from "../storage/runs.ts";
import { uuidv7 } from "../uuid.ts";
import { DiskGuard, type FreeBytes, statfsFreeBytes } from "./disk-guard.ts";
import { IndexSink } from "./index-sink.ts";
import { HeartbeatLock, LockLostError } from "./lock.ts";
import { ProviderGate, type ProviderLease } from "./provider-gate.ts";
import { reconcileLoop } from "./reconcile.ts";
import { Semaphore } from "./semaphore.ts";
import { SourceRunner } from "./source-runner.ts";

const JOB = "record";
const HEARTBEAT_MS = 30_000;
const LOCK_STALE_MS = 90_000;
const DISK_CHECK_MS = 60_000;
const MODE_CHECK_MS = 60_000;

export interface RecorderDeps {
  readonly config: RecorderConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly index: IndexWriter | null;
  readonly signal: AbortSignal;
  readonly random?: () => number;
  readonly freeBytes?: FreeBytes;
  readonly sources?: readonly SourceDefinition[];
  readonly providerLimits?: Readonly<Record<string, ProviderLimit>>;
  readonly migrate?: () => Promise<void>;
  /** How often the mode file is read. */
  readonly modeCheckMs?: number;
  readonly travelPeriods?: (runningIds: readonly string[]) => ReadonlyMap<string, number>;
}

/**
 * Every source this configuration knows. The DB API sources (IRIS, StaDa, FaSta) join only with
 * `RECORDER_DB_APIS=1`, so a recorder rebuilt from main never starts polling IRIS by accident: the IRIS
 * plan allows 60 requests per minute for the whole application, and only one poller may hold that budget.
 */
function mobilithekAccess(config: RecorderConfig): MobilithekAccess {
  const { missing, subscriptionId } = config.mobilithek;
  if (missing) return { certificate: null, subscriptionId, problem: `${missing} is empty` };
  try {
    return { certificate: config.mobilithek.openCertificate(), subscriptionId, problem: null };
  } catch (error) {
    return { certificate: null, subscriptionId, problem: errorMessage(error) };
  }
}

export function configuredSources(config: RecorderConfig): SourceDefinition[] {
  const sources = recorderSources({
    otdChApiKey: config.otdChApiKey,
    sncbApiKey: config.sncbApiKey,
    mobilithek: mobilithekAccess(config),
  });
  return config.dbApis
    ? [...sources, ...dbApiSources({ dbCredentials: config.dbCredentials })]
    : sources;
}

export function selectSources(config: RecorderConfig, logger: Logger): SourceDefinition[] {
  return configuredSources(config).filter((source) => {
    if (config.onlySources && !config.onlySources.has(source.id)) return false;
    if (source.skipReason) {
      logger.log("info", "source skipped", { source: source.id, reason: source.skipReason });
      return false;
    }
    return true;
  });
}

/** The IRIS lease, logged when another process takes it from the recorder or leaves it again. */
function loggedLease(lease: IrisLease, logger: Logger): ProviderLease {
  let last: string | null = null;
  return {
    hold: async () => {
      const heldBy = await lease.hold();
      if (heldBy !== last) {
        if (heldBy) {
          logger.log("warn", "IRIS sources skipped while another process holds the lease", {
            provider: IRIS_PROVIDER,
            heldBy,
          });
        } else {
          logger.log("info", "IRIS lease taken, IRIS sources run", { provider: IRIS_PROVIDER });
        }
        last = heldBy;
      }
      return heldBy;
    },
  };
}

function every(
  deps: RecorderDeps,
  signal: AbortSignal,
  name: string,
  ms: number,
  task: () => Promise<void>,
): Promise<void> {
  const { clock, logger } = deps;
  return (async () => {
    while (!signal.aborted) {
      await clock.sleep(ms, signal);
      if (signal.aborted) break;
      try {
        await task();
      } catch (error) {
        logger.log("error", "background task failed, retrying on its next turn", {
          task: name,
          error: errorMessage(error),
        });
      }
    }
  })();
}

async function recordEvent(
  root: string,
  repaired: Set<string>,
  event: Record<string, unknown>,
): Promise<void> {
  await appendJsonLine(
    resolveInside(root, EVENTS_PATH),
    { v: STORAGE_FORMAT_VERSION, ...event },
    repaired,
  );
}

interface Session {
  readonly deps: RecorderDeps;
  readonly root: string;
  readonly startedAt: string;
  readonly runs: RunLog;
  readonly index: IndexSink;
  readonly eventFiles: Set<string>;
}

async function startRun(session: Session, source: SourceDefinition): Promise<string> {
  const { deps, runs, index, startedAt } = session;
  const runId = uuidv7(deps.clock.now());
  const crashed = await runs.closeUnfinished(source.id, JOB, startedAt);
  if (crashed.length > 0) {
    deps.logger.log("warn", "closed runs left by a crash", { source: source.id, runs: crashed });
  }
  await runs.start({
    run: runId,
    source: source.id,
    job: JOB,
    appVersion: deps.config.appVersion,
    at: startedAt,
  });
  await index.failStaleRuns(source.id, JOB, runId, new Date(startedAt));
  await index.run({
    id: runId,
    source: source.id,
    job: JOB,
    appVersion: deps.config.appVersion,
    startedAt,
    status: "running",
    finishedAt: null,
    error: null,
  });
  return runId;
}

async function finishRun(
  session: Session,
  runner: SourceRunner,
  result: PromiseSettledResult<void> | undefined,
  finishedAt: string,
): Promise<void> {
  const failed = result?.status === "rejected";
  const error = failed ? errorMessage(result.reason) : null;
  const status = failed ? "failed" : "succeeded";
  await session.runs.end({
    run: runner.runId,
    source: runner.source.id,
    status,
    at: finishedAt,
    ...(error ? { error } : {}),
  });
  await session.index.run({
    id: runner.runId,
    source: runner.source.id,
    job: JOB,
    appVersion: session.deps.config.appVersion,
    startedAt: session.startedAt,
    status,
    finishedAt,
    error,
  });
}

function diskChecker(session: Session, guard: DiskGuard): () => Promise<void> {
  const { clock, logger } = session.deps;
  return async () => {
    const change = await guard.check();
    if (!change) return;
    const detail = { freeBytes: change.freeBytes, floorBytes: guard.floorBytes };
    if (change.paused)
      logger.log("error", "recording paused: free disk space below the floor", detail);
    else logger.log("info", "recording resumed", detail);
    await recordEvent(session.root, session.eventFiles, {
      type: change.paused ? "disk-pause" : "disk-resume",
      at: new Date(clock.now()).toISOString(),
      ...detail,
    });
  };
}

/** Follows the mode file; logs and records each change, the first reading included. */
class ModeFollower {
  setting: ModeSetting | null = null;
  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
  }

  async check(): Promise<void> {
    const next = await readMode(this.session.root);
    if (this.setting?.mode === next.mode) return;
    this.setting = next;
    const { clock, logger } = this.session.deps;
    logger.log(next.mode === "full" ? "info" : "warn", "recorder mode", {
      mode: next.mode,
      reason: next.reason,
    });
    await recordEvent(this.session.root, this.session.eventFiles, {
      type: "mode",
      mode: next.mode,
      at: new Date(clock.now()).toISOString(),
      setAt: next.at,
      reason: next.reason,
    });
  }

  periodFor(travel: ReadonlyMap<string, number>): (source: SourceDefinition) => number | null {
    return (source) => {
      const mode = this.setting?.mode ?? "full";
      if (mode === "paused") return null;
      if (mode === "travel") return travel.get(source.id) ?? null;
      return source.periodMs;
    };
  }
}

/** Rebuilds the index of yesterday and today (UTC) from the files, stopping between sources on abort. */
function reconciler(
  session: Session,
  index: IndexWriter,
  sources: readonly SourceDefinition[],
): (signal: AbortSignal) => Promise<void> {
  const { deps } = session;
  return async (signal) => {
    await deps.migrate?.();
    if (signal.aborted) return;
    await reindexAll(session.root, index, sources, {
      sinceDate: utcDate(deps.clock.now() - 86_400_000),
      signal,
    });
  };
}

function reconcileInBackground(
  session: Session,
  sources: readonly SourceDefinition[],
  signal: AbortSignal,
): Promise<void> {
  const { deps } = session;
  if (!deps.index) return Promise.resolve();
  return reconcileLoop({
    clock: deps.clock,
    signal,
    logger: deps.logger,
    sink: session.index,
    reconcile: reconciler(session, deps.index, sources),
  });
}

async function cleanTemp(root: string): Promise<void> {
  await rm(resolveInside(root, TMP_DIR), { recursive: true, force: true });
  await mkdir(resolveInside(root, TMP_DIR), { recursive: true });
}

/** Runs every source until the signal aborts, then closes each run as succeeded. */
export async function runRecorder(deps: RecorderDeps): Promise<void> {
  const { config, clock, logger } = deps;
  const root = config.recordingsDir;
  const stop = new AbortController();
  const signal = stop.signal;
  if (deps.signal.aborted) stop.abort();
  deps.signal.addEventListener("abort", () => stop.abort(), { once: true });
  await mkdir(root, { recursive: true });
  const lock = new HeartbeatLock({ root, path: LOCK_PATH, clock, staleAfterMs: LOCK_STALE_MS });
  const acquired = await lock.acquire(signal, (owner) =>
    logger.log("warn", "another recorder holds the lock, waiting", {
      pid: owner.pid,
      host: owner.host,
      heartbeatAt: owner.heartbeatAt,
    }),
  );
  if (!acquired) return;
  await cleanTemp(root);
  let lockLost: LockLostError | null = null;
  const heartbeat = async () => {
    try {
      await lock.heartbeat();
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
      lockLost = error;
      logger.log("error", "another writer took the recordings lock over, stopping", {
        error: error.message,
      });
      stop.abort();
    }
  };

  const sources = deps.sources ?? selectSources(config, logger);
  const session: Session = {
    deps,
    root,
    startedAt: new Date(clock.now()).toISOString(),
    runs: new RunLog(root),
    index: new IndexSink(deps.index, logger),
    eventFiles: new Set<string>(),
  };
  const irisLease = sources.some((source) => source.provider === IRIS_PROVIDER)
    ? new IrisLease({ root, clock })
    : null;
  const guard = new DiskGuard(root, config.diskFloorBytes, deps.freeBytes ?? statfsFreeBytes);
  const modes = new ModeFollower(session);
  const travel = (deps.travelPeriods ?? travelPlan)(sources.map((source) => source.id));
  const context = {
    root,
    userAgent: config.userAgent,
    clock,
    random: deps.random ?? Math.random,
    logger,
    index: session.index,
    gate: new ProviderGate({
      clock,
      limits: deps.providerLimits ?? PROVIDER_LIMITS,
      inFlight: new Semaphore(config.maxInFlight),
      leases: irisLease ? { [IRIS_PROVIDER]: loggedLease(irisLease, logger) } : {},
    }),
    isPaused: () => guard.paused,
    periodFor: modes.periodFor(travel),
    seedDir: config.seedDir,
    signal,
  };
  await session.index.sources(sources);
  const runners: SourceRunner[] = [];
  for (const source of sources) {
    runners.push(new SourceRunner(source, context, await startRun(session, source)));
  }
  await recordEvent(root, session.eventFiles, {
    type: "recorder-start",
    at: session.startedAt,
    sources: sources.map((s) => s.id),
    appVersion: config.appVersion,
  });

  const checkDisk = diskChecker(session, guard);
  await checkDisk();
  await modes.check();
  await Promise.all(runners.map((runner) => runner.init()));
  logger.log("info", "recorder started", {
    sources: sources.map((source) => source.id),
    recordingsDir: root,
  });
  const background = [
    every(deps, signal, "heartbeat", HEARTBEAT_MS, heartbeat),
    every(deps, signal, "disk check", DISK_CHECK_MS, checkDisk),
    every(deps, signal, "mode check", deps.modeCheckMs ?? MODE_CHECK_MS, () => modes.check()),
    reconcileInBackground(session, sources, signal),
  ];
  const results = await Promise.allSettled(runners.map((runner) => runner.loop()));
  await Promise.allSettled(background);

  const finishedAt = new Date(clock.now()).toISOString();
  const lost: LockLostError | null = lockLost;
  for (const [position, runner] of runners.entries()) {
    const result = lost ? { status: "rejected" as const, reason: lost } : results[position];
    await finishRun(session, runner, result, finishedAt);
  }
  await irisLease?.release();
  await recordEvent(root, session.eventFiles, { type: "recorder-stop", at: finishedAt });
  if (lost) throw lost;
  await lock.release();
  logger.log("info", "recorder stopped", { at: finishedAt });
}
