import { randomBytes } from "node:crypto";
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
import { IRIS_FOLD_SOURCE, registerFoldSources } from "./fold-sources.ts";

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

describe.skipIf(!available)("fold sources against a throwaway database", () => {
  const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = withDatabase(serverUrl, name);
  let admin: pg.Client;
  let db: Kysely<DB>;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE template0`);
    await migrateUp({ databaseUrl, lockWaitMs: 10_000 });
    db = createDatabase({
      databaseUrl,
      applicationName: "gerlines-ingest-test",
      maxConnections: 1,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
    await admin.end();
  });

  const rows = () =>
    db.selectFrom("source").selectAll().where("source_id", "=", "db-iris").execute();

  it("registers nothing for a run without IRIS answers", async () => {
    expect(await registerFoldSources(db, ["gtfsde-rt", "delfi-gtfs-rt"])).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("registers db-iris once with DB's licence, however often a run starts", async () => {
    const sources = ["db-iris-fchg-8000105", "db-iris-plan-8000105", "gtfsde-rt"];
    expect(await registerFoldSources(db, sources)).toEqual(["db-iris"]);
    expect(await registerFoldSources(db, sources)).toEqual(["db-iris"]);
    const [row] = await rows();
    expect(row).toMatchObject({
      source_id: "db-iris",
      licence: "CC-BY-4.0",
      attribution: "Deutsche Bahn AG",
      homepage_url: IRIS_FOLD_SOURCE.homepage_url,
    });
    expect(await rows()).toHaveLength(1);
  });
});
