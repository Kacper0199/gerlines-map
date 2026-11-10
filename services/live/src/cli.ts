import { readFile, rm, writeFile } from "node:fs/promises";
import { getPriority, setPriority } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDatabase, type DB, redactDatabaseUrl, resolveDatabaseUrl } from "@gerlines/db";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { checkChain, compareTrees, digestTree } from "./evidence/chain-check.ts";
import { type HeadEntry, runContinuity } from "./evidence/continuity.ts";
import { durationSummary } from "./metrics.ts";
import { createPlaybackApp } from "./playback/app.ts";
import { PlaybackCache, type PlaybackIndex } from "./playback/cache.ts";
import {
  acquireRenderLock,
  DEFAULT_PLAYBACK_BUDGET_MB,
  DEFAULT_PLAYBACK_NICE,
  DEFAULT_PLAYBACK_PORT,
  nowOption,
  parseRenderJob,
  parseServe,
  type RenderJob,
  RenderLockHeld,
} from "./playback/job.ts";
import { databaseRenderWindow } from "./playback/render-window.ts";
import { PlaybackRenderer, type RenderWindow } from "./playback/renderer.ts";
import { DEFAULT_LIMITS, dueWindows } from "./playback/window.ts";
import { FileStore } from "./publish/storage.ts";
import { render } from "./render.ts";
import { runLive } from "./run.ts";
import { createLiveApp } from "./server/app.ts";
import { createReplayApp, ReplayClock } from "./server/replay.ts";
import { buildPacks, parseShapeNumbers } from "./shapes/packs.ts";
import { parseAvailability } from "./timetable/available.ts";
import { checkShapesDatabase } from "./timetable/shapes-database.ts";

/** Run and replay listen on ports apart from the API (8787), so all three can run side by side. */
const DEFAULT_RUN_PORT = 8790;
const DEFAULT_REPLAY_PORT = 8788;

const USAGE = `gerlines live engine

Usage: node src/cli.ts <command> [options]

  render --from ISO --to ISO --out DIR [--cadence 1] [--no-hold] [--restart-at ISO] [--report FILE]
      [--detail-check] [--heap-profile-at ISO,ISO --profile-dir DIR] [--version-available ID=ISO ...]
      [--packs DIR] [--delta-interval 2] [--keyframe-interval 30]
      run the engine over a replayed window on a virtual clock against the History reader
      (stop_event_forecast as of each tick) and write every object under DIR; a feed version named
      by --version-available stays hidden until that instant (a rollover replayed); with
      --packs the engine takes no version whose packs DIR does not mark complete, as live run
  packs build --out DIR --timetable-version N [--limit N]
      [--allow-hairpin-shapes NO,NO] [--allow-falling-m-shapes NO,NO]
      [--allow-u-turn-shapes NO,NO] (repeated --allow options merge)
      write one shape pack per drawable shape at DIR/s/<epoch>/<number>.bin (brotli 11, gzip 9);
      for the shapes the timetable version links to; report turns above 160 degrees, hairpins
      (such turns not at an intermediate stop), U-turns and falling M; exit 1 when a shape has a
      fault its --allow list does not name by shape number (none by default) or no shape
      matched; a full build without failures that passes marks the version in
      DIR/s/<epoch>/complete.json last (a new build drops the mark first); live run waits for it
  run --out DIR [--host 127.0.0.1] [--port ${DEFAULT_RUN_PORT}] [--clock system | replay:<ISO>:<speed>]
      [--memory-keys] [--timetable-version N]
      follow realtime (rt_payload cursor), publish frames under DIR, serve /live/v1/* on
      HOST:PORT, push notices to Centrifugo when CENTRIFUGO_URL is set; waits (logging once a
      minute) until DIR/s/<epoch>/complete.json marks the packs of the current shape epoch;
      --timetable-version N serves version N whenever it is loaded, below the switch floors

  replay --out DIR --packs DIR --report RENDER.json [--speed 10] [--start ISO] [--loop]
      [--host 127.0.0.1] [--port ${DEFAULT_REPLAY_PORT}]
      serve a finished render as if it were live: /live/v1/head follows a virtual clock over the
      render's heads at --speed, objects come from --out and shape packs from --packs; no database

  playback render --cache DIR --packs DIR [--from ISO] [--to ISO] [--last 24] [--now ISO]
      [--budget-mb ${DEFAULT_PLAYBACK_BUDGET_MB}] [--force] [--nice ${DEFAULT_PLAYBACK_NICE}] [--version-available ID=ISO ...]
      render every settled hour window in [from, to] (default the last --last hours) that the cache
      lacks (all with --force) at the playback cadence (delta 10 s, keyframe 300 s), then drop
      windows past 7 days, replaced revisions past two hours and the oldest windows above the
      budget; --packs is the live packs directory (the pack gate of live run); each timetable
      version plays from its load time, --version-available replaces it (replay databases);
      one job per cache (DIR/render.lock, exit 75 when held), at nice --nice, sweeping dead
      renders from DIR/tmp first; --now sets the instant the limits count from (old replays)
  playback serve --cache DIR [--packs DIR] [--render-on-miss] [--now ISO] [--host 127.0.0.1]
      [--port ${DEFAULT_PLAYBACK_PORT}] [--version-available ID=ISO ...]
      serve /playback/v1/* from the cache and /live/v1/s/* from --packs; with --render-on-miss
      (loopback hosts only, --packs required) a request for a missing window renders it with the
      job's options (one at a time, two waiting at most)

  verify chain --out DIR --report RENDER.json [--clients 40] [--seed 7]
      simulated clients join at random heads of a render and follow it; states against keyframes
  verify continuity --out DIR --packs DIR --report RENDER.json [--from ISO] [--to ISO]
         [--time-scale 10] [--fps 60|variable] [--sample 1] [--seed 7] [--keys K,K]
      headless client: frames and packs into MotionFleet, every frame through ContinuityMeter
  verify compare DIR_A DIR_B
      sha256 of every object in two renders (determinism)

Environment: DATABASE_URL or POSTGRES_* (read only), LIVE_PLAYBACK_DIR (run, optional: an absolute
directory of rendered playback windows served read only under /playback/v1/*), VALKEY_URL (run; required unless --memory-keys),
SHAPES_DATABASE_URL (optional: pattern shapes and their links from another database; the shape
epoch stays in the main one), CENTRIFUGO_URL and CENTRIFUGO_HTTP_API_KEY (run, optional; the .env.example placeholder key only with
LIVE_LOCAL_STACK=1), LIVE_DETAIL (run; 0, false, off or no switches the train detail writer off, else it runs whenever
VALKEY_URL is set).`;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function openDatabase(): Kysely<DB> {
  return createDatabase({
    databaseUrl: resolveDatabaseUrl(process.env),
    applicationName: "gerlines-live",
    maxConnections: 4,
  });
}

/** The detail writer's own pool: one load runs seven queries at once, the tick keeps its four. */
function openDetailDatabase(): Kysely<DB> {
  return createDatabase({
    databaseUrl: resolveDatabaseUrl(process.env),
    applicationName: "gerlines-live-detail",
    maxConnections: 2,
  });
}

/** The shapes database, checked against the main one; null when SHAPES_DATABASE_URL is unset. */
async function checkedShapesDatabase(db: Kysely<DB>): Promise<Kysely<DB> | null> {
  const shapesDb = openShapesDatabase();
  if (!shapesDb) return null;
  try {
    await checkShapesDatabase(db, shapesDb);
  } catch (error) {
    await shapesDb.destroy();
    throw error;
  }
  return shapesDb;
}

/** A second database for pattern shapes and their links (SHAPES_DATABASE_URL), when set. */
function openShapesDatabase(): Kysely<DB> | null {
  const databaseUrl = process.env.SHAPES_DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  return createDatabase({
    databaseUrl,
    applicationName: "gerlines-live-shapes",
    maxConnections: 2,
  });
}

function directory(value: string | undefined, name = "--out"): string {
  if (!value) throw new Error(`${name} DIR is required`);
  return isAbsolute(value) ? value : resolve(value);
}

function requiredVersion(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value))
    throw new Error("--timetable-version needs a feed_version_id");
  return Number(value);
}

function instant(value: string | undefined, name: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${name} needs an ISO instant`);
  return Math.floor(parsed / 1000);
}

function wholeSeconds(value: string, name: string, max: number): number {
  const parsed = Number(value);
  if (!(Number.isInteger(parsed) && parsed >= 1 && parsed <= max)) {
    throw new Error(`${name} takes whole seconds from 1 to ${max}`);
  }
  return parsed;
}

function frameIntervals(
  delta: string | undefined,
  keyframe: string | undefined,
): { deltaInterval?: number; keyframeInterval?: number } {
  return {
    ...(delta === undefined ? {} : { deltaInterval: wholeSeconds(delta, "--delta-interval", 60) }),
    ...(keyframe === undefined
      ? {}
      : { keyframeInterval: wholeSeconds(keyframe, "--keyframe-interval", 3600) }),
  };
}

async function commandRender(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      out: { type: "string" },
      cadence: { type: "string" },
      "no-hold": { type: "boolean" },
      "restart-at": { type: "string" },
      report: { type: "string" },
      "heap-profile-at": { type: "string" },
      "profile-dir": { type: "string" },
      "detail-check": { type: "boolean" },
      "version-available": { type: "string", multiple: true },
      packs: { type: "string" },
      "delta-interval": { type: "string" },
      "keyframe-interval": { type: "string" },
    },
  });
  const versionAvailable = parseAvailability(values["version-available"] ?? []);
  const db = openDatabase();
  let shapesDb: Kysely<DB> | null = null;
  try {
    shapesDb = await checkedShapesDatabase(db);
    const cadence = Number(values.cadence ?? 1);
    if (!(Number.isInteger(cadence) && cadence >= 1 && cadence <= 60)) {
      throw new Error("--cadence takes whole seconds from 1 to 60");
    }
    const report = await render({
      db,
      ...(shapesDb ? { shapesDb } : {}),
      from: instant(values.from, "--from"),
      to: instant(values.to, "--to"),
      cadence,
      out: directory(values.out),
      holdRule: values["no-hold"] !== true,
      detailCheck: values["detail-check"] === true,
      ...(versionAvailable.size > 0 ? { versionAvailable } : {}),
      ...(values.packs ? { packs: directory(values.packs, "--packs") } : {}),
      ...frameIntervals(values["delta-interval"], values["keyframe-interval"]),
      ...(values["restart-at"] ? { restartAt: instant(values["restart-at"], "--restart-at") } : {}),
      progress: (line) => process.stderr.write(`${line}\n`),
      ...(values["heap-profile-at"]
        ? {
            heapProfileAt: values["heap-profile-at"]
              .split(",")
              .map((at) => instant(at, "--heap-profile-at")),
            profileDir: directory(values["profile-dir"] ?? "."),
          }
        : {}),
    });
    const full = { database: redactDatabaseUrl(resolveDatabaseUrl(process.env)), ...report };
    if (values.report) await writeFile(values.report, `${JSON.stringify(full)}\n`);
    const { objects, heads, ...summary } = full;
    print(JSON.stringify({ ...summary, objects: objects.length, heads: heads.length }, null, 2));
    return 0;
  } finally {
    await db.destroy();
    await shapesDb?.destroy();
  }
}

async function commandPacks(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "build") {
    print(USAGE);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      "timetable-version": { type: "string" },
      limit: { type: "string" },
      "allow-hairpin-shapes": { type: "string", multiple: true },
      "allow-falling-m-shapes": { type: "string", multiple: true },
      "allow-u-turn-shapes": { type: "string", multiple: true },
    },
  });
  const db = openDatabase();
  let shapesDb: Kysely<DB> | null = null;
  try {
    shapesDb = await checkedShapesDatabase(db);
    const report = await buildPacks(db, new FileStore(directory(values.out)), {
      timetableVersion: requiredVersion(values["timetable-version"]),
      ...(values.limit ? { limit: Number(values.limit) } : {}),
      allow: {
        hairpinShapes: parseShapeNumbers(values["allow-hairpin-shapes"]),
        fallingMShapes: parseShapeNumbers(values["allow-falling-m-shapes"]),
        uTurnShapes: parseShapeNumbers(values["allow-u-turn-shapes"]),
      },
      ...(shapesDb ? { shapesDb } : {}),
    });
    const shapesUrl = process.env.SHAPES_DATABASE_URL?.trim();
    const shapesDatabase = shapesUrl ? redactDatabaseUrl(shapesUrl) : null;
    print(JSON.stringify({ shapesDatabase, ...report, durations: durationSummary() }, null, 2));
    return report.failed > 0 || !report.geometry.passed || (!values.limit && !report.complete)
      ? 1
      : 0;
  } finally {
    await db.destroy();
    await shapesDb?.destroy();
  }
}

async function commandRun(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      clock: { type: "string" },
      "memory-keys": { type: "boolean" },
      "timetable-version": { type: "string" },
    },
  });
  return runLive({
    out: directory(values.out),
    host: values.host ?? "127.0.0.1",
    port: Number(values.port ?? DEFAULT_RUN_PORT),
    clock: values.clock ?? "system",
    openDatabase,
    openDetailDatabase,
    databaseUrl: resolveDatabaseUrl(process.env),
    openShapesDatabase,
    memoryKeys: values["memory-keys"] === true,
    ...(values["timetable-version"] === undefined
      ? {}
      : { pinnedVersion: requiredVersion(values["timetable-version"]) }),
  });
}

async function commandReplay(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string" },
      packs: { type: "string" },
      report: { type: "string" },
      speed: { type: "string" },
      start: { type: "string" },
      loop: { type: "boolean" },
      host: { type: "string" },
      port: { type: "string" },
    },
  });
  const { heads } = await renderReport(values.report);
  const first = heads[0]?.[0];
  const last = heads.at(-1)?.[0];
  if (first === undefined || last === undefined) throw new Error("the report holds no heads");
  const clock = new ReplayClock({
    first,
    last,
    speed: Number(values.speed ?? 10),
    loop: values.loop === true,
    wall: () => Date.now() / 1000,
    ...(values.start ? { startAt: instant(values.start, "--start") } : {}),
  });
  const app = createReplayApp({
    frames: new FileStore(directory(values.out)),
    packs: new FileStore(directory(values.packs, "--packs")),
    heads,
    clock,
  });
  const server = serve({
    fetch: app.fetch,
    hostname: values.host ?? "127.0.0.1",
    port: Number(values.port ?? DEFAULT_REPLAY_PORT),
  });
  print(
    JSON.stringify({
      msg: "replay serving",
      from: new Date(first * 1000).toISOString(),
      to: new Date(last * 1000).toISOString(),
      speed: clock.speed,
      heads: heads.length,
    }),
  );
  await new Promise<void>((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
  });
  server.close();
  return 0;
}

async function renderReport(path: string | undefined): Promise<{
  heads: HeadEntry[];
  shapeEpoch: number;
}> {
  if (!path) throw new Error("--report RENDER.json is required");
  return JSON.parse(await readFile(path, "utf8")) as { heads: HeadEntry[]; shapeEpoch: number };
}

function reader(root: string) {
  const store = new FileStore(root);
  return async (relative: string) => {
    const bytes = await store.read(relative);
    return bytes ? new Uint8Array(bytes) : null;
  };
}

const VERIFY_OPTIONS = {
  out: { type: "string" },
  packs: { type: "string" },
  report: { type: "string" },
  clients: { type: "string" },
  seed: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  "time-scale": { type: "string" },
  fps: { type: "string" },
  sample: { type: "string" },
  keys: { type: "string" },
} as const;

type VerifyValues = ReturnType<typeof parseVerify>;

function parseVerify(args: string[]) {
  return parseArgs({ args, options: VERIFY_OPTIONS }).values;
}

async function verifyCompare(args: string[]): Promise<number> {
  const [a, b] = args;
  if (!a || !b) throw new Error("verify compare needs two directories");
  const result = compareTrees(await digestTree(directory(a)), await digestTree(directory(b)));
  print(JSON.stringify(result, null, 2));
  return result.different.length === 0 && result.onlyInOne.length === 0 ? 0 : 1;
}

async function verifyChain(values: VerifyValues): Promise<number> {
  const report = await renderReport(values.report);
  const result = await checkChain(reader(directory(values.out)), report.heads, {
    clients: Number(values.clients ?? 40),
    seed: Number(values.seed ?? 7),
  });
  print(JSON.stringify(result, null, 2));
  const clean = result.mismatches === 0 && result.chainErrors.length === 0;
  return clean && result.finalStatesEqual ? 0 : 1;
}

function optionalInstant(value: string | undefined, name: string, fallback: number): number {
  return value ? instant(value, name) : fallback;
}

async function verifyContinuity(values: VerifyValues): Promise<number> {
  const report = await renderReport(values.report);
  const result = await runContinuity({
    frames: reader(directory(values.out)),
    packs: reader(directory(values.packs ?? values.out)),
    shapeEpoch: report.shapeEpoch,
    heads: report.heads,
    from: optionalInstant(values.from, "--from", report.heads[0]?.[0] ?? 0),
    to: optionalInstant(values.to, "--to", report.heads.at(-1)?.[0] ?? 0),
    timeScale: Number(values["time-scale"] ?? 10),
    fps: values.fps === "variable" ? "variable" : Number(values.fps ?? 60),
    sampleShare: Number(values.sample ?? 1),
    seed: Number(values.seed ?? 7),
    ...(values.keys ? { keys: new Set(values.keys.split(",").map(Number)) } : {}),
  });
  print(JSON.stringify(result, null, 2));
  const c = result.continuity;
  return c.jumps + c.stalls + c.backwardSteps + c.visibleSwaps + c.offTrackFrames === 0 ? 0 : 1;
}

async function commandVerify(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "compare") return verifyCompare(rest);
  if (sub === "chain") return verifyChain(parseVerify(rest));
  if (sub === "continuity") return verifyContinuity(parseVerify(rest));
  print(USAGE);
  return 2;
}

function windowSummary(index: PlaybackIndex) {
  const { heads, ...summary } = index;
  return { ...summary, heads: heads.length };
}

async function renderDueWindows(
  cache: PlaybackCache,
  renderWindow: RenderWindow,
  starts: readonly number[],
  options: { readonly force: boolean; readonly results: unknown[] },
): Promise<number> {
  let failed = 0;
  for (const start of starts) {
    const cached = await cache.index(start);
    if (cached && !options.force) {
      options.results.push({ start, status: "cached", revision: cached.revision });
      continue;
    }
    const out = await cache.scratchDirectory(start);
    try {
      const index = await cache.put(
        await renderWindow(start, start + DEFAULT_LIMITS.windowSeconds, out),
        out,
      );
      options.results.push({ status: "rendered", ...windowSummary(index) });
    } catch (error) {
      failed++;
      await rm(out, { recursive: true, force: true });
      options.results.push({ start, status: "failed", error: String(error).slice(0, 300) });
    }
  }
  return failed;
}

function lowerPriority(nice: number): string {
  try {
    setPriority(0, nice);
    return String(getPriority(0));
  } catch (error) {
    return `unchanged (${String(error).slice(0, 80)})`;
  }
}

async function renderJob(
  job: RenderJob,
  cache: PlaybackCache,
  results: unknown[],
): Promise<number> {
  const db = openDatabase();
  let shapesDb: Kysely<DB> | null = null;
  try {
    shapesDb = await checkedShapesDatabase(db);
    const renderWindow = databaseRenderWindow({
      db,
      ...(shapesDb ? { shapesDb } : {}),
      packs: job.packs,
      versionAvailable: job.versionAvailable,
      progress: (line) => process.stderr.write(`${line}\n`),
    });
    return await renderDueWindows(cache, renderWindow, dueWindows(job.from, job.to, job.now), {
      force: job.force,
      results,
    });
  } finally {
    await db.destroy();
    await shapesDb?.destroy();
  }
}

/** Exit status of a job that found the cache locked by another (EX_TEMPFAIL). */
const LOCKED_EXIT = 75;

async function playbackRender(args: string[]): Promise<number> {
  const job = parseRenderJob(args, Date.now() / 1000);
  const cache = new PlaybackCache(job.cache);
  let release: () => Promise<void>;
  try {
    release = await acquireRenderLock(job.cache);
  } catch (error) {
    if (!(error instanceof RenderLockHeld)) throw error;
    print(JSON.stringify({ skipped: "locked", pid: error.pid }));
    return LOCKED_EXIT;
  }
  try {
    const nice = lowerPriority(job.nice);
    const swept = await cache.sweepScratch();
    const results: unknown[] = [];
    const failed = await renderJob(job, cache, results);
    const pruned = await cache.prune({ budgetBytes: job.budgetBytes, now: job.now });
    print(JSON.stringify({ nice, swept, windows: results, pruned }, null, 2));
    return failed > 0 ? 1 : 0;
  } finally {
    await release();
  }
}

async function playbackServe(args: string[]): Promise<number> {
  const options = parseServe(args);
  const cache = new PlaybackCache(options.cache);
  const db = options.renderOnMiss ? openDatabase() : null;
  const shapesDb = db ? await checkedShapesDatabase(db) : null;
  const renderer =
    db && options.packs
      ? new PlaybackRenderer(
          cache,
          databaseRenderWindow({
            db,
            ...(shapesDb ? { shapesDb } : {}),
            packs: options.packs,
            versionAvailable: options.versionAvailable,
          }),
          {
            maxPending: 2,
            onError: (start, error) =>
              process.stderr.write(
                `${JSON.stringify({ level: "error", msg: "playback render failed", start, error: String(error).slice(0, 300) })}\n`,
              ),
          },
        )
      : null;
  const app = new Hono();
  app.route("/", createPlaybackApp({ cache, renderer, now: nowOption(options.now) }));
  if (options.packs) {
    const packs = new FileStore(options.packs);
    app.route(
      "/",
      createLiveApp({
        read: (relative) =>
          relative.startsWith("s/") ? packs.read(relative) : Promise.resolve(null),
      }),
    );
  }
  const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port });
  const windows = await cache.list();
  print(
    JSON.stringify({
      msg: "playback serving",
      windows: windows.length,
      renderOnMiss: renderer !== null,
    }),
  );
  await new Promise<void>((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
  });
  server.close();
  await db?.destroy();
  await shapesDb?.destroy();
  return 0;
}

async function commandPlayback(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "render") return playbackRender(rest);
  if (sub === "serve") return playbackServe(rest);
  print(USAGE);
  return 2;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  render: commandRender,
  playback: commandPlayback,
  verify: commandVerify,
  packs: commandPacks,
  run: commandRun,
  replay: commandReplay,
};

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    print(USAGE);
    return name ? 2 : 0;
  }
  return command(args);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `live command failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  },
);
