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
import { DatabaseFleetSource } from "./database.ts";
import type { FleetCatalogue } from "./identities.ts";

const serverUrl = resolveDatabaseUrl(process.env);
const required =
  process.env.GERLINES_DB_TESTS === "required" || ["1", "true"].includes(process.env.CI ?? "");
/** A migrated builder database to run in (the test rolls back); else a throwaway one is made. */
const named = process.env.GERLINES_LIVE_TEST_DATABASE ?? null;
if (named === "gerlines")
  throw new Error("the recorder's database gerlines is never a test database");

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

const SOURCE = "f128-test-source";
const OP_ROUTE = "f128-op-route";
const OP_INSTANCE = "f128-op-instance";
const FEED = 990_128;
const PLACE = "00000000-0000-5000-8000-0000000f1280";
const PATTERN = "00000000-0000-5000-8000-0000000f1281";
const MOVED = "00000000-0000-5000-8000-0000000f1282";
const SAME = "00000000-0000-5000-8000-0000000f1283";
const DAY = "2026-10-25";

class Rollback extends Error {}

const SEED = [
  sql`INSERT INTO source (source_id, name, licence, attribution)
        VALUES (${SOURCE}, 'F128 test source', 'test', 'test')`,
  sql`INSERT INTO operator (operator_id, name, name_source_id) VALUES
        (${OP_ROUTE}, 'Route operator', ${SOURCE}), (${OP_INSTANCE}, 'Instance operator', ${SOURCE})`,
  sql`INSERT INTO ingest_run (source_id, job, app_version) VALUES (${SOURCE}, 'test', '0')`,
  sql`INSERT INTO raw_object (source_id, ingest_run_id, object_key, sha256, bytes, content_type,
                              fetched_at, http_status)
        SELECT ${SOURCE}, ingest_run_id, 'f128/a', repeat('a', 64), 1, 'application/octet-stream',
               '2026-10-01T00:00:00Z', 200 FROM ingest_run WHERE source_id = ${SOURCE}`,
  sql`INSERT INTO feed_version (feed_version_id, source_id, raw_object_id, published_on, sha256,
                                category_codes, status, loaded_at, ingest_run_id)
        OVERRIDING SYSTEM VALUE
        SELECT ${FEED}, ${SOURCE}, raw_object_id, '2026-10-01', repeat('b', 64), '{sbahn}', 'loaded',
               now(), ingest_run_id FROM raw_object WHERE source_id = ${SOURCE}`,
  sql`INSERT INTO stop_place (stop_place_id, name, name_source_id) VALUES (${PLACE}, 'F128 Hbf', ${SOURCE})`,
  sql`INSERT INTO route (feed_version_id, route_key, short_name, operator_id, gtfs_route_type,
                         category_code, category_rule, is_foreign)
        VALUES (${FEED}, 'r-s1', 'S1', ${OP_ROUTE}, 2, 'sbahn', 'test', false)`,
  sql`INSERT INTO trip_pattern (feed_version_id, trip_pattern_id, route_key, stop_count)
        VALUES (${FEED}, ${PATTERN}, 'r-s1', 2)`,
  sql`INSERT INTO service_calendar (feed_version_id, service_key, weekdays, start_date, end_date)
        VALUES (${FEED}, 'daily', 127, '2026-10-01', '2026-12-31')`,
  sql`INSERT INTO trip (feed_version_id, trip_key, route_key, service_key, trip_pattern_id, short_name,
                        category_code, is_foreign, first_departure_s, last_arrival_s)
        VALUES (${FEED}, 'k1', 'r-s1', 'daily', ${PATTERN}, '612', 'sbahn', false, 28800, 32400),
               (${FEED}, 'k2', 'r-s1', 'daily', ${PATTERN}, '613', 'sbahn', false, 29800, 33400)`,
  sql`INSERT INTO trip_instance (trip_instance_id, service_date, feed_version_id, trip_key, operator_id,
                                 train_number, category_code, origin_stop_place_id, origin_departure,
                                 is_added, first_source_id, first_observed_at, first_raw_object_id)
        SELECT id::uuid, ${DAY}::date, ${FEED}, trip_key, operator_id, train_number, 'sbahn', ${PLACE}::uuid,
               ${`${DAY}T07:00:00Z`}::timestamptz, false, ${SOURCE}, ${`${DAY}T06:00:00Z`}::timestamptz,
               raw_object_id
          FROM raw_object,
               (VALUES (${MOVED}, 'k1', ${OP_INSTANCE}, '0612'), (${SAME}, 'k2', ${OP_ROUTE}, '613'))
                 AS v(id, trip_key, operator_id, train_number)
         WHERE raw_object.source_id = ${SOURCE}`,
  sql`INSERT INTO vehicle_series (series_id, name, unit_length_m, priority, source_id)
        VALUES ('f128-series', 'F128 series', 70.5, 'P3', ${SOURCE})`,
  sql`INSERT INTO fleet_rule (rule_id, scope, operator_id, category_code, line_keys, series_ids, units,
                              source_id, evidence)
        VALUES ('f128-rule', 'line', ${OP_ROUTE}, 'sbahn', '{S1}', '{f128-series}', 2, ${SOURCE}, 'test')`,
  sql`INSERT INTO formation_observation (source_id, service_date, train_number, operator_id, series_id,
                                         units, cars, length_m, observed_at)
        VALUES (${SOURCE}, ${DAY}::date, '612', ${OP_INSTANCE}, 'f128-series', 2, 6, 141, '2026-10-25T05:00:00Z'),
               (${SOURCE}, '2026-10-01'::date, '612', ${OP_INSTANCE}, 'f128-series', 1, 3, 70.5,
                '2026-10-01T05:00:00Z')`,
];

describe.skipIf(!available)("DatabaseFleetSource against PostgreSQL", () => {
  const throwaway = `gerlines_live_fleet_${randomBytes(4).toString("hex")}`;
  const databaseUrl = withDatabase(serverUrl, named ?? throwaway);
  let admin: pg.Client | undefined;
  let db: Kysely<DB>;

  beforeAll(async () => {
    if (named === null) {
      admin = new pg.Client({ connectionString: serverUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(throwaway)} TEMPLATE template0`);
      await migrateUp({ databaseUrl, lockWaitMs: 10_000 });
    }
    db = createDatabase({
      databaseUrl,
      applicationName: "gerlines-live-fleet-test",
      maxConnections: 1,
    });
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(throwaway)} WITH (FORCE)`);
    await admin?.end();
  });

  /** Seeds the fixture, reads it the engine's way and rolls everything back. */
  async function inRollback<T>(
    check: (trx: Kysely<DB>, catalogue: FleetCatalogue) => Promise<T>,
  ): Promise<T> {
    let result: T | undefined;
    await db
      .transaction()
      .execute(async (trx) => {
        for (const statement of SEED) await statement.execute(trx);
        const catalogue = await new DatabaseFleetSource(trx).load({
          from: "2026-10-11",
          to: DAY,
          days: [DAY],
        });
        result = await check(trx, catalogue);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    return result as T;
  }

  it("reads the rule, the series, the observations of the window and the named operators", async () => {
    await inRollback(async (_, catalogue) => {
      expect(catalogue.rules.find((rule) => rule.ruleId === "f128-rule")).toMatchObject({
        scope: "line",
        operatorId: OP_ROUTE,
        lineKeys: ["S1"],
        seriesIds: ["f128-series"],
        units: 2,
        sourceId: SOURCE,
      });
      expect(catalogue.series.get("f128-series")).toEqual({
        seriesId: "f128-series",
        name: "F128 series",
        br: null,
        unitLengthMetres: 70.5,
      });
      expect(catalogue.observations.filter((row) => row.sourceId === SOURCE)).toEqual([
        {
          serviceDate: DAY,
          trainNumber: "612",
          operatorId: OP_INSTANCE,
          seriesId: "f128-series",
          units: 2,
          cars: 6,
          lengthMetres: 141,
          sourceId: SOURCE,
          observedAt: Date.parse("2026-10-25T05:00:00Z"),
        },
      ]);
      expect(catalogue.namedOperators.has(OP_ROUTE)).toBe(true);
      expect(catalogue.namedOperators.has(OP_INSTANCE)).toBe(true);
    });
  });

  it("reads only the instances whose operator or number differ from their trip", async () => {
    await inRollback(async (_, catalogue) => {
      expect(catalogue.instances.get(MOVED)).toEqual({
        operatorId: OP_INSTANCE,
        trainNumber: "0612",
      });
      expect(catalogue.instances.has(SAME)).toBe(false);
    });
  });

  it("bounds each statement of the read and can use the service day index (0091)", async () => {
    const [timeout, plan] = await inRollback(async (trx) => {
      const shown = await sql<{ statement_timeout: string }>`SHOW statement_timeout`.execute(trx);
      await sql`SET LOCAL enable_seqscan = off`.execute(trx);
      const explained = await sql<{ "QUERY PLAN": string }>`
        EXPLAIN SELECT * FROM formation_observation
         WHERE service_date BETWEEN '2026-10-11'::date AND '2026-10-25'::date`.execute(trx);
      return [
        shown.rows[0]?.statement_timeout,
        explained.rows.map((row) => row["QUERY PLAN"]).join("\n"),
      ] as const;
    });
    expect(timeout).toBe("10s");
    expect(plan).toContain("formation_observation_day_idx");
  });
});
