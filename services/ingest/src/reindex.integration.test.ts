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
import type { Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecorderIndex } from "./index-db.ts";
import { reindexAll } from "./reindex.ts";
import { recorderSources } from "./sources.ts";
import { PayloadStore } from "./storage/payload-store.ts";
import { listSidecars, readFetchRecords } from "./storage/reader.ts";
import { RunLog } from "./storage/runs.ts";

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
    if (
      ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"].includes(code) ||
      /timeout/i.test(String(error))
    )
      return false;
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
const sources = recorderSources({ otdChApiKey: null, sncbApiKey: null }).filter((s) =>
  ["delfi-gtfs-rt", "vbb-gtfs-rt"].includes(s.id),
);

describe.skipIf(!available)("reindex against a throwaway database", () => {
  const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = withDatabase(serverUrl, name);
  let admin: pg.Client;
  let db: Kysely<DB>;
  let root: string;
  const runId = "0199f000-0000-7000-8000-000000000042";

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
    root = await mkdtemp(join(tmpdir(), "gerlines-reindex-"));
    const runs = new RunLog(root);
    await runs.start({
      run: runId,
      source: "delfi-gtfs-rt",
      job: "record",
      appVersion: "0.1.0",
      at: "2026-10-25T00:55:00.000Z",
    });
    const store = new PayloadStore({
      root,
      source: "delfi-gtfs-rt",
      writer: "live",
      period: "hour",
      contentType: "application/x-protobuf",
    });
    let payload = randomBytes(50_000);
    const times = [
      "2026-10-25T00:58:20Z",
      "2026-10-25T00:59:20Z",
      "2026-10-25T01:00:20Z",
      "2026-10-25T01:06:20Z",
    ];
    for (const iso of times) {
      await store.storePayload(
        {
          v: 1,
          type: "fetch",
          source: "delfi-gtfs-rt",
          run: runId,
          writer: "live",
          url: "https://stc.traines.eu/mirror/german-delfi-gtfs-rt/latest.original.gtfs-rt.pbf",
          method: "GET",
          startedAt: iso,
          observedAt: iso,
          durationMs: 900,
          status: 200,
          headers: {},
        },
        payload,
        sha(payload),
        Date.parse(iso),
      );
      payload = Buffer.concat([payload.subarray(0, 49_000), randomBytes(1_000)]);
    }
    await store.close();
    await runs.end({
      run: runId,
      source: "delfi-gtfs-rt",
      status: "succeeded",
      at: "2026-10-25T01:07:00.000Z",
    });
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
    await admin?.end();
    await rm(root, { recursive: true, force: true });
  });

  it("reproduces runs, raw objects, segment positions and gaps from the files, idempotently", async () => {
    const index = new RecorderIndex(db);
    const first = await reindexAll(root, index, sources);
    const second = await reindexAll(root, index, sources);
    expect(first.find((r) => r.source === "delfi-gtfs-rt")).toMatchObject({
      runs: 1,
      records: 4,
      objects: 4,
      inserted: 4,
      gaps: 1,
    });
    expect(second.find((r) => r.source === "delfi-gtfs-rt")).toMatchObject({
      inserted: 0,
      gaps: 1,
    });

    const records = await readFetchRecords(root, await listSidecars(root, "delfi-gtfs-rt"));
    const rows = await db
      .selectFrom("raw_object")
      .innerJoin(
        "raw_object_segment",
        "raw_object_segment.raw_object_id",
        "raw_object.raw_object_id",
      )
      .select([
        "raw_object.raw_object_id",
        "object_key",
        "sha256",
        "bytes",
        "content_encoding",
        "segment_key",
        "seq",
        "base_seq",
        "frame_offset",
        "frame_bytes",
        "fetched_at",
        "request_url",
      ])
      .orderBy("fetched_at")
      .execute();
    expect(rows).toEqual(
      records.map((record) => ({
        raw_object_id: record.object?.id,
        object_key: record.object?.key,
        sha256: record.sha256,
        bytes: String(record.bytes),
        content_encoding: "zstd-patch-v1",
        segment_key: record.object?.file,
        seq: record.object?.seq,
        base_seq: record.object?.base,
        frame_offset: String(record.object?.offset),
        frame_bytes: String(record.object?.length),
        fetched_at: new Date(record.startedAt),
        request_url: record.url,
      })),
    );
    expect(rows.map((row) => row.segment_key)).toEqual([
      "delfi-gtfs-rt/2026-10-25/00.seg.zst",
      "delfi-gtfs-rt/2026-10-25/00.seg.zst",
      "delfi-gtfs-rt/2026-10-25/01.seg.zst",
      "delfi-gtfs-rt/2026-10-25/01.seg.zst",
    ]);
    const run = await db.selectFrom("ingest_run").selectAll().executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      ingest_run_id: runId,
      status: "succeeded",
      job: "record",
      finished_at: new Date("2026-10-25T01:07:00Z"),
    });
    const gaps = await db.selectFrom("recording_gap").selectAll().execute();
    expect(gaps).toEqual([
      {
        source_id: "delfi-gtfs-rt",
        gap_start: new Date("2026-10-25T01:00:20Z"),
        gap_end: new Date("2026-10-25T01:06:20Z"),
      },
    ]);
    const sourceRows = await db
      .selectFrom("source")
      .select(["source_id", "licence"])
      .orderBy("source_id")
      .execute();
    expect(sourceRows.map((row) => row.source_id)).toEqual(["delfi-gtfs-rt"]);
  });

  it("replaces only the gaps that reach into a backfill window", async () => {
    const index = new RecorderIndex(db);
    const old = {
      start: Date.parse("2026-10-01T10:00:00Z"),
      end: Date.parse("2026-10-01T12:00:00Z"),
    };
    await index.upsertGap("delfi-gtfs-rt", old);
    await index.replaceGaps("delfi-gtfs-rt", [], new Date("2026-10-24T00:00:00Z"));
    const gaps = await db
      .selectFrom("recording_gap")
      .select(["gap_start", "gap_end"])
      .orderBy("gap_start")
      .execute();
    expect(gaps).toEqual([{ gap_start: new Date(old.start), gap_end: new Date(old.end) }]);
  });

  it("stores the observed time and corrects it on a later reindex", async () => {
    const [row] = await db
      .selectFrom("raw_object")
      .select(["raw_object_id", "observed_at"])
      .orderBy("fetched_at")
      .limit(1)
      .execute();
    expect(row?.observed_at).toEqual(new Date("2026-10-25T00:58:20Z"));
    await db
      .updateTable("raw_object")
      .set({ observed_at: new Date("2000-01-01T00:00:00Z") })
      .where("raw_object_id", "=", row?.raw_object_id ?? "")
      .execute();
    const [report] = await reindexAll(root, new RecorderIndex(db), sources.slice(0, 1));
    expect(report?.inserted).toBe(1);
    const fixed = await db
      .selectFrom("raw_object")
      .select("observed_at")
      .where("raw_object_id", "=", row?.raw_object_id ?? "")
      .executeTakeFirstOrThrow();
    expect(fixed.observed_at).toEqual(new Date("2026-10-25T00:58:20Z"));
  });
});
