import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { systemClock } from "../clock.ts";
import { DbApiClient, irisPath, loadDbCredentials } from "./client.ts";
import { withIrisLease } from "./iris-lease.ts";
import { IRIS_SCHEDULE_CADENCE, irisBudget } from "./limits.ts";
import { evaArg, keep, liveUserAgent, probeCalls, requireAbsolute, runIris } from "./live.ts";
import { IRIS_STATIONS } from "./stations.ts";

const USAGE = `DB APIs (WP-2.4), run with node --env-file=<.env> src/db-apis/cli.ts <command>

  budget                              print the IRIS request budget of the chosen station set
  sample --out DIR --recordings DIR [--eva N]
                                      one plan, fchg and rchg call for one station
  probe --out DIR --recordings DIR --eva N [--hours 6]
                                      full changes, the plans from the hour before to --hours ahead,
                                      full changes again: at most 10 calls for one station
  iris-run --out DIR --recordings DIR [--minutes 60]
                                      poll the chosen stations on the recorder cadence
  download --api stada|fasta --out DIR
                                      one full download of StaDa stations or FaSta facilities
  report --out DIR                    parse every stored IRIS payload of a run and summarise it
  stada-join --file FILE              join StaDa stations with stop_place and id_map (DATABASE_URL)

Environment: DB_CLIENT_ID, DB_API_KEY, APP_NAME, APP_CONTACT. Keys are sent as headers only and never
printed. Behind an HTTP proxy, set NODE_USE_ENV_PROXY=1.

sample and iris-run first take the IRIS lease in the recordings folder the recorder writes to
(--recordings, or RECORDINGS_DIR; the host path, such as data/recordings in the main checkout). They
refuse to start while the recorder or another poller holds it: the 60 requests per minute of DB
Timetables are shared by every caller.`;

type Values = Readonly<
  Partial<Record<"out" | "eva" | "minutes" | "api" | "file" | "recordings" | "hours", string>>
>;

const budget = irisBudget({ stations: IRIS_STATIONS.length, ...IRIS_SCHEDULE_CADENCE });

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function client(): DbApiClient {
  const credentials = loadDbCredentials(process.env);
  if (!credentials) throw new Error("DB_CLIENT_ID and DB_API_KEY must be set");
  return new DbApiClient({
    credentials,
    userAgent: liveUserAgent(process.env),
    clock: systemClock,
  });
}

async function leaseRoot(values: Values): Promise<string> {
  const root = values.recordings ?? process.env.RECORDINGS_DIR?.trim();
  if (!root) {
    throw new Error("--recordings (or RECORDINGS_DIR) must name the recorder's recordings folder");
  }
  const info = await stat(requireAbsolute(root)).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`the recordings folder ${root} does not exist`);
  return root;
}

async function withLease(values: Values, task: (signal: AbortSignal) => Promise<number>) {
  return withIrisLease({ root: await leaseRoot(values), clock: systemClock }, task);
}

async function sample(values: Values): Promise<number> {
  const out = requireAbsolute(values.out ?? "");
  const eva = evaArg(values.eva ?? String(IRIS_STATIONS[0]?.eva));
  return withLease(values, async (signal) => {
    const api = client();
    const now = Date.now();
    for (const endpoint of ["plan", "fchg", "rchg"] as const) {
      const response = await api.get("timetables", irisPath(endpoint, eva, now), signal);
      print(await keep(out, response, endpoint, eva, "xml"));
    }
    return 0;
  });
}

async function probe(values: Values): Promise<number> {
  const out = requireAbsolute(values.out ?? "");
  const eva = evaArg(values.eva);
  const calls = probeCalls(Date.now(), Number(values.hours ?? "6"));
  return withLease(values, async (signal) => {
    const api = client();
    let failed = 0;
    for (const call of calls) {
      const response = await api.get("timetables", irisPath(call.endpoint, eva, call.at), signal);
      const line = await keep(out, response, call.endpoint, eva, "xml");
      print(
        `${line.startedAt} ${line.endpoint} ${line.url.replace(/^.*\/timetables/, "")} ${line.status} ${line.bytes ?? 0}`,
      );
      if (line.status !== 200) failed += 1;
    }
    return failed === 0 ? 0 : 1;
  });
}

async function irisRun(values: Values): Promise<number> {
  const out = requireAbsolute(values.out ?? "");
  const minutes = Number(values.minutes ?? "60");
  return withLease(values, (lost) => pollIris(out, minutes, lost));
}

async function pollIris(out: string, minutes: number, lost: AbortSignal): Promise<number> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const signal = AbortSignal.any([controller.signal, lost]);
  await mkdir(out, { recursive: true });
  const run = {
    startedAt: new Date().toISOString(),
    minutes,
    stations: IRIS_STATIONS,
    cadence: IRIS_SCHEDULE_CADENCE,
    budget,
  };
  await writeFile(join(out, "run.json"), JSON.stringify(run, null, 2));
  let count = 0;
  const lines = await runIris({
    client: client(),
    stations: IRIS_STATIONS,
    outDir: out,
    durationMs: minutes * 60_000,
    cadence: IRIS_SCHEDULE_CADENCE,
    signal,
    onLine: (line) => {
      count += 1;
      if (line.status !== 200 || count % 100 === 0) {
        print(
          `${line.startedAt} #${count} ${line.endpoint} ${line.eva} ${line.status} ${line.bytes ?? 0} ${line.error ?? ""}`,
        );
      }
    },
  });
  print(`done: ${lines.length} requests`);
  if (lost.aborted) {
    process.stderr.write(`stopped early: ${String(lost.reason)}\n`);
    return 1;
  }
  return 0;
}

async function download(values: Values): Promise<number> {
  const out = requireAbsolute(values.out ?? "");
  const api = values.api;
  if (api !== "stada" && api !== "fasta") throw new Error("--api must be stada or fasta");
  const response = await client().get(api, api === "stada" ? "/stations" : "/facilities");
  print(await keep(out, response, api, null, "json"));
  return response.status === 200 ? 0 : 1;
}

async function report(values: Values): Promise<number> {
  const { irisRunReport } = await import("./report.ts");
  print(await irisRunReport(requireAbsolute(values.out ?? "")));
  return 0;
}

async function stadaJoin(values: Values): Promise<number> {
  const { stadaJoinReport } = await import("./stada-join.ts");
  print(await stadaJoinReport(requireAbsolute(values.file ?? ""), process.env));
  return 0;
}

const COMMANDS: Readonly<Record<string, (values: Values) => Promise<number>>> = {
  budget: async () => {
    print({ stations: IRIS_STATIONS.length, cadence: IRIS_SCHEDULE_CADENCE, ...budget });
    return 0;
  },
  sample,
  probe,
  "iris-run": irisRun,
  download,
  report,
  "stada-join": stadaJoin,
};

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      eva: { type: "string" },
      minutes: { type: "string" },
      api: { type: "string" },
      file: { type: "string" },
      recordings: { type: "string" },
      hours: { type: "string" },
    },
  });
  const run = command === undefined ? undefined : COMMANDS[command];
  if (run) return run(values);
  print(USAGE);
  return command === undefined || command === "help" ? 0 : 2;
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
