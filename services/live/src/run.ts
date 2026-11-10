import type { DB } from "@gerlines/db";
import { serve } from "@hono/node-server";
import Valkey from "iovalkey";
import type { Kysely } from "kysely";
import { CentrifugoClient, plainHttpAllowed } from "./detail/centrifugo.ts";
import { type Logger, TrainDetailPublisher } from "./detail/publisher.ts";
import { DetailRepository, type ReadMode } from "./detail/repository.ts";
import { productCoverage } from "./detail/running.ts";
import { ValkeyDetailStore, type ValkeyWriter } from "./detail/store.ts";
import { LiveEngine } from "./engine/engine.ts";
import { type KeyStore, MemoryKeyStore, ValkeyKeyStore } from "./engine/keys.ts";
import { durationSummary } from "./metrics.ts";
import { playbackDirectory, playbackState } from "./playback/mount.ts";
import {
  BackgroundNotifier,
  CentrifugoNotifier,
  ChangedHeadNotifier,
  type Notifier,
} from "./publish/notice.ts";
import { newChainStart, restoreChain } from "./publish/restore.ts";
import { FileStore, PACKS_COMPLETE } from "./publish/storage.ts";
import { RebuildListener, type RebuildNotices } from "./realtime/notices.ts";
import { FollowReader, type RealtimeReader, SnapshotThen } from "./realtime/readers.ts";
import { createWaitingApp } from "./server/app.ts";
import { type HttpThread, startHttpThread } from "./server/http-thread.ts";
import { currentShapeEpoch } from "./shapes/packs.ts";
import { PackSetPublisher, WorkerRunner } from "./shapes/sets.ts";
import { DatabaseTimetable } from "./timetable/loader.ts";
import { checkShapesDatabase } from "./timetable/shapes-database.ts";
import { DatabaseFleetSource } from "./vehicle/database.ts";
import { VehicleIdentities } from "./vehicle/identities.ts";

/** The engine clock (design note §1): the system clock, or a replay at a speed. */
export interface Clock {
  now(): number;
}

export function parseClock(spec: string, wall: () => number = () => Date.now() / 1000): Clock {
  if (spec === "system") return { now: () => Math.floor(wall()) };
  const match = /^replay:(.+):(\d+(?:\.\d+)?)$/.exec(spec);
  const start = match ? Date.parse(match[1] as string) / 1000 : Number.NaN;
  const speed = match ? Number(match[2]) : Number.NaN;
  if (!Number.isFinite(start) || !(speed > 0)) {
    throw new Error("--clock takes system or replay:<ISO>:<speed>");
  }
  const origin = wall();
  return { now: () => Math.floor(start + (wall() - origin) * speed) };
}

/** `live run`'s reader: the snapshot, then the cursor from the wall clock before it was read. */
export function startupThenFollow(
  db: Kysely<DB>,
  wallNow: number,
  notices?: RebuildNotices,
  logLine?: (fields: Record<string, unknown>) => void,
): RealtimeReader {
  const follow = new FollowReader(db, wallNow, {
    ...(notices ? { notices } : {}),
    ...(logLine ? { log: logLine } : {}),
  });
  return new SnapshotThen(db, () => follow);
}

export interface RunOptions {
  readonly out: string;
  readonly host: string;
  readonly port: number;
  readonly clock: string;
  readonly openDatabase: () => Kysely<DB>;
  /** Where the rebuild listener connects (the database `openDatabase` opens). */
  readonly databaseUrl: string;
  /** Pattern shapes from another database (SHAPES_DATABASE_URL), else the main one. */
  readonly openShapesDatabase?: () => Kysely<DB> | null;
  /** The detail writer's own pool (small: one load runs seven queries at once). */
  readonly openDetailDatabase?: () => Kysely<DB>;
  /** Trip keys in memory only (local runs): a restart re-keys every train. */
  readonly memoryKeys?: boolean;
  /** The operator's override: serve this timetable version whenever it is loaded, below the floors. */
  readonly pinnedVersion?: number;
}

function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`);
}

/**
 * Valkey keeps trip keys stable across restarts (F-15: without it every restored train would be
 * removed and re-added under a new key); running without it needs `--memory-keys`.
 */
export async function connectValkey(memoryKeys: boolean): Promise<Valkey | null> {
  const url = process.env.VALKEY_URL?.trim();
  if (!url) {
    if (memoryKeys) return null;
    throw new Error(
      "live run needs VALKEY_URL so trip keys survive a restart; pass --memory-keys to run without it",
    );
  }
  const valkey = new Valkey(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await valkey.connect();
  return valkey;
}

/** The placeholder of `.env.example`: accepted only on the local Compose stack. */
export const PLACEHOLDER_SECRET = "change-me-locally";

interface CentrifugoAccess {
  readonly url: string;
  readonly apiKey: string;
}

/**
 * CENTRIFUGO_URL and its key, or null without a URL. A missing key, the placeholder key outside the
 * local stack (`LIVE_LOCAL_STACK=1`), or plain http to a host that is neither loopback nor a service
 * name stops the start instead of sending the key where it can be read.
 */
function centrifugoFromEnvironment(env: NodeJS.ProcessEnv): CentrifugoAccess | null {
  const url = env.CENTRIFUGO_URL?.trim();
  if (!url) return null;
  const apiKey = env.CENTRIFUGO_HTTP_API_KEY?.trim();
  if (!apiKey) throw new Error("CENTRIFUGO_URL is set but CENTRIFUGO_HTTP_API_KEY is empty");
  if (apiKey === PLACEHOLDER_SECRET && env.LIVE_LOCAL_STACK !== "1") {
    throw new Error(
      "CENTRIFUGO_HTTP_API_KEY is the .env.example placeholder; set a real key (or LIVE_LOCAL_STACK=1 on the local stack)",
    );
  }
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new Error("CENTRIFUGO_URL must be an http or https origin");
  }
  if (parsed.protocol === "http:" && !plainHttpAllowed(parsed.hostname)) {
    throw new Error("CENTRIFUGO_URL must use https unless it is loopback or a service name");
  }
  return { url, apiKey };
}

/** Centrifugo head notices when CENTRIFUGO_URL is set. */
export function notifierFromEnvironment(env: NodeJS.ProcessEnv = process.env): Notifier | null {
  const centrifugo = centrifugoFromEnvironment(env);
  if (!centrifugo) return null;
  return new BackgroundNotifier(
    new ChangedHeadNotifier(new CentrifugoNotifier(centrifugo.url, centrifugo.apiKey)),
  );
}

/**
 * How train details read stop rows: the folded `stop_event` state at the wall clock, the forecasts
 * as of the instant on a replay clock (the folded state is the present, not the replayed instant).
 */
export function detailReadMode(clock: string): ReadMode {
  return clock === "system" ? "current" : "history";
}

/** The detail writer runs unless LIVE_DETAIL is 0, false, off or no. */
export function detailEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.LIVE_DETAIL?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

export interface DetailWiring {
  readonly db: Kysely<DB>;
  readonly valkey: ValkeyWriter | null;
  readonly mode: ReadMode;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
}

/**
 * The engine's DetailPort (WP-3.2b): train details in Valkey, where the API reads them, pushed to
 * their per-train channels when CENTRIFUGO_URL is set. None without Valkey or with LIVE_DETAIL=0.
 */
export function detailPublisherFor(wiring: DetailWiring): TrainDetailPublisher | null {
  if (!wiring.valkey || !detailEnabled(wiring.env)) return null;
  const centrifugo = centrifugoFromEnvironment(wiring.env);
  return new TrainDetailPublisher({
    repository: new DetailRepository(wiring.db),
    store: new ValkeyDetailStore(wiring.valkey),
    ...(centrifugo
      ? { push: new CentrifugoClient({ baseUrl: centrifugo.url, apiKey: centrifugo.apiKey }) }
      : {}),
    mode: wiring.mode,
    logger: wiring.logger,
  });
}

/** Pack sets are on unless `LIVE_PACK_SETS` is 0, false, off or no (any case). */
export function packSetsEnabled(env: Record<string, string | undefined>): boolean {
  return !/^(?:0|false|off|no)$/i.test((env.LIVE_PACK_SETS ?? "").trim());
}

/**
 * Starts the next pack set when one is due; it builds off the tick and joins the head when its
 * files are in place. A failed build is logged and not tried again before the next window.
 */
export function startPackSetBuild(
  sets: PackSetPublisher,
  engine: Pick<LiveEngine, "shapesAhead" | "timetableVersion">,
  now: number,
  write: (fields: Record<string, unknown>) => void,
): Promise<void> | null {
  const id = sets.due(now);
  if (id === null) return null;
  return sets
    .build(id, (until) => engine.shapesAhead(until), engine.timetableVersion)
    .then((report) => {
      write({ level: "info", msg: "pack set", ...report });
      if (report.corrupt.length > 0) {
        write({
          level: "warn",
          msg: "pack set: single packs that do not decode",
          shapes: report.corrupt,
        });
      }
    })
    .catch((error: unknown) =>
      write({ level: "error", msg: "pack set failed", id, error: String(error).slice(0, 300) }),
    );
}

/** One engine tick per new clock second, a log line per minute and a prune every five minutes. */
class Ticker {
  readonly #engine: LiveEngine;
  readonly #store: FileStore;
  readonly #keys: KeyStore;
  #lastTick = 0;
  #lastLog = 0;
  #lastPrune = 0;

  readonly #detail: TrainDetailPublisher | null;
  readonly #onVersion: (feedVersionId: number) => void;
  readonly #sets: PackSetPublisher | null;
  #version = 0;

  constructor(
    engine: LiveEngine,
    store: FileStore,
    keys: KeyStore,
    detail: TrainDetailPublisher | null,
    onVersion: (feedVersionId: number) => void = () => {},
    sets: PackSetPublisher | null = null,
  ) {
    this.#engine = engine;
    this.#store = store;
    this.#keys = keys;
    this.#detail = detail;
    this.#onVersion = onVersion;
    this.#sets = sets;
  }

  #buildSets(now: number): void {
    if (this.#sets) startPackSetBuild(this.#sets, this.#engine, now, log);
  }

  async step(now: number): Promise<void> {
    if (now <= this.#lastTick) return;
    this.#lastTick = now;
    try {
      const report = await this.#engine.tick(now);
      this.#buildSets(now);
      if (this.#engine.timetableVersion !== this.#version) {
        this.#version = this.#engine.timetableVersion;
        this.#onVersion(this.#version);
      }
      if (now - this.#lastLog >= 60) this.#logTick(now, report.sequence);
      if (now - this.#lastPrune >= 300) await this.#prune(now);
    } catch (error) {
      log({ level: "error", msg: "tick failed", error: String(error).slice(0, 300) });
    }
  }

  #logTick(now: number, sequence: number): void {
    this.#lastLog = now;
    log({
      level: "info",
      msg: "tick",
      at: new Date(now * 1000).toISOString(),
      sequence,
      trips: this.#engine.currentState.size,
      timetable: {
        version: this.#engine.timetableVersion,
        publishedOn: this.#engine.activeVersionPublishedOn,
        switches: this.#engine.counters.versionSwitches,
        refusals: this.#engine.counters.versionRefusals,
      },
      rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
      ...(this.#keys instanceof ValkeyKeyStore
        ? { lastKey: this.#keys.lastKey, keysAheadOfClock: this.#keys.aheadOfClock }
        : {}),
      durations: durationSummary().filter((d) => d.name !== "compress"),
      ...(this.#detail ? { detail: this.#detailSummary() } : {}),
    });
  }

  #detailSummary(): Record<string, unknown> {
    const report = this.#detail?.lastReport;
    return {
      dispatcher: this.#engine.detailStats,
      ...(report
        ? {
            lastAt: new Date(report.at).toISOString(),
            changed: report.changed,
            written: report.written,
            pushed: report.pushed,
            failures: report.failures,
            errors: report.errors.length,
          }
        : {}),
    };
  }

  async #prune(now: number): Promise<void> {
    this.#lastPrune = now;
    if (await this.#store.read("head")) await this.#store.prune(this.#engine.latestSequence - 3600);
  }
}

/** A Valkey client the detail writer duplicates for a connection of its own. */
export interface DuplicableValkey {
  duplicate(): ValkeyWriter & {
    readonly status: string;
    connect(): Promise<unknown>;
    quit(): Promise<unknown>;
  };
}

export interface DetailResources {
  readonly publisher: TrainDetailPublisher;
  close(): Promise<void>;
}

/**
 * The detail writer with a Valkey connection and a database pool of its own, so a burst of details
 * (thousands of trains at a start, seven queries per load) never queues the tick's key commands or
 * realtime reads behind it. None without Valkey or when LIVE_DETAIL switches it off.
 */
export async function openDetail(input: {
  readonly valkey: DuplicableValkey | null;
  readonly openDatabase: () => Kysely<DB>;
  readonly mode: ReadMode;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
}): Promise<DetailResources | null> {
  if (!input.valkey || !detailEnabled(input.env)) return null;
  centrifugoFromEnvironment(input.env);
  const connection = input.valkey.duplicate();
  if (connection.status === "wait") await connection.connect();
  const db = input.openDatabase();
  const publisher = detailPublisherFor({ ...input, db, valkey: connection });
  if (!publisher) throw new Error("detail writer not built");
  return {
    publisher,
    close: async () => {
      await db.destroy();
      await connection.quit();
    },
  };
}

/** Longest wait at shutdown for the detail update in flight. */
const DETAIL_DRAIN_MS = 5_000;

async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ]);
  clearTimeout(timer);
}

/** Trips per category with a product name, logged for each timetable version run. */
async function logProductCoverage(db: Kysely<DB>, feedVersionId: number): Promise<void> {
  if (feedVersionId <= 0) return;
  try {
    log({
      level: "info",
      msg: "product coverage",
      feedVersionId,
      coverage: await productCoverage(db, feedVersionId),
    });
  } catch (error) {
    log({ level: "warn", msg: "product coverage unread", error: String(error).slice(0, 300) });
  }
}

export interface PackWait {
  readonly log: (fields: Record<string, unknown>) => void;
  readonly stopped: () => boolean;
  /** Between two looks (ms). */
  readonly everyMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Milliseconds clock for the once-a-minute log. */
  readonly now?: () => number;
  /** The timetable version whose packs must be marked complete (any version when unset). */
  readonly timetableVersion?: number;
}

/**
 * Waits until the packs of the current shape epoch are under the output directory (frames
 * naming packs that do not exist cannot be drawn), logging once a minute what to build, instead of
 * exiting into a restart loop. False when the process was asked to stop first.
 */
export async function waitForPacks(
  store: FileStore,
  epoch: number,
  wait: PackWait,
): Promise<boolean> {
  const everyMs = wait.everyMs ?? 5_000;
  const sleep = wait.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = wait.now ?? Date.now;
  const started = now();
  let loggedAt = Number.NEGATIVE_INFINITY;
  while (!(await store.hasPacks(epoch, wait.timetableVersion))) {
    if (wait.stopped()) return false;
    if (now() - loggedAt >= 60_000) {
      loggedAt = now();
      wait.log({
        msg: "waiting for packs",
        epoch,
        waitedS: Math.round((loggedAt - started) / 1000),
        missing: `${store.root}/s/${epoch}/${PACKS_COMPLETE}`,
        timetableVersion: wait.timetableVersion ?? null,
        build: `node src/cli.ts packs build --out ${store.root} --timetable-version ${wait.timetableVersion ?? "<id>"}`,
      });
    }
    await sleep(everyMs);
  }
  return true;
}

/**
 * `waitForPacks` with the waiting app on the server's address meanwhile. A failure to
 * listen (the address in use) is logged, not thrown: the wait goes on and the real server reports it.
 */
export async function waitServing(
  store: FileStore,
  epoch: number,
  options: Pick<RunOptions, "host" | "port">,
  wait: PackWait,
): Promise<boolean> {
  if (await store.hasPacks(epoch, wait.timetableVersion)) return true;
  const waiting = serve({
    fetch: createWaitingApp(epoch).fetch,
    hostname: options.host,
    port: options.port,
  });
  waiting.on("error", (error) =>
    wait.log({ msg: "waiting server failed", error: String(error).slice(0, 200) }),
  );
  try {
    return await waitForPacks(store, epoch, wait);
  } finally {
    await new Promise((resolve) => waiting.close(() => resolve(undefined)));
  }
}

async function closeBeforeStart(
  db: Kysely<DB>,
  shapesDb: Kysely<DB> | null,
  valkey: Valkey | null,
): Promise<number> {
  await db.destroy();
  await shapesDb?.destroy();
  if (valkey) await valkey.quit();
  return 0;
}

/** The version whose packs `live run` waits for: the pinned one, else the newest loaded. */
async function servedVersion(
  db: Kysely<DB>,
  pinned: number | undefined,
): Promise<number | undefined> {
  if (pinned !== undefined) return pinned;
  return (await new DatabaseTimetable(db).versions()).at(-1)?.feedVersionId;
}

function pinnedOption(pinned: number | undefined): { pinnedVersion?: number } {
  return pinned === undefined ? {} : { pinnedVersion: pinned };
}

/** `live run`: one tick per second, objects then head, a push notice, and the HTTP server. */
export async function runLive(options: RunOptions): Promise<number> {
  const db = options.openDatabase();
  const shapesDb = options.openShapesDatabase?.() ?? null;
  if (shapesDb) await checkShapesDatabase(db, shapesDb);
  const clock = parseClock(options.clock);
  const store = new FileStore(options.out);
  const valkey = await connectValkey(options.memoryKeys === true);
  const shapeEpoch = await currentShapeEpoch(db);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const newest = await servedVersion(db, options.pinnedVersion);
  const ready = await waitServing(store, shapeEpoch, options, {
    log: (fields) => log({ level: "warn", ...fields }),
    stopped: () => stopping,
    ...(newest === undefined ? {} : { timetableVersion: newest }),
  });
  if (!ready) return closeBeforeStart(db, shapesDb, valkey);
  const restored = await restoreChain(store, shapeEpoch);
  const floor = restored.kind === "none" ? restored.floor : restored.chain.sequence;
  const start = clock.now();
  const keys: KeyStore = valkey
    ? new ValkeyKeyStore(valkey, newChainStart(start, 0), () => newChainStart(clock.now(), 0))
    : new MemoryKeyStore(newChainStart(start, 0));
  const notifier = notifierFromEnvironment();
  const detailResources = await openDetail({
    valkey,
    openDatabase: options.openDetailDatabase ?? options.openDatabase,
    mode: detailReadMode(options.clock),
    env: process.env,
    logger: {
      info: (msg) => log({ level: "info", msg }),
      error: (msg) => log({ level: "error", msg }),
    },
  });
  const detail = detailResources?.publisher ?? null;
  const listener = new RebuildListener({
    connectionString: options.databaseUrl,
    log: (fields) => log({ level: "warn", ...fields }),
  });
  await listener.start();
  let http: HttpThread | undefined;
  const setRunner = packSetsEnabled(process.env) ? new WorkerRunner() : null;
  const sets = setRunner
    ? new PackSetPublisher(options.out, shapeEpoch, { runner: setRunner.run })
    : null;
  const engine = new LiveEngine({
    timetable: new DatabaseTimetable(db, shapesDb ?? db),
    reader: startupThenFollow(db, Date.now() / 1000, listener, (fields) =>
      log({ level: "warn", ...fields }),
    ),
    keys,
    sink: {
      object: (kind, sequence, bytes) => store.object(kind, sequence, bytes),
      head: async (bytes, head) => {
        await store.head(bytes, head);
        http?.postHead(bytes);
        await notifier?.notify(head);
      },
    },
    shapeEpoch,
    firstSequence: newChainStart(start, floor),
    onVersionDecision: (decision) => log({ level: "info", msg: "timetable decision", ...decision }),
    vehicles: new VehicleIdentities(new DatabaseFleetSource(db), {
      onError: (error) =>
        log({ level: "warn", msg: "vehicle read failed", error: String(error).slice(0, 300) }),
    }),
    packsReady: (version) => store.hasPacks(shapeEpoch, version),
    ...(sets ? { packSets: () => sets.current() } : {}),
    ...pinnedOption(options.pinnedVersion),
    ...(detail
      ? {
          detail,
          onDetailError: (error: unknown) =>
            log({
              level: "error",
              msg: "detail publish failed",
              error: String(error).slice(0, 300),
            }),
        }
      : {}),
  });
  if (restored.kind === "chain") await engine.restore(restored.chain);
  log({
    level: "info",
    msg: "live starting",
    restored: restored.kind,
    sequenceFloor: floor,
    detail: detail
      ? { mode: detailReadMode(options.clock), push: detail.pushes }
      : "off (no VALKEY_URL or LIVE_DETAIL=0)",
    playback: playbackState(playbackDirectory(process.env)),
  });
  const ticker = new Ticker(
    engine,
    store,
    keys,
    detail,
    (version) => {
      if (detail) void logProductCoverage(db, version);
    },
    sets,
  );
  return serveAndTick({
    start: async () => {
      http = await startHttpThread({
        root: options.out,
        host: options.host,
        port: options.port,
        playback: playbackDirectory(process.env),
      });
      return http;
    },
    step: () => ticker.step(clock.now()),
    stopped: () => stopping,
    stop,
    close: async () => {
      await settleWithin(engine.detailIdle(), DETAIL_DRAIN_MS);
      await setRunner?.close();
      await listener.close();
      await db.destroy();
      await shapesDb?.destroy();
      if (valkey) await valkey.quit();
      await detailResources?.close();
    },
    log,
  });
}

export interface ServeAndTick {
  readonly start: () => Promise<HttpThread>;
  readonly step: () => Promise<void>;
  readonly stopped: () => boolean;
  readonly stop: () => void;
  /** Closes what the engine holds (listener, pools, Valkey), also when the server never started. */
  readonly close: () => Promise<void>;
  readonly log: (fields: Record<string, unknown>) => void;
  readonly pauseMs?: number;
}

/**
 * Starts the HTTP thread, then steps the engine every `pauseMs` with a heartbeat to the thread after
 * each step until stopped. The thread is closed before the engine's resources, and those are closed
 * however it ends: a server that does not start rejects with nothing left open, so the process
 * exits non-zero and its supervisor starts it again. A thread that ends on its own stops
 * the loop with exit code 1.
 */
export async function serveAndTick(input: ServeAndTick): Promise<number> {
  let http: HttpThread | undefined;
  let exitCode = 0;
  try {
    http = await input.start();
    http.onExit((error) => {
      input.log({ level: "error", msg: "http server stopped", error: String(error).slice(0, 300) });
      exitCode = 1;
      input.stop();
    });
    while (!input.stopped()) {
      await input.step();
      http.beat();
      await new Promise((resolve) => setTimeout(resolve, input.pauseMs ?? 200));
    }
  } finally {
    await http?.close();
    await input.close();
  }
  return exitCode;
}
