import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { RecorderIndex } from "../index-db.ts";
import { recorderSources } from "../sources.ts";
import { PayloadStore } from "../storage/payload-store.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { FEED_REJECTED, invariants, quality } from "./check.ts";
import { ensureIndexed } from "./raw-index.ts";
import { emptyBatch, type RowBatch } from "./rows.ts";
import { waitForSchema } from "./startup.ts";
import {
  notifyRebuilt,
  PAYLOAD_CHANNEL,
  REBUILD_CHANNEL,
  StagingLostError,
  stageBatch,
  startStaging,
  swapStaged,
  writeBatch,
} from "./writer.ts";

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

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const PLACE = "00000000-0000-5000-8000-000000000001";
const INSTANCE = "00000000-0000-5000-a000-000000000001";
const DAY = "2026-10-29";
const NEXT_DAY = "2026-10-30";
const T0 = Date.parse("2026-10-29T10:00:00Z");

describe.skipIf(!available)("realtime writer against a throwaway database", () => {
  const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = withDatabase(serverUrl, name);
  let admin: pg.Client;
  let db: Kysely<DB>;
  let root: string;
  const records: FetchRecord[] = [];

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE template0`);
    await migrateUp({ databaseUrl, lockWaitMs: 10_000 });
    db = createDatabase({
      databaseUrl,
      applicationName: "gerlines-ingest-test",
      maxConnections: 2,
    });
    const sources = recorderSources({ otdChApiKey: null, sncbApiKey: null }).filter((source) =>
      ["delfi-gtfs-rt", "delfi-gtfs-sa"].includes(source.id),
    );
    await new RecorderIndex(db).upsertSources(sources);
    await sql`INSERT INTO stop_place (stop_place_id, name, name_source_id)
              VALUES (${PLACE}, 'Berlin Hbf', 'delfi-gtfs-rt')`.execute(db);
    root = await mkdtemp(join(tmpdir(), "gerlines-writer-"));
    for (const source of ["delfi-gtfs-rt", "delfi-mobilithek-rt"]) {
      const store = new PayloadStore({
        root,
        source,
        writer: "live",
        period: "hour",
        contentType: "application/x-protobuf",
      });
      for (const minute of [0, 1, 2]) {
        const at = T0 + minute * 60_000;
        const payload = randomBytes(2_000);
        const iso = new Date(at).toISOString();
        records.push(
          await store.storePayload(
            {
              v: 1,
              type: "fetch",
              source,
              run: "0199f000-0000-7000-8000-000000000042",
              writer: "live",
              url: "https://example.org/latest.pbf",
              method: "GET",
              startedAt: iso,
              observedAt: iso,
              durationMs: 100,
              status: 200,
              headers: {},
            },
            payload,
            sha(payload),
            at,
          ),
        );
      }
      await store.close();
    }
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
    await admin?.end();
    await rm(root, { recursive: true, force: true });
  });

  const raw = (index: number): string => records[index]?.object?.id ?? "";

  function batchFor(index: number, day: string, delay: number): RowBatch {
    const batch = emptyBatch();
    const at = T0 + index * 60_000;
    batch.instances.push({
      tripInstanceId: INSTANCE,
      serviceDate: day,
      feedVersionId: null,
      tripKey: null,
      operatorId: null,
      trainNumber: null,
      categoryCode: null,
      originStopPlaceId: PLACE,
      originDeparture: T0,
      isAdded: true,
      sourceId: "delfi-gtfs-rt",
      observedAt: at,
      rawObjectId: raw(index),
    });
    batch.instanceSeen.push({
      tripInstanceId: INSTANCE,
      sourceId: "delfi-gtfs-rt",
      observedAt: at,
      rawObjectId: raw(index),
    });
    batch.forecasts.push({
      tripInstanceId: INSTANCE,
      stopIndex: 0,
      sourceId: "delfi-gtfs-rt",
      observedAt: at,
      serviceDate: day,
      predictedArrival: T0 / 1000 + delay,
      predictedDeparture: T0 / 1000 + delay,
      arrivalDelay: delay,
      departureDelay: delay,
      cancelled: false,
      explicit: true,
      rawObjectId: raw(index),
    });
    batch.events.push({
      eventId: `00000000-0000-5000-b000-00000000000${index}`,
      occurredAt: at,
      eventType: "TripDelayChanged",
      sourceId: "delfi-gtfs-rt",
      tripInstanceId: INSTANCE,
      stopIndex: null,
      payload: { delaySeconds: delay },
      rawObjectId: raw(index),
    });
    const scope = {
      sourceId: "delfi-gtfs-sa",
      alertKey: "A1",
      contentHash: "a".repeat(64),
      firstObservedAt: at,
      firstRawObjectId: raw(index),
      lastSeenHour: Math.floor(at / 3_600_000) * 3_600_000,
    };
    batch.alertMessages.push({
      ...scope,
      cause: 1,
      effect: 2,
      severity: null,
      activePeriods: [],
      header: [{ text: "Bauarbeiten", language: "de" }],
      description: [],
      url: [],
      selectorCount: 2,
    });
    batch.alertScopes.push({ ...scope, tripInstanceId: INSTANCE, stopPlaceId: null });
    batch.alertScopes.push({ ...scope, tripInstanceId: null, stopPlaceId: PLACE });
    return batch;
  }

  it("indexes payloads of registered sources once and returns the others apart", async () => {
    const first = await ensureIndexed(db, records);
    const again = await ensureIndexed(db, records);
    expect(first.indexed).toHaveLength(3);
    expect(first.unregistered.map((record) => record.source)).toEqual([
      "delfi-mobilithek-rt",
      "delfi-mobilithek-rt",
      "delfi-mobilithek-rt",
    ]);
    expect(again.indexed).toHaveLength(3);
    const count = await sql<{ n: string }>`SELECT count(*)::text AS n FROM raw_object`.execute(db);
    expect(count.rows[0]?.n).toBe("3");
  });

  it("finds the realtime migration applied", async () => {
    const signal = new AbortController().signal;
    const clock = { now: () => Date.now(), sleep: async () => {} };
    expect(await waitForSchema(db, clock, { log: () => {} }, signal)).toBe(true);
  });

  it("lets the recorder correct the app version of a run the processor indexed first", async () => {
    const run = records[0]?.run ?? "";
    await new RecorderIndex(db).upsertRun({
      id: run,
      source: "delfi-gtfs-rt",
      job: "record",
      appVersion: "9.9.9",
      startedAt: records[0]?.startedAt ?? new Date(T0).toISOString(),
      status: "running",
      finishedAt: null,
      error: null,
    });
    const row = await sql<{ version: string }>`
      SELECT app_version AS version FROM ingest_run WHERE ingest_run_id = ${run}::uuid`.execute(db);
    expect(row.rows[0]?.version).toBe("9.9.9");
  });

  it("writes a payload with its log line and a notice delivered at commit", async () => {
    const listener = new pg.Client({ connectionString: databaseUrl });
    await listener.connect();
    const notices: { channel: string; payload: string | undefined }[] = [];
    listener.on("notification", (message) =>
      notices.push({ channel: message.channel, payload: message.payload ?? undefined }),
    );
    await listener.query(`LISTEN ${PAYLOAD_CHANNEL}`);
    await listener.query(`LISTEN ${REBUILD_CHANNEL}`);
    for (const index of [1, 0]) {
      await writeBatch(db, batchFor(index, DAY, 60 * (index + 1)), {
        rawObjectId: raw(index),
        sourceId: "delfi-gtfs-rt",
        foldSourceId: "delfi-gtfs-rt",
        observedAt: T0 + index * 60_000,
        processedAt: Date.now(),
        counts: { trip: 1 },
        error: null,
      });
    }
    await notifyRebuilt(db, "delfi-gtfs-rt", [DAY]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await listener.end();
    expect(notices.map((notice) => notice.channel)).toEqual([
      PAYLOAD_CHANNEL,
      PAYLOAD_CHANNEL,
      REBUILD_CHANNEL,
    ]);
    expect(JSON.parse(notices[0]?.payload ?? "{}")).toMatchObject({
      rawObjectId: raw(1),
      foldSourceId: "delfi-gtfs-rt",
      rows: 1,
    });
    const seen = await sql<{ first: Date; last: Date; raw: string }>`
      SELECT first_observed_at AS first, last_observed_at AS last, last_raw_object_id AS raw
        FROM trip_instance_source`.execute(db);
    expect(seen.rows).toEqual([{ first: new Date(T0), last: new Date(T0 + 60_000), raw: raw(1) }]);
    const scopes = await sql<{ n: string; first: Date }>`
      SELECT count(*)::text AS n, min(first_observed_at) AS first FROM alert_scope`.execute(db);
    expect(scopes.rows[0]).toEqual({ n: "2", first: new Date(T0) });
    const messages = await sql<{
      n: string;
    }>`SELECT count(*)::text AS n FROM alert_message`.execute(db);
    expect(messages.rows[0]?.n).toBe("1");
    const logged = await sql<{ fold: string }>`
      SELECT fold_source_id AS fold FROM rt_payload ORDER BY observed_at`.execute(db);
    expect(logged.rows.map((row) => row.fold)).toEqual(["delfi-gtfs-rt", "delfi-gtfs-rt"]);
  });

  function stopRow(index: number, stopIndex: number, at: number, delay: number) {
    return {
      serviceDate: DAY,
      tripInstanceId: INSTANCE,
      stopIndex,
      sourceId: "delfi-gtfs-rt",
      stopPlaceId: PLACE,
      scheduledArrival: T0 / 1000,
      scheduledDeparture: T0 / 1000,
      predictedArrival: T0 / 1000 + delay,
      predictedDeparture: T0 / 1000 + delay,
      arrivalDelay: delay,
      departureDelay: delay,
      predictionKind: "explicit" as const,
      finalArrival: null,
      finalDeparture: null,
      finalQuality: null,
      platformScheduled: null,
      platformActual: null,
      cancelled: false,
      additional: false,
      observedAt: at,
      rawObjectId: raw(index),
    };
  }

  it("swaps staged rows in for the rows a rebuild changed, leaving equal and earlier rows alone", async () => {
    await writeBatch(db, batchFor(2, NEXT_DAY, 300), null);
    const live = emptyBatch();
    live.stopEvents.push(stopRow(1, 0, T0 + 60_000, 120));
    live.stopEvents.push(stopRow(0, 1, T0, 60));
    live.stopEvents.push(stopRow(1, 2, T0 + 60_000, 90));
    await writeBatch(db, live, null);
    const forecastsBefore = await sql<{ at: Date; delay: number }>`
      SELECT observed_at AS at, arrival_delay_s AS delay FROM stop_event_forecast
       WHERE service_date = ${DAY} ORDER BY observed_at`.execute(db);
    expect(forecastsBefore.rows.map((row) => row.delay)).toEqual([60, 120]);

    const cut = T0 + 60_000;
    const token = "00000000-0000-4000-8000-0000000000aa";
    await startStaging(db, "00000000-0000-4000-8000-0000000000bb");
    await stageBatch(db, batchFor(1, DAY, 999), cut);
    await expect(swapStaged(db, token, "delfi-gtfs-rt", [DAY], cut, [])).rejects.toBeInstanceOf(
      StagingLostError,
    );
    await startStaging(db, token);
    const rebuilt = batchFor(1, DAY, 150);
    rebuilt.stopEvents.push(stopRow(1, 0, T0 + 60_000, 150));
    rebuilt.stopEvents.push(stopRow(0, 1, T0, 60));
    rebuilt.forecasts.push({ ...(batchFor(0, DAY, 60).forecasts[0] as RowBatch["forecasts"][0]) });
    await stageBatch(db, rebuilt, cut);
    const later = batchFor(2, DAY, 200);
    later.forecasts[0] = {
      ...(later.forecasts[0] as RowBatch["forecasts"][0]),
      observedAt: T0 + 180_000,
    };
    await stageBatch(db, later, cut);
    const staged = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM rt_rebuild_forecast`.execute(db);
    expect(staged.rows[0]?.n).toBe("2");

    const listener = new pg.Client({ connectionString: databaseUrl });
    await listener.connect();
    const notices: string[] = [];
    listener.on("notification", (message) => notices.push(message.channel));
    await listener.query(`LISTEN ${PAYLOAD_CHANNEL}`);
    await listener.query(`LISTEN ${REBUILD_CHANNEL}`);
    const counts = await swapStaged(db, token, "delfi-gtfs-rt", [DAY], cut, [
      {
        log: {
          rawObjectId: raw(2),
          sourceId: "delfi-gtfs-rt",
          foldSourceId: "delfi-gtfs-rt",
          observedAt: T0 + 120_000,
          processedAt: Date.now(),
          counts: { trip: 1 },
          error: null,
        },
        rows: 1,
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await listener.end();
    expect(notices).toEqual([PAYLOAD_CHANNEL, REBUILD_CHANNEL]);
    expect(counts).toEqual({
      deleted: { stopEvents: 2, forecasts: 1, segments: 0 },
      inserted: { stopEvents: 1, forecasts: 2, segments: 0 },
    });
    const forecasts = await sql<{ day: string; delay: number }>`
      SELECT service_date::text AS day, arrival_delay_s AS delay FROM stop_event_forecast
       ORDER BY service_date, observed_at`.execute(db);
    expect(forecasts.rows).toEqual([
      { day: DAY, delay: 60 },
      { day: DAY, delay: 150 },
      { day: DAY, delay: 200 },
      { day: NEXT_DAY, delay: 300 },
    ]);
    const stops = await sql<{ index: number; delay: number }>`
      SELECT stop_index AS index, arrival_delay_s AS delay FROM stop_event ORDER BY stop_index`.execute(
      db,
    );
    expect(stops.rows).toEqual([
      { index: 0, delay: 150 },
      { index: 1, delay: 60 },
    ]);
    const events = await sql<{ n: string }>`SELECT count(*)::text AS n FROM event`.execute(db);
    expect(events.rows[0]?.n).toBe("3");
    const logged = await sql<{ n: string }>`SELECT count(*)::text AS n FROM rt_payload`.execute(db);
    expect(logged.rows[0]?.n).toBe("3");
  });

  it("counts payloads a source sent broken under quality and processor errors as invariants", async () => {
    const line = (index: number, error: string) => ({
      rawObjectId: raw(index),
      sourceId: "delfi-gtfs-rt",
      foldSourceId: "delfi-gtfs-rt",
      observedAt: T0 + index * 60_000,
      processedAt: Date.now(),
      counts: {},
      error,
    });
    await writeBatch(db, emptyBatch(), line(0, `${FEED_REJECTED}feed has no header`));
    await writeBatch(db, emptyBatch(), line(1, `${FEED_REJECTED}truncated varint`));
    const errors = (await invariants(db)).find((item) => item.name === "payload_errors");
    expect(errors?.violations).toBe(0);
    expect((await quality(db)).filter((item) => item.name === "feed_rejected")).toEqual([
      { name: "feed_rejected", source: "delfi-gtfs-rt", violations: 2 },
    ]);
    await writeBatch(db, emptyBatch(), line(1, "processing failed: boom"));
    const after = (await invariants(db)).find((item) => item.name === "payload_errors");
    expect(after?.violations).toBe(1);
  });
});
