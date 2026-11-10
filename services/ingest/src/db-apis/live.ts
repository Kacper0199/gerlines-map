import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { userAgent } from "@gerlines/schema";
import { type Clock, systemClock } from "../clock.ts";
import { APP_VERSION } from "../env.ts";
import { slotAfter } from "../policy/schedule.ts";
import { type DbApiClient, type DbApiResponse, type IrisEndpoint, irisPath } from "./client.ts";
import type { DbApi } from "./limits.ts";
import type { IrisStation } from "./stations.ts";

const HOUR = 3_600_000;

export interface RequestLogLine {
  readonly api: DbApi;
  readonly endpoint: string;
  readonly eva: number | null;
  readonly url: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: number | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly contentType: string | null;
  readonly retryAfterMs: number | null;
  readonly error: string | null;
  readonly file: string | null;
}

export function liveUserAgent(env: Readonly<Record<string, string | undefined>>): string {
  return userAgent({
    appName: env.APP_NAME ?? "",
    version: APP_VERSION,
    contact: env.APP_CONTACT ?? "",
  });
}

/** An EVA number as IRIS paths take it: seven digits, so no `NaN` or other path reaches DB. */
export function evaArg(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (!/^\d{7}$/.test(text)) throw new Error("--eva must be a seven-digit EVA number");
  return Number(text);
}

export function requireAbsolute(dir: string): string {
  if (!isAbsolute(dir)) throw new Error("the output folder must be an absolute path");
  return dir;
}

function stamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replaceAll(":", "").replace(".", "-");
}

/** Writes the payload byte for byte and one request line; returns the line. */
export async function keep(
  outDir: string,
  response: DbApiResponse,
  endpoint: string,
  eva: number | null,
  extension: string,
): Promise<RequestLogLine> {
  let file: string | null = null;
  await mkdir(outDir, { recursive: true });
  if (response.body) {
    const folder = join(endpoint, eva === null ? "all" : String(eva));
    await mkdir(join(outDir, folder), { recursive: true });
    file = join(folder, `${stamp(response.startedAt)}.${extension}`);
    await writeFile(join(outDir, file), response.body);
  }
  const line: RequestLogLine = {
    api: response.api,
    endpoint,
    eva,
    url: response.url,
    startedAt: new Date(response.startedAt).toISOString(),
    durationMs: response.durationMs,
    status: response.status,
    bytes: response.body?.byteLength ?? null,
    sha256: response.sha256,
    contentType: response.contentType,
    retryAfterMs: response.retryAfterMs,
    error: response.error,
    file,
  };
  await appendFile(join(outDir, "requests.jsonl"), `${JSON.stringify(line)}\n`);
  return line;
}

/** The most DB Timetables calls one probe makes. */
export const PROBE_MAX_CALLS = 10;

/**
 * A one-station probe: full changes, the plans from the hour before `at` to `hours` ahead, then full
 * changes again, so both change answers can be read against the plans. Refuses more than
 * `PROBE_MAX_CALLS` calls.
 */
export function probeCalls(
  at: number,
  hours: number,
): { readonly endpoint: IrisEndpoint; readonly at: number }[] {
  if (!Number.isInteger(hours) || hours < 0) throw new Error("--hours must be a whole number");
  const plans = Array.from({ length: hours + 2 }, (_, index) => ({
    endpoint: "plan" as const,
    at: at + (index - 1) * HOUR,
  }));
  const calls = [{ endpoint: "fchg" as const, at }, ...plans, { endpoint: "fchg" as const, at }];
  if (calls.length > PROBE_MAX_CALLS) {
    throw new Error(
      `a probe makes at most ${PROBE_MAX_CALLS} calls, --hours ${hours} needs ${calls.length}`,
    );
  }
  return calls;
}

interface IrisTask {
  readonly endpoint: IrisEndpoint;
  readonly station: IrisStation;
  readonly periodMs: number;
  readonly offsetMs: number;
  readonly planAheadMs: number;
}

export interface IrisRunOptions {
  readonly client: DbApiClient;
  readonly stations: readonly IrisStation[];
  readonly outDir: string;
  readonly durationMs: number;
  readonly cadence: {
    readonly planEveryMs: number;
    readonly fchgEveryMs: number;
    readonly rchgEveryMs: number;
  };
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  readonly onLine?: (line: RequestLogLine) => void;
}

/**
 * Builds the poll plan: each station's recent changes, full changes and next-hour plan are spread evenly
 * over their period, so the shared bucket sees a steady stream instead of bursts.
 */
export function irisTasks(
  stations: readonly IrisStation[],
  cadence: IrisRunOptions["cadence"],
): IrisTask[] {
  const spread = (index: number, periodMs: number) =>
    Math.floor((index * periodMs) / Math.max(stations.length, 1));
  return stations.flatMap((station, index) => [
    {
      endpoint: "rchg",
      station,
      periodMs: cadence.rchgEveryMs,
      offsetMs: spread(index, cadence.rchgEveryMs),
      planAheadMs: 0,
    },
    {
      endpoint: "fchg",
      station,
      periodMs: cadence.fchgEveryMs,
      offsetMs: spread(index, cadence.fchgEveryMs),
      planAheadMs: 0,
    },
    {
      endpoint: "plan",
      station,
      periodMs: cadence.planEveryMs,
      offsetMs: spread(index, cadence.planEveryMs),
      planAheadMs: HOUR,
    },
  ]);
}

/** Polls DB Timetables on the task plan until the duration ends; the current and next hour's plans first. */
export async function runIris(options: IrisRunOptions): Promise<RequestLogLine[]> {
  const clock = options.clock ?? systemClock;
  const start = clock.now();
  const end = start + options.durationMs;
  const lines: RequestLogLine[] = [];
  await mkdir(options.outDir, { recursive: true });

  const call = async (endpoint: IrisEndpoint, station: IrisStation, at: number) => {
    const response = await options.client.get(
      "timetables",
      irisPath(endpoint, station.eva, at),
      options.signal,
    );
    const line = await keep(options.outDir, response, endpoint, station.eva, "xml");
    lines.push(line);
    options.onLine?.(line);
  };

  const initialPlans = options.stations.flatMap((station) => [
    call("plan", station, start),
    call("plan", station, start + HOUR),
  ]);

  const loops = irisTasks(options.stations, options.cadence).map(async (task) => {
    for (;;) {
      const due = slotAfter(clock.now(), task.periodMs, task.offsetMs);
      if (due >= end || options.signal?.aborted) return;
      await clock.sleep(due - clock.now(), options.signal);
      if (options.signal?.aborted) return;
      await call(task.endpoint, task.station, clock.now() + task.planAheadMs);
    }
  });
  await Promise.all([...initialPlans, ...loops]);
  return lines;
}
