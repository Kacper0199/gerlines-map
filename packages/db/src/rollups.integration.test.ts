import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactDatabaseUrl, resolveDatabaseUrl, withDatabase } from "./config.ts";
import { probeDatabase } from "./probe.ts";
import { migrateUp } from "./runner.ts";

const serverUrl = resolveDatabaseUrl(process.env);
const required =
  process.env.GERLINES_DB_TESTS === "required" || ["1", "true"].includes(process.env.CI ?? "");
const reachable = await probeDatabase(serverUrl);
if (!reachable && required) {
  throw new Error(
    `database ${redactDatabaseUrl(serverUrl)} is not reachable and database tests are required`,
  );
}
const suiteName = reachable
  ? "rollups against a throwaway database"
  : `rollups (skipped: no database at ${redactDatabaseUrl(serverUrl)}, run pnpm infra:up)`;

const place = {
  a: "00000000-0000-5000-8000-00000000a001",
  b: "00000000-0000-5000-8000-00000000a002",
  c: "00000000-0000-5000-8000-00000000a003",
  d: "00000000-0000-5000-8000-00000000a004",
  e: "00000000-0000-5000-8000-00000000a005",
  f: "00000000-0000-5000-8000-00000000a006",
};
const run = {
  regional: "00000000-0000-5000-8000-00000000b001",
  express: "00000000-0000-5000-8000-00000000b002",
  quiet: "00000000-0000-5000-8000-00000000b003",
  dropped: "00000000-0000-5000-8000-00000000b004",
};
const delfi = "delfi-gtfs-rt";
const gtfsde = "gtfsde-rt";
const rollups = [
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

const seed = `
INSERT INTO source (source_id, name, licence, attribution) VALUES
  ('test-stops', 'Test stops', 'CC-BY-4.0', 'Test'),
  ('${delfi}', 'DELFI', 'CC-BY-4.0', 'Test'),
  ('${gtfsde}', 'gtfs.de', 'CC-BY-4.0', 'Test');
INSERT INTO ingest_run (source_id, job, app_version)
  SELECT source_id, 'poll', '0.0.0-test' FROM source;
INSERT INTO raw_object (source_id, ingest_run_id, object_key, sha256, bytes, content_type, fetched_at, http_status)
  SELECT source_id, ingest_run_id, source_id || '/a.pb', repeat('a', 64), 1, 'application/x-protobuf',
         '2026-10-27T12:00:00Z', 200
    FROM ingest_run;
INSERT INTO operator (operator_id, name, name_source_id) VALUES
  ('op-a', 'Operator A', 'test-stops'), ('op-b', 'Operator B', 'test-stops');
INSERT INTO land_area (land_code, geom, edition, source_url, source_sha256, licence, attribution) VALUES
  ('DE-BY', ST_Multi(ST_MakeEnvelope(600000, 5300000, 700000, 5400000, 25832)), 'test', 'https://example.org/vg250',
   repeat('b', 64), 'DL-DE-BY-2.0', 'Test'),
  ('DE-BW', ST_Multi(ST_MakeEnvelope(500000, 5300000, 600000, 5400000, 25832)), 'test', 'https://example.org/vg250',
   repeat('b', 64), 'DL-DE-BY-2.0', 'Test');
INSERT INTO stop_place (stop_place_id, name, name_source_id, geom_source_id, dhid, ifopt, country_code, geom) VALUES
  ('${place.a}', 'A', 'test-stops', 'test-stops', 'de:09162:1', NULL, 'DE',
   ST_Transform(ST_SetSRID(ST_MakePoint(650000, 5350000), 25832), 4326)),
  ('${place.b}', 'B', 'test-stops', 'test-stops', 'de:08111:1', NULL, 'DE',
   ST_Transform(ST_SetSRID(ST_MakePoint(550000, 5350000), 25832), 4326)),
  ('${place.c}', 'C', 'test-stops', 'test-stops', 'de:09999:1', NULL, 'DE',
   ST_Transform(ST_SetSRID(ST_MakePoint(700050, 5350000), 25832), 4326)),
  ('${place.d}', 'D', 'test-stops', 'test-stops', NULL, 'at:4:1', 'AT',
   ST_Transform(ST_SetSRID(ST_MakePoint(705000, 5350000), 25832), 4326)),
  ('${place.f}', 'F', 'test-stops', 'test-stops', NULL, NULL, 'DE',
   ST_Transform(ST_SetSRID(ST_MakePoint(700150, 5350000), 25832), 4326));
INSERT INTO stop_place (stop_place_id, name, name_source_id) VALUES ('${place.e}', 'E', 'test-stops');
`;

function instance(id: string, category: string, operator: string, number: string, origin: string) {
  return `INSERT INTO trip_instance (trip_instance_id, service_date, operator_id, train_number,
      category_code, origin_stop_place_id, origin_departure, is_added, first_source_id,
      first_observed_at, first_raw_object_id)
    SELECT '${id}', '2026-10-27', '${operator}', '${number}', '${category}', '${origin}',
           '2026-10-27T07:00:00Z', true, '${delfi}', '2026-10-27T06:00:00Z', raw_object_id
      FROM raw_object WHERE source_id = '${delfi}';`;
}

interface StopRow {
  instance: string;
  index: number;
  source: string;
  place: string;
  arr?: string;
  dep?: string;
  finalArr?: string;
  finalDep?: string;
  cancelled?: boolean;
  quality?: "live" | "carried";
  kind?: "explicit" | "propagated";
}

const at = (iso: string, seconds: number) =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString();
const text = (value: string | undefined) => (value === undefined ? "NULL" : `'${value}'`);

function stopEvent(row: StopRow): string {
  const decided = row.finalArr !== undefined || row.finalDep !== undefined;
  return `INSERT INTO stop_event (service_date, trip_instance_id, stop_index, source_id, stop_place_id,
      scheduled_arrival, scheduled_departure, final_arrival, final_departure, final_quality,
      prediction_kind, cancelled, additional, observed_at, raw_object_id)
    SELECT '2026-10-27', '${row.instance}', ${row.index}, '${row.source}', '${row.place}',
      ${text(row.arr)}, ${text(row.dep)}, ${text(row.finalArr)}, ${text(row.finalDep)},
      ${decided ? text(row.quality ?? "live") : "NULL"}, ${text(row.kind)}, ${row.cancelled === true},
      false, '2026-10-27T12:00:00Z', raw_object_id
    FROM raw_object WHERE source_id = '${row.source}';`;
}

interface LegRow {
  instance: string;
  from: number;
  to: number;
  source: string;
  fromPlace: string;
  toPlace: string;
  dep: number;
  arr: number;
  runSched: number;
  runAct: number;
  distance?: number;
}

function leg(row: LegRow): string {
  return `INSERT INTO segment_obs (service_date, trip_instance_id, from_index, source_id, to_index,
      from_stop_place_id, to_stop_place_id, dep_delay_from_s, arr_delay_to_s, delay_gain_s,
      run_sched_s, run_act_s, distance_m, observed_at, raw_object_id)
    SELECT '2026-10-27', '${row.instance}', ${row.from}, '${row.source}', ${row.to},
      '${row.fromPlace}', '${row.toPlace}', ${row.dep}, ${row.arr}, ${row.arr - row.dep},
      ${row.runSched}, ${row.runAct}, ${row.distance ?? "NULL"}, '2026-10-27T12:00:00Z', raw_object_id
    FROM raw_object WHERE source_id = '${row.source}';`;
}

const t0 = "2026-10-27T07:00:00Z";
const t1 = "2026-10-27T07:30:00Z";
const t2 = "2026-10-27T08:00:00Z";
const t3 = "2026-10-27T09:00:00Z";
const t4 = "2026-10-27T10:00:00Z";
const q0 = "2026-10-27T07:10:00Z";
const q1 = "2026-10-27T07:40:00Z";

const events: StopRow[] = [
  {
    instance: run.regional,
    index: 0,
    source: delfi,
    place: place.a,
    dep: t0,
    finalDep: at(t0, 359),
  },
  {
    instance: run.regional,
    index: 0,
    source: gtfsde,
    place: place.a,
    dep: t0,
    finalDep: at(t0, 600),
  },
  { instance: run.regional, index: 1, source: delfi, place: place.b, arr: t1, dep: at(t1, 120) },
  {
    instance: run.regional,
    index: 1,
    source: gtfsde,
    place: place.b,
    arr: t1,
    dep: at(t1, 120),
    finalArr: at(t1, 360),
    finalDep: at(t1, 520),
  },
  {
    instance: run.regional,
    index: 2,
    source: delfi,
    place: place.c,
    arr: t2,
    finalArr: at(t2, -1860),
  },
  {
    instance: run.regional,
    index: 2,
    source: gtfsde,
    place: place.c,
    arr: t2,
    finalArr: at(t2, 959),
  },
  {
    instance: run.express,
    index: 0,
    source: gtfsde,
    place: place.c,
    dep: t3,
    finalDep: at(t3, 960),
  },
  { instance: run.express, index: 0, source: delfi, place: place.c, dep: t3, finalDep: at(t3, 0) },
  { instance: run.express, index: 1, source: gtfsde, place: place.d, arr: t4, cancelled: true },
  { instance: run.express, index: 1, source: delfi, place: place.d, arr: t4, finalArr: at(t4, 60) },
  { instance: run.quiet, index: 0, source: delfi, place: place.a, dep: q0 },
  {
    instance: run.quiet,
    index: 1,
    source: delfi,
    place: place.b,
    arr: q1,
    finalArr: at(q1, -1500),
  },
];

const legs: LegRow[] = [
  {
    instance: run.regional,
    from: 0,
    to: 1,
    source: delfi,
    fromPlace: place.a,
    toPlace: place.b,
    dep: 359,
    arr: 459,
    runSched: 1800,
    runAct: 1900,
  },
  {
    instance: run.regional,
    from: 0,
    to: 1,
    source: gtfsde,
    fromPlace: place.a,
    toPlace: place.b,
    dep: 600,
    arr: 650,
    runSched: 1800,
    runAct: 1850,
  },
  {
    instance: run.regional,
    from: 1,
    to: 2,
    source: gtfsde,
    fromPlace: place.b,
    toPlace: place.c,
    dep: 400,
    arr: 959,
    runSched: 1680,
    runAct: 1700,
    distance: 10000,
  },
];

describe.skipIf(!reachable)(suiteName, () => {
  const databaseName = `gerlines_test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = withDatabase(serverUrl, databaseName);
  let admin: pg.Client;
  let client: pg.Client;

  async function rows<T extends pg.QueryResultRow>(query: string): Promise<T[]> {
    return (await client.query<T>(query)).rows;
  }

  async function refreshAll(): Promise<void> {
    for (const name of rollups) {
      await client.query(`CALL refresh_continuous_aggregate('${name}', NULL, NULL)`);
    }
  }

  async function stationDay() {
    return rows<{
      stop_place_id: string;
      category_code: string;
      n_stops: string;
      n_cancelled: string;
      n_no_data: string;
      n_observed: string;
      n_lt_6min: string;
      n_lt_16min: string;
      sum_delay_s: string;
      delay_hist: string[];
    }>(
      `SELECT stop_place_id, category_code, n_stops, n_cancelled, n_no_data, n_observed, n_lt_6min,
              n_lt_16min, sum_delay_s, stat_hist_counts(delay_hist) AS delay_hist
         FROM station_day ORDER BY stop_place_id, category_code`,
    );
  }

  function bins(size: number, counts: Record<number, number>): string[] {
    return Array.from({ length: size }, (_, bin) => String(counts[bin] ?? 0));
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(databaseName)} TEMPLATE template0`);
    await migrateUp({ databaseUrl, lockWaitMs: 1000 });
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(
      `SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_refresh_continuous_aggregate'`,
    );
    await client.query(seed);
    await client.query(instance(run.regional, "reg", "op-a", "100", place.a));
    await client.query(instance(run.express, "hsr", "op-b", "200", place.c));
    await client.query(instance(run.quiet, "reg", "op-a", "101", place.a));
    for (const row of events) await client.query(stopEvent(row));
    for (const row of legs) await client.query(leg(row));
  });

  afterAll(async () => {
    await client?.end();
    if (admin) {
      await admin.query(
        `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(databaseName)} WITH (FORCE)`,
      );
      await admin.end();
    }
  });

  it("keeps the bin functions and the stat_bin table in agreement at every edge", async () => {
    const [mismatch] = await rows<{ count: string }>(
      `SELECT count(*) FROM stat_bin b WHERE
         (b.kind = 'delay' AND ((b.lower_value IS NOT NULL AND stat_delay_bin(b.lower_value) <> b.bin)
           OR (b.upper_value IS NOT NULL AND stat_delay_bin(b.upper_value - 1) <> b.bin)))
         OR (b.kind = 'gain' AND ((b.lower_value IS NOT NULL AND stat_gain_bin(b.lower_value) <> b.bin)
           OR (b.upper_value IS NOT NULL AND stat_gain_bin(b.upper_value - 1) <> b.bin)))
         OR (b.kind = 'speed' AND (stat_speed_bin(b.lower_value) <> b.bin
           OR (b.upper_value IS NOT NULL AND stat_speed_bin(b.upper_value - 0.001) <> b.bin)))`,
    );
    expect(mismatch?.count).toBe("0");
    const [edges] = await rows<Record<string, number | null>>(
      `SELECT stat_delay_bin(-1801) AS too_early, stat_delay_bin(-1800) AS earliest,
              stat_delay_bin(359) AS d359, stat_delay_bin(360) AS d360, stat_delay_bin(959) AS d959,
              stat_delay_bin(960) AS d960, stat_delay_bin(86400) AS day, stat_gain_bin(-86400) AS gmin,
              stat_gain_bin(0) AS g0, stat_gain_bin(-1) AS gm1, stat_speed_bin(299.99) AS s299,
              stat_speed_bin(-1) AS sneg, (SELECT count(*)::int FROM stat_bin WHERE kind = 'delay') AS nd,
              (SELECT count(*)::int FROM stat_bin WHERE kind = 'gain') AS ng,
              (SELECT count(*)::int FROM stat_bin WHERE kind = 'speed') AS ns`,
    );
    expect(edges).toEqual({
      too_early: null,
      earliest: 0,
      d359: 7,
      d360: 8,
      d959: 17,
      d960: 18,
      day: 29,
      gmin: 0,
      g0: 7,
      gm1: 6,
      s299: 29,
      sneg: null,
      nd: 30,
      ng: 21,
      ns: 31,
    });
  });

  it("assigns each stop place a Land by point in polygon, foreign as its own value", async () => {
    const assigned = await rows<{ name: string; land_code: string | null; method: string }>(
      `SELECT s.name, l.land_code, l.method, round(l.distance_m) AS distance
         FROM stop_place s JOIN stop_place_land l USING (stop_place_id) ORDER BY s.name`,
    );
    expect(assigned).toEqual([
      { name: "A", land_code: "DE-BY", method: "within", distance: 0 },
      { name: "B", land_code: "DE-BW", method: "within", distance: 0 },
      { name: "C", land_code: "DE-BY", method: "nearest", distance: 50 },
      { name: "D", land_code: "foreign", method: "outside", distance: 5000 },
      { name: "E", land_code: null, method: "no_geometry", distance: null },
      { name: "F", land_code: "foreign", method: "outside", distance: 150 },
    ]);
    await client.query(
      `UPDATE stop_place SET geom = ST_Transform(ST_SetSRID(ST_MakePoint(520000, 5350000), 25832), 4326)
        WHERE stop_place_id = '${place.d}'`,
    );
    const [moved] = await rows<{ land_code: string }>(
      `SELECT land_code FROM stop_place_land WHERE stop_place_id = '${place.d}'`,
    );
    expect(moved?.land_code).toBe("DE-BW");
    await client.query(
      `UPDATE stop_place SET geom = ST_Transform(ST_SetSRID(ST_MakePoint(705000, 5350000), 25832), 4326)
        WHERE stop_place_id = '${place.d}'`,
    );
    const [back] = await rows<{ land_code: string }>(
      `SELECT land_code FROM stop_place_land WHERE stop_place_id = '${place.d}'`,
    );
    expect(back?.land_code).toBe("foreign");
  });

  it("serves only materialised rows, so nothing before the first refresh", async () => {
    expect(await stationDay()).toEqual([]);
    await refreshAll();
    expect((await stationDay()).length).toBeGreaterThan(0);
  });

  it("takes each stop from the best-ranked source that has a final, by category", async () => {
    const stops = await rows<{
      trip_instance_id: string;
      stop_index: number;
      source_id: string | null;
      n_sources: number;
      stop_delay_s: number | null;
      cancelled: boolean | null;
      local_hour: number;
    }>(
      `SELECT trip_instance_id, stop_index, source_id, n_sources, stop_delay_s, cancelled, local_hour
         FROM stat_stop ORDER BY trip_instance_id, stop_index`,
    );
    expect(stops).toEqual([
      {
        trip_instance_id: run.regional,
        stop_index: 0,
        source_id: delfi,
        n_sources: 2,
        stop_delay_s: 359,
        cancelled: false,
        local_hour: 8,
      },
      {
        trip_instance_id: run.regional,
        stop_index: 1,
        source_id: gtfsde,
        n_sources: 2,
        stop_delay_s: 360,
        cancelled: false,
        local_hour: 8,
      },
      {
        trip_instance_id: run.regional,
        stop_index: 2,
        source_id: delfi,
        n_sources: 2,
        stop_delay_s: null,
        cancelled: false,
        local_hour: 9,
      },
      {
        trip_instance_id: run.express,
        stop_index: 0,
        source_id: gtfsde,
        n_sources: 2,
        stop_delay_s: 960,
        cancelled: false,
        local_hour: 10,
      },
      {
        trip_instance_id: run.express,
        stop_index: 1,
        source_id: gtfsde,
        n_sources: 2,
        stop_delay_s: null,
        cancelled: true,
        local_hour: 11,
      },
      {
        trip_instance_id: run.quiet,
        stop_index: 0,
        source_id: null,
        n_sources: 1,
        stop_delay_s: null,
        cancelled: null,
        local_hour: 8,
      },
      {
        trip_instance_id: run.quiet,
        stop_index: 1,
        source_id: delfi,
        n_sources: 1,
        stop_delay_s: -1500,
        cancelled: false,
        local_hour: 8,
      },
    ]);
  });

  it("counts punctuality by DB's 5:59 and 15:59 rules with cancelled stops excluded", async () => {
    expect(await stationDay()).toEqual([
      {
        stop_place_id: place.a,
        category_code: "reg",
        n_stops: "2",
        n_cancelled: "0",
        n_no_data: "1",
        n_observed: "1",
        n_lt_6min: "1",
        n_lt_16min: "1",
        sum_delay_s: "359",
        delay_hist: bins(30, { 7: 1 }),
      },
      {
        stop_place_id: place.b,
        category_code: "reg",
        n_stops: "2",
        n_cancelled: "0",
        n_no_data: "0",
        n_observed: "2",
        n_lt_6min: "1",
        n_lt_16min: "2",
        sum_delay_s: "-1140",
        delay_hist: bins(30, { 0: 1, 8: 1 }),
      },
      {
        stop_place_id: place.c,
        category_code: "hsr",
        n_stops: "1",
        n_cancelled: "0",
        n_no_data: "0",
        n_observed: "1",
        n_lt_6min: "0",
        n_lt_16min: "0",
        sum_delay_s: "960",
        delay_hist: bins(30, { 18: 1 }),
      },
      {
        stop_place_id: place.c,
        category_code: "reg",
        n_stops: "1",
        n_cancelled: "0",
        n_no_data: "0",
        n_observed: "0",
        n_lt_6min: "0",
        n_lt_16min: "0",
        sum_delay_s: null,
        delay_hist: null,
      },
      {
        stop_place_id: place.d,
        category_code: "hsr",
        n_stops: "1",
        n_cancelled: "1",
        n_no_data: "0",
        n_observed: "0",
        n_lt_6min: "0",
        n_lt_16min: "0",
        sum_delay_s: null,
        delay_hist: null,
      },
    ]);
  });

  it("rolls stops up by Land, hour, train and line", async () => {
    const lands = await rows<{
      land_code: string;
      category_code: string;
      n_stops: string;
      n_observed_arr: string;
    }>(`SELECT land_code, category_code, n_stops, n_observed_arr FROM land_day ORDER BY 1, 2`);
    expect(lands).toEqual([
      { land_code: "DE-BW", category_code: "reg", n_stops: "2", n_observed_arr: "2" },
      { land_code: "DE-BY", category_code: "hsr", n_stops: "1", n_observed_arr: "0" },
      { land_code: "DE-BY", category_code: "reg", n_stops: "3", n_observed_arr: "0" },
      { land_code: "foreign", category_code: "hsr", n_stops: "1", n_observed_arr: "0" },
    ]);
    const hours = await rows<{ local_hour: number; n_stops: string }>(
      `SELECT local_hour, n_stops FROM station_hour WHERE stop_place_id = '${place.a}'`,
    );
    expect(hours).toEqual([{ local_hour: 8, n_stops: "2" }]);
    const trains = await rows<{ train_number: string; n_runs: string; n_observed: string }>(
      `SELECT train_number, n_runs, n_observed FROM train_day ORDER BY 1`,
    );
    expect(trains).toEqual([
      { train_number: "100", n_runs: "1", n_observed: "2" },
      { train_number: "101", n_runs: "1", n_observed: "1" },
      { train_number: "200", n_runs: "1", n_observed: "1" },
    ]);
  });

  it("rolls legs up per segment with delay gain bins and speed only where a distance exists", async () => {
    const segments = await rows<{
      from_stop_place_id: string;
      n_legs: string;
      sum_gain_s: string;
      gain_hist: string[];
      n_speed: string;
      speed_hist: string[] | null;
    }>(
      `SELECT from_stop_place_id, n_legs, sum_gain_s, stat_hist_counts(gain_hist) AS gain_hist,
              n_speed, stat_hist_counts(speed_hist) AS speed_hist
         FROM segment_day ORDER BY from_stop_place_id`,
    );
    expect(segments).toEqual([
      {
        from_stop_place_id: place.a,
        n_legs: "1",
        sum_gain_s: "100",
        gain_hist: bins(21, { 8: 1 }),
        n_speed: "0",
        speed_hist: null,
      },
      {
        from_stop_place_id: place.b,
        n_legs: "1",
        sum_gain_s: "559",
        gain_hist: bins(21, { 16: 1 }),
        n_speed: "1",
        speed_hist: bins(31, { 2: 1 }),
      },
    ]);
  });

  it("merges histograms over a period and reads quantiles from them", async () => {
    const [merged] = await rows<{ hist: string[]; median: number; p0: number }>(
      `SELECT stat_hist_counts(stat_hist_sum(delay_hist)) AS hist,
              stat_hist_quantile(stat_hist_sum(delay_hist), 'delay', 0.5) AS median,
              stat_hist_quantile(stat_hist_sum(delay_hist), 'delay', 0) AS p0
         FROM station_day`,
    );
    expect(merged?.hist).toEqual(bins(30, { 0: 1, 7: 1, 8: 1, 18: 1 }));
    expect(merged?.median).toBe(360);
    expect(merged?.p0).toBe(-1800);
    const [types] = await rows<{ sum_type: string }>(
      `SELECT pg_typeof(stat_hist_sum(delay_hist))::text AS sum_type FROM station_day`,
    );
    expect(types?.sum_type).toBe("bigint[]");
    await expect(
      client.query(
        `SELECT stat_hist_sum(h) FROM (VALUES (ARRAY[1, 2]), (ARRAY[1, 2, 3])) AS v (h)`,
      ),
    ).rejects.toThrow(/different lengths/);
  });

  it("starts level 1 at least 10 minutes after the migration and level 2 before it", async () => {
    const jobs = await rows<{ hypertable_name: string; first_run: string; applied: string }>(
      `SELECT j.hypertable_name, j.initial_start::text AS first_run,
              (SELECT applied_at FROM gerlines_meta.migration WHERE version = 62)::text AS applied
         FROM timescaledb_information.jobs j
        WHERE j.proc_name = 'policy_refresh_continuous_aggregate'`,
    );
    const levelOne = new Set(["stat_stop", "stat_segment"]);
    const first = (names: (name: string) => boolean) =>
      jobs.filter((job) => names(job.hypertable_name)).map((job) => Date.parse(job.first_run));
    const applied = Date.parse(jobs[0]?.applied ?? "");
    const levelOneStarts = first((name) => levelOne.has(name));
    const levelTwoStarts = first((name) => !levelOne.has(name));
    expect(levelOneStarts).toHaveLength(2);
    expect(levelTwoStarts).toHaveLength(rollups.length - 2);
    expect(Math.min(...levelOneStarts) - applied).toBeGreaterThanOrEqual(10 * 60_000);
    expect(Math.max(...levelTwoStarts)).toBeLessThan(Math.min(...levelOneStarts));
  });

  it("refreshes every rollup on a schedule and picks up late data only after a refresh", async () => {
    const jobs = await rows<{
      hypertable_name: string;
      schedule_interval: string;
      start_offset: string | null;
      minute: number;
    }>(
      `SELECT j.hypertable_name, j.schedule_interval::text, j.config->>'start_offset' AS start_offset,
              extract(minute FROM j.initial_start)::int AS minute
         FROM timescaledb_information.jobs j
        WHERE j.proc_name = 'policy_refresh_continuous_aggregate'`,
    );
    expect(jobs).toHaveLength(rollups.length);
    expect(new Set(jobs.map((job) => job.schedule_interval))).toEqual(new Set(["00:30:00"]));
    expect(jobs.every((job) => job.start_offset === null)).toBe(true);
    expect(new Set(jobs.map((job) => job.minute)).size).toBe(rollups.length);

    await client.query(
      `UPDATE stop_event SET final_departure = scheduled_departure, observed_at = '2026-10-28T12:00:00Z'
        WHERE trip_instance_id = '${run.regional}' AND stop_index = 0 AND source_id = '${delfi}'`,
    );
    await client.query(
      stopEvent({
        instance: run.quiet,
        index: 0,
        source: gtfsde,
        place: place.a,
        dep: q0,
        finalDep: at(q0, 120),
      }),
    );
    const before = (await stationDay()).find((row) => row.stop_place_id === place.a);
    expect(before?.delay_hist).toEqual(bins(30, { 7: 1 }));
    await refreshAll();
    const after = (await stationDay()).find((row) => row.stop_place_id === place.a);
    expect(after).toMatchObject({
      n_no_data: "0",
      n_observed: "2",
      n_lt_6min: "2",
      sum_delay_s: "120",
    });
    expect(after?.delay_hist).toEqual(bins(30, { 2: 1, 4: 1 }));
  });

  it("takes a live final from the next source over a carried final, and counts carried and propagated", async () => {
    const t5 = "2026-10-27T11:00:00Z";
    await client.query(instance(run.dropped, "reg", "op-a", "102", place.a));
    for (const row of [
      {
        instance: run.dropped,
        index: 0,
        source: delfi,
        place: place.a,
        dep: t5,
        finalDep: at(t5, 60),
      },
      {
        instance: run.dropped,
        index: 1,
        source: delfi,
        place: place.b,
        arr: at(t5, 1800),
        finalArr: at(t5, 1860),
        quality: "carried" as const,
        kind: "propagated" as const,
      },
      {
        instance: run.dropped,
        index: 1,
        source: gtfsde,
        place: place.b,
        arr: at(t5, 1800),
        finalArr: at(t5, 2400),
        kind: "explicit" as const,
      },
      {
        instance: run.dropped,
        index: 2,
        source: delfi,
        place: place.c,
        arr: at(t5, 3600),
        finalArr: at(t5, 3660),
        quality: "carried" as const,
        kind: "propagated" as const,
      },
    ]) {
      await client.query(stopEvent(row));
    }
    await refreshAll();
    const stops = await rows<{
      stop_index: number;
      source_id: string;
      final_quality: string;
      prediction_kind: string;
      stop_delay_s: number;
    }>(
      `SELECT stop_index, source_id, final_quality, prediction_kind, stop_delay_s FROM stat_stop
        WHERE trip_instance_id = '${run.dropped}' ORDER BY stop_index`,
    );
    expect(stops).toEqual([
      {
        stop_index: 0,
        source_id: delfi,
        final_quality: "live",
        prediction_kind: null,
        stop_delay_s: 60,
      },
      {
        stop_index: 1,
        source_id: gtfsde,
        final_quality: "live",
        prediction_kind: "explicit",
        stop_delay_s: 600,
      },
      {
        stop_index: 2,
        source_id: delfi,
        final_quality: "carried",
        prediction_kind: "propagated",
        stop_delay_s: 60,
      },
    ]);
    const [train] = await rows<Record<string, string>>(
      `SELECT n_observed, n_observed_arr, n_lt_6min_arr, n_observed_carried, n_observed_propagated
         FROM train_day WHERE train_number = '102'`,
    );
    expect(train).toEqual({
      n_observed: "3",
      n_observed_arr: "2",
      n_lt_6min_arr: "1",
      n_observed_carried: "1",
      n_observed_propagated: "1",
    });
  });
});

describe.skipIf(!reachable)(`${suiteName}: policies on fresh databases`, () => {
  const policies = `SELECT job_id FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_refresh_continuous_aggregate'`;
  const created: string[] = [];
  const clients: pg.Client[] = [];
  let admin: pg.Client;
  let stopped: pg.Client;

  async function freshDatabase(options: { schedulerStopped: boolean }): Promise<pg.Client> {
    const name = `gerlines_test_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE template0`);
    created.push(name);
    const databaseUrl = withDatabase(serverUrl, name);
    const client = new pg.Client({ connectionString: databaseUrl });
    clients.push(client);
    if (options.schedulerStopped) {
      await migrateUp({ databaseUrl, lockWaitMs: 1000, targetVersion: 1 });
      await client.connect();
      await client.query("SELECT _timescaledb_functions.stop_background_workers()");
      await migrateUp({ databaseUrl, lockWaitMs: 1000 });
    } else {
      await migrateUp({ databaseUrl, lockWaitMs: 1000 });
      await client.connect();
    }
    return client;
  }

  async function seedStops(client: pg.Client): Promise<void> {
    await client.query(seed);
    await client.query(instance(run.regional, "reg", "op-a", "100", place.a));
    await client.query(instance(run.express, "hsr", "op-b", "200", place.c));
    await client.query(instance(run.quiet, "reg", "op-a", "101", place.a));
    for (const row of events) await client.query(stopEvent(row));
    for (const row of legs) await client.query(leg(row));
  }

  async function runEveryPolicyThenLevelTwoAgain(
    client: pg.Client,
    start: () => Promise<void>,
  ): Promise<void> {
    const [{ since } = { since: "" }] = (
      await client.query<{ since: string }>("SELECT now()::text AS since")
    ).rows;
    await client.query(
      `SELECT alter_job(job_id, scheduled => true, next_start => now()) FROM (${policies}) p`,
    );
    await start();
    const deadline = Date.now() + 45_000;
    for (;;) {
      const [state] = (
        await client.query<{ done: number; failed: number }>(
          `SELECT count(*) FILTER (WHERE s.last_successful_finish > $1::timestamptz)::int AS done,
                  coalesce(sum(s.total_failures), 0)::int AS failed
             FROM (${policies}) p JOIN timescaledb_information.job_stats s USING (job_id)`,
          [since],
        )
      ).rows;
      expect(state?.failed).toBe(0);
      if (state?.done === rollups.length) break;
      if (Date.now() > deadline) throw new Error(`only ${state?.done} policies ran`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await client.query(`SELECT alter_job(job_id, scheduled => false) FROM (${policies}) p`);
    const levelTwo = await client.query<{ job_id: number }>(
      `${policies} AND hypertable_name NOT IN ('stat_stop', 'stat_segment') ORDER BY job_id`,
    );
    for (const { job_id } of levelTwo.rows) await client.query(`CALL run_job(${job_id})`);
  }

  async function counts(client: pg.Client) {
    const [row] = (
      await client.query<Record<string, number>>(
        `SELECT (SELECT count(*) FROM stat_stop)::int AS stat_stop,
                (SELECT count(*) FROM stat_segment)::int AS stat_segment,
                (SELECT coalesce(sum(n_stops), 0) FROM station_day)::int AS station_day,
                (SELECT coalesce(sum(n_stops), 0) FROM station_hour)::int AS station_hour,
                (SELECT coalesce(sum(n_stops), 0) FROM train_day)::int AS train_day,
                (SELECT coalesce(sum(n_stops), 0) FROM line_day)::int AS line_day,
                (SELECT coalesce(sum(n_legs), 0) FROM segment_day)::int AS segment_day,
                (SELECT coalesce(sum(n_stops), 0) FROM land_category_day)::int AS land_category_day,
                (SELECT coalesce(sum(n_stops), 0) FROM land_category_hour)::int AS land_category_hour`,
      )
    ).rows;
    return row;
  }

  function expectLevelTwoHoldsEveryLevelOneRow(found: Record<string, number> | undefined): void {
    expect(found?.stat_stop).toBeGreaterThan(0);
    expect(found?.stat_segment).toBeGreaterThan(0);
    expect(found).toEqual({
      stat_stop: found?.stat_stop,
      stat_segment: found?.stat_segment,
      station_day: found?.stat_stop,
      station_hour: found?.stat_stop,
      train_day: found?.stat_stop,
      line_day: found?.stat_stop,
      segment_day: found?.stat_segment,
      land_category_day: found?.stat_stop,
      land_category_hour: found?.stat_stop,
    });
  }

  async function loggedDaysBeyondLevelOne(client: pg.Client) {
    return (
      await client.query<{ name: string; margin_days: number | null }>(
        `SELECT parent.user_view_name AS name,
                _timescaledb_functions.to_timestamp_without_timezone(t.watermark)::date
                  - (now() - (j.config->>'end_offset')::interval)::date AS margin_days
           FROM _timescaledb_catalog.continuous_agg parent
           JOIN timescaledb_information.jobs j
             ON j.proc_name = 'policy_refresh_continuous_aggregate'
            AND j.hypertable_name = parent.user_view_name
           LEFT JOIN _timescaledb_catalog.continuous_aggs_invalidation_threshold t
             ON t.hypertable_id = parent.mat_hypertable_id
          WHERE parent.parent_mat_hypertable_id IS NULL
          ORDER BY 1`,
      )
    ).rows;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    stopped = await freshDatabase({ schedulerStopped: true });
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => undefined);
    if (admin) {
      for (const name of created) {
        await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
      }
      await admin.end();
    }
  });

  it("logs every level-1 write from the migration on, before any policy has run", async () => {
    const [runs] = (
      await stopped.query<{ runs: number }>(
        `SELECT coalesce(sum(s.total_runs), 0)::int AS runs
           FROM (${policies}) p LEFT JOIN timescaledb_information.job_stats s USING (job_id)`,
      )
    ).rows;
    expect(runs?.runs).toBe(0);
    const margins = await loggedDaysBeyondLevelOne(stopped);
    expect(margins.map((row) => row.name)).toEqual(["stat_segment", "stat_stop"]);
    for (const row of margins) expect(row.margin_days).toBeGreaterThanOrEqual(1);
    const offsets = await stopped.query<{ name: string; end_offset: string }>(
      `SELECT hypertable_name AS name, (config->>'end_offset')::interval::text AS end_offset
         FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_refresh_continuous_aggregate' ORDER BY 1`,
    );
    expect(Object.fromEntries(offsets.rows.map((row) => [row.name, row.end_offset]))).toEqual({
      land_category_day: "-14 days",
      land_category_hour: "-14 days",
      line_day: "-7 days",
      segment_day: "-7 days",
      stat_segment: "-2 days",
      stat_stop: "-2 days",
      station_day: "-7 days",
      station_hour: "-7 days",
      train_day: "-7 days",
    });
  });

  it("keeps every level-1 row when the scheduler starts after the first level-1 run is due", async () => {
    await seedStops(stopped);
    await runEveryPolicyThenLevelTwoAgain(stopped, async () => {
      await stopped.query("SELECT _timescaledb_functions.start_background_workers()");
    });
    expectLevelTwoHoldsEveryLevelOneRow(await counts(stopped));
  });

  it("keeps every level-1 row when paused policies resume together", async () => {
    const client = await freshDatabase({ schedulerStopped: false });
    await client.query(`SELECT alter_job(job_id, scheduled => false) FROM (${policies}) p`);
    await seedStops(client);
    await runEveryPolicyThenLevelTwoAgain(client, async () => undefined);
    expectLevelTwoHoldsEveryLevelOneRow(await counts(client));
    for (const row of await loggedDaysBeyondLevelOne(client)) {
      expect(row.margin_days).toBeGreaterThanOrEqual(1);
    }
  });
});
