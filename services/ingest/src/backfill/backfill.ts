import type { Clock } from "../clock.ts";
import { utcDate } from "../clock.ts";
import { type FetchRequest, fetchPayload } from "../fetch/http-fetch.ts";
import { findGaps, type Gap, snapshotOf } from "../gaps.ts";
import { summarizeFeed } from "../gtfs-rt/feed-summary.ts";
import type { Logger } from "../log.ts";
import type { IndexSink } from "../recorder/index-sink.ts";
import type { SourceDefinition } from "../sources.ts";
import { STORAGE_FORMAT_VERSION } from "../storage/frame.ts";
import { PayloadStore, type RecordDraft } from "../storage/payload-store.ts";
import { listSidecars, readFetchRecords } from "../storage/reader.ts";
import { RunLog } from "../storage/runs.ts";
import { type FetchRecord, isSuccess } from "../storage/sidecar.ts";
import { lastSuccessBefore } from "../storage/state.ts";
import { uuidv7 } from "../uuid.ts";
import { mirrorDay, parseDayFolders, parseSnapshots } from "./mirror.ts";

export const MIRROR_BASE = "https://stc.traines.eu/mirror/german-delfi-gtfs-rt/";
export const ARCHIVE_BASE = "https://mirror.traines.eu/german-delfi-gtfs-rt/";
const MIN_SPACING_MS = 2_000;
const JOB = "backfill";
const PROVENANCE = "backfill:traines-mirror-day-folder";

export interface BackfillOptions {
  readonly root: string;
  readonly source: SourceDefinition;
  readonly userAgent: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly index: IndexSink;
  readonly signal: AbortSignal;
  readonly days: number;
  /** Start here instead of `days` back; minutes before it are left alone. */
  readonly from?: number;
  readonly dryRun: boolean;
  readonly mirrorBase?: string;
  readonly archiveBase?: string;
  readonly appVersion: string;
}

export interface BackfillReport {
  readonly since: string;
  readonly gapsBefore: number;
  readonly missing: number;
  readonly available: number;
  readonly fetched: number;
  readonly stored: number;
  readonly unchanged: number;
  readonly invalid: number;
  readonly invalidMinutes: string[];
  readonly stoppedOn: string | null;
  readonly notInMirror: string[];
  readonly archives: string[];
  readonly gapsAfter: { from: string; to: string }[];
}

interface Listings {
  readonly folders: Set<string>;
  readonly snapshots: Map<number, string>;
}

const MINUTE_MS = 60_000;

interface Coverage {
  readonly gaps: Gap[];
  readonly missing: number[];
}

/**
 * Which mirror minutes since `sinceMs` no successful record (live or backfill) covers, minute by minute,
 * from the last success before the window (found however far back) to the latest success. A single
 * failed fetch leaves a missing minute even when it does not make a gap of twice the cadence.
 */
export async function coverage(
  root: string,
  source: SourceDefinition,
  sinceMs: number,
): Promise<Coverage> {
  const records = await readFetchRecords(
    root,
    await listSidecars(root, source.id, utcDate(sinceMs)),
  );
  const inWindow = records
    .filter(isSuccess)
    .map((record) => Date.parse(record.observedAt))
    .filter((at) => at >= sinceMs);
  const anchor = await lastSuccessBefore(root, source.id, sinceMs);
  const times = anchor === null ? inWindow : [anchor, ...inWindow];
  if (times.length === 0) return { gaps: [], missing: [] };
  const covered = new Set(times.map((at) => snapshotOf(at)));
  const last = snapshotOf(Math.max(...times));
  const missing: number[] = [];
  for (let at = snapshotOf(Math.min(...times)) + MINUTE_MS; at < last; at += MINUTE_MS) {
    if (!covered.has(at)) missing.push(at);
  }
  return { gaps: findGaps(times, source.periodMs), missing };
}

class PoliteFetcher {
  private last = 0;
  private readonly options: BackfillOptions;

  constructor(options: BackfillOptions) {
    this.options = options;
  }

  async get(url: string, maxBytes: number) {
    const { clock, signal } = this.options;
    await clock.sleep(this.last + MIN_SPACING_MS - clock.now(), signal);
    const request: FetchRequest = {
      url,
      method: "GET",
      headers: { "user-agent": this.options.userAgent },
      redirect: "manual",
      maxBytes,
      headersTimeoutMs: 20_000,
      totalTimeoutMs: 120_000,
      sink: { kind: "memory" },
    };
    const result = await fetchPayload(request, clock, signal);
    this.last = clock.now();
    return result;
  }
}

async function loadListings(
  fetcher: PoliteFetcher,
  base: string,
  days: ReadonlySet<string>,
): Promise<Listings> {
  const index = await fetcher.get(base, 1024 * 1024);
  if (index.kind !== "response" || index.status !== 200 || !index.body) {
    throw new Error(
      `mirror index ${base} answered ${index.kind === "response" ? index.status : index.message}`,
    );
  }
  const folders = new Set(parseDayFolders(index.body.toString("utf8")));
  const snapshots = new Map<number, string>();
  for (const day of [...days].filter((d) => folders.has(d)).sort()) {
    const listing = await fetcher.get(`${base}${day}/`, 4 * 1024 * 1024);
    if (listing.kind !== "response" || listing.status !== 200 || !listing.body) {
      throw new Error(
        `mirror day folder ${day} answered ${listing.kind === "response" ? listing.status : listing.message}`,
      );
    }
    for (const snapshot of parseSnapshots(listing.body.toString("utf8"))) {
      snapshots.set(snapshot.at, `${base}${day}/${snapshot.href}`);
    }
  }
  return { folders, snapshots };
}

function draftFor(
  options: BackfillOptions,
  runId: string,
  url: string,
  startedAt: number,
  at: number,
  durationMs: number,
  status: number | null,
): RecordDraft {
  return {
    v: STORAGE_FORMAT_VERSION,
    type: "fetch",
    source: options.source.id,
    run: runId,
    writer: "backfill",
    url,
    method: "GET",
    startedAt: new Date(startedAt).toISOString(),
    observedAt: new Date(at).toISOString(),
    durationMs: Math.round(durationMs),
    status,
    headers: {},
    provenance: PROVENANCE,
  };
}

type SnapshotOutcome =
  | { readonly kind: "record"; readonly record: FetchRecord }
  | { readonly kind: "error"; readonly message: string };

/**
 * One mirror minute. A transport or HTTP error is returned as an error, which stops the run; a 2xx body
 * that is not a GTFS-RT feed is the mirror's own content, so it is stored as invalid and the run goes on.
 */
async function fetchSnapshot(
  options: BackfillOptions,
  fetcher: PoliteFetcher,
  store: PayloadStore,
  runId: string,
  at: number,
  url: string,
): Promise<SnapshotOutcome> {
  const result = await fetcher.get(url, options.source.maxBytes);
  if (result.kind === "failure") {
    return { kind: "error", message: `${url}: ${result.reason} ${result.message}` };
  }
  const draft = {
    ...draftFor(options, runId, url, result.startedAt, at, result.durationMs, result.status),
    headers: result.headers,
  };
  if (result.status !== 200 || !result.body || !result.sha256) {
    await store.note({ ...draft, outcome: "http-error", error: `HTTP ${result.status}` }, at);
    return { kind: "error", message: `${url}: HTTP ${result.status}` };
  }
  const feed = summarizeFeed(result.body);
  const checked = feed.ok
    ? { ...draft, feed }
    : { ...draft, feed, outcome: "invalid" as const, error: `not a GTFS-RT feed: ${feed.error}` };
  return {
    kind: "record",
    record: await store.storePayload(checked, result.body, result.sha256, at),
  };
}

interface Progress {
  fetched: number;
  stored: number;
  unchanged: number;
  invalid: number;
  invalidMinutes: string[];
  stoppedOn: string | null;
}

function count(progress: Progress, record: FetchRecord): void {
  progress.fetched += 1;
  if (record.outcome === "invalid") {
    progress.invalid += 1;
    progress.invalidMinutes.push(record.observedAt);
  } else if (record.outcome === "stored") {
    progress.stored += 1;
  } else {
    progress.unchanged += 1;
  }
}

async function fetchAll(
  options: BackfillOptions,
  fetcher: PoliteFetcher,
  runId: string,
  snapshots: readonly [number, string][],
): Promise<Progress> {
  const progress: Progress = {
    fetched: 0,
    stored: 0,
    unchanged: 0,
    invalid: 0,
    invalidMinutes: [],
    stoppedOn: null,
  };
  const store = new PayloadStore({
    root: options.root,
    source: options.source.id,
    writer: "backfill",
    period: "hour",
    contentType: options.source.contentType,
  });
  try {
    for (const [at, url] of snapshots) {
      if (options.signal.aborted) break;
      const outcome = await fetchSnapshot(options, fetcher, store, runId, at, url);
      if (outcome.kind === "error") {
        progress.stoppedOn = outcome.message;
        break;
      }
      const { record } = outcome;
      count(progress, record);
      if (record.object) await options.index.objects([record]);
      options.logger.log(record.outcome === "invalid" ? "warn" : "info", "backfilled", {
        source: options.source.id,
        at: record.observedAt,
        outcome: record.outcome,
        bytes: record.bytes,
        ...(record.error ? { error: record.error } : {}),
      });
    }
  } finally {
    await store.close();
  }
  return progress;
}

async function runLogged(
  options: BackfillOptions,
  work: (runId: string) => Promise<Progress>,
): Promise<Progress> {
  const { clock, source, appVersion } = options;
  const runId = uuidv7(clock.now());
  const runs = new RunLog(options.root);
  const startedAt = new Date(clock.now()).toISOString();
  const row = { id: runId, source: source.id, job: JOB, appVersion, startedAt };
  await runs.start({ run: runId, source: source.id, job: JOB, appVersion, at: startedAt });
  await options.index.run({ ...row, status: "running", finishedAt: null, error: null });
  const progress = await work(runId);
  const finishedAt = new Date(clock.now()).toISOString();
  const status = progress.stoppedOn ? "failed" : "succeeded";
  const error = progress.stoppedOn;
  await runs.end({
    run: runId,
    source: source.id,
    status,
    at: finishedAt,
    ...(error ? { error } : {}),
  });
  await options.index.run({ ...row, status, finishedAt, error });
  return progress;
}

function windowStart(options: BackfillOptions): number {
  const now = options.clock.now();
  if (options.from === undefined) return now - options.days * 86_400_000;
  if (!Number.isFinite(options.from) || options.from > now) {
    throw new Error("--from must be a valid time in the past");
  }
  return options.from;
}

/**
 * Fills every missing minute of the DELFI original feed with the same bytes from the mirror's minute
 * folders: at most one file every 2 s, stopping at the first transport or HTTP error. A mirror file that
 * is not a GTFS-RT feed is stored as invalid and reported, and the run continues. Minutes whose day left
 * the folders are reported with the daily archive that holds them.
 */
export async function backfillRecent(options: BackfillOptions): Promise<BackfillReport> {
  const { root, source } = options;
  const sinceMs = windowStart(options);
  const before = await coverage(root, source, sinceMs);
  const missing =
    options.from === undefined ? before.missing : before.missing.filter((at) => at >= sinceMs);
  const fetcher = new PoliteFetcher(options);
  const listings =
    missing.length > 0
      ? await loadListings(
          fetcher,
          options.mirrorBase ?? MIRROR_BASE,
          new Set(missing.map(mirrorDay)),
        )
      : { folders: new Set<string>(), snapshots: new Map<number, string>() };
  const available = missing.flatMap((at): [number, string][] => {
    const url = listings.snapshots.get(at);
    return url ? [[at, url]] : [];
  });
  const notInMirror = missing.filter((at) => !listings.snapshots.has(at));
  const archiveDays = [
    ...new Set(notInMirror.map(mirrorDay).filter((day) => !listings.folders.has(day))),
  ].sort();
  const summary = {
    since: new Date(sinceMs).toISOString(),
    gapsBefore: before.gaps.length,
    missing: missing.length,
    available: available.length,
    notInMirror: notInMirror.map((at) => new Date(at).toISOString()),
    archives: archiveDays.map((day) => `${options.archiveBase ?? ARCHIVE_BASE}${day}.tar.br`),
  };
  if (options.dryRun || available.length === 0) {
    const idle = {
      fetched: 0,
      stored: 0,
      unchanged: 0,
      invalid: 0,
      invalidMinutes: [],
      stoppedOn: null,
    };
    return { ...summary, ...idle, gapsAfter: before.gaps.map(formatGap) };
  }
  const progress = await runLogged(options, (runId) =>
    fetchAll(options, fetcher, runId, available),
  );
  const after = await coverage(root, source, sinceMs);
  return { ...summary, ...progress, gapsAfter: after.gaps.map(formatGap) };
}

function formatGap(gap: Gap): { from: string; to: string } {
  return { from: new Date(gap.start).toISOString(), to: new Date(gap.end).toISOString() };
}
