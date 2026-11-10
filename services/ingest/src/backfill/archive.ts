import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createBrotliDecompress, zstdCompress, zstdDecompress } from "node:zlib";
import type { Clock } from "../clock.ts";
import { utcDate } from "../clock.ts";
import { snapshotOf } from "../gaps.ts";
import { summarizeFeed } from "../gtfs-rt/feed-summary.ts";
import { errorMessage, type Logger } from "../log.ts";
import { type FreeBytes, statfsFreeBytes } from "../recorder/disk-guard.ts";
import type { IndexSink } from "../recorder/index-sink.ts";
import type { SourceDefinition } from "../sources.ts";
import { STORAGE_FORMAT_VERSION } from "../storage/frame.ts";
import { PayloadStore, type RecordDraft } from "../storage/payload-store.ts";
import { listSidecars, readFetchRecords } from "../storage/reader.ts";
import { RunLog } from "../storage/runs.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { uuidv7 } from "../uuid.ts";
import { ARCHIVE_BASE, coverage } from "./backfill.ts";
import { berlinDayStart, mirrorDay } from "./mirror.ts";
import { readTar, type TarEnd } from "./tar.ts";

const JOB = "archive-backfill";
const PROVENANCE = "backfill:traines-mirror-day-archive";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const GIB = 1024 ** 3;
export const MAX_MEMBERS = 3000;
const SNAPSHOT_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\.gtfs-rt\.pbf$/;
const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

export const MANIFEST_DIR = ".archive-manifests";
/** Not under `.tmp`, which the recorder empties at every start. */
export const SPOOL_DIR = ".archive-spool";

export interface ArchivePassOptions {
  /** The recordings folder: read to find the missing minutes and to compare what was recorded. */
  readonly root: string;
  /** Where the archive writer stores payloads; the recordings folder itself in production. */
  readonly storeRoot: string;
  /** Where the manifest goes, `<recordings>/.archive-manifests` in production. */
  readonly manifestRoot: string;
  /** The German local date the archive is named by. */
  readonly day: string;
  readonly source: SourceDefinition;
  readonly userAgent: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly index: IndexSink;
  readonly signal: AbortSignal;
  readonly dryRun: boolean;
  readonly archiveBase?: string;
  /** Download rate cap, to keep the load on the community mirror light. */
  readonly maxBytesPerSecond?: number;
  readonly appVersion: string;
  /** No response headers within this time aborts the pass (default 60 s). */
  readonly headersTimeoutMs?: number;
  /** No body bytes within this time aborts the pass (default 60 s). */
  readonly idleTimeoutMs?: number;
  /** Compressed bytes accepted, whatever Content-Length says (default 6 GiB, about 3 times a day archive). */
  readonly maxArchiveBytes?: number;
  /** Decompressed bytes accepted (default 1,600 times the source's payload limit). */
  readonly maxDecodedBytes?: number;
  /** The pass stops when free space on the store falls below this (the recorder's disk floor). */
  readonly diskFloorBytes?: number;
  readonly freeBytes?: FreeBytes;
}

export interface ArchiveReport {
  readonly day: string;
  readonly url: string;
  readonly archiveBytes: number;
  readonly snapshots: number;
  readonly otherMembers: number;
  /** Snapshot members whose minute lies outside the German day: counted, not in the manifest. */
  readonly outOfWindow: number;
  /** Second and later members of the same minute: counted, not in the manifest. */
  readonly repeated: number;
  readonly missingBefore: number;
  readonly inArchive: number;
  readonly stored: number;
  readonly unchanged: number;
  readonly invalid: number;
  readonly notInArchive: string[];
  readonly recordedMatched: number;
  readonly recordedDiffering: string[];
  readonly manifest: string;
  readonly complete: boolean;
  readonly seconds: number;
  /** Peak resident memory of this process so far. */
  readonly maxRssMiB: number;
}

export type ArchiveManifestLine =
  | {
      readonly type: "archive";
      readonly v: number;
      readonly source: string;
      readonly day: string;
      readonly url: string;
      readonly bytes: number;
      readonly lastModified: string | null;
      readonly snapshots: number;
      /** False when the tar ended without its end-of-archive block: retention never trusts it. */
      readonly complete: boolean;
      readonly completedAt: string;
    }
  | {
      readonly type: "snapshot";
      readonly name: string;
      readonly at: string;
      readonly sha256: string;
      readonly bytes: number;
    };

export function manifestPath(manifestRoot: string, source: string, day: string): string {
  return join(manifestRoot, source, `${day}.jsonl`);
}

export { berlinDayStart };

/** Passes a byte stream through at no more than `bytesPerSecond` on average. */
export async function* throttled(
  source: AsyncIterable<Uint8Array>,
  bytesPerSecond: number,
  clock: Clock,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const started = clock.now();
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    const due = started + (bytes / bytesPerSecond) * 1000;
    const wait = due - clock.now();
    if (wait > 0) await clock.sleep(wait, signal);
    yield chunk;
  }
}

interface Download {
  readonly body: AsyncIterable<Uint8Array>;
  readonly bytes: number | null;
  readonly lastModified: string | null;
  counted(): number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The next chunk, or the deadline's reason when none arrives within `idleMs`. */
async function nextWithin(
  iterator: AsyncIterator<Uint8Array>,
  idleMs: number,
  deadline: AbortController,
  url: string,
): Promise<IteratorResult<Uint8Array>> {
  const timer = setTimeout(
    () => deadline.abort(new Error(`${url}: no bytes for ${idleMs} ms`)),
    idleMs,
  );
  try {
    return await iterator.next();
  } catch (error) {
    throw deadline.signal.aborted ? deadline.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

async function download(url: string, options: ArchivePassOptions): Promise<Download> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const headersMs = options.headersTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleMs = options.idleTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxArchiveBytes ?? 6 * GIB;
  const headersTimer = setTimeout(
    () => deadline.abort(new Error(`${url}: no response headers within ${headersMs} ms`)),
    headersMs,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": options.userAgent, "accept-encoding": "identity" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    throw deadline.signal.aborted ? deadline.signal.reason : error;
  } finally {
    clearTimeout(headersTimer);
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${url} answered HTTP ${response.status}`);
  }
  const length = response.headers.get("content-length");
  const declared = length && /^\d+$/.test(length) ? Number(length) : null;
  if (declared !== null && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`${url}: Content-Length ${declared} exceeds ${maxBytes} compressed bytes`);
  }
  let counted = 0;
  const body = response.body;
  async function* counting(): AsyncGenerator<Uint8Array> {
    const iterator = body[Symbol.asyncIterator]();
    try {
      for (
        let next = await nextWithin(iterator, idleMs, deadline, url);
        !next.done;
        next = await nextWithin(iterator, idleMs, deadline, url)
      ) {
        counted += next.value.byteLength;
        if (counted > maxBytes) throw new Error(`${url}: more than ${maxBytes} compressed bytes`);
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }
  const rate = options.maxBytesPerSecond;
  return {
    body: rate ? throttled(counting(), rate, options.clock, options.signal) : counting(),
    bytes: declared,
    lastModified: response.headers.get("last-modified"),
    counted: () => counted,
  };
}

async function* capped(source: AsyncIterable<Buffer>, maxBytes: number): AsyncGenerator<Buffer> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`archive holds more than ${maxBytes} decompressed bytes`);
    yield chunk;
  }
}

async function checkFloor(options: ArchivePassOptions): Promise<void> {
  if (options.diskFloorBytes === undefined) return;
  const free = await (options.freeBytes ?? statfsFreeBytes)(options.storeRoot);
  if (free < options.diskFloorBytes) {
    throw new Error(
      `free space ${free} B on ${options.storeRoot} is under the recorder's floor of ${options.diskFloorBytes} B`,
    );
  }
}

/** Spool folders of a pass that was killed (SIGKILL, out of memory) and never reached its cleanup. */
async function removeOldSpools(storeRoot: string, now: number): Promise<void> {
  const dir = join(storeRoot, SPOOL_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    const { mtimeMs } = await stat(path);
    if (now - mtimeMs > DAY_MS) await rm(path, { recursive: true, force: true });
  }
}

/** What the recordings hold per mirror minute of the day: the sha256 of each successful payload. */
async function recordedMinutes(
  root: string,
  source: string,
  from: number,
  to: number,
): Promise<Map<number, Set<string>>> {
  const sidecars = await listSidecars(root, source, utcDate(from));
  const minutes = new Map<number, Set<string>>();
  for (const record of await readFetchRecords(root, sidecars)) {
    const at = snapshotOf(Date.parse(record.observedAt));
    if (at < from || at >= to || !record.sha256) continue;
    const set = minutes.get(at) ?? new Set<string>();
    set.add(record.sha256);
    minutes.set(at, set);
  }
  return minutes;
}

/** Minutes the archive writer already holds, stored or invalid, so a rerun never stores them again. */
async function archiveWriterMinutes(
  roots: readonly string[],
  source: string,
  from: number,
  to: number,
): Promise<Set<number>> {
  const minutes = new Set<number>();
  for (const root of new Set(roots)) {
    const sidecars = (await listSidecars(root, source, utcDate(from))).filter(
      (sidecar) => sidecar.date <= utcDate(to) && sidecar.path.endsWith(".archive.jsonl"),
    );
    for (const record of await readFetchRecords(root, sidecars)) {
      const at = Date.parse(record.observedAt);
      if (record.writer === "archive" && at >= from && at < to) minutes.add(at);
    }
  }
  return minutes;
}

interface Snapshot {
  readonly name: string;
  readonly at: number;
  readonly sha256: string;
  readonly bytes: number;
}

interface Scan {
  readonly snapshots: Snapshot[];
  readonly spooled: Map<number, string>;
  readonly otherMembers: number;
  readonly outOfWindow: number;
  readonly repeated: number;
  readonly complete: boolean;
}

interface Window {
  readonly from: number;
  readonly to: number;
}

async function scanArchive(
  body: AsyncIterable<Uint8Array>,
  options: ArchivePassOptions,
  window: Window,
  wanted: ReadonlySet<number>,
  spoolDir: string,
): Promise<Scan> {
  const brotli = createBrotliDecompress();
  const decoding = pipeline(Readable.from(body), brotli);
  decoding.catch(() => undefined);
  const snapshots: Snapshot[] = [];
  const seen = new Set<number>();
  const spooled = new Map<number, string>();
  let otherMembers = 0;
  let outOfWindow = 0;
  let repeated = 0;
  const end: TarEnd = { endBlock: false };
  const decoded = capped(brotli, options.maxDecodedBytes ?? 1600 * options.source.maxBytes);
  const tarOptions = { maxEntryBytes: options.source.maxBytes, maxMembers: MAX_MEMBERS };
  for await (const entry of readTar(decoded, tarOptions, end)) {
    const stamp = SNAPSHOT_NAME.exec(basename(entry.name))?.[1];
    const at = stamp ? Date.parse(stamp) : Number.NaN;
    if (Number.isNaN(at)) {
      otherMembers += 1;
      continue;
    }
    if (at < window.from || at >= window.to) {
      outOfWindow += 1;
      continue;
    }
    if (seen.has(at)) {
      repeated += 1;
      continue;
    }
    seen.add(at);
    const sha256 = createHash("sha256").update(entry.data).digest("hex");
    snapshots.push({ name: entry.name, at, sha256, bytes: entry.data.length });
    if (wanted.has(at) && !options.dryRun) {
      await checkFloor(options);
      const path = join(spoolDir, `${at}.zst`);
      await writeFile(path, await compress(entry.data));
      spooled.set(at, path);
    }
  }
  await decoding;
  return {
    snapshots: snapshots.sort((a, b) => a.at - b.at),
    spooled,
    otherMembers,
    outOfWindow,
    repeated,
    complete: end.endBlock,
  };
}

async function writeManifest(
  options: ArchivePassOptions,
  url: string,
  bytes: number,
  lastModified: string | null,
  snapshots: readonly Snapshot[],
  complete: boolean,
): Promise<string> {
  const target = manifestPath(options.manifestRoot, options.source.id, options.day);
  await mkdir(dirname(target), { recursive: true });
  const head: ArchiveManifestLine = {
    type: "archive",
    v: STORAGE_FORMAT_VERSION,
    source: options.source.id,
    day: options.day,
    url,
    bytes,
    lastModified,
    snapshots: snapshots.length,
    complete,
    completedAt: new Date(options.clock.now()).toISOString(),
  };
  const lines = [
    head,
    ...snapshots.map(
      (snapshot): ArchiveManifestLine => ({
        type: "snapshot",
        name: snapshot.name,
        at: new Date(snapshot.at).toISOString(),
        sha256: snapshot.sha256,
        bytes: snapshot.bytes,
      }),
    ),
  ];
  const temp = `${target}.part`;
  await writeFile(temp, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
    flush: true,
  });
  await rename(temp, target);
  return target;
}

interface StoreCounts {
  stored: number;
  unchanged: number;
  invalid: number;
}

async function storeSpooled(
  options: ArchivePassOptions,
  url: string,
  snapshots: readonly Snapshot[],
  spooled: ReadonlyMap<number, string>,
  runId: string,
  startedAt: string,
): Promise<StoreCounts> {
  const counts: StoreCounts = { stored: 0, unchanged: 0, invalid: 0 };
  const store = new PayloadStore({
    root: options.storeRoot,
    source: options.source.id,
    writer: "archive",
    period: "hour",
    contentType: options.source.contentType,
  });
  try {
    for (const snapshot of snapshots) {
      const path = spooled.get(snapshot.at);
      if (!path) continue;
      const payload = await decompress(await readFile(path));
      const feed = summarizeFeed(payload);
      const observedAt = new Date(snapshot.at).toISOString();
      const draft: RecordDraft = {
        v: STORAGE_FORMAT_VERSION,
        type: "fetch",
        source: options.source.id,
        run: runId,
        writer: "archive",
        url: `${url}#${snapshot.name}`,
        method: "GET",
        startedAt,
        observedAt,
        durationMs: 0,
        status: 200,
        headers: {},
        provenance: PROVENANCE,
        feed,
        ...(feed.ok
          ? {}
          : { outcome: "invalid" as const, error: `not a GTFS-RT feed: ${feed.error}` }),
      };
      const record: FetchRecord = await store.storePayload(
        draft,
        payload,
        snapshot.sha256,
        snapshot.at,
      );
      if (record.object) await options.index.objects([record]);
      if (record.outcome === "invalid") counts.invalid += 1;
      else if (record.outcome === "stored") counts.stored += 1;
      else counts.unchanged += 1;
      await rm(path, { force: true });
    }
  } finally {
    await store.close();
  }
  return counts;
}

function compare(
  snapshots: readonly Snapshot[],
  recorded: ReadonlyMap<number, ReadonlySet<string>>,
): { matched: number; differing: string[] } {
  let matched = 0;
  const differing: string[] = [];
  for (const snapshot of snapshots) {
    const ours = recorded.get(snapshot.at);
    if (!ours) continue;
    if (ours.has(snapshot.sha256)) matched += 1;
    else differing.push(new Date(snapshot.at).toISOString());
  }
  return { matched, differing };
}

/**
 * One pass over a mirror day archive (`YYYY-MM-DD.tar.br`), streamed once and never kept: a manifest of every
 * snapshot (name, minute, sha256, bytes), written only when the archive was read to its end; the minutes the
 * recordings miss are stored, in time order, as the `archive` writer with the archive URL and member as
 * provenance; and how many recorded minutes carry exactly the archived bytes. Missing minutes are spooled
 * zstd-compressed on disk while the stream runs, since the archive is not in time order.
 */
export async function archivePass(options: ArchivePassOptions): Promise<ArchiveReport> {
  const { clock, source } = options;
  const begun = clock.now();
  const url = `${options.archiveBase ?? ARCHIVE_BASE}${options.day}.tar.br`;
  const from = berlinDayStart(options.day);
  const to = berlinDayStart(mirrorDay(from + 26 * HOUR_MS));
  await checkFloor(options);
  const before = await coverage(options.root, source, from);
  const held = await archiveWriterMinutes([options.root, options.storeRoot], source.id, from, to);
  const missing = new Set(before.missing.filter((at) => at >= from && at < to && !held.has(at)));
  const recorded = await recordedMinutes(options.root, source.id, from, to);
  await removeOldSpools(options.storeRoot, clock.now());
  const spoolDir = join(options.storeRoot, SPOOL_DIR, `${options.day}-${begun}`);
  await mkdir(spoolDir, { recursive: true });
  const runId = uuidv7(begun);
  const runs = new RunLog(options.storeRoot);
  const startedAt = new Date(begun).toISOString();
  try {
    const archive = await download(url, options);
    const scan = await scanArchive(archive.body, options, { from, to }, missing, spoolDir);
    const bytes = archive.counted();
    if (archive.bytes !== null && bytes !== archive.bytes) {
      throw new Error(`${url}: received ${bytes} of ${archive.bytes} bytes`);
    }
    const manifest = await writeManifest(
      options,
      url,
      bytes,
      archive.lastModified,
      scan.snapshots,
      scan.complete,
    );
    let counts: StoreCounts = { stored: 0, unchanged: 0, invalid: 0 };
    if (!options.dryRun && scan.spooled.size > 0) {
      const row = { run: runId, source: source.id, job: JOB, appVersion: options.appVersion };
      await runs.start({ ...row, at: startedAt });
      try {
        counts = await storeSpooled(options, url, scan.snapshots, scan.spooled, runId, startedAt);
        await runs.end({
          run: runId,
          source: source.id,
          status: "succeeded",
          at: new Date(clock.now()).toISOString(),
        });
      } catch (error) {
        await runs.end({
          run: runId,
          source: source.id,
          status: "failed",
          at: new Date(clock.now()).toISOString(),
          error: errorMessage(error),
        });
        throw error;
      }
    }
    const archived = new Set(scan.snapshots.map((snapshot) => snapshot.at));
    const { matched, differing } = compare(scan.snapshots, recorded);
    return {
      day: options.day,
      url,
      archiveBytes: bytes,
      snapshots: scan.snapshots.length,
      otherMembers: scan.otherMembers,
      outOfWindow: scan.outOfWindow,
      repeated: scan.repeated,
      missingBefore: missing.size,
      inArchive: [...missing].filter((at) => archived.has(at)).length,
      ...counts,
      notInArchive: [...missing]
        .filter((at) => !archived.has(at))
        .sort((a, b) => a - b)
        .map((at) => new Date(at).toISOString()),
      recordedMatched: matched,
      recordedDiffering: differing,
      manifest,
      complete: scan.complete,
      seconds: Math.round((clock.now() - begun) / 1000),
      maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    };
  } finally {
    await rm(spoolDir, { recursive: true, force: true });
  }
}
