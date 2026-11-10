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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SearchIndex } from "./search-index.ts";
import { DatabaseSearchSource, NoTimetableError } from "./timetable-source.ts";

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
const BONN = "5eda9b92-2ddf-5610-b59b-ed665a8b2610";
const BERLIN = "6eda9b92-2ddf-5610-b59b-ed665a8b2610";
const GOETTINGEN_03159 = "795a14a8-63bf-5379-b5b8-6d76edaad93f";
const GOETTINGEN_03152 = "b2e2b3aa-156f-5812-9e17-c1f756fbb20e";
const DUISBURG_16032 = "2c655c84-84e4-5088-b0f2-a0c4e391ae0e";
const DUISBURG_16078 = "a878f8be-d28e-5569-9188-adeb735afdd3";
const point = (place: string) => `${place.slice(0, 7)}0${place.slice(8)}`;

const SEED = [
  sql`
    INSERT INTO source (source_id, name, licence, attribution)
    VALUES ('delfi-gtfs', 'DELFI test feed', 'CC-BY-4.0', 'DELFI e.V.')`,
  sql`
    INSERT INTO ingest_run (ingest_run_id, source_id, job, app_version)
    VALUES ('0190f000-0000-7000-8000-000000000001', 'delfi-gtfs', 'import', '0.0.0-test')`,
  sql`
    INSERT INTO raw_object (raw_object_id, source_id, ingest_run_id, object_key, sha256, bytes, content_type, fetched_at)
    VALUES ('0190f000-0000-7000-8000-000000000002', 'delfi-gtfs', '0190f000-0000-7000-8000-000000000001',
            'test/feed.zip', ${"a".repeat(64)}, 1, 'application/zip', '2026-10-01T00:00:00Z')`,
  sql`
    INSERT INTO feed_version (feed_version_id, source_id, raw_object_id, published_on, sha256, category_codes, status,
                              loaded_at, ingest_run_id)
    OVERRIDING SYSTEM VALUE
    VALUES (7, 'delfi-gtfs', '0190f000-0000-7000-8000-000000000002', '2026-10-01', ${"b".repeat(64)},
            '{hsr,reg}', 'loaded', now(), '0190f000-0000-7000-8000-000000000001')`,
  sql`
    INSERT INTO stop_place (stop_place_id, name, name_source_id, eva, dhid, geom, geom_source_id) VALUES
      (${KOELN}, 'Köln Hbf', 'delfi-gtfs', 8000207, 'de:05315:11201', ST_SetSRID(ST_MakePoint(6.9587, 50.9430), 4326), 'delfi-gtfs'),
      (${BONN}, 'Bonn Hbf', 'delfi-gtfs', 8000044, NULL, ST_SetSRID(ST_MakePoint(7.0973, 50.7320), 4326), 'delfi-gtfs'),
      (${BERLIN}, 'Berlin Hbf', 'delfi-gtfs', 8011160, 'de:11000:900003201', ST_SetSRID(ST_MakePoint(13.3695, 52.5251), 4326), 'delfi-gtfs'),
      (${GOETTINGEN_03159}, 'Göttingen', 'delfi-gtfs', 8000128, 'de:03159:33817', ST_SetSRID(ST_MakePoint(9.9256, 51.5368), 4326), 'delfi-gtfs'),
      (${GOETTINGEN_03152}, 'Göttingen', 'delfi-gtfs', 8000128, 'de:03152:33817', ST_SetSRID(ST_MakePoint(9.926072, 51.536815), 4326), 'delfi-gtfs'),
      (${DUISBURG_16032}, 'Duisburg Hbf', 'delfi-gtfs', 8000086, 'de:05112:16032', ST_SetSRID(ST_MakePoint(6.774528, 51.430453), 4326), 'delfi-gtfs'),
      (${DUISBURG_16078}, 'Duisburg Hbf', 'delfi-gtfs', 8000086, 'de:05112:16078', ST_SetSRID(ST_MakePoint(6.777266, 51.429918), 4326), 'delfi-gtfs')`,
  sql`
    INSERT INTO stop_place_display_name (stop_place_id, name, source_id, rule)
    VALUES (${BONN}, 'Bonn Hauptbahnhof', 'delfi-gtfs', 'test')`,
  sql`
    INSERT INTO stop_point (stop_point_id, stop_place_id) VALUES
      (${point(KOELN)}, ${KOELN}), (${point(BONN)}, ${BONN}), (${point(BERLIN)}, ${BERLIN}),
      (${point(GOETTINGEN_03159)}, ${GOETTINGEN_03159}), (${point(GOETTINGEN_03152)}, ${GOETTINGEN_03152})`,
  sql`
    INSERT INTO stop_point (stop_point_id, stop_place_id, geom, geom_source_id) VALUES
      (${point(DUISBURG_16032)}, ${DUISBURG_16032}, ST_SetSRID(ST_MakePoint(6.7761, 51.4302), 4326), 'delfi-gtfs'),
      (${point(DUISBURG_16078)}, ${DUISBURG_16078}, ST_SetSRID(ST_MakePoint(6.777266, 51.429918), 4326), 'delfi-gtfs')`,
  sql`
    INSERT INTO id_map (source_id, entity, source_key, canonical_id, first_seen_at, last_seen_at) VALUES
      ('delfi-gtfs', 'stop_place', 'de:05112:16032', ${DUISBURG_16032}, '2026-10-29T14:13:19Z', '2026-10-29T14:13:19Z'),
      ('delfi-gtfs', 'stop_point', 'de:05112:16032:1:1', ${point(DUISBURG_16032)}, '2026-10-29T14:13:19Z', '2026-10-29T14:13:19Z'),
      ('delfi-gtfs', 'stop_place', 'de:05112:16078', ${DUISBURG_16078}, '2026-10-29T14:13:19Z', '2026-10-29T14:13:19Z'),
      ('delfi-gtfs', 'stop_point', 'de:05112:16078::1', ${point(DUISBURG_16078)}, '2026-10-29T14:13:19Z', '2026-10-29T14:13:19Z')`,
  sql`
    INSERT INTO stop_place_search_name (stop_place_id, name, source_id) VALUES
      (${BONN}, 'Bonn Hbf', 'delfi-gtfs'), (${BONN}, 'Bonn Bahnhof', 'delfi-gtfs')`,
  sql`
    INSERT INTO id_map (source_id, entity, source_key, canonical_id) VALUES
      ('delfi-gtfs', 'stop_point', 'de:05315:11201:1:1', ${point(KOELN)}),
      ('delfi-gtfs', 'stop_place', 'de:05315:11201', ${KOELN}),
      ('delfi-gtfs', 'stop_place', 'de:03159:33817', ${GOETTINGEN_03159}),
      ('delfi-gtfs', 'stop_point', 'de:03159:33817::5', ${point(GOETTINGEN_03159)}),
      ('delfi-gtfs', 'stop_place', 'de:03152:33817', ${GOETTINGEN_03152}),
      ('delfi-gtfs', 'stop_point', 'de:03152:33817', ${point(GOETTINGEN_03152)})`,
  sql`
    INSERT INTO id_map (source_id, entity, source_key, canonical_id, first_seen_at, last_seen_at) VALUES
      ('delfi-gtfs', 'stop_place', 'de:05314:61101', ${BONN}, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('delfi-gtfs', 'stop_place', '000008000044', ${BONN}, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
  sql`
    INSERT INTO route (feed_version_id, route_key, short_name, gtfs_route_type, category_code, category_rule, is_foreign)
    VALUES (7, 'r-re5', 'RE5', 2, 'reg', 'test', false), (7, 'r-ice', NULL, 2, 'hsr', 'test', false)`,
  sql`
    INSERT INTO trip_pattern (feed_version_id, trip_pattern_id, route_key, stop_count)
    VALUES (7, '0190f000-0000-7000-8000-0000000000a1', 'r-re5', 2), (7, '0190f000-0000-7000-8000-0000000000a2', 'r-ice', 2),
           (7, '0190f000-0000-7000-8000-0000000000a3', 'r-re5', 2), (7, '0190f000-0000-7000-8000-0000000000a4', 'r-re5', 2)`,
  sql`
    INSERT INTO trip_pattern_stop (feed_version_id, trip_pattern_id, stop_index, stop_point_id) VALUES
      (7, '0190f000-0000-7000-8000-0000000000a1', 0, ${point(KOELN)}), (7, '0190f000-0000-7000-8000-0000000000a1', 1, ${point(BONN)}),
      (7, '0190f000-0000-7000-8000-0000000000a2', 0, ${point(BERLIN)}), (7, '0190f000-0000-7000-8000-0000000000a2', 1, ${point(KOELN)}),
      (7, '0190f000-0000-7000-8000-0000000000a3', 0, ${point(GOETTINGEN_03159)}),
      (7, '0190f000-0000-7000-8000-0000000000a3', 1, ${point(GOETTINGEN_03152)}),
      (7, '0190f000-0000-7000-8000-0000000000a4', 0, ${point(DUISBURG_16032)}),
      (7, '0190f000-0000-7000-8000-0000000000a4', 1, ${point(DUISBURG_16078)})`,
  sql`
    INSERT INTO service_calendar (feed_version_id, service_key, weekdays, start_date, end_date)
    VALUES (7, 'daily', 127, '2026-10-01', '2026-12-31'), (7, 'never', 0, '2026-10-01', '2026-12-31')`,
  sql`
    INSERT INTO service_calendar_date (feed_version_id, service_key, service_date, exception_type)
    VALUES (7, 'daily', '2026-11-11', 2), (7, 'never', '2026-11-10', 1)`,
  sql`
    INSERT INTO trip (feed_version_id, trip_key, route_key, service_key, trip_pattern_id, short_name, category_code,
                      is_foreign, first_departure_s, last_arrival_s) VALUES
      (7, 'day', 'r-re5', 'daily', '0190f000-0000-7000-8000-0000000000a1', '12345', 'reg', false, 28800, 32400),
      (7, 'extra', 'r-re5', 'never', '0190f000-0000-7000-8000-0000000000a1', '12347', 'reg', false, 36000, 39600),
      (7, 'night', 'r-ice', 'daily', '0190f000-0000-7000-8000-0000000000a2', '1001', 'hsr', false, 79200, 93600)`,
  sql`
    INSERT INTO trip_product (feed_version_id, trip_key, product, source_id, rule)
    VALUES (7, 'night', 'ICE', 'delfi-gtfs', 'test')`,
];

describe.skipIf(!online)(
  online
    ? "DatabaseSearchSource over a seeded feed"
    : `DatabaseSearchSource (skipped: no database at ${redactDatabaseUrl(serverUrl)})`,
  () => {
    const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
    const databaseUrl = withDatabase(serverUrl, name);
    let admin: Kysely<DB>;
    let db: Kysely<DB>;
    let source: DatabaseSearchSource;

    beforeAll(async () => {
      admin = createDatabase({ databaseUrl: serverUrl, applicationName: "gerlines-api-test" });
      await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(admin);
      await migrateUp({ databaseUrl, lockWaitMs: 1000 });
      db = createDatabase({ databaseUrl, applicationName: "gerlines-api-test", maxConnections: 2 });
      for (const statement of SEED) await statement.execute(db);
      source = new DatabaseSearchSource(db);
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
      if (admin) {
        await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(admin);
        await admin.destroy();
      }
    });

    const numbers = (trains: readonly { trainNumber: string | null; serviceDate: string }[]) =>
      trains.map((train) => `${train.trainNumber} ${train.serviceDate}`).sort();

    it("lists the day's trains with calendar exceptions both ways and last evening's train past midnight", async () => {
      const day = await source.load("2026-11-10");
      expect(day.timetableVersion).toBe("7");
      expect(numbers(day.trains)).toEqual([
        "1001 2026-11-09",
        "1001 2026-11-10",
        "12345 2026-11-10",
        "12347 2026-11-10",
      ]);
      const removed = await source.load("2026-11-11");
      expect(numbers(removed.trains)).toEqual(["1001 2026-11-10"]);
    });

    it("names origin and destination by their display names and the train by product and number", async () => {
      const { trains } = await source.load("2026-11-10");
      const regional = trains.find((train) => train.trainNumber === "12345");
      expect(regional).toMatchObject({
        origin: { stopPlaceId: KOELN, name: "Köln Hbf" },
        destination: { stopPlaceId: BONN, name: "Bonn Hauptbahnhof" },
        line: "RE5",
        departure: "2026-11-10T07:00:00.000Z",
      });
      expect(trains.find((train) => train.trainNumber === "1001")?.title).toBe("ICE 1001");
    });

    it("counts each station's trains and lines, and boxes a line by its stops", async () => {
      const { stations, lines } = await source.load("2026-11-10");
      expect(stations.find((station) => station.id === KOELN)).toMatchObject({
        name: "Köln Hbf",
        eva: 8000207,
        dhid: "de:05315:11201",
        stopId: "de:05315:11201",
        trainsToday: 3,
        lines: ["RE5"],
      });
      expect(stations.find((station) => station.id === BONN)).toMatchObject({
        name: "Bonn Hauptbahnhof",
        otherNames: ["Bonn Bahnhof", "Bonn Hbf"],
        dhid: null,
        stopId: "000008000044",
      });
      expect(stations.find((station) => station.id === BERLIN)?.stopId).toBe("de:11000:900003201");
      expect(stations.find((station) => station.id === KOELN)?.otherNames).toEqual([]);
      const re5 = lines.find((line) => line.line === "RE5");
      expect(re5?.bbox).toEqual([6.9587, 50.732, 7.0973, 50.943]);
    });

    it("gives both Göttingen places the district twin's id that is a stops.txt row", async () => {
      const { stations } = await source.load("2026-11-10");
      const goettingen = stations.filter((station) => station.name === "Göttingen");
      expect(
        goettingen
          .map(({ id, dhid, stopId }) => ({ id, dhid, stopId }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual([
        { id: GOETTINGEN_03159, dhid: "de:03159:33817", stopId: "de:03152:33817" },
        { id: GOETTINGEN_03152, dhid: "de:03152:33817", stopId: "de:03152:33817" },
      ]);
    });

    it("gives a Duisburg Hbf place built from platform ids its twin's parent row", async () => {
      const data = await source.load("2026-11-10");
      const duisburg = data.stations.filter((station) => station.name === "Duisburg Hbf");
      expect(duisburg.map((station) => station.stopId)).toEqual([
        "de:05112:16032",
        "de:05112:16032",
      ]);
      const index = SearchIndex.of({ ...data, places: [] });
      expect(index.routableStopOf("de:05112:16078")).toBe("de:05112:16078::1");
    });

    it("lists the DELFI stop ids of id_map with the stop place each belongs to", async () => {
      const { stopIds } = await source.load("2026-11-10");
      expect(stopIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stopId: "de:05315:11201:1:1",
            stationId: KOELN,
            stopPoint: true,
          }),
          expect.objectContaining({ stopId: "de:05315:11201", stationId: KOELN, stopPoint: false }),
        ]),
      );
    });

    it("gives a station the router lacks a stops.txt row of its own", async () => {
      const index = SearchIndex.of({ ...(await source.load("2026-11-10")), places: [] });
      expect(index.routableStopOf("de:03159:33817")).toMatch(/^de:03159:33817::/);
      expect(index.routableStopOf("de:05315:11201")).toBe("de:05315:11201:1:1");
    });

    it("places times on the day the clocks go back", async () => {
      const { trains } = await source.load("2026-10-25");
      expect(trains.find((train) => train.trainNumber === "12345")?.departure).toBe(
        "2026-10-25T07:00:00.000Z",
      );
    });

    it("names the timetable version of a day, and says when no loaded timetable covers it", async () => {
      expect(await source.version("2026-11-10")).toBe("7");
      await expect(source.load("2026-09-01")).rejects.toBeInstanceOf(NoTimetableError);
    });

    it("starts no query of a load whose signal is aborted", async () => {
      const reason = new Error("deadline");
      await expect(source.load("2026-11-10", AbortSignal.abort(reason))).rejects.toBe(reason);
    });
  },
);
