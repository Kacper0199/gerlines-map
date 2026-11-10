import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "@gerlines/db";
import type { TrainCategory } from "@gerlines/schema";
import { resolveIdentity } from "@gerlines/schema/vehicle-resolver";
import { sql } from "kysely";
import { buildUserAgent } from "../config.ts";
import { readFormation, seriesByNumber } from "./formation.ts";
import { DatabaseIdentityStore } from "./repository.ts";
import { VehicleSequenceClient } from "./vehicle-sequence.ts";

interface Candidate {
  readonly operator_id: string;
  readonly category_code: TrainCategory;
  readonly line: string | null;
  readonly number: string;
  readonly product: string;
  readonly eva: number;
  readonly departure: string;
}

const [serviceDate = "", fromS = "0", toS = "0", limitText = "200", outDir = ""] =
  process.argv.slice(2);
const limit = Math.min(Number(limitText), 200);
const timetable = createDatabase({
  databaseUrl: process.env.TIMETABLE_DATABASE_URL ?? "",
  applicationName: "wp62-sample",
  maxConnections: 1,
});
const catalogue = createDatabase({
  databaseUrl: process.env.DATABASE_URL ?? "",
  applicationName: "wp62-sample",
  maxConnections: 1,
});
const weekday = (new Date(`${serviceDate}T00:00:00Z`).getUTCDay() + 6) % 7;
const { rows } = await sql<Candidate>`
  WITH active AS (
    SELECT t.trip_key FROM trip t JOIN service_calendar c USING (feed_version_id, service_key)
      LEFT JOIN service_calendar_date x ON x.feed_version_id = t.feed_version_id
       AND x.service_key = t.service_key AND x.service_date = ${serviceDate}::date
     WHERE t.feed_version_id = 1 AND coalesce(x.exception_type = 1, c.start_date <= ${serviceDate}::date
       AND c.end_date >= ${serviceDate}::date AND (c.weekdays >> ${weekday}::int) & 1 = 1, false)
  ), picked AS (
    SELECT r.operator_id, t.category_code, r.short_name AS line, ltrim(t.short_name, '0') AS number,
           CASE WHEN t.category_code = 'hsr' THEN 'ICE' WHEN t.category_code IN ('ld', 'night') THEN 'IC'
                WHEN t.category_code = 'sbahn' THEN 'S'
                ELSE substring(r.short_name from '^[A-Za-z]+') END AS product,
           opl.eva, (${serviceDate}::date + make_interval(secs => t.first_departure_s)) AT TIME ZONE 'Europe/Berlin' AS dep,
           row_number() OVER (PARTITION BY r.operator_id LIKE 'db-fernverkehr%' ORDER BY md5(t.trip_key)) AS rank,
           r.operator_id LIKE 'db-fernverkehr%' AS long_distance
      FROM active a JOIN trip t ON t.feed_version_id = 1 AND t.trip_key = a.trip_key
      JOIN route r ON r.feed_version_id = 1 AND r.route_key = t.route_key
      JOIN trip_pattern_stop os ON os.feed_version_id = 1 AND os.trip_pattern_id = t.trip_pattern_id AND os.stop_index = 0
      JOIN stop_point op ON op.stop_point_id = os.stop_point_id
      JOIN stop_place opl ON opl.stop_place_id = op.stop_place_id
     WHERE r.operator_id LIKE 'db-%' AND opl.eva IS NOT NULL AND t.short_name ~ '^[0-9]+$'
       AND t.first_departure_s BETWEEN ${Number(fromS)}::int AND ${Number(toS)}::int
  )
  SELECT operator_id, category_code, line, number, product, eva, to_char(dep AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS departure
    FROM picked WHERE product IS NOT NULL
     AND rank <= CASE WHEN long_distance THEN ${Math.round(limit * 0.6)}::int ELSE ${Math.round(limit * 0.4)}::int END
   ORDER BY departure`.execute(timetable);
const store = new DatabaseIdentityStore(catalogue);
const rules = await store.rules();
const seriesRows = await store.series();
const series = new Map(seriesRows.map((row) => [row.seriesId, row]));
const byNumber = seriesByNumber(seriesRows);
const client = new VehicleSequenceClient({
  userAgent: buildUserAgent(process.env, "0.0.0"),
  minIntervalMs: 3_000,
  timeoutMs: 15_000,
  maxCallsPerHour: 200,
});
mkdirSync(outDir, { recursive: true });
const results: object[] = [];
for (const train of rows.slice(0, limit)) {
  const result = await client.get({
    category: train.product,
    trainNumber: train.number,
    serviceDate,
    eva: train.eva,
    departure: train.departure,
  });
  if (result.status === "blocked") break;
  if (result.status === "ok")
    writeFileSync(
      join(outDir, `${serviceDate}-${train.number}.json`),
      JSON.stringify(result.answer),
    );
  const formation = result.status === "ok" ? readFormation(result.answer, byNumber) : null;
  const key = {
    serviceDate,
    operatorId: train.operator_id,
    category: train.category_code,
    line: train.line,
    trainNumber: train.number,
  };
  const rule = resolveIdentity(key, { rules, series });
  results.push({
    ...train,
    status: result.status,
    l0: formation?.seriesId ?? null,
    l0Units: formation?.units ?? null,
    ruleLayer: rule?.layer ?? null,
    ruleSeries: rule?.seriesId ?? null,
    alternatives: rule?.alternatives ?? [],
  });
}
writeFileSync(
  join(outDir, `sample-${serviceDate}.json`),
  JSON.stringify({ calls: client.calls, blocked: client.blocked, results }, null, 1),
);
process.stdout.write(`calls ${client.calls} blocked ${client.blocked} trains ${results.length}\n`);
await timetable.destroy();
await catalogue.destroy();
