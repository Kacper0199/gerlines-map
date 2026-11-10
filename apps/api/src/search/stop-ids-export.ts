import { createDatabase } from "@gerlines/db";
import { DatabaseSearchSource } from "./timetable-source.ts";

const SERVICE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(text: string): boolean {
  const ms = Date.parse(`${text}T00:00:00Z`);
  return (
    SERVICE_DATE.test(text) && !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === text
  );
}

const databaseUrl = process.env.SEARCH_DATABASE_URL?.trim();
const serviceDate = process.argv[2] ?? "";
if (SERVICE_DATE.test(serviceDate) && !realDate(serviceDate)) {
  process.stderr.write(`${serviceDate} is no calendar date\n`);
  process.exit(2);
}
if (!databaseUrl || !realDate(serviceDate)) {
  process.stderr.write(
    "usage: SEARCH_DATABASE_URL=postgres://... node src/search/stop-ids-export.ts YYYY-MM-DD\n" +
      "prints stop_place_id, stop id and name of every station the search holds that day\n",
  );
  process.exit(2);
}

const db = createDatabase({
  databaseUrl,
  applicationName: "gerlines-search-stop-ids",
  maxConnections: 4,
  statementTimeoutMs: 120_000,
  queryTimeoutMs: 125_000,
});
try {
  const { stations, timetableVersion } = await new DatabaseSearchSource(db).load(serviceDate);
  const lines = stations
    .map((station) => [station.id, station.stopId ?? "", station.name].join("\t"))
    .sort();
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stderr.write(`${stations.length} stations, timetable version ${timetableVersion}\n`);
} finally {
  await db.destroy();
}
