import { writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { parseArgs } from "node:util";
import { createDatabase, type DB, redactDatabaseUrl } from "@gerlines/db";
import { servedProgress, TrainDetail, type TrainProgress } from "@gerlines/schema";
import Valkey from "iovalkey";
import type { Kysely } from "kysely";
import { LiveEngine } from "../engine/engine.ts";
import { MemoryKeyStore } from "../engine/keys.ts";
import { newChainStart } from "../publish/restore.ts";
import { HistoryReader } from "../realtime/readers.ts";
import { detailPublisherFor, detailReadMode } from "../run.ts";
import { currentShapeEpoch } from "../shapes/packs.ts";
import { DatabaseTimetable } from "../timetable/loader.ts";
import { DETAIL_CONFIRMED_KEY, DETAIL_TTL_S, trainDetailKey, trainLeftKey } from "./keys.ts";
import type { DetailPort, LiveInstanceState, LiveTickUpdate } from "./port.ts";
import type { TrainDetailPublisher } from "./publisher.ts";

const usage = `Usage: node src/detail/wired.ts --from <iso> --to <iso> --report <file> [options]

The live engine over a recorded window on a virtual clock with TrainDetailPublisher as its detail
port, writing to VALKEY_URL (flushed first: use a database index of its own) and pushing to
CENTRIFUGO_URL. Once a virtual minute it reads back every detail the way the API serves it.

  --cadence <s>        seconds between ticks (1)
  --settle             wait for the detail queue after each tick (default: only at samples)
  --pace-ms <ms>       keep at least this much wall time per tick (0)
  --centrifugo-hang    push to a local server that accepts and never answers
  --switch-coverage <share>  shape coverage a timetable version needs to go live (0.95)
  --shared-pool        the detail writer reads through the engine's 4-connection pool (the earlier
                       wiring) instead of a 2-connection pool of its own

The detail writer is wired as \`live run\` wires it (detailPublisherFor, history reads on a replay clock).
`;

const HISTORY_LOOKBACK_S = 6 * 3600;
const GENERIC_NAMES = new Set([
  "Bahnhof",
  "Bf",
  "Hbf",
  "Hauptbahnhof",
  "Ostbahnhof",
  "Westbahnhof",
  "Südbahnhof",
  "Nordbahnhof",
  "ZOB",
]);

interface Seen {
  state: LiveInstanceState;
  left: boolean;
  lastPassed: number;
  atStation: number;
  /** The furthest stop the engine reported passed (−1: none), and its earlier report of it. */
  engineMax: number;
}

const checks = {
  samples: 0,
  readsRunning: 0,
  missingRunning: 0,
  missingLeft: 0,
  /** Trains that left more than 15 min after their run's end: no detail by design. */
  leftLongAfterEnd: 0,
  progressBackwards: 0,
  engineBackwards: 0,
  progressDisagreesWithEngine: 0,
  atStation: 0,
  trainsSeenAtStation: 0,
  timetableOnlyReads: 0,
  left: 0,
  leftArrived: 0,
  leftNotArrived: [] as string[],
  leftWithoutMarker: 0,
  servedPastLeft: 0,
  maxConfirmGapS: 0,
  confirmGapsOver30S: 0,
  examples: [] as string[],
};

function example(kind: string, entry: Seen, view: View): void {
  if (checks.examples.filter((line) => line.startsWith(kind)).length >= 6) return;
  const stops = view.detail.stops
    .filter((stop) => Math.abs(stop.index - (view.progress.lastPassedIndex ?? 0)) <= 1)
    .map(
      (stop) =>
        `${stop.index} a=${stop.predictedArrival ?? stop.scheduledArrival} d=${stop.predictedDeparture ?? stop.scheduledDeparture}`,
    );
  checks.examples.push(
    `${kind} ${view.detail.tripInstanceId} asOf=${new Date(view.asOf).toISOString()} served=${view.progress.lastPassedIndex}:${view.progress.nextIndex} engine=${entry.state.lastPassedIndex}:${entry.state.nextIndex}@${new Date(entry.state.at * 1000).toISOString()} seen=${entry.lastPassed} engineMax=${entry.engineMax} ${stops.join(" | ")}`,
  );
}

function quantile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0);
}

function summary(values: readonly number[]) {
  return {
    n: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: Math.round(Math.max(0, ...values)),
  };
}

function hangingServer(): Promise<{ server: Server; url: string; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, sockets });
    });
  });
}

interface View {
  readonly detail: TrainDetail;
  readonly asOf: number;
  readonly progress: TrainProgress;
}

/** The detail as the API serves it (apps/api compose): asOf moved to the tick, capped where it left. */
function served(raw: string, confirmed: string | null, left: string | null): View {
  const detail = TrainDetail.parse(JSON.parse(raw));
  let asOf = Date.parse(detail.asOf);
  if (confirmed !== null) asOf = Math.max(asOf, Date.parse(confirmed));
  if (left !== null) asOf = Math.min(asOf, Date.parse(left));
  return { detail, asOf, progress: servedProgress(detail.progress, detail.stops, asOf) };
}

function lastServedIndex(detail: TrainDetail): number | null {
  const served = detail.stops.filter((stop) => !stop.cancelled);
  return served[served.length - 1]?.index ?? null;
}

/** True when the card would draw the train standing at its last passed stop. */
function standing(view: View): boolean {
  const { lastPassedIndex, nextIndex } = view.progress;
  if (lastPassedIndex === null || nextIndex === null) return false;
  const stop = view.detail.stops.find((entry) => entry.index === lastPassedIndex);
  const departure = stop?.predictedDeparture ?? stop?.scheduledDeparture ?? null;
  return departure !== null && view.asOf < Date.parse(departure);
}

/** The engine's progress on the listed (passenger) stops, as the detail builder maps it. */
function engineOnListed(
  state: LiveInstanceState,
  detail: TrainDetail,
): [number | null, number | null] {
  const listed = detail.stops.map((stop) => stop.index);
  const passed = state.lastPassedIndex;
  const next = state.nextIndex;
  return [
    passed === null ? null : (listed.filter((index) => index <= passed).pop() ?? null),
    next === null ? null : (listed.find((index) => index >= next) ?? null),
  ];
}

function checkRunning(entry: Seen, view: View, now: number): void {
  checks.readsRunning += 1;
  if (entry.state.source === null) checks.timetableOnlyReads += 1;
  const passed = view.progress.lastPassedIndex ?? -1;
  if (passed < entry.lastPassed) {
    checks.progressBackwards += 1;
    example("backwards", entry, view);
  }
  entry.lastPassed = Math.max(entry.lastPassed, passed);
  const sameTime = view.asOf === now * 1000;
  const [enginePassed, engineNext] = engineOnListed(entry.state, view.detail);
  const differs =
    enginePassed !== view.progress.lastPassedIndex || engineNext !== view.progress.nextIndex;
  if (sameTime && differs) {
    checks.progressDisagreesWithEngine += 1;
    example("disagrees", entry, view);
  }
  if (!standing(view)) return;
  checks.atStation += 1;
  if (entry.atStation === 0) checks.trainsSeenAtStation += 1;
  entry.atStation += 1;
}

async function sample(valkey: Valkey, seen: Map<string, Seen>, now: number): Promise<void> {
  checks.samples += 1;
  const confirmed = await valkey.get(DETAIL_CONFIRMED_KEY);
  for (const [id, entry] of seen) {
    const [raw, left] = (await valkey.mget(trainDetailKey(id), trainLeftKey(id))) as [
      string | null,
      string | null,
    ];
    if (raw === null) {
      if (!entry.left) checks.missingRunning += 1;
      else if (entry.state.endsAt + DETAIL_TTL_S <= entry.state.at) checks.leftLongAfterEnd += 1;
      else checks.missingLeft += 1;
    } else if (!entry.left) {
      checkRunning(entry, served(raw, confirmed, left), now);
    } else if (left === null) {
      checks.leftWithoutMarker += 1;
    } else if (served(raw, confirmed, left).asOf > Date.parse(left)) {
      checks.servedPastLeft += 1;
    }
  }
}

class Tally {
  stored = 0;
  bytes = 0;
  genericNames = 0;
  readonly byCategory: Record<string, { trains: number; withoutProduct: number }> = {};
  readonly withoutProduct = new Map<string, number>();
  readonly generic = new Map<string, number>();

  add(raw: string, detail: TrainDetail): void {
    this.stored += 1;
    this.bytes += Buffer.byteLength(raw);
    const category = this.byCategory[detail.category] ?? { trains: 0, withoutProduct: 0 };
    this.byCategory[detail.category] = category;
    category.trains += 1;
    if (detail.productName === null) {
      category.withoutProduct += 1;
      bump(this.withoutProduct, `${detail.category} ${detail.line ?? "no line"}`);
    }
    for (const stop of detail.stops) {
      if (!GENERIC_NAMES.has(stop.name)) continue;
      this.genericNames += 1;
      bump(this.generic, stop.name);
    }
  }
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function checkArrived(id: string, entry: Seen, view: View): void {
  checks.left += 1;
  const last = lastServedIndex(view.detail);
  if (view.progress.nextIndex === null && view.progress.lastPassedIndex === last) {
    checks.leftArrived += 1;
  } else if (checks.leftNotArrived.length < 20) {
    checks.leftNotArrived.push(
      `${id} ${view.detail.category} ${view.detail.line ?? ""} cancelled=${entry.state.cancelled} progress=${view.progress.lastPassedIndex}:${view.progress.nextIndex} last=${last}`,
    );
  }
}

async function finalChecks(valkey: Valkey, seen: Map<string, Seen>) {
  const confirmed = await valkey.get(DETAIL_CONFIRMED_KEY);
  const tally = new Tally();
  for (const [id, entry] of seen) {
    const [raw, left] = (await valkey.mget(trainDetailKey(id), trainLeftKey(id))) as [
      string | null,
      string | null,
    ];
    if (raw === null) continue;
    const view = served(raw, confirmed, left);
    tally.add(raw, view.detail);
    if (entry.left) checkArrived(id, entry, view);
  }
  const used = /used_memory:(\d+)/.exec(await valkey.info("memory"))?.[1];
  return {
    stored: tally.stored,
    detailBytes: tally.bytes,
    bytesPerDetail: tally.stored > 0 ? Math.round(tally.bytes / tally.stored) : 0,
    valkeyUsedMemory: used === undefined ? null : Number(used),
    byCategory: tally.byCategory,
    withoutProduct: Object.fromEntries([...tally.withoutProduct].sort((a, b) => b[1] - a[1])),
    genericNames: tally.genericNames,
    generic: Object.fromEntries(tally.generic),
  };
}

/** Wraps the publisher: records each publish and the newest state per instance. */
class RecordingPort implements DetailPort {
  readonly seen = new Map<string, Seen>();
  readonly publishMs: number[] = [];
  readonly changedPerPublish: number[] = [];
  readonly failures: Record<string, number> = {};
  written = 0;
  pushed = 0;
  pushErrors = 0;
  storeErrors: string[] = [];
  lastConfirm: number;
  heartbeats = 0;
  /** A publish is running: ticks taken meanwhile show what a detail burst costs the tick. */
  inFlight = false;
  private readonly publisher: TrainDetailPublisher;

  constructor(publisher: TrainDetailPublisher, from: number) {
    this.publisher = publisher;
    this.lastConfirm = from;
  }

  async publish(update: LiveTickUpdate): Promise<void> {
    if (update.changed.length === 0 && update.removed.length === 0) this.heartbeats += 1;
    const began = performance.now();
    this.inFlight = true;
    try {
      await this.publisher.publish(update);
    } finally {
      this.inFlight = false;
      this.publishMs.push(performance.now() - began);
      this.changedPerPublish.push(update.changed.length + update.removed.length);
      this.note(this.publisher.lastReport, update.at);
      for (const state of update.changed) this.remember(state, false);
      for (const state of update.removed) this.remember(state, true);
    }
  }

  private note(report: TrainDetailPublisher["lastReport"], at: number): void {
    if (!report) return;
    this.written += report.written;
    this.pushed += report.pushed;
    for (const [reason, n] of Object.entries(report.failures)) {
      this.failures[reason] = (this.failures[reason] ?? 0) + (n ?? 0);
    }
    const store = report.errors.filter((line) => !line.startsWith("push:"));
    this.pushErrors += report.errors.length - store.length;
    if (store.length > 0) {
      if (this.storeErrors.length < 5) this.storeErrors.push(...store);
      return;
    }
    checks.maxConfirmGapS = Math.max(checks.maxConfirmGapS, at - this.lastConfirm);
    if (at - this.lastConfirm > 30) checks.confirmGapsOver30S += 1;
    this.lastConfirm = at;
  }

  private remember(state: LiveInstanceState, left: boolean): void {
    const entry = this.seen.get(state.tripInstanceId);
    const passed = state.lastPassedIndex ?? -1;
    if (entry) {
      if (passed < entry.engineMax) checks.engineBackwards += 1;
      entry.engineMax = Math.max(entry.engineMax, passed);
      entry.state = state;
      entry.left = left;
    } else {
      this.seen.set(state.tripInstanceId, {
        state,
        left,
        lastPassed: -1,
        atStation: 0,
        engineMax: passed,
      });
    }
  }
}

interface Run {
  readonly from: number;
  readonly to: number;
  readonly cadence: number;
  readonly settle: boolean;
  readonly paceMs: number;
  readonly switchCoverage: number;
  readonly sharedPool: boolean;
}

async function drive(engine: LiveEngine, valkey: Valkey, port: RecordingPort, run: Run) {
  const tickMs: number[] = [];
  const duringPublish: number[] = [];
  for (let now = run.from; now <= run.to; now += run.cadence) {
    const wallStart = performance.now();
    const busy = port.inFlight;
    await engine.tick(now);
    tickMs.push(performance.now() - wallStart);
    if (now > run.from && (busy || port.inFlight))
      duringPublish.push(performance.now() - wallStart);
    if (run.settle) await engine.detailIdle();
    if (now > run.from && (now - run.from) % 60 === 0) {
      await engine.detailIdle();
      await sample(valkey, port.seen, now);
    }
    const rest = run.paceMs - (performance.now() - wallStart);
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
  }
  await engine.detailIdle();
  checks.maxConfirmGapS = Math.max(checks.maxConfirmGapS, run.to - port.lastConfirm);
  return { tickMs, duringPublish };
}

interface Invocation extends Run {
  readonly report: string;
  readonly hang: boolean;
}

function invocation(argv: string[]): Invocation | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      report: { type: "string" },
      cadence: { type: "string", default: "1" },
      settle: { type: "boolean", default: false },
      "pace-ms": { type: "string", default: "0" },
      "centrifugo-hang": { type: "boolean", default: false },
      "switch-coverage": { type: "string", default: "0.95" },
      "shared-pool": { type: "boolean", default: false },
    },
  });
  if (!values.from || !values.to || !values.report) return null;
  return {
    from: Math.floor(Date.parse(values.from) / 1000),
    to: Math.floor(Date.parse(values.to) / 1000),
    cadence: Number(values.cadence),
    settle: values.settle,
    paceMs: Number(values["pace-ms"]),
    switchCoverage: Number(values["switch-coverage"]),
    sharedPool: values["shared-pool"],
    report: values.report,
    hang: values["centrifugo-hang"],
  };
}

/** The detail writer's pool: its own 2 connections, as `live run` opens it, or the engine's. */
function detailDatabase(run: Run, databaseUrl: string, engineDb: Kysely<DB>): Kysely<DB> {
  if (run.sharedPool) return engineDb;
  return createDatabase({
    databaseUrl,
    applicationName: "gerlines-live-wired-detail",
    maxConnections: 2,
  });
}

async function main(argv: string[]): Promise<number> {
  const run = invocation(argv);
  if (run === null) {
    process.stdout.write(usage);
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const valkeyUrl = process.env.VALKEY_URL?.trim();
  if (!databaseUrl || !valkeyUrl) throw new Error("DATABASE_URL and VALKEY_URL must be set");
  const hang = run.hang ? await hangingServer() : null;
  const env = hang
    ? { CENTRIFUGO_URL: hang.url, CENTRIFUGO_HTTP_API_KEY: "hanging", LIVE_LOCAL_STACK: "1" }
    : { ...process.env, LIVE_LOCAL_STACK: "1", LIVE_DETAIL: "1" };
  const db = createDatabase({
    databaseUrl,
    applicationName: "gerlines-live-wired",
    maxConnections: 4,
  });
  const detailDb = detailDatabase(run, databaseUrl, db);
  const valkey = new Valkey(valkeyUrl);
  try {
    await valkey.flushdb();
    const publisher = detailPublisherFor({
      db: detailDb,
      valkey,
      mode: detailReadMode(`replay:${new Date(run.from * 1000).toISOString()}:1`),
      env,
      logger: { info: () => undefined, error: () => undefined },
    });
    if (!publisher) throw new Error("no detail publisher");
    const port = new RecordingPort(publisher, run.from);
    const detailErrors: string[] = [];
    const engine = new LiveEngine({
      timetable: new DatabaseTimetable(db),
      reader: new HistoryReader(db, run.from - HISTORY_LOOKBACK_S),
      keys: new MemoryKeyStore(newChainStart(run.from, 0)),
      sink: { object: async () => undefined, head: async () => undefined },
      shapeEpoch: await currentShapeEpoch(db),
      firstSequence: newChainStart(run.from, 0),
      detail: port,
      onDetailError: (error) => void detailErrors.push(String(error)),
      switchCoverage: run.switchCoverage,
    });
    const started = performance.now();
    const { tickMs, duringPublish } = await drive(engine, valkey, port, run);
    const final = await finalChecks(valkey, port.seen);
    const states = [...port.seen.values()].map((entry) => entry.state);
    const report = {
      database: redactDatabaseUrl(databaseUrl),
      ...run,
      from: new Date(run.from * 1000).toISOString(),
      to: new Date(run.to * 1000).toISOString(),
      centrifugo: hang ? "hanging local server" : publisher.pushes ? "up" : "none",
      wallSeconds: Math.round((performance.now() - started) / 100) / 10,
      firstTickMs: Math.round(tickMs[0] ?? 0),
      tickMs: summary(tickMs.slice(1)),
      tickMsDuringPublish: summary(duringPublish),
      detailPool: run.sharedPool ? "shared with the engine (4)" : "own (2)",
      activeTimetableVersion: engine.timetableVersion,
      publishMs: summary(port.publishMs),
      changedPerPublish: summary(port.changedPerPublish),
      dispatcher: engine.detailStats,
      heartbeats: port.heartbeats,
      written: port.written,
      pushed: port.pushed,
      pushErrors: port.pushErrors,
      storeErrors: port.storeErrors,
      failures: port.failures,
      detailErrors: detailErrors.slice(0, 5),
      instancesSeen: port.seen.size,
      timetableOnly: states.filter((state) => state.source === null).length,
      drawn: states.filter((state) => state.key !== null).length,
      cancelled: states.filter((state) => state.cancelled).length,
      checks,
      final,
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    };
    await writeFile(run.report, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ ...report, final: { ...final, withoutProduct: undefined } }, null, 2)}\n`,
    );
    return 0;
  } finally {
    await db.destroy();
    await (detailDb === db ? undefined : detailDb.destroy());
    valkey.disconnect();
    for (const socket of hang?.sockets ?? []) socket.destroy();
    hang?.server.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
