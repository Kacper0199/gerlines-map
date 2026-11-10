import { randomBytes } from "node:crypto";
import {
  createDatabase,
  type DB,
  migrateUp,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  withDatabase,
} from "@gerlines/db";
import type { FormationObservation } from "@gerlines/schema";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseIdentityStore } from "./repository.ts";

const serverUrl = resolveDatabaseUrl(process.env);
const required =
  process.env.GERLINES_DB_TESTS === "required" || ["1", "true"].includes(process.env.CI ?? "");

async function reachable(url: string): Promise<boolean> {
  const probe = createDatabase({ databaseUrl: url, applicationName: "gerlines-api-test" });
  try {
    await sql`SELECT 1`.execute(probe);
    return true;
  } catch {
    return false;
  } finally {
    await probe.destroy();
  }
}

const online = await reachable(serverUrl);
if (!online && required) {
  throw new Error(
    `database ${redactDatabaseUrl(serverUrl)} is not reachable and database tests are required`,
  );
}

const KOELN = "4eda9b92-2ddf-5610-b59b-ed665a8b2610";
const FV = "db-fernverkehr-ag";
const OTHER = "flixtrain-gmbh";

const SEED = [
  sql`
    INSERT INTO source (source_id, name, licence, attribution) VALUES
      ('delfi-gtfs', 'DELFI test feed', 'CC-BY-4.0', 'DELFI e.V.'),
      ('wikipedia-de-ice-linien', 'Liste der ICE-Linien', 'CC-BY-SA-4.0', 'Wikipedia'),
      ('bahn-vehicle-sequence', 'bahn.de coach sequence', 'LicenseRef-FactsOnly', 'DB')
    ON CONFLICT (source_id) DO NOTHING`,
  sql`
    INSERT INTO operator (operator_id, name, name_source_id) VALUES
      (${FV}, 'DB Fernverkehr AG', 'delfi-gtfs'), (${OTHER}, 'FlixTrain GmbH', 'delfi-gtfs')`,
  sql`
    INSERT INTO vehicle_series (series_id, name, br, unit_length_m, priority, source_id) VALUES
      ('db-412', 'ICE 4', '412', 346.000, 'P1', 'wikipedia-de-ice-linien'),
      ('db-401', 'ICE 1', '401', NULL, 'P1', 'wikipedia-de-ice-linien')`,
  sql`
    INSERT INTO fleet_rule (rule_id, scope, operator_id, category_code, line_keys, series_ids, units,
                            valid_from, valid_to, source_id, evidence) VALUES
      ('ice-line-12', 'line', ${FV}, 'hsr', '{12}', '{db-412}', 1, '2025-12-14', '2026-12-12',
       'wikipedia-de-ice-linien', 'ICE 4')`,
  sql`
    INSERT INTO stop_place (stop_place_id, name, name_source_id, eva, geom, geom_source_id)
    VALUES (${KOELN}, 'Köln Hbf', 'delfi-gtfs', 8000207, ST_SetSRID(ST_MakePoint(6.9587, 50.9430), 4326),
            'delfi-gtfs')`,
];

function observation(
  serviceDate: string,
  seriesId: string,
  overrides: Partial<FormationObservation> = {},
): FormationObservation {
  return {
    sourceId: "bahn-vehicle-sequence",
    serviceDate,
    trainNumber: "586",
    operatorId: FV,
    categoryCode: "hsr",
    line: "12",
    seriesId,
    units: 1,
    cars: 13,
    lengthMetres: 346,
    unitNames: ["ICE9479"],
    sequenceStatus: "MATCHES_SCHEDULE",
    rawSha256: "a".repeat(64),
    ...overrides,
  };
}

describe.skipIf(!online)(
  online
    ? "DatabaseIdentityStore over a migrated database"
    : `DatabaseIdentityStore (skipped: no database at ${redactDatabaseUrl(serverUrl)})`,
  () => {
    const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
    const databaseUrl = withDatabase(serverUrl, name);
    let admin: Kysely<DB>;
    let db: Kysely<DB>;
    let store: DatabaseIdentityStore;

    beforeAll(async () => {
      admin = createDatabase({ databaseUrl: serverUrl, applicationName: "gerlines-api-test" });
      await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(admin);
      await migrateUp({ databaseUrl, lockWaitMs: 1000 });
      db = createDatabase({ databaseUrl, applicationName: "gerlines-api-test", maxConnections: 2 });
      for (const statement of SEED) await statement.execute(db);
      store = new DatabaseIdentityStore(db);
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
      if (admin) {
        await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(admin);
        await admin.destroy();
      }
    });

    it("reads rules with validity as ISO dates, series lengths as numbers and source names", async () => {
      expect(await store.rules()).toEqual([
        expect.objectContaining({
          ruleId: "ice-line-12",
          lineKeys: ["12"],
          seriesIds: ["db-412"],
          units: 1,
          validFrom: "2025-12-14",
          validTo: "2026-12-12",
        }),
      ]);
      const series = await store.series();
      expect(series.find((row) => row.seriesId === "db-412")).toEqual({
        seriesId: "db-412",
        name: "ICE 4",
        br: "412",
        unitLengthMetres: 346,
      });
      expect(await store.sources()).toEqual(
        expect.arrayContaining([
          { sourceId: "wikipedia-de-ice-linien", name: "Liste der ICE-Linien" },
          { sourceId: "bahn-vehicle-sequence", name: "bahn.de coach sequence" },
        ]),
      );
      expect(await store.evaOf(KOELN)).toBe(8000207);
      expect(await store.evaOf("5eda9b92-2ddf-5610-b59b-ed665a8b2610")).toBeNull();
    });

    it("upserts one observation per source, day and train and reads it back exactly", async () => {
      await store.save(observation("2026-11-07", "db-401", { units: 2 }));
      await store.save(observation("2026-11-07", "db-412"));
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM formation_observation WHERE service_date = '2026-11-07'`.execute(
        db,
      );
      expect(rows[0]?.n).toBe(1);
      expect(await store.exact("2026-11-07", "586", FV)).toEqual({
        seriesId: "db-412",
        units: 1,
        cars: 13,
        lengthMetres: 346,
        sourceId: "bahn-vehicle-sequence",
      });
      expect(await store.exact("2026-11-07", "586", null)).toMatchObject({ seriesId: "db-412" });
      expect(await store.exact("2026-11-07", "586", OTHER)).toBeNull();
      expect(await store.exact("2026-11-06", "586", FV)).toBeNull();
    });

    it("takes the majority over the 14 days before the service day, of the same operator only", async () => {
      for (const [day, series] of [
        ["2026-10-23", "db-401"],
        ["2026-10-24", "db-401"],
        ["2026-11-01", "db-412"],
        ["2026-11-02", "db-412"],
        ["2026-11-03", "db-401"],
        ["2026-11-04", "db-412"],
      ] as const) {
        await store.save(observation(day, series, { units: day === "2026-11-04" ? 2 : 1 }));
      }
      await store.save(observation("2026-11-05", "db-401", { operatorId: OTHER }));
      await store.save(observation("2026-11-06", "db-401", { operatorId: OTHER }));
      expect(await store.majority("2026-11-07", "586", FV)).toEqual({
        seriesId: "db-412",
        units: 1,
        count: 3,
        total: 5,
        sourceId: "bahn-vehicle-sequence",
      });
      expect(await store.majority("2026-11-07", "586", null)).toMatchObject({
        seriesId: "db-401",
        count: 4,
        total: 7,
      });
      expect(await store.majority("2026-11-07", "586", OTHER)).toMatchObject({
        seriesId: "db-401",
        count: 2,
        total: 2,
      });
      expect(await store.majority("2026-11-07", "999", FV)).toBeNull();
    });
  },
);
