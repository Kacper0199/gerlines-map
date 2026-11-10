import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDatabase, redactDatabaseUrl } from "@gerlines/db";
import type { TrainDetail } from "@gerlines/schema";
import { localDate } from "@gerlines/schema/service-day";
import Valkey from "iovalkey";
import { CentrifugoClient } from "./centrifugo.ts";
import { type BuildReport, buildAll, pushDetails } from "./publisher.ts";
import { DetailRepository, type LoadedDetails, type ReadMode } from "./repository.ts";
import { productCoverage, runningAt, versionForDay } from "./running.ts";
import { ValkeyDetailStore } from "./store.ts";

const usage = `Usage: node src/detail/cli.ts render --at <ISO instant> [options]

Builds the train detail of every trip instance running at the instant (or of the named instances)
from DATABASE_URL, checks each with the TrainDetail schema and prints a summary.

Options:
  --mode history|current   history (default) rebuilds the state as of the instant from forecasts,
                           current reads the folded state in stop_event
  --instance <uuid>        only this instance (repeatable)
  --limit <n>              at most n instances
  --out <dir>              write each detail as <dir>/<uuid>.json
  --publish                write the details to VALKEY_URL and push them to their channels when
                           CENTRIFUGO_URL and CENTRIFUGO_HTTP_API_KEY are set
`;

const BATCH = 500;

interface Summary {
  database: string;
  at: string;
  mode: ReadMode;
  running: number;
  built: number;
  failures: Record<string, number>;
  placeMismatches: number;
  byKind: Record<string, number>;
  byCategory: Record<string, { trains: number; withProduct: number; realtime: number }>;
  stopsWithDisplayName: number;
  stopsWithPlatform: number;
  loadMs: { p50: number; p95: number; max: number };
  published: number;
  pushed: number;
  productCoverage: Awaited<ReturnType<typeof productCoverage>>;
}

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
}

function count(summary: Summary, details: readonly TrainDetail[], displayNames: Set<string>): void {
  for (const detail of details) {
    summary.byKind[detail.provenance.kind] = (summary.byKind[detail.provenance.kind] ?? 0) + 1;
    const entry = summary.byCategory[detail.category] ?? { trains: 0, withProduct: 0, realtime: 0 };
    entry.trains += 1;
    if (detail.productName !== null) entry.withProduct += 1;
    if (detail.provenance.kind === "realtime") entry.realtime += 1;
    summary.byCategory[detail.category] = entry;
    for (const stop of detail.stops) {
      if (displayNames.has(stop.stopPlaceId)) summary.stopsWithDisplayName += 1;
      if (stop.platformScheduled !== null) summary.stopsWithPlatform += 1;
    }
  }
}

interface Outputs {
  readonly out: string | null;
  readonly store: ValkeyDetailStore | null;
  readonly centrifugo: CentrifugoClient | null;
}

interface RenderOptions {
  readonly at: number;
  readonly mode: ReadMode;
  readonly wanted: ReadonlySet<string>;
  readonly limit: number;
  readonly out: string | null;
  readonly publish: boolean;
}

function renderOptions(values: Record<string, string | boolean | string[] | undefined>) {
  const at = Date.parse(String(values.at ?? ""));
  if (Number.isNaN(at)) throw new Error("--at must be an ISO instant");
  const limit = Number(values.limit ?? Number.POSITIVE_INFINITY);
  return {
    at,
    mode: values.mode === "current" ? "current" : "history",
    wanted: new Set((values.instance as string[] | undefined) ?? []),
    limit: Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY,
    out: typeof values.out === "string" ? values.out : null,
    publish: values.publish === true,
  } satisfies RenderOptions;
}

function emptySummary(databaseUrl: string, options: RenderOptions, running: number): Summary {
  return {
    database: redactDatabaseUrl(databaseUrl),
    at: new Date(options.at).toISOString(),
    mode: options.mode,
    running,
    built: 0,
    failures: {},
    placeMismatches: 0,
    byKind: {},
    byCategory: {},
    stopsWithDisplayName: 0,
    stopsWithPlatform: 0,
    loadMs: { p50: 0, p95: 0, max: 0 },
    published: 0,
    pushed: 0,
    productCoverage: [],
  };
}

function addReport(summary: Summary, report: BuildReport, loaded: LoadedDetails): void {
  const displayNames = new Set(
    [...loaded.places].filter(([, place]) => place.displayName !== null).map(([id]) => id),
  );
  summary.built += report.details.length;
  summary.placeMismatches += report.placeMismatches;
  for (const [reason, n] of Object.entries(report.failures)) {
    summary.failures[reason] = (summary.failures[reason] ?? 0) + (n ?? 0);
  }
  count(summary, report.details, displayNames);
}

async function emit(
  summary: Summary,
  report: BuildReport,
  loaded: LoadedDetails,
  at: number,
  outputs: Outputs,
): Promise<void> {
  if (outputs.out !== null) {
    for (const detail of report.details) {
      const path = join(outputs.out, `${detail.tripInstanceId}.json`);
      await writeFile(path, `${JSON.stringify(detail, null, 2)}\n`);
    }
  }
  if (outputs.store) {
    await outputs.store.write(report.details);
    await outputs.store.confirm(at, loaded.feedObservedAt);
    summary.published += report.details.length;
  }
  if (outputs.centrifugo) {
    const { pushed, error } = await pushDetails(outputs.centrifugo, report.details);
    summary.pushed += pushed;
    if (error) throw new Error(`push: ${error}`);
  }
}

function centrifugoFromEnv(publish: boolean): CentrifugoClient | null {
  const baseUrl = process.env.CENTRIFUGO_URL;
  const apiKey = process.env.CENTRIFUGO_HTTP_API_KEY;
  return publish && baseUrl && apiKey ? new CentrifugoClient({ baseUrl, apiKey }) : null;
}

async function render(values: Record<string, string | boolean | string[] | undefined>) {
  const options = renderOptions(values);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL must name the database to read");
  const db = createDatabase({
    databaseUrl,
    applicationName: "gerlines-live-detail",
    maxConnections: 4,
  });
  const valkey = options.publish
    ? new Valkey(process.env.VALKEY_URL ?? "redis://127.0.0.1:6379")
    : null;
  const centrifugo = centrifugoFromEnv(options.publish);
  try {
    const running = await runningAt(db, options.at);
    const refs = running
      .filter((ref) => options.wanted.size === 0 || options.wanted.has(ref.tripInstanceId))
      .slice(0, options.limit);
    const repository = new DetailRepository(db);
    const day = localDate(options.at);
    const fallbackVersion = String((await versionForDay(db, day)) ?? 0);
    const summary = emptySummary(databaseUrl, options, running.length);
    summary.productCoverage = await productCoverage(db, Number(fallbackVersion));
    const outputs: Outputs = {
      out: options.out,
      store: valkey ? new ValkeyDetailStore(valkey) : null,
      centrifugo,
    };
    if (options.out !== null) await mkdir(options.out, { recursive: true });
    const timings: number[] = [];
    for (let start = 0; start < refs.length; start += BATCH) {
      const began = performance.now();
      const loaded = await repository.load(
        refs.slice(start, start + BATCH),
        options.at,
        options.mode,
      );
      timings.push(performance.now() - began);
      const report = buildAll(loaded, {
        asOf: options.at,
        version: Math.floor(options.at / 1000),
        timetableVersion: (instance) =>
          String(instance.ref.feedVersionId ?? instance.trip?.feedVersionId ?? fallbackVersion),
      });
      addReport(summary, report, loaded);
      await emit(summary, report, loaded, options.at, outputs);
    }
    summary.loadMs = {
      p50: Math.round(percentile(timings, 0.5)),
      p95: Math.round(percentile(timings, 0.95)),
      max: Math.round(Math.max(0, ...timings)),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await db.destroy();
    await valkey?.quit();
  }
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      at: { type: "string" },
      mode: { type: "string" },
      instance: { type: "string", multiple: true },
      limit: { type: "string" },
      out: { type: "string" },
      publish: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals[0] !== "render") {
    process.stdout.write(usage);
    return values.help ? 0 : 2;
  }
  await render(values);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
