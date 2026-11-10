import { randomBytes } from "node:crypto";
import {
  createDatabase,
  type DB,
  migrateUp,
  type RollupGroupColumn,
  readRollupSets,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  withDatabase,
} from "@gerlines/db";
import { STATS_DELAY_BINS } from "@gerlines/schema/stats";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseStatsReader, StatsService } from "./service.ts";

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

const A = "4eda9b92-2ddf-5610-b59b-ed665a8b2610";
const B = "5eda9b92-2ddf-5610-b59b-ed665a8b2610";
const D = "6eda9b92-2ddf-5610-b59b-ed665a8b2610";
const E = "7eda9b92-2ddf-5610-b59b-ed665a8b2610";
const T1 = "0190f000-0000-7000-8000-0000000000c1";
const T2 = "0190f000-0000-7000-8000-0000000000c2";
const T3 = "0190f000-0000-7000-8000-0000000000c3";

const SEED = `
INSERT INTO source (source_id, name, licence, attribution) VALUES
  ('delfi-gtfs', 'DELFI test feed', 'CC-BY-4.0', 'Test'),
  ('delfi-gtfs-rt', 'DELFI realtime', 'CC-BY-4.0', 'Test');
INSERT INTO ingest_run (source_id, job, app_version) SELECT source_id, 'poll', '0.0.0-test' FROM source;
INSERT INTO raw_object (source_id, ingest_run_id, object_key, sha256, bytes, content_type, fetched_at, http_status)
  SELECT source_id, ingest_run_id, source_id || '/a', repeat('a', 64), 1, 'application/octet-stream',
         '2026-10-01T00:00:00Z', 200 FROM ingest_run;
INSERT INTO feed_version (feed_version_id, source_id, raw_object_id, published_on, sha256, category_codes, status,
                          loaded_at, ingest_run_id)
  OVERRIDING SYSTEM VALUE
  SELECT 7, 'delfi-gtfs', raw_object_id, '2026-10-01', repeat('b', 64), '{hsr,reg}', 'loaded', now(), ingest_run_id
    FROM raw_object WHERE source_id = 'delfi-gtfs';
INSERT INTO operator (operator_id, name, name_source_id) VALUES
  ('op-a', 'Operator A', 'delfi-gtfs'), ('op-b', 'Operator B', 'delfi-gtfs');
INSERT INTO land_area (land_code, geom, edition, source_url, source_sha256, licence, attribution) VALUES
  ('DE-BY', ST_Multi(ST_MakeEnvelope(600000, 5300000, 700000, 5400000, 25832)), 'test', 'https://example.org/vg250',
   repeat('b', 64), 'DL-DE-BY-2.0', 'Test'),
  ('DE-BW', ST_Multi(ST_MakeEnvelope(500000, 5300000, 600000, 5400000, 25832)), 'test', 'https://example.org/vg250',
   repeat('b', 64), 'DL-DE-BY-2.0', 'Test');
INSERT INTO stop_place (stop_place_id, name, name_source_id, geom_source_id, dhid, country_code, geom) VALUES
  ('${A}', 'A Hbf', 'delfi-gtfs', 'delfi-gtfs', 'de:09162:1', 'DE', ST_Transform(ST_SetSRID(ST_MakePoint(650000, 5350000), 25832), 4326)),
  ('${B}', 'B Hbf', 'delfi-gtfs', 'delfi-gtfs', 'de:08111:1', 'DE', ST_Transform(ST_SetSRID(ST_MakePoint(550000, 5350000), 25832), 4326)),
  ('${D}', 'D', 'delfi-gtfs', 'delfi-gtfs', NULL, 'AT', ST_Transform(ST_SetSRID(ST_MakePoint(705000, 5350000), 25832), 4326));
INSERT INTO stop_place (stop_place_id, name, name_source_id) VALUES ('${E}', 'E', 'delfi-gtfs');
INSERT INTO stop_place_display_name (stop_place_id, name, source_id, rule) VALUES ('${A}', 'A Hauptbahnhof', 'delfi-gtfs', 'test');
INSERT INTO route (feed_version_id, route_key, short_name, gtfs_route_type, category_code, category_rule, is_foreign)
  VALUES (7, 'r-re5', 'RE5', 2, 'reg', 'test', false);
INSERT INTO trip_pattern (feed_version_id, trip_pattern_id, route_key, stop_count)
  VALUES (7, '0190f000-0000-7000-8000-0000000000a1', 'r-re5', 3);
INSERT INTO service_calendar (feed_version_id, service_key, weekdays, start_date, end_date)
  VALUES (7, 'daily', 127, '2026-10-01', '2026-12-31');
INSERT INTO trip (feed_version_id, trip_key, route_key, service_key, trip_pattern_id, short_name, category_code,
                  is_foreign, first_departure_s, last_arrival_s)
  VALUES (7, 'k100', 'r-re5', 'daily', '0190f000-0000-7000-8000-0000000000a1', '100', 'reg', false, 28800, 32400);
`;

function instance(
  id: string,
  day: string,
  category: string,
  operator: string,
  number: string,
  tripKey: string | null,
) {
  return `INSERT INTO trip_instance (trip_instance_id, service_date, feed_version_id, trip_key, operator_id, train_number,
      category_code, origin_stop_place_id, origin_departure, is_added, first_source_id, first_observed_at, first_raw_object_id)
    SELECT '${id}', '${day}', ${tripKey ? 7 : "NULL"}, ${tripKey ? `'${tripKey}'` : "NULL"}, '${operator}', '${number}',
           '${category}', '${A}', '${day}T07:00:00Z', ${tripKey === null}, 'delfi-gtfs-rt', '${day}T06:00:00Z', raw_object_id
      FROM raw_object WHERE source_id = 'delfi-gtfs-rt';`;
}

const at = (day: string, minutes: number, delayS = 0) =>
  `'${new Date(Date.parse(`${day}T07:00:00Z`) + minutes * 60_000 + delayS * 1000).toISOString()}'`;

interface Stop {
  trip: string;
  day: string;
  index: number;
  place: string;
  minute: number;
  delay?: number;
  cancelled?: boolean;
  arrives?: boolean;
  departs?: boolean;
}

function stop(row: Stop): string {
  const arrives = row.arrives ?? row.index > 0;
  const departs = row.departs ?? !arrives;
  const decided = row.delay !== undefined;
  const final = (on: boolean) => (on && decided ? at(row.day, row.minute, row.delay) : "NULL");
  return `INSERT INTO stop_event (service_date, trip_instance_id, stop_index, source_id, stop_place_id, scheduled_arrival,
      scheduled_departure, final_arrival, final_departure, final_quality, cancelled, additional, observed_at, raw_object_id)
    SELECT '${row.day}', '${row.trip}', ${row.index}, 'delfi-gtfs-rt', '${row.place}',
      ${arrives ? at(row.day, row.minute) : "NULL"}, ${departs ? at(row.day, row.minute) : "NULL"},
      ${final(arrives)}, ${final(departs)}, ${decided ? "'live'" : "NULL"}, ${row.cancelled === true}, false,
      '${row.day}T12:00:00Z', raw_object_id
    FROM raw_object WHERE source_id = 'delfi-gtfs-rt';`;
}

const D1 = "2026-10-27";
const D2 = "2026-10-28";
const STOPS: Stop[] = [
  { trip: T1, day: D1, index: 0, place: A, minute: 0, delay: 0 },
  { trip: T1, day: D1, index: 1, place: B, minute: 30, delay: 300 },
  { trip: T1, day: D1, index: 2, place: D, minute: 60, delay: 400 },
  { trip: T2, day: D1, index: 0, place: A, minute: 10, delay: 120 },
  { trip: T2, day: D1, index: 1, place: E, minute: 40, delay: 1000 },
  { trip: T2, day: D1, index: 2, place: B, minute: 70, cancelled: true },
  { trip: T3, day: D2, index: 0, place: A, minute: 0, delay: 0 },
  { trip: T3, day: D2, index: 1, place: B, minute: 30, delay: 959 },
  { trip: T3, day: D2, index: 2, place: A, minute: 60 },
];

const ROLLUPS = [
  "stat_stop",
  "stat_segment",
  "station_day",
  "station_hour",
  "train_day",
  "line_day",
  "segment_day",
  "land_category_day",
  "land_category_hour",
];

describe.skipIf(!online)(
  online
    ? "StatsService over refreshed rollups"
    : `StatsService (skipped: no database at ${redactDatabaseUrl(serverUrl)})`,
  () => {
    const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
    const databaseUrl = withDatabase(serverUrl, name);
    let admin: Kysely<DB>;
    let db: Kysely<DB>;
    let stats: StatsService;

    beforeAll(async () => {
      admin = createDatabase({ databaseUrl: serverUrl, applicationName: "gerlines-api-test" });
      await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(admin);
      await migrateUp({ databaseUrl, lockWaitMs: 1000 });
      db = createDatabase({ databaseUrl, applicationName: "gerlines-api-test", maxConnections: 2 });
      await sql`SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs
                 WHERE proc_name = 'policy_refresh_continuous_aggregate'`.execute(db);
      await sql.raw(SEED).execute(db);
      await sql.raw(instance(T1, D1, "reg", "op-a", "100", "k100")).execute(db);
      await sql.raw(instance(T2, D1, "hsr", "op-b", "200", null)).execute(db);
      await sql.raw(instance(T3, D2, "reg", "op-a", "100", "k100")).execute(db);
      for (const row of STOPS) await sql.raw(stop(row)).execute(db);
      for (const rollup of ROLLUPS) {
        await sql.raw(`CALL refresh_continuous_aggregate('${rollup}', NULL, NULL)`).execute(db);
      }
      stats = new StatsService(new DatabaseStatsReader(db), () =>
        Date.parse("2026-10-28T20:00:00Z"),
      );
    }, 180_000);

    afterAll(async () => {
      await db?.destroy();
      if (admin) {
        await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(admin);
        await admin.destroy();
      }
    });

    it("counts Germany only for the network and keeps stops abroad and without a Land apart", async () => {
      const day = await stats.network({ from: D1, to: D1 });
      expect(day.summary).toMatchObject({
        stops: 4,
        cancelled: 1,
        observed: 3,
        observedArrivals: 1,
        punctual6: 1,
        punctual16: 1,
        meanDelayS: 140,
        maxDelayS: 300,
        noData: 0,
      });
      expect(day.outsideGermany).toEqual({ foreignStops: 1, unassignedStops: 1 });
      expect(day.byLand.map((land) => [land.landCode, land.summary.stops])).toEqual([
        ["DE-BW", 2],
        ["DE-BY", 2],
      ]);
      expect(day.byHour.map((hour) => [hour.hour, hour.stops])).toEqual([
        [8, 3],
        [9, 1],
      ]);
      expect(day.freshness.refreshedAt).toBeNull();

      const period = await stats.network({ from: D1, to: D2 });
      expect(period.summary).toMatchObject({
        stops: 7,
        observed: 5,
        observedArrivals: 2,
        punctual6: 0.5,
        punctual16: 1,
        noData: 1,
      });
      expect(period.byDay.map((row) => [row.day, row.stops, row.punctual6])).toEqual([
        [D1, 4, 1],
        [D2, 3, 0],
      ]);
      const hsr = await stats.network({ from: D1, to: D2, categories: ["hsr"] });
      expect(hsr.summary).toMatchObject({
        stops: 2,
        cancelled: 1,
        observedArrivals: 0,
        punctual6: null,
      });
    });

    it("reads a train and its line across days with runs and the line from the timetable", async () => {
      const train = await stats.train("100", null, { from: D1, to: D2 });
      expect(train.groups).toHaveLength(1);
      expect(train.groups[0]).toMatchObject({
        operator: { id: "op-a", name: "Operator A" },
        category: "reg",
        line: "RE5",
        runs: 2,
        summary: { stops: 6, observed: 5, observedArrivals: 3, punctual6: 0.3333, punctual16: 1 },
      });
      expect(train.groups[0]?.byDay.map((row) => [row.day, row.runs, row.stops])).toEqual([
        [D1, 1, 3],
        [D2, 1, 3],
      ]);
      const line = await stats.line("RE5", "op-a", { from: D1, to: D2 });
      expect(line.groups[0]?.summary).toEqual(train.groups[0]?.summary);
      expect((await stats.train("100", "op-b", { from: D1, to: D2 })).groups).toEqual([]);
    });

    it("reads a station with its display name, operators and departures, and a Land", async () => {
      const station = await stats.station(A, { from: D1, to: D2 });
      expect(station?.station).toEqual({ id: A, name: "A Hauptbahnhof", landCode: "DE-BY" });
      expect(station?.summary).toMatchObject({ stops: 4, observed: 3, noData: 1 });
      expect(station?.departures).toEqual({ observed: 3, punctual6: 1 });
      expect(station?.byOperator.map((row) => [row.operator?.id, row.summary.stops])).toEqual([
        ["op-a", 3],
        ["op-b", 1],
      ]);
      expect(
        await stats.station("00000000-0000-4000-8000-000000000000", { from: D1, to: D2 }),
      ).toBeNull();
      const land = await stats.land("DE-BW", { from: D1, to: D2 });
      expect(land.land).toEqual({ code: "DE-BW", name: "Baden-Württemberg" });
      expect(land.summary).toMatchObject({
        stops: 3,
        cancelled: 1,
        observedArrivals: 2,
        punctual6: 0.5,
        punctual16: 1,
      });
    });

    it("caps the run groups in SQL, busiest first, and keeps the day rows of those groups only", async () => {
      const groups: RollupGroupColumn[] = ["operator_id", "category_code", "line_name"];
      const filter = { from: D1, to: D2 };
      const [all = []] = await readRollupSets(db, "train_day", filter, [groups]);
      const [days = []] = await readRollupSets(db, "train_day", filter, [[...groups, "day"]], {
        histogram: false,
      });
      expect(all.length).toBeGreaterThan(1);
      const busiest = [...all].sort((left, right) => right.n_stops - left.n_stops);
      const [uncapped = []] = await readRollupSets(db, "train_day", filter, [groups], {
        limit: 20,
      });
      expect(uncapped).toEqual(busiest);
      const [uncappedDays = []] = await readRollupSets(
        db,
        "train_day",
        { ...filter, top: { by: groups, limit: 20 } },
        [[...groups, "day"]],
        { histogram: false },
      );
      expect(uncappedDays).toEqual(days);
      const [capped = []] = await readRollupSets(db, "train_day", filter, [groups], { limit: 1 });
      expect(capped).toEqual(busiest.slice(0, 1));
      const [cappedDays = []] = await readRollupSets(
        db,
        "train_day",
        { ...filter, top: { by: groups, limit: 1 } },
        [[...groups, "day"]],
        { histogram: false },
      );
      const top = busiest[0]?.key;
      expect(cappedDays).toEqual(
        days.filter((row) => groups.every((column) => row.key[column] === top?.[column])),
      );
      expect(cappedDays.length).toBeGreaterThan(0);
    });

    it("uses the bins of stat_bin and gives the exact median of the stops in Germany", async () => {
      const bins = await sql<{ lower_value: number | null; upper_value: number | null }>`
        SELECT lower_value, upper_value FROM stat_bin WHERE kind = 'delay' ORDER BY bin`.execute(
        db,
      );
      expect(bins.rows.map((row) => [row.lower_value, row.upper_value])).toEqual(
        STATS_DELAY_BINS.map(([lower, upper]) => [lower, upper]),
      );
      const period = await stats.network({ from: D1, to: D2 });
      const exact = await sql<{ q50: number; q90: number }>`
        SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY stop_delay_s) AS q50,
               percentile_disc(0.9) WITHIN GROUP (ORDER BY stop_delay_s) AS q90
          FROM stat_stop
         WHERE stop_place_id IN (${A}::uuid, ${B}::uuid) AND stop_delay_s IS NOT NULL`.execute(db);
      const q50 = Number(exact.rows[0]?.q50);
      const q90 = Number(exact.rows[0]?.q90);
      expect(q50).toBe(120);
      expect(period.summary.medianDelayS).toBe(q50);
      expect(period.summary.p90DelayS).toBe(Math.floor(q90 / 60) * 60);
      expect(period.delayHistogram.reduce((sum, bin) => sum + bin.count, 0)).toBe(
        period.summary.observed,
      );
    });

    it("answers every route the same once every rollup chunk is in the columnstore", async () => {
      const range = { from: D1, to: D2 };
      const read = async () => ({
        network: await stats.network(range),
        day: await stats.network({ from: D1, to: D1 }),
        hsr: await stats.network({ ...range, categories: ["hsr"] }),
        land: await stats.land("DE-BW", range),
        station: await stats.station(A, range),
        train: await stats.train("100", null, range),
        line: await stats.line("RE5", "op-a", range),
        segments: await stats.trainSegments("100", null, range),
      });
      const rowstore = await read();
      const compressed = await sql<{ chunks: number }>`
        SELECT count(compress_chunk(c, if_not_compressed => true))::int AS chunks
          FROM unnest(${ROLLUPS}::text[]) AS r (name), show_chunks(r.name::regclass) AS c`.execute(
        db,
      );
      expect(compressed.rows[0]?.chunks).toBeGreaterThan(0);
      const left = await sql<{ rowstore: number }>`
        SELECT count(*)::int AS rowstore FROM timescaledb_information.chunks c
          JOIN _timescaledb_catalog.hypertable h ON h.table_name = c.hypertable_name
          JOIN _timescaledb_catalog.continuous_agg a ON a.mat_hypertable_id = h.id
         WHERE NOT c.is_compressed`.execute(db);
      expect(left.rows[0]?.rowstore).toBe(0);
      expect(await read()).toEqual(rowstore);
    });
  },
);
