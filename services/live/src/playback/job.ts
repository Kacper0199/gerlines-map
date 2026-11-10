import { mkdir, open, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseAvailability } from "../timetable/available.ts";
import { processAlive } from "./cache.ts";

export const DEFAULT_PLAYBACK_PORT = 8789;
export const DEFAULT_PLAYBACK_BUDGET_MB = 2048;
/** The render job's nice level: the live engine on the same machine keeps the CPU first. */
export const DEFAULT_PLAYBACK_NICE = 10;

function directory(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} DIR is required`);
  return isAbsolute(value) ? value : resolve(value);
}

function instant(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} needs an ISO instant`);
  return Math.floor(parsed / 1000);
}

/** `--now ISO` as Unix seconds, else the wall clock. */
export function nowOption(value: string | undefined): () => number {
  if (!value) return () => Date.now() / 1000;
  const at = instant(value, "--now");
  return () => at;
}

export interface RenderJob {
  readonly cache: string;
  readonly packs: string;
  readonly now: number;
  readonly from: number;
  readonly to: number;
  readonly budgetBytes: number;
  readonly force: boolean;
  readonly nice: number;
  readonly versionAvailable: ReadonlyMap<number, number>;
}

/**
 * `live playback render` options. `--packs` is required: the job takes no timetable version whose
 * packs the live packs directory does not mark complete, as live run.
 */
export function parseRenderJob(args: readonly string[], wallNow: number): RenderJob {
  const { values } = parseArgs({
    args: [...args],
    options: {
      cache: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      last: { type: "string" },
      now: { type: "string" },
      "budget-mb": { type: "string" },
      packs: { type: "string" },
      force: { type: "boolean" },
      nice: { type: "string" },
      "version-available": { type: "string", multiple: true },
    },
  });
  const cache = directory(values.cache, "--cache");
  const packs = directory(values.packs, "--packs");
  const now = values.now ? instant(values.now, "--now") : wallNow;
  const to = values.to ? instant(values.to, "--to") : now;
  const hours = Number(values.last ?? 24);
  if (!(Number.isFinite(hours) && hours > 0)) throw new Error("--last takes hours");
  const from = values.from ? instant(values.from, "--from") : to - hours * 3600;
  const budgetMb = Number(values["budget-mb"] ?? DEFAULT_PLAYBACK_BUDGET_MB);
  if (!(Number.isFinite(budgetMb) && budgetMb > 0)) throw new Error("--budget-mb takes megabytes");
  const niceText = values.nice ?? String(DEFAULT_PLAYBACK_NICE);
  if (!/^\d{1,2}$/.test(niceText) || Number(niceText) > 19) throw new Error("--nice takes 0 to 19");
  return {
    cache,
    packs,
    now,
    from,
    to,
    budgetBytes: budgetMb * 1_048_576,
    force: values.force === true,
    nice: Number(niceText),
    versionAvailable: parseAvailability(values["version-available"] ?? []),
  };
}

/** 127.0.0.0/8, ::1 and localhost. */
export function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

export interface ServeOptions {
  readonly cache: string;
  readonly packs: string | null;
  readonly renderOnMiss: boolean;
  readonly now: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly versionAvailable: ReadonlyMap<number, number>;
}

/**
 * `live playback serve` options. `--render-on-miss` lets a request start a render, so it is for
 * local use only: refused on a host other than loopback, and it renders with the job's
 * options, `--packs` required.
 */
export function parseServe(args: readonly string[]): ServeOptions {
  const { values } = parseArgs({
    args: [...args],
    options: {
      cache: { type: "string" },
      packs: { type: "string" },
      "render-on-miss": { type: "boolean" },
      now: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "version-available": { type: "string", multiple: true },
    },
  });
  const renderOnMiss = values["render-on-miss"] === true;
  const host = values.host ?? "127.0.0.1";
  if (renderOnMiss && !isLoopback(host))
    throw new Error("--render-on-miss serves loopback only (--host 127.0.0.1, ::1 or localhost)");
  if (renderOnMiss && !values.packs) throw new Error("--render-on-miss needs --packs DIR");
  return {
    cache: directory(values.cache, "--cache"),
    packs: values.packs ? directory(values.packs, "--packs") : null,
    renderOnMiss,
    now: values.now,
    host,
    port: Number(values.port ?? DEFAULT_PLAYBACK_PORT),
    versionAvailable: parseAvailability(values["version-available"] ?? []),
  };
}

export class RenderLockHeld extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`another playback render job (pid ${pid}) holds the cache`);
    this.pid = pid;
  }
}

/**
 * `<root>/render.lock` with the job's pid: one render job per cache at a time. A lock
 * of a process that no longer runs, or of this pid (a restarted container reuses pids), is taken
 * over. Returns the release.
 */
export async function acquireRenderLock(
  root: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  const path = join(root, "render.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        const holder = await readFile(path, "utf8").catch(() => "");
        if (holder.trim() === String(process.pid)) await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
      const other = Number.isInteger(pid) && pid > 0 && pid !== process.pid;
      if (other && alive(pid)) throw new RenderLockHeld(pid);
      await rm(path, { force: true });
    }
  }
  throw new Error(`could not take ${path}`);
}
