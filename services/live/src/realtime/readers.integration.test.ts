import { randomBytes } from "node:crypto";
import {
  createDatabase,
  type DB,
  migrateUp,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  withDatabase,
} from "@gerlines/db";
import { type Kysely, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBatch, type RowBatch } from "../../../ingest/src/realtime/rows.ts";
import {
  type PayloadLogRow,
  stageBatch,
  startStaging,
  swapStaged,
  writeBatch,
} from "../../../ingest/src/realtime/writer.ts";
import { RebuildListener } from "./notices.ts";
import { FollowReader, HistoryReader, type RealtimeChunk, snapshotThenHistory } from "./readers.ts";
import { RealtimeStore } from "./store.ts";

const serverUrl = resolveDatabaseUrl(process.env);
const required =
  process.env.GERLINES_DB_TESTS === "required" || ["1", "true"].includes(process.env.CI ?? "");

async function reachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: serverUrl, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"].includes(code)) return false;
    if (/timeout/i.test(String(error))) return false;
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const available = await reachable();
if (!available && required) {
  throw new Error(
    `database ${redactDatabaseUrl(serverUrl)} is not reachable and database tests are required`,
  );
}

const DELFI = "delfi-gtfs-rt";
const MOBILITHEK = "delfi-mobilithek-rt";
const GTFSDE = "gtfsde-rt";
const A = "00000000-0000-5000-a000-00000000000a";
const B = "00000000-0000-5000-a000-00000000000b";
const C = "00000000-0000-5000-a000-00000000000c";
const PLACE = "00000000-0000-5000-8000-000000000001";
const RUNS: Record<string, string> = {
  "delfi-gtfs-rt": "0199f000-0000-7000-8000-000000000041",
  "delfi-mobilithek-rt": "0199f000-0000-7000-8000-000000000042",
  "gtfsde-rt": "0199f000-0000-7000-8000-000000000043",
};
const DAY = "2026-10-29";
const T0 = Date.parse("2026-10-29T10:00:00Z");
const T0S = T0 / 1000;
const LISTENER_NAME = "gerlines-live-listen-test";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The engine's use of a chunk (engine.ts `tick`). */
function applyChunk(store: RealtimeStore, chunk: RealtimeChunk): void {
  if (chunk.reload) store.replace(chunk.reload.sourceId, chunk.reload.instanceIds, chunk.rows);
  else store.apply(chunk.rows);
  if (chunk.seen) store.noteSeen(chunk.seen);
}

async function drain(
  reader: { read(now: number): AsyncIterable<RealtimeChunk> },
  now: number,
): Promise<RealtimeChunk[]> {
  const out: RealtimeChunk[] = [];
  for await (const chunk of reader.read(now)) out.push(chunk);
  return out;
}

/**
 * The cases run in order on one database, one reader and one store: each builds on the payloads and
 * the follow state of the ones before it (a follow is a sequence by nature). Run the file whole.
 */
describe.skipIf(!available)("FollowReader against WP-2.3b's writer (F-02, F-03)", () => {
  const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = withDatabase(serverUrl, name);
  let admin: pg.Client;
  let db: Kysely<DB>;
  let listener: RebuildListener;
  let reader: FollowReader;
  const store = new RealtimeStore();
  const raws = new Map<string, string>();
  const listenerLog: Record<string, unknown>[] = [];

  async function rawObject(key: string, source: string): Promise<string> {
    const id = `00000000-0000-7000-9000-${(raws.size + 1).toString(16).padStart(12, "0")}`;
    await sql`INSERT INTO raw_object (raw_object_id, source_id, ingest_run_id, object_key, sha256,
                bytes, content_type, fetched_at)
              VALUES (${id}::uuid, ${source}, ${RUNS[source]}::uuid, ${`test/${key}`}, ${"0".repeat(64)}, 1,
                'application/x-protobuf', now())`.execute(db);
    raws.set(key, id);
    return id;
  }

  /** One payload: instances seen at `minute`, forecasts for the `changes` given. */
  async function payload(
    key: string,
    recorded: string,
    fold: string,
    second: number,
    seen: readonly string[],
    changes: readonly [instance: string, stop: number, delay: number][],
  ): Promise<{ batch: RowBatch; log: PayloadLogRow }> {
    const raw = await rawObject(key, recorded);
    const at = T0 + second * 1000;
    const batch = emptyBatch();
    for (const instance of seen) {
      batch.instances.push({
        tripInstanceId: instance,
        serviceDate: DAY,
        feedVersionId: null,
        tripKey: null,
        operatorId: null,
        trainNumber: null,
        categoryCode: null,
        originStopPlaceId: PLACE,
        originDeparture: T0,
        isAdded: true,
        sourceId: fold,
        observedAt: at,
        rawObjectId: raw,
      });
      batch.instanceSeen.push({
        tripInstanceId: instance,
        sourceId: fold,
        observedAt: at,
        rawObjectId: raw,
      });
    }
    for (const [instance, stopIndex, delay] of changes) {
      batch.forecasts.push({
        tripInstanceId: instance,
        stopIndex,
        sourceId: fold,
        observedAt: at,
        serviceDate: DAY,
        predictedArrival: T0S + 3_600 + delay,
        predictedDeparture: T0S + 3_600 + delay,
        arrivalDelay: delay,
        departureDelay: delay,
        cancelled: false,
        explicit: true,
        rawObjectId: raw,
      });
    }
    const log: PayloadLogRow = {
      rawObjectId: raw,
      sourceId: recorded,
      foldSourceId: fold,
      observedAt: at,
      processedAt: Date.now(),
      counts: { trip: seen.length },
      error: null,
    };
    return { batch, log };
  }

  async function tail(...args: Parameters<typeof payload>): Promise<void> {
    const { batch, log } = await payload(...args);
    await writeBatch(db, batch, log);
  }

  /** One tick's read, then, once its reloads are loaded off the tick, the read that takes them. */
  async function follow(now: number): Promise<RealtimeChunk[]> {
    const chunks = await drain(reader, now);
    for (const chunk of chunks) applyChunk(store, chunk);
    await reader.reloadsIdle();
    const later = await drain(reader, now);
    for (const chunk of later) applyChunk(store, chunk);
    return [...chunks, ...later];
  }

  const delay = (instance: string, source: string, stop: number) =>
    store.source(instance, source)?.stops.get(stop)?.arrivalDelay;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE template0`);
    await migrateUp({ databaseUrl, lockWaitMs: 10_000 });
    db = createDatabase({ databaseUrl, applicationName: "gerlines-live-test", maxConnections: 2 });
    for (const source of [DELFI, MOBILITHEK, GTFSDE]) {
      await sql`INSERT INTO source (source_id, name, licence, attribution)
                VALUES (${source}, ${source}, 'test', 'test')`.execute(db);
    }
    for (const [source, run] of Object.entries(RUNS)) {
      await sql`INSERT INTO ingest_run (ingest_run_id, source_id, job, app_version)
                VALUES (${run}::uuid, ${source}, 'test', '0')`.execute(db);
    }
    await sql`INSERT INTO stop_place (stop_place_id, name, name_source_id)
              VALUES (${PLACE}, 'Berlin Hbf', ${DELFI})`.execute(db);
    listener = new RebuildListener({
      connectionString: databaseUrl,
      applicationName: LISTENER_NAME,
      retryMs: 50,
      log: (fields) => listenerLog.push(fields),
    });
    await listener.start();
    reader = new FollowReader(db, Date.now() / 1000 - 1, { notices: listener });
  });

  afterAll(async () => {
    await listener?.close();
    await db?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
    await admin?.end();
  });

  it("reads a payload's rows under its logical source, not the recorded one", async () => {
    await tail(
      "p0",
      MOBILITHEK,
      DELFI,
      0,
      [A, B],
      [
        [A, 0, 60],
        [B, 0, 30],
      ],
    );
    await tail("p0g", GTFSDE, GTFSDE, 5, [A], [[A, 0, 15]]);
    const chunks = await follow(T0S + 5);
    expect(
      chunks.flatMap((c) => c.rows).map((r) => [r.instanceId, r.sourceId, r.stopIndex]),
    ).toEqual([
      [A, DELFI, 0],
      [B, DELFI, 0],
      [A, GTFSDE, 0],
    ]);
    expect(delay(A, DELFI, 0)).toBe(60);
    expect(delay(B, DELFI, 0)).toBe(30);
    expect(delay(A, GTFSDE, 0)).toBe(15);
    expect(store.source(A, DELFI)?.stops.get(0)?.stopPlaceId).toBeNull();
    expect(await drain(reader, T0S + 6)).toEqual([]);
  });

  it("keeps a source active from its sightings while its predictions do not change (F-02)", async () => {
    await tail("p1", MOBILITHEK, DELFI, 60, [A, B], [[A, 1, 120]]);
    const rows = (await follow(T0S + 65)).flatMap((c) => c.rows);
    expect(rows.map((r) => [r.instanceId, r.stopIndex])).toEqual([[A, 1]]);
    await tail("p2", MOBILITHEK, DELFI, 120, [A, B], []);
    await follow(T0S + 125);
    const activity = store.activity(B, T0S + 125).find((s) => s.sourceId === DELFI);
    expect(activity).toEqual({ sourceId: DELFI, firstSeen: T0S, lastSeen: T0S + 120 });
    expect(store.source(B, DELFI)?.lastSeen).toBe(T0S);
  });

  it("reloads the rebuilt days at the swap: moved and deleted rows, late lines read once (F-03)", async () => {
    const late = await payload("late", DELFI, DELFI, 30, [A], [[A, 0, 90]]);
    await tail("p3", MOBILITHEK, DELFI, 180, [A, B], [[B, 0, 45]]);
    const token = "00000000-0000-4000-8000-0000000000aa";
    const cut = T0 + 30_000;
    await startStaging(db, token);
    await stageBatch(db, late.batch, cut);
    for (const key of ["p1", "p2", "p3"]) {
      const refold = emptyBatch();
      const second = { p1: 60, p2: 120, p3: 180 }[key] as number;
      if (key === "p3") {
        refold.forecasts.push({
          ...(late.batch.forecasts[0] as RowBatch["forecasts"][0]),
          tripInstanceId: B,
          observedAt: T0 + second * 1000,
          arrivalDelay: 45,
          departureDelay: 45,
          predictedArrival: T0S + 3_645,
          predictedDeparture: T0S + 3_645,
          rawObjectId: raws.get(key) as string,
        });
      }
      await stageBatch(db, refold, cut);
    }
    const before = (await follow(T0S + 185)).flatMap((c) => c.rows);
    expect(before.map((r) => [r.instanceId, r.stopIndex])).toEqual([[B, 0]]);
    expect(delay(A, DELFI, 1)).toBe(120);

    await swapStaged(db, token, DELFI, [DAY], cut, [
      { log: { ...late.log, processedAt: Date.now() }, rows: 1 },
    ]);
    await tail("p4", MOBILITHEK, DELFI, 240, [B], [[B, 0, 50]]);
    await pause(300);
    const chunks = await follow(T0S + 245);
    const followed = chunks.filter((c) => !c.reload).flatMap((c) => c.rows);
    expect(followed.map((r) => [r.instanceId, r.stopIndex, r.arrivalDelay])).toEqual([
      [A, 0, 90],
      [B, 0, 50],
    ]);
    const reloads = chunks.filter((c) => c.reload);
    expect(reloads.map((c) => c.reload)).toEqual([{ sourceId: DELFI, instanceIds: [A, B] }]);
    expect(reloads[0]?.rows.map((r) => [r.instanceId, r.stopIndex, r.arrivalDelay])).toEqual([
      [A, 0, 90],
      [B, 0, 50],
      ...followed.map((r) => [r.instanceId, r.stopIndex, r.arrivalDelay]),
    ]);
    expect(delay(A, DELFI, 0)).toBe(90);
    expect(store.source(A, DELFI)?.stops.has(1)).toBe(false);
    expect(delay(B, DELFI, 0)).toBe(50);
    expect(delay(A, GTFSDE, 0)).toBe(15);
    expect(await drain(reader, T0S + 246)).toEqual([]);
  });

  it("catches a backlog up over several reads, at most maxPayloads payloads each", async () => {
    const from = Date.now() / 1000 - 3600;
    const total = (await drain(new FollowReader(db, from), T0S + 250)).flatMap((c) => c.rows);
    const logs: Record<string, unknown>[] = [];
    const capped = new FollowReader(db, from, { maxPayloads: 1, log: (f) => logs.push(f) });
    const perRead: number[] = [];
    for (let i = 0; i < 40; i++) {
      perRead.push((await drain(capped, T0S + 250)).flatMap((c) => c.rows).length);
    }
    expect(perRead.filter((n) => n > 0).length).toBeGreaterThan(1);
    expect(perRead.reduce((a, b) => a + b, 0)).toBe(total.length);
    expect(logs[0]).toMatchObject({ msg: "follow backlog", perRead: 1 });
  });

  it("reads a line committed late but stamped inside the margin, once", async () => {
    const { batch, log } = await payload("p5", MOBILITHEK, DELFI, 300, [B], [[B, 0, 55]]);
    await writeBatch(db, batch, { ...log, processedAt: reader.position * 1000 - 5_000 });
    const rows = (await follow(T0S + 305)).flatMap((c) => c.rows);
    expect(rows.map((r) => r.arrivalDelay)).toEqual([55]);
    expect((await follow(T0S + 306)).flatMap((c) => c.rows)).toEqual([]);
  });

  it("reads a fallback folded after a later primary: rows at the fold instant, line at its observation", async () => {
    await tail("p6", MOBILITHEK, DELFI, 350, [B], [[B, 0, 70]]);
    expect((await follow(T0S + 352)).flatMap((c) => c.rows).map((r) => r.arrivalDelay)).toEqual([
      70,
    ]);
    const fallback = await payload("f6", DELFI, DELFI, 350, [A], [[A, 1, 200]]);
    await writeBatch(db, fallback.batch, { ...fallback.log, observedAt: T0 + 330_000 });
    const rows = (await follow(T0S + 355)).flatMap((c) => c.rows);
    expect(rows.map((r) => [r.instanceId, r.stopIndex, r.arrivalDelay, r.observedAt])).toEqual([
      [A, 1, 200, T0S + 350],
    ]);
    expect(delay(A, DELFI, 1)).toBe(200);
  });

  it("reloads every source after the listener lost its connection", async () => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND application_name = $2`,
      [name, LISTENER_NAME],
    );
    for (
      let i = 0;
      i < 40 && !listenerLog.some((l) => l.msg === "rebuild listener reconnected");
      i++
    )
      await pause(50);
    expect(listenerLog.map((l) => l.msg)).toEqual([
      "rebuild listener lost",
      "rebuild listener reconnected",
    ]);
    const reloads = (await follow(T0S + 360)).filter((c) => c.reload);
    expect(reloads.map((c) => c.reload)).toEqual([{ sourceId: null, instanceIds: [A, B] }]);
    expect(delay(A, DELFI, 0)).toBe(90);
    expect(delay(A, GTFSDE, 0)).toBe(15);
    expect(delay(B, DELFI, 0)).toBe(70);
    expect(delay(A, DELFI, 1)).toBe(200);
  });

  it("refreshes a sighting committed long after its observation", async () => {
    await tail("g7", GTFSDE, GTFSDE, 200, [A], []);
    await follow(T0S + 420);
    expect(store.activity(A, T0S + 420).find((a) => a.sourceId === GTFSDE)).toEqual({
      sourceId: GTFSDE,
      firstSeen: T0S + 5,
      lastSeen: T0S + 200,
    });
  });

  it("a render reads sightings once and counts them up to the instant it evaluates", async () => {
    const history = new HistoryReader(db, T0S - 1);
    const replay = new RealtimeStore();
    for (const chunk of await drain(history, T0S + 70)) applyChunk(replay, chunk);
    expect(replay.activity(B, T0S + 70)).toEqual([
      { sourceId: DELFI, firstSeen: T0S, lastSeen: T0S + 70 },
    ]);
    expect(replay.activity(B, T0S + 2_000)[0]?.lastSeen).toBe(T0S + 350);
  });
  it("starts from the newest row per stop of the days around it: an 8 h old cancellation survives", async () => {
    const old = await payload("c0", MOBILITHEK, DELFI, -8 * 3_600, [C], [[C, 0, 0]]);
    old.batch.forecasts[0] = {
      ...(old.batch.forecasts[0] as RowBatch["forecasts"][0]),
      cancelled: true,
    };
    await writeBatch(db, old.batch, old.log);
    const lastHours = new RealtimeStore();
    for (const chunk of await drain(new HistoryReader(db, T0S + 400 - 6 * 3_600), T0S + 400))
      applyChunk(lastHours, chunk);
    expect(lastHours.has(C)).toBe(false);
    const started = new RealtimeStore();
    const reader = snapshotThenHistory(db);
    for (const chunk of await drain(reader, T0S + 400)) applyChunk(started, chunk);
    expect(started.source(C, DELFI)?.stops.get(0)?.cancelled).toBe(true);
    expect(started.source(A, DELFI)?.stops.get(0)?.arrivalDelay).toBe(90);
    expect(started.source(A, DELFI)?.stops.get(1)?.arrivalDelay).toBe(200);
    expect(started.source(B, DELFI)?.stops.get(0)?.arrivalDelay).toBe(70);
    expect(started.source(A, GTFSDE)?.stops.get(0)?.arrivalDelay).toBe(15);
    expect(started.activity(C, T0S + 400)).toEqual([
      { sourceId: DELFI, firstSeen: T0S - 8 * 3_600, lastSeen: T0S - 8 * 3_600 },
    ]);
    expect(await drain(reader, T0S + 401)).toEqual([]);
  });
});
