import { randomBytes } from "node:crypto";
import {
  createDatabase,
  type DB,
  migrateUp,
  readTrainSegments,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  withDatabase,
} from "@gerlines/db";
import { STATS_GAIN_BINS, STATS_SPEED_BINS, StatsTrainSegments } from "@gerlines/schema/stats";
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
const C = "6eda9b92-2ddf-5610-b59b-ed665a8b2610";
const D = "7eda9b92-2ddf-5610-b59b-ed665a8b2610";

const SEED = `
INSERT INTO source (source_id, name, licence, attribution) VALUES ('test-rt', 'Test realtime', 'CC-BY-4.0', 'Test');
INSERT INTO ingest_run (source_id, job, app_version) VALUES ('test-rt', 'poll', '0.0.0-test');
INSERT INTO raw_object (source_id, ingest_run_id, object_key, sha256, bytes, content_type, fetched_at, http_status)
  SELECT 'test-rt', ingest_run_id, 'test-rt/a', repeat('a', 64), 1, 'application/octet-stream',
         '2025-11-01T00:00:00Z', 200 FROM ingest_run;
INSERT INTO stop_place (stop_place_id, name, name_source_id) VALUES
  ('${A}', 'Hamburg Hbf', 'test-rt'), ('${B}', 'Hannover Hbf', 'test-rt'),
  ('${C}', 'Göttingen', 'test-rt'), ('${D}', 'Celle', 'test-rt');
INSERT INTO stop_place_display_name (stop_place_id, name, source_id, rule)
  VALUES ('${A}', 'Hamburg Hauptbahnhof', 'test-rt', 'test');
INSERT INTO operator (operator_id, name, name_source_id) VALUES ('test-bus', 'Test Bus GmbH', 'test-rt');
`;

interface Leg {
  from: string;
  to: string;
  gain: number;
  distance?: number;
}

interface Run {
  day: string;
  number: string;
  category: string;
  operator?: string;
  legs: Leg[];
}

const DAYS = ["2025-11-03", "2025-11-04", "2025-11-05", "2025-11-06", "2025-11-07"];
const ICE_GAINS = [60, 60, 120, 0, -60];

const RUNS: Run[] = [
  ...DAYS.map((day, index) => ({
    day,
    number: "596",
    category: "hsr",
    legs: [
      { from: A, to: B, gain: ICE_GAINS[index] ?? 0 },
      { from: B, to: C, gain: 30, distance: 20_000 },
    ],
  })),
  {
    day: "2025-11-08",
    number: "596",
    category: "hsr",
    legs: [
      { from: A, to: B, gain: 0 },
      { from: B, to: D, gain: 300 },
    ],
  },
  { day: "2025-11-12", number: "596", category: "hsr", legs: [{ from: A, to: C, gain: 0 }] },
  {
    day: "2025-11-05",
    number: "596",
    category: "bus",
    operator: "test-bus",
    legs: [{ from: A, to: B, gain: 0 }],
  },
  ...DAYS.slice(0, 3).map((day) => ({
    day,
    number: "100",
    category: "reg",
    legs: [{ from: A, to: B, gain: 600, distance: 50_000 }],
  })),
];

function runSql(run: Run, index: number): string {
  const id = `0190f000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
  const legs = run.legs
    .map(
      (
        leg,
        stop,
      ) => `INSERT INTO segment_obs (service_date, trip_instance_id, from_index, source_id, to_index,
        from_stop_place_id, to_stop_place_id, dep_delay_from_s, arr_delay_to_s, delay_gain_s, run_sched_s,
        run_act_s, distance_m, observed_at, raw_object_id)
      SELECT '${run.day}', '${id}', ${stop}, 'test-rt', ${stop + 1}, '${leg.from}', '${leg.to}', 0, ${leg.gain},
             ${leg.gain}, 540, 600, ${leg.distance ?? "NULL"}, '${run.day}T12:00:00Z', raw_object_id FROM raw_object;`,
    )
    .join("\n");
  const operator = run.operator ? `'${run.operator}'` : "NULL";
  return `INSERT INTO trip_instance (trip_instance_id, service_date, train_number, category_code, operator_id,
      origin_stop_place_id, origin_departure, is_added, backfill, first_source_id, first_observed_at, first_raw_object_id)
    SELECT '${id}', '${run.day}', '${run.number}', '${run.category}', ${operator}, '${run.legs[0]?.from}', '${run.day}T07:00:00Z',
           false, true, 'test-rt', '${run.day}T06:00:00Z', raw_object_id FROM raw_object;
  ${legs}`;
}

const NOVEMBER = { from: "2025-11-01", to: "2025-11-10" };

describe.skipIf(!online)(
  online
    ? "segment profile over refreshed leg rollups"
    : `segment profile (skipped: no database at ${redactDatabaseUrl(serverUrl)})`,
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
      for (const [index, run] of RUNS.entries()) await sql.raw(runSql(run, index)).execute(db);
      for (const rollup of ["stat_segment", "segment_day"]) {
        await sql.raw(`CALL refresh_continuous_aggregate('${rollup}', NULL, NULL)`).execute(db);
      }
      stats = new StatsService(new DatabaseStatsReader(db), () =>
        Date.parse("2026-11-08T05:00:00Z"),
      );
    }, 180_000);

    afterAll(async () => {
      await db?.destroy();
      if (admin) {
        await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(admin);
        await admin.destroy();
      }
    });

    it("uses the gain and speed bins of stat_bin", async () => {
      const bins = await sql<{
        kind: string;
        lower_value: number | null;
        upper_value: number | null;
      }>`
        SELECT kind, lower_value, upper_value FROM stat_bin WHERE kind IN ('gain', 'speed')
         ORDER BY kind, bin`.execute(db);
      const of = (kind: string) =>
        bins.rows
          .filter((row) => row.kind === kind)
          .map((row) => [row.lower_value, row.upper_value]);
      expect(of("gain")).toEqual(STATS_GAIN_BINS.map(([lower, upper]) => [lower, upper]));
      expect(of("speed")).toEqual(STATS_SPEED_BINS.map(([lower, upper]) => [lower, upper]));
    });

    it("follows the most frequent stop sequence, then the other legs, against every train", async () => {
      const answer = StatsTrainSegments.parse(
        await stats.trainSegments("596", null, { ...NOVEMBER, categories: ["hsr"] }),
      );
      expect(answer.route).toEqual({ runs: 6, patternRuns: 5 });
      expect(answer.truncated).toBe(false);
      expect(
        answer.segments.map((segment) => [
          segment.position,
          segment.onRoute,
          segment.from.name,
          segment.to.name,
        ]),
      ).toEqual([
        [0, true, "Hamburg Hauptbahnhof", "Hannover Hbf"],
        [1, true, "Hannover Hbf", "Göttingen"],
        [2, false, "Hannover Hbf", "Celle"],
      ]);
      const [first, second, third] = answer.segments;
      expect(first?.train).toMatchObject({
        status: "known",
        runs: 6,
        medianGainS: 0,
        p80GainS: 60,
        meanGainS: 30,
        speed: { status: "missing", legs: 0, reason: "no_distance" },
      });
      expect(first?.all).toMatchObject({
        status: "known",
        runs: 10,
        medianGainS: 60,
        p80GainS: 660,
        meanGainS: 198,
        speed: { status: "missing", legs: 3, reason: "too_few_runs" },
      });
      expect(second?.train).toMatchObject({
        status: "known",
        runs: 5,
        medianGainS: 0,
        speed: { status: "known", legs: 5, meanKmh: 120, medianKmh: 125 },
      });
      expect(third?.train).toEqual({ status: "missing", runs: 1, reason: "too_few_runs" });
      expect(third?.all).toEqual({ status: "missing", runs: 1, reason: "too_few_runs" });
    });

    it("gives the exact median of every leg on the pair and the p80 inside its bin", async () => {
      const answer = await stats.trainSegments("596", null, { ...NOVEMBER, categories: ["hsr"] });
      const exact = await sql<{ q50: number; q80: number }>`
        SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY delay_gain_s) AS q50,
               percentile_disc(0.8) WITHIN GROUP (ORDER BY delay_gain_s) AS q80
          FROM segment_obs
         WHERE from_stop_place_id = ${A}::uuid AND to_stop_place_id = ${B}::uuid
           AND service_date BETWEEN ${NOVEMBER.from}::date AND ${NOVEMBER.to}::date`.execute(db);
      const all = answer.segments[0]?.all;
      if (all?.status !== "known") throw new Error("known figures expected");
      expect(all.medianGainS).toBe(Number(exact.rows[0]?.q50));
      expect(Number(exact.rows[0]?.q80)).toBe(600);
      expect(all.p80GainS).toBeGreaterThanOrEqual(600);
      expect(all.p80GainS).toBeLessThan(900);
    });

    it("chooses runs by category and period, and cuts the list at the limit", async () => {
      const everyCategory = await stats.trainSegments("596", null, NOVEMBER);
      expect(everyCategory.groups).toEqual([
        { category: "hsr", operator: null, runs: 6, shown: true },
        {
          category: "bus",
          operator: { id: "test-bus", name: "Test Bus GmbH" },
          runs: 1,
          shown: false,
        },
      ]);
      expect(everyCategory.route).toEqual({ runs: 6, patternRuns: 5 });
      expect(everyCategory.segments[0]?.train.runs).toBe(6);
      const bus = await stats.trainSegments("596", null, { ...NOVEMBER, categories: ["bus"] });
      expect(bus.groups).toEqual([
        {
          category: "bus",
          operator: { id: "test-bus", name: "Test Bus GmbH" },
          runs: 1,
          shown: true,
        },
      ]);
      expect(bus.route).toEqual({ runs: 1, patternRuns: 1 });
      const late = await stats.trainSegments("596", null, { from: "2025-11-12", to: "2025-11-12" });
      expect(late.route).toEqual({ runs: 1, patternRuns: 1 });
      expect(late.segments.map((segment) => [segment.from.id, segment.to.id])).toEqual([[A, C]]);
      const nothing = await stats.trainSegments("596", "db-fernverkehr-ag", NOVEMBER);
      expect(nothing).toMatchObject({
        route: { runs: 0, patternRuns: 0 },
        groups: [],
        segments: [],
      });
      const cut = await readTrainSegments(db, {
        trainNumber: "596",
        ...NOVEMBER,
        categories: ["hsr"],
        limit: 1,
      });
      expect(cut.pairs).toBe(3);
      expect(cut.rows.map((row) => [row.from_stop_place_id, row.route_index])).toEqual([[A, 0]]);
    });

    it("profiles the same legs once stat_segment and segment_day are in the columnstore", async () => {
      const read = async () => [
        await stats.trainSegments("596", null, { ...NOVEMBER, categories: ["hsr"] }),
        await stats.trainSegments("596", null, NOVEMBER),
        await stats.trainSegments("596", null, { from: "2025-11-12", to: "2025-11-12" }),
      ];
      const rowstore = await read();
      await sql`SELECT compress_chunk(c, if_not_compressed => true)
                  FROM unnest(ARRAY['stat_segment', 'segment_day']) AS r (name),
                       show_chunks(r.name::regclass) AS c`.execute(db);
      expect(await read()).toEqual(rowstore);
    });
  },
);
