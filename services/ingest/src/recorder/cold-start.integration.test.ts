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
import { silentLogger } from "../log.ts";
import { recorderSources } from "../sources.ts";
import { PayloadStore } from "../storage/payload-store.ts";
import { recorderDatabaseOptions } from "./database.ts";
import { IndexSink } from "./index-sink.ts";

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

const source = recorderSources({ otdChApiKey: null, sncbApiKey: null }).find(
  (s) => s.id === "delfi-gtfs-rt",
);
const runId = "019a6400-0000-7000-8000-000000000168";
const at = "2026-11-08T15:01:00.000Z";

describe.skipIf(!available || !source)(
  "index sink when the database appears after the recorder",
  () => {
    const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
    const databaseUrl = withDatabase(serverUrl, name);
    let admin: pg.Client;
    let db: Kysely<DB>;
    let root: string;

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: serverUrl });
      await admin.connect();
      db = createDatabase({
        databaseUrl,
        applicationName: "gerlines-ingest-test",
        maxConnections: 2,
      });
      root = await mkdtemp(join(tmpdir(), "gerlines-cold-start-db-"));
    });

    afterAll(async () => {
      await db?.destroy();
      await admin?.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
      await admin?.end();
      await rm(root, { recursive: true, force: true });
    });

    it("writes the refused run row before the first object, which then lands", async () => {
      if (!source) return;
      const sink = new IndexSink(new RecorderIndex(db), silentLogger);
      await sink.sources([source]);
      await sink.failStaleRuns(source.id, "record", runId, new Date(at));
      await sink.run({
        id: runId,
        source: source.id,
        job: "record",
        appVersion: "0.1.0",
        startedAt: at,
        status: "running",
        finishedAt: null,
        error: null,
      });
      expect(sink.dirty).toBe(true);

      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE template0`);
      await migrateUp({ databaseUrl, lockWaitMs: 10_000 });
      const store = new PayloadStore({
        root,
        source: source.id,
        writer: "live",
        period: "hour",
        contentType: "application/x-protobuf",
      });
      const payload = randomBytes(2_000);
      const record = await store.storePayload(
        {
          v: 1,
          type: "fetch",
          source: source.id,
          run: runId,
          writer: "live",
          url: "https://stc.traines.eu/mirror/german-delfi-gtfs-rt/latest.original.gtfs-rt.pbf",
          method: "GET",
          startedAt: at,
          observedAt: at,
          durationMs: 900,
          status: 200,
          headers: {},
        },
        payload,
        createHash("sha256").update(payload).digest("hex"),
        Date.parse(at),
      );
      await store.close();

      await sink.objects([record]);

      expect(sink.takeRecovered()).toBe(true);
      const run = await db
        .selectFrom("ingest_run")
        .select(["status", "source_id"])
        .where("ingest_run_id", "=", runId)
        .executeTakeFirstOrThrow();
      expect(run).toEqual({ status: "running", source_id: source.id });
      const objects = await db
        .selectFrom("raw_object")
        .select("raw_object_id")
        .where("ingest_run_id", "=", runId)
        .execute();
      expect(objects.map((row) => row.raw_object_id)).toEqual([record.object?.id]);
    });
  },
);

describe.skipIf(!available)("recorder pool when Postgres ends its connections", () => {
  const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = withDatabase(serverUrl, name);
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE template0`);
  });

  afterAll(async () => {
    await admin?.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
    await admin?.end();
  });

  it("logs the error of an idle connection, keeps the process and connects again", async () => {
    const lines: string[] = [];
    const db = createDatabase(
      recorderDatabaseOptions(databaseUrl, { log: (_level, message) => lines.push(message) }),
    );
    try {
      await sql`select 1`.execute(db);
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [name],
      );
      for (let wait = 0; wait < 40 && lines.length === 0; wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(lines).toContain("database connection failed, the index reconciles from files later");
      const { rows } = await sql<{ one: number }>`select 1 as one`.execute(db);
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await db.destroy();
    }
  });
});
