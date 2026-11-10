import { performance } from "node:perf_hooks";
import { createDatabase } from "@gerlines/db";
import type { TrainCategory } from "@gerlines/schema";
import type { StatsLandCode } from "@gerlines/schema/stats";
import { DatabaseStatsReader, type StatsRange, StatsService } from "./service.ts";

interface Case {
  readonly name: string;
  readonly run: (service: StatsService) => Promise<unknown>;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? (process.argv[index + 1] as string) : fallback;
}

const databaseUrl = process.env.STATS_DATABASE_URL?.trim();
if (!databaseUrl) {
  process.stderr.write("STATS_DATABASE_URL is not set\n");
  process.exit(2);
}
const from = argument("from", "2025-11-01");
const to = argument("to", "2025-11-30");
const repeat = Number(argument("repeat", "3"));
const station = argument("station", "");
const land = argument("land", "DE-BY") as StatsLandCode;
const train = argument("train", "");
const segments = argument("segments", "")
  .split(",")
  .filter((item) => item !== "")
  .map((item) => {
    const [number = "", category] = item.split(":");
    return { number, category: category as TrainCategory | undefined };
  });

const db = createDatabase({
  databaseUrl,
  applicationName: "gerlines-stats-bench",
  maxConnections: 6,
  statementTimeoutMs: 60_000,
  queryTimeoutMs: 65_000,
});
const service = new StatsService(new DatabaseStatsReader(db));
const range: StatsRange = { from, to };

const network = argument("network", "yes") === "yes";
const cases: Case[] = [
  ...(network
    ? [
        { name: "period", run: (stats: StatsService) => stats.network(range) },
        { name: "land", run: (stats: StatsService) => stats.land(land, range) },
      ]
    : []),
  ...(station
    ? [{ name: "station", run: (stats: StatsService) => stats.station(station, range) }]
    : []),
  ...(train
    ? [{ name: "train", run: (stats: StatsService) => stats.train(train, null, range) }]
    : []),
  ...segments.map(({ number, category }) => ({
    name: `segments ${number}${category ? ` ${category}` : ""}`,
    run: (stats: StatsService) =>
      stats.trainSegments(number, null, {
        ...range,
        ...(category ? { categories: [category] } : {}),
      }),
  })),
];

const results: Record<string, number[]> = {};
for (const item of cases) {
  const timings: number[] = [];
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    const began = performance.now();
    await item.run(service);
    timings.push(Math.round(performance.now() - began));
  }
  results[item.name] = timings;
}
process.stdout.write(`${JSON.stringify({ from, to, ms: results })}\n`);
await db.destroy();
