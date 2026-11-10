import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { MANIFEST_DIR } from "./backfill/archive.ts";
import type { Clock } from "./clock.ts";
import { errorMessage, type Logger } from "./log.ts";
import { HeartbeatLock } from "./recorder/lock.ts";
import { NOTHING_PROCESSED, type ProcessedLookup } from "./storage/processed-evidence.ts";
import {
  applyRetention,
  loadArchiveEvidence,
  planRetention,
  readGoldenDays,
} from "./storage/retention.ts";
import { uuidv7 } from "./uuid.ts";

/** The only database whose `rt_payload` may count as processed: builder databases never do. */
export const SHARED_DATABASE = "gerlines";
export const BACKFILL_LOCK = ".backfill.lock";
const LOCK_STALE_MS = 10 * 60_000;

export interface ProcessedSource {
  readonly lookup: ProcessedLookup;
  close(): Promise<void>;
}

export interface RetentionCommandContext {
  readonly recordingsDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly print: (text: string) => void;
  /** The name of the database `--processed-db` would read, or null when none is configured. */
  readonly databaseName: string | null;
  readonly openProcessed: () => ProcessedSource;
  readonly heartbeatMs?: number;
}

interface Parsed {
  readonly keepDays: number;
  readonly now: number;
  readonly manifestRoots: string[];
  readonly processedDb: boolean;
  readonly out: string | undefined;
  readonly apply: boolean;
}

function assertSharedDatabase(name: string | null): void {
  if (name !== SHARED_DATABASE) {
    throw new Error(
      `--processed-db counts only the shared database ${SHARED_DATABASE}, not ${name ?? "none"}`,
    );
  }
}

function parse(args: string[], context: RetentionCommandContext): Parsed {
  const { values } = parseArgs({
    args,
    options: {
      "keep-days": { type: "string" },
      "as-of": { type: "string" },
      "manifest-root": { type: "string", multiple: true },
      "processed-db": { type: "boolean" },
      out: { type: "string" },
      apply: { type: "boolean" },
    },
  });
  const keepDays = Number(values["keep-days"] ?? 3);
  if (!Number.isFinite(keepDays) || keepDays < 3) throw new Error("--keep-days must be 3 or more");
  if (values.apply && values["as-of"]) {
    throw new Error("--apply works only as of now, without --as-of");
  }
  const now = values["as-of"] ? Date.parse(values["as-of"]) : context.clock.now();
  if (Number.isNaN(now)) throw new Error("--as-of must be an ISO time");
  const manifestRoots = values["manifest-root"] ?? [join(context.recordingsDir, MANIFEST_DIR)];
  if (!manifestRoots.every((dir) => isAbsolute(dir))) {
    throw new Error("--manifest-root must be an absolute path");
  }
  if (values["processed-db"]) assertSharedDatabase(context.databaseName);
  return {
    keepDays,
    now,
    manifestRoots,
    processedDb: values["processed-db"] ?? false,
    out: values.out,
    apply: values.apply ?? false,
  };
}

async function underLock<T>(context: RetentionCommandContext, work: () => Promise<T>): Promise<T> {
  const lock = new HeartbeatLock({
    root: context.recordingsDir,
    path: BACKFILL_LOCK,
    clock: context.clock,
    staleAfterMs: LOCK_STALE_MS,
  });
  const blocker = await lock.tryAcquire();
  if (blocker) throw new Error(`a backfill runs (pid ${blocker.pid} on ${blocker.host})`);
  const keepAlive = setInterval(() => {
    lock.heartbeat().catch((error: unknown) => {
      context.logger.log("error", "backfill lock lost", { error: errorMessage(error) });
    });
  }, context.heartbeatMs ?? 60_000);
  try {
    return await work();
  } finally {
    clearInterval(keepAlive);
    await lock.release();
  }
}

/**
 * `retention`: a dry-run plan by default; with `--apply` the backfill lock is taken before planning and held,
 * with a heartbeat, until the last file is deleted, so no backfill writes a sidecar line the plan never saw.
 */
export async function runRetention(
  args: string[],
  context: RetentionCommandContext,
): Promise<number> {
  const options = parse(args, context);
  const work = async (): Promise<number> => {
    const archive = await loadArchiveEvidence(options.manifestRoots);
    const processed = options.processedDb ? context.openProcessed() : null;
    const lookup = processed?.lookup ?? NOTHING_PROCESSED;
    try {
      const plan = await planRetention({
        root: context.recordingsDir,
        now: options.now,
        keepDays: options.keepDays,
        goldenDays: await readGoldenDays(context.recordingsDir),
        evidence: {
          archived: archive.archived,
          processed: lookup.processed,
          describe: () => ({ manifests: archive.manifests, processed: lookup.note }),
        },
      });
      if (options.out) await writeFile(options.out, `${JSON.stringify(plan, null, 2)}\n`);
      const { units, ...summary } = plan;
      if (!options.apply) {
        const deletable = units.filter((unit) => unit.reason === "deletable");
        context.print(JSON.stringify({ ...summary, deletable }, null, 2));
        return 0;
      }
      const at = new Date(context.clock.now());
      const result = await applyRetention(context.recordingsDir, plan, at, uuidv7(at.getTime()));
      context.print(JSON.stringify({ ...summary, applied: result }, null, 2));
      return result.skipped.length > 0 ? 1 : 0;
    } finally {
      await processed?.close();
    }
  };
  return options.apply ? underLock(context, work) : work();
}
