import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import type { DB } from "@gerlines/db";
import { type Kysely, sql } from "kysely";
import type { DetailPort, LiveInstanceState, LiveTickUpdate } from "./engine/detail-port.ts";
import {
  type EngineCounters,
  type EngineSizes,
  LiveEngine,
  type TickReport,
} from "./engine/engine.ts";
import { MemoryKeyStore } from "./engine/keys.ts";
import { durationSummary, recordDuration } from "./metrics.ts";
import { newChainStart, restoreChain } from "./publish/restore.ts";
import { FileStore } from "./publish/storage.ts";
import { snapshotThenHistory } from "./realtime/readers.ts";
import { currentShapeEpoch } from "./shapes/packs.ts";
import { AvailableFrom } from "./timetable/available.ts";
import { DatabaseTimetable, type TimetableSource } from "./timetable/loader.ts";
import { DatabaseFleetSource } from "./vehicle/database.ts";
import { VehicleIdentities } from "./vehicle/identities.ts";

export interface RenderOptions {
  readonly db: Kysely<DB>;
  /** Where pattern shapes are read (default `db`). */
  readonly shapesDb?: Kysely<DB>;
  /** Unix seconds. */
  readonly from: number;
  readonly to: number;
  /** Seconds between ticks (1 live; 3 for a fast render). */
  readonly cadence: number;
  readonly out: string;
  readonly holdRule: boolean;
  /** Unix seconds at which the engine is dropped and rebuilt from storage (restart path). */
  readonly restartAt?: number;
  readonly progress?: (line: string) => void;
  /**
   * Unix seconds at which the live heap is sampled (after a full GC) and written to `profileDir` as
   * a `.heapprofile` (V8 sampling heap profiler: live bytes by allocation site).
   */
  readonly heapProfileAt?: readonly number[];
  readonly profileDir?: string;
  /** Attach a detail port that counts progress reported lower than before for an instance. */
  readonly detailCheck?: boolean;
  /** Feed version id to unix seconds: the version stays hidden from the engine before then. */
  readonly versionAvailable?: ReadonlyMap<number, number>;
  /** The instant of a version `versionAvailable` does not name (Infinity hides versions loaded later). */
  readonly unlistedVersionAvailable?: number;
  /** A packs directory: the engine takes no version whose packs it does not mark complete. */
  readonly packs?: string;
  /** Minimum seconds between deltas and between keyframes (the engine's 2 and 30 when unset). */
  readonly deltaInterval?: number;
  readonly keyframeInterval?: number;
}

/** What the engine's detail feed reported over a render. */
export interface DetailCheckReport {
  readonly updates: number;
  readonly states: number;
  readonly instances: number;
  /**
   * States whose last passed stop is lower than one reported before for the same instance while a
   * served stop at or below that one still lies ahead (`nextIndex` at or below it), or that name no
   * stop at all after one was reported (the trip not cancelled): a step back.
   */
  readonly backwards: number;
  readonly examples: readonly string[];
  /**
   * Lower states whose next served stop lies beyond the furthest one reported (or none is left):
   * candidates for a give-way to the served stop before stops the source cancels (the
   * detail port's contract). Each is checked against the source data (`verify`).
   */
  readonly givenWay: number;
  readonly givenWayExamples: readonly string[];
  /** Give-ways whose stops after the reported one up to the furthest are all cancelled or passed through. */
  readonly givenWayVerified: number;
  /** Give-ways not (yet) verified: not checked, or a stop in between still served. */
  readonly givenWayUnverified: number;
  readonly unverifiedExamples: readonly string[];
  /** The gate: no step back and every give-way verified. */
  readonly passed: boolean;
}

/** A state lower than the furthest one of its instance whose next stop lies beyond that one. */
export interface GiveWay {
  readonly tripInstanceId: string;
  readonly feedVersionId: number;
  readonly tripKey: string | null;
  readonly sourceId: string | null;
  /** The reported last passed stop and the furthest reported before. */
  readonly passed: number;
  readonly furthest: number;
  readonly at: number;
  readonly line: string;
}

export interface GiveWayStop {
  readonly stopIndex: number;
  readonly cancelled: boolean;
  readonly passThrough: boolean;
}

/** Whether every static stop in (passed, furthest] is known and cancelled or passed through. */
export function giveWayHolds(
  stops: readonly GiveWayStop[],
  passed: number,
  furthest: number,
): boolean {
  for (let index = passed + 1; index <= furthest; index++) {
    const stop = stops.find((candidate) => candidate.stopIndex === index);
    if (!stop || !(stop.cancelled || stop.passThrough)) return false;
  }
  return true;
}

const MAX_EXAMPLES = 20;
const MAX_GIVE_WAYS = 100_000;

/**
 * A detail port that keeps the furthest last passed stop per instance and counts steps back,
 * keeping give-way candidates apart for a check against the source data.
 */
export class ProgressCheck implements DetailPort {
  updates = 0;
  states = 0;
  backwards = 0;
  givenWay = 0;
  givenWayVerified = 0;
  readonly examples: string[] = [];
  readonly givenWayExamples: string[] = [];
  readonly unverifiedExamples: string[] = [];
  readonly #giveWays: GiveWay[] = [];
  readonly #furthest = new Map<string, number>();

  async publish(update: LiveTickUpdate): Promise<void> {
    this.updates++;
    for (const state of [...update.changed, ...update.removed]) {
      this.states++;
      const passed = state.lastPassedIndex ?? -1;
      const furthest = this.#furthest.get(state.tripInstanceId);
      if (furthest !== undefined && passed < furthest) this.#lower(state, furthest);
      this.#furthest.set(state.tripInstanceId, Math.max(furthest ?? -1, passed));
    }
  }

  #lower(state: LiveInstanceState, furthest: number): void {
    const line = `${state.tripInstanceId} at ${new Date(state.at * 1000).toISOString()} reported ${state.lastPassedIndex}:${state.nextIndex} after ${furthest} (cancelled ${state.cancelled}, drawn ${state.key !== null})`;
    const lost = state.lastPassedIndex === null && furthest >= 0 && !state.cancelled;
    const gaveWay = !lost && (state.nextIndex === null || state.nextIndex > furthest);
    if (!gaveWay) {
      this.backwards++;
      if (this.examples.length < MAX_EXAMPLES) this.examples.push(line);
      return;
    }
    this.givenWay++;
    if (this.givenWayExamples.length < MAX_EXAMPLES) this.givenWayExamples.push(line);
    if (this.#giveWays.length < MAX_GIVE_WAYS) {
      this.#giveWays.push({
        tripInstanceId: state.tripInstanceId,
        feedVersionId: state.feedVersionId,
        tripKey: state.tripKey,
        sourceId: state.source?.sourceId ?? null,
        passed: state.lastPassedIndex ?? -1,
        furthest,
        at: state.at,
        line,
      });
    }
  }

  /** Checks every give-way kept (at most MAX_GIVE_WAYS; the rest stay unverified). */
  async verify(holds: (giveWay: GiveWay) => Promise<boolean>): Promise<void> {
    this.givenWayVerified = 0;
    this.unverifiedExamples.length = 0;
    for (const giveWay of this.#giveWays) {
      if (await holds(giveWay)) this.givenWayVerified++;
      else if (this.unverifiedExamples.length < MAX_EXAMPLES)
        this.unverifiedExamples.push(giveWay.line);
    }
  }

  report(): DetailCheckReport {
    const givenWayUnverified = this.givenWay - this.givenWayVerified;
    return {
      updates: this.updates,
      states: this.states,
      instances: this.#furthest.size,
      backwards: this.backwards,
      examples: this.examples,
      givenWay: this.givenWay,
      givenWayExamples: this.givenWayExamples,
      givenWayVerified: this.givenWayVerified,
      givenWayUnverified,
      unverifiedExamples: this.unverifiedExamples,
      passed: this.backwards + givenWayUnverified === 0,
    };
  }
}

/**
 * Checks a give-way against the database: the instance's source as of the state's time cancels
 * every stop after the reported one up to the furthest, or the timetable passes through it.
 */
export function giveWayFromDatabase(db: Kysely<DB>) {
  return async (giveWay: GiveWay): Promise<boolean> => {
    if (giveWay.sourceId === null || giveWay.tripKey === null) return false;
    const rows = await sql<{
      stop_index: number;
      last: boolean;
      pickup_type: number;
      drop_off_type: number;
      arrival_s: number | null;
      departure_s: number | null;
      cancelled: boolean | null;
    }>`
      SELECT st.stop_index,
             st.stop_index = (SELECT max(stop_index) FROM stop_time
                               WHERE feed_version_id = st.feed_version_id AND trip_key = st.trip_key) AS last,
             st.pickup_type, st.drop_off_type, st.arrival_s, st.departure_s,
             (SELECT f.cancelled FROM stop_event_forecast f
               WHERE f.trip_instance_id = ${giveWay.tripInstanceId}
                 AND f.source_id = ${giveWay.sourceId}
                 AND f.stop_index = st.stop_index
                 AND f.observed_at <= to_timestamp(${giveWay.at})
               ORDER BY f.observed_at DESC LIMIT 1) AS cancelled
        FROM stop_time st
       WHERE st.feed_version_id = ${giveWay.feedVersionId} AND st.trip_key = ${giveWay.tripKey}
         AND st.stop_index > ${giveWay.passed} AND st.stop_index <= ${giveWay.furthest}`.execute(
      db,
    );
    const stops = rows.rows.map((row) => ({
      stopIndex: row.stop_index,
      cancelled: row.cancelled === true,
      passThrough:
        row.stop_index > 0 &&
        !row.last &&
        row.pickup_type === 1 &&
        row.drop_off_type === 1 &&
        !(row.arrival_s !== null && row.departure_s !== null && row.departure_s > row.arrival_s),
    }));
    return giveWayHolds(stops, giveWay.passed, giveWay.furthest);
  };
}

/** Process memory (MB) and engine structure sizes, every 15 minutes of plan time. */
export interface MemorySample extends EngineSizes {
  readonly at: string;
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
}

export interface ObjectSize {
  readonly kind: "k" | "d" | "head";
  readonly sequence: number;
  readonly at: number;
  readonly trips: number;
  readonly plain: number;
  readonly br: number;
  readonly gz: number;
}

export interface RenderReport {
  readonly from: string;
  readonly to: string;
  readonly cadence: number;
  readonly holdRule: boolean;
  readonly shapeEpoch: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly ticks: number;
  readonly restarts: number;
  readonly counters: EngineCounters[];
  readonly hourly: readonly HourStats[];
  readonly durations: ReturnType<typeof durationSummary>;
  readonly wallSeconds: number;
  readonly peakRssMb: number;
  readonly memory: readonly MemorySample[];
  readonly objects: readonly ObjectSize[];
  /** Every head written: [at, sequence, keyframe, oldest, timetableVersion]. */
  readonly heads: readonly (readonly [number, number, number, number, number])[];
  readonly detail: DetailCheckReport | null;
}

export interface HourStats {
  readonly hour: string;
  running: number;
  realtime: number;
  untracked: number;
  cancelled: number;
  samples: number;
  readonly byCategory: Record<string, { running: number; realtime: number; untracked: number }>;
}

/** Realtime observed this long before the window still shapes the first plans. */

async function verifiedReport(check: ProgressCheck, db: Kysely<DB>): Promise<DetailCheckReport> {
  await check.verify(giveWayFromDatabase(db));
  return check.report();
}

function hourOf(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 13);
}

/**
 * `live render`: runs the engine over a replayed window on a virtual clock (one tick per `cadence`
 * seconds) against the History reader, writing every object under `out`, and reports sizes, counts
 * and timings. Deterministic: the same database and options give the same bytes.
 */
export async function render(options: RenderOptions): Promise<RenderReport> {
  const started = performance.now();
  const objects: ObjectSize[] = [];
  const heads: [number, number, number, number, number][] = [];
  let lastAt = options.from;
  const tripsBySequence = new Map<string, number>();
  const store = new FileStore(options.out, (event) => {
    if (event.kind === "s") return;
    const sequence = event.kind === "head" ? 0 : Number.parseInt(event.path.slice(2), 10);
    objects.push({
      kind: event.kind,
      sequence,
      at: lastAt,
      trips: tripsBySequence.get(`${event.kind}${sequence}`) ?? 0,
      ...event.sizes,
    });
  });
  const shapeEpoch = await currentShapeEpoch(options.db);
  const keys = new MemoryKeyStore(newChainStart(options.from, 0));
  const timetable = renderTimetable(options, () => lastAt);
  const firstSequence = newChainStart(options.from, 0);
  const check = new ProgressCheck();
  const gate = packGate(options.packs, shapeEpoch);
  const makeEngine = () =>
    new LiveEngine({
      timetable,
      reader: snapshotThenHistory(options.db),
      keys,
      sink: {
        object: (kind, sequence, bytes) => store.object(kind, sequence, bytes),
        head: (bytes, head) => {
          heads.push([
            head.timeBase,
            head.sequence,
            head.keyframeSequence,
            head.oldestSequence,
            head.timetableVersion,
          ]);
          return store.head(bytes, head);
        },
      },
      shapeEpoch,
      firstSequence,
      onVersionDecision: (decision) => options.progress?.(JSON.stringify({ decision })),
      vehicles: new VehicleIdentities(new DatabaseFleetSource(options.db), {
        onError: (error) =>
          options.progress?.(JSON.stringify({ vehicleError: String(error).slice(0, 300) })),
      }),
      awaitVehicles: true,
      ...gate,
      holdRule: options.holdRule,
      ...(options.deltaInterval === undefined ? {} : { deltaInterval: options.deltaInterval }),
      ...(options.keyframeInterval === undefined
        ? {}
        : { keyframeInterval: options.keyframeInterval }),
      ...(options.detailCheck ? { detail: check } : {}),
    });
  let engine = makeEngine();
  const counters: EngineCounters[] = [];
  const hourly = new Map<string, HourStats>();
  const memory: MemorySample[] = [];
  const profiles = [...(options.heapProfileAt ?? [])].sort((a, b) => a - b);
  const profiler = profiles.length > 0 ? await startHeapSampling() : null;
  let ticks = 0;
  let restarts = 0;
  for (let now = options.from; now <= options.to; now += options.cadence) {
    if (options.restartAt !== undefined && restarts === 0 && now >= options.restartAt) {
      engine = await restartedEngine(engine, counters, store, shapeEpoch, makeEngine);
      restarts++;
    }
    lastAt = now;
    const tickStarted = performance.now();
    const report: TickReport = await engine.tick(now);
    recordDuration("tick", performance.now() - tickStarted);
    noteTripCounts(report, engine, tripsBySequence);
    ticks++;
    if (ticks % Math.max(1, Math.round(60 / options.cadence)) === 0)
      sampleHour(engine, now, hourly);
    if (ticks % Math.max(1, Math.round(900 / options.cadence)) === 0)
      progressLine(options, engine, now, memory);
    if (profiler && profiles.length > 0 && now >= (profiles[0] as number)) {
      profiles.shift();
      const file = join(
        options.profileDir ?? ".",
        `heap-${new Date(now * 1000).toISOString().replaceAll(":", "")}.heapprofile`,
      );
      await writeHeapProfile(profiler, file);
      options.progress?.(`heap profile ${file}`);
    }
  }
  profiler?.disconnect();
  await engine.detailIdle();
  counters.push(engine.counters);
  fillTripCounts(objects, tripsBySequence);
  return {
    from: new Date(options.from * 1000).toISOString(),
    to: new Date(options.to * 1000).toISOString(),
    cadence: options.cadence,
    holdRule: options.holdRule,
    shapeEpoch,
    firstSequence,
    lastSequence: engine.latestSequence,
    ticks,
    restarts,
    counters,
    hourly: [...hourly.values()],
    durations: durationSummary(),
    wallSeconds: Math.round((performance.now() - started) / 100) / 10,
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    memory,
    objects,
    heads,
    detail: options.detailCheck ? await verifiedReport(check, options.db) : null,
  };
}

/** The pack gate of `live run` over a packs directory (none without one). */
function packGate(
  dir: string | undefined,
  shapeEpoch: number,
): { packsReady?: (version: number) => Promise<boolean> } {
  if (!dir) return {};
  const store = new FileStore(dir);
  return { packsReady: (version) => store.hasPacks(shapeEpoch, version) };
}

/** The database timetable, with versions hidden until their `versionAvailable` instant. */
function renderTimetable(options: RenderOptions, now: () => number): TimetableSource {
  const database = new DatabaseTimetable(options.db, options.shapesDb);
  if (!options.versionAvailable?.size && options.unlistedVersionAvailable === undefined)
    return database;
  return new AvailableFrom(
    database,
    options.versionAvailable ?? new Map(),
    now,
    options.unlistedVersionAvailable,
  );
}

async function startHeapSampling(): Promise<Session> {
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.startSampling", { samplingInterval: 16_384 });
  return session;
}

async function writeHeapProfile(session: Session, file: string): Promise<void> {
  await session.post("HeapProfiler.collectGarbage");
  const { profile } = await session.post("HeapProfiler.getSamplingProfile");
  await writeFile(file, JSON.stringify(profile));
}

async function restartedEngine(
  previous: LiveEngine,
  counters: EngineCounters[],
  store: FileStore,
  shapeEpoch: number,
  makeEngine: () => LiveEngine,
): Promise<LiveEngine> {
  await previous.detailIdle();
  counters.push(previous.counters);
  const restored = await restoreChain(store, shapeEpoch);
  const engine = makeEngine();
  if (restored.kind === "chain") await engine.restore(restored.chain);
  return engine;
}

function noteTripCounts(report: TickReport, engine: LiveEngine, trips: Map<string, number>): void {
  if (report.delta !== null) trips.set(`d${report.delta}`, report.changedTrips);
  if (report.keyframe !== null) trips.set(`k${report.keyframe}`, engine.currentState.size);
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}

function progressLine(
  options: RenderOptions,
  engine: LiveEngine,
  now: number,
  memory: MemorySample[],
): void {
  const usage = process.memoryUsage();
  const sample: MemorySample = {
    at: new Date(now * 1000).toISOString(),
    rssMb: megabytes(usage.rss),
    heapUsedMb: megabytes(usage.heapUsed),
    heapTotalMb: megabytes(usage.heapTotal),
    externalMb: megabytes(usage.external),
    arrayBuffersMb: megabytes(usage.arrayBuffers),
    ...engine.sizes,
  };
  memory.push(sample);
  options.progress?.(
    `${sample.at} seq ${engine.latestSequence} trips ${sample.state} rss ${sample.rssMb} MB heap ${sample.heapUsedMb} MB external ${sample.externalMb} MB rows ${sample.forecastRows} tracked ${sample.tracked} wake ${sample.wake}`,
  );
}

function fillTripCounts(objects: ObjectSize[], trips: Map<string, number>): void {
  for (const object of objects) {
    if (object.kind === "head" || object.trips !== 0) continue;
    const count = trips.get(`${object.kind}${object.sequence}`);
    if (count !== undefined) (object as { trips: number }).trips = count;
  }
}

function sampleHour(engine: LiveEngine, now: number, hourly: Map<string, HourStats>): void {
  const hour = hourOf(now);
  let stats = hourly.get(hour);
  if (!stats) {
    stats = {
      hour,
      running: 0,
      realtime: 0,
      untracked: 0,
      cancelled: 0,
      samples: 0,
      byCategory: {},
    };
    hourly.set(hour, stats);
  }
  stats.samples++;
  for (const count of engine.counts(now)) {
    if (count.category === null) {
      stats[count.metric] += count.count;
      continue;
    }
    const entry = stats.byCategory[count.category] ?? { running: 0, realtime: 0, untracked: 0 };
    stats.byCategory[count.category] = entry;
    if (count.metric !== "cancelled") entry[count.metric] += count.count;
  }
}
