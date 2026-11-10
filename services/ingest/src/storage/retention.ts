import { lstat, realpath, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { berlinDayStart } from "../backfill/mirror.ts";
import {
  appendJsonLine,
  listDirIfExists,
  readJsonLinesDetailed,
  readJsonLinesFile,
  resolveInside,
  syncDir,
} from "./files.ts";
import { STORAGE_FORMAT_VERSION } from "./frame.ts";
import { sha256OfFile } from "./reader.ts";
import type { FetchRecord } from "./sidecar.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEGMENT = /^(\d{2}|day)(\.\d+)?(\.backfill|\.archive)?(\.\d+)?\.seg\.zst$/;

export const RETENTION_JOURNAL = "retention.jsonl";
export const GOLDEN_DAYS_FILE = "golden-days.jsonl";

/** Days kept whole whatever their age: the G1 window and the days the WP-2.3 replays and fixtures use. */
export const CONFIGURED_GOLDEN_DAYS: ReadonlyMap<string, string> = new Map([
  ["2026-10-25", "G1 window, WP-2.3 12 h replay and fixtures"],
  ["2026-10-26", "G1 window, feed version switch replay"],
]);

export type RetentionReason =
  | "recent"
  | "golden"
  | "unindexed"
  | "not-recoverable"
  | "unprocessed"
  | "same-as-target"
  | "newest"
  | "deletable";

export type Evidence = "archive" | "processed" | "archive+processed";

export interface RecoveryEvidence {
  /** The payload with this sha256 is in a public archive whose manifest was read to its end. */
  archived(source: string, sha256: string): boolean;
  /** The raw objects among these ids that were processed into the database without an error. */
  processed(objectIds: readonly string[]): Promise<ReadonlySet<string>>;
  describe(): Record<string, unknown>;
}

export interface RetentionUnit {
  readonly source: string;
  readonly file: string;
  readonly bytes: number;
  readonly objects: number;
  readonly from: string;
  readonly to: string;
  readonly reason: RetentionReason;
  readonly evidence: Evidence | null;
  readonly detail: string | null;
}

export interface ReasonTotals {
  files: number;
  bytes: number;
}

export interface RetentionPlan {
  readonly dryRun: true;
  readonly asOf: string;
  readonly keepDays: number;
  readonly cutoff: string;
  readonly goldenDays: Record<string, string>;
  readonly evidence: Record<string, unknown>;
  readonly totals: { files: number; bytes: number; deletableFiles: number; deletableBytes: number };
  readonly bySource: Record<string, Record<RetentionReason, ReasonTotals>>;
  readonly units: readonly RetentionUnit[];
}

export interface RetentionOptions {
  readonly root: string;
  readonly now: number;
  readonly keepDays: number;
  readonly goldenDays: ReadonlyMap<string, string>;
  readonly evidence: RecoveryEvidence;
  readonly sources?: readonly string[];
}

interface Sidecar {
  readonly path: string;
  readonly writer: string;
  readonly from: number;
  readonly to: number;
  readonly records: FetchRecord[];
  readonly badLines: readonly number[];
}

const SIDECAR_NAME = /^(\d{2}|day)(?:\.(backfill|archive))?\.jsonl$/;

interface Candidate {
  readonly source: string;
  readonly file: string;
  readonly bytes: number;
  readonly from: number;
  readonly to: number;
  readonly records: FetchRecord[];
  reason: RetentionReason;
  evidence: Evidence | null;
  detail: string | null;
}

function utcSpan(day: string): [number, number] {
  const start = Date.parse(`${day}T00:00:00Z`);
  return [start, start + DAY_MS];
}

/** A golden day covers its UTC date and its German local date: from the German midnight to the UTC one after. */
function goldenOverlap(
  from: number,
  to: number,
  golden: ReadonlyMap<string, string>,
): string | null {
  for (const [day, reason] of golden) {
    const start = berlinDayStart(day);
    const end = utcSpan(day)[1];
    if (from < end && to > start) return `${day}: ${reason}`;
  }
  return null;
}

function segmentSpan(date: string, name: string): [number, number] | null {
  const match = SEGMENT.exec(name);
  if (!match) return null;
  const [dayStart] = utcSpan(date);
  if (match[1] === "day") return [dayStart, dayStart + DAY_MS];
  const start = dayStart + Number(match[1]) * HOUR_MS;
  return [start, start + HOUR_MS];
}

/** A directory that is not a symlink: retention never follows links out of the recordings folder. */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readSidecar(
  root: string,
  date: string,
  name: string,
  file: string,
): Promise<Sidecar> {
  const { values, badLines } = await readJsonLinesDetailed<FetchRecord>(resolveInside(root, file));
  const [from, to] = segmentSpan(date, name.replace(/\.jsonl$/, ".seg.zst")) ?? utcSpan(date);
  return {
    path: file,
    writer: SIDECAR_NAME.exec(name)?.[2] ?? "live",
    from,
    to,
    records: values.filter((record) => record.type === "fetch"),
    badLines,
  };
}

function candidateOf(source: string, date: string, name: string, bytes: number): Candidate {
  const [from, to] = segmentSpan(date, name) ?? utcSpan(date);
  return {
    source,
    file: `${source}/${date}/${name}`,
    bytes,
    from,
    to,
    records: [],
    reason: "deletable",
    evidence: null,
    detail: null,
  };
}

async function readDate(
  root: string,
  source: string,
  date: string,
  into: { sidecars: Sidecar[]; candidates: Candidate[] },
): Promise<void> {
  const names = (await listDirIfExists(join(root, source, date))).sort();
  for (const name of names) {
    const file = `${source}/${date}/${name}`;
    const entry = await lstat(resolveInside(root, file));
    if (!entry.isFile()) continue;
    if (name.endsWith(".jsonl")) into.sidecars.push(await readSidecar(root, date, name, file));
    else into.candidates.push(candidateOf(source, date, name, entry.size));
  }
}

async function readSource(
  root: string,
  source: string,
): Promise<{ sidecars: Sidecar[]; candidates: Candidate[] }> {
  const found = { sidecars: [] as Sidecar[], candidates: [] as Candidate[] };
  if (!(await isRealDirectory(join(root, source)))) return found;
  const dates = (await listDirIfExists(join(root, source)))
    .filter((name) => DATE.test(name))
    .sort();
  for (const date of dates) {
    if (await isRealDirectory(join(root, source, date))) await readDate(root, source, date, found);
  }
  const byFile = new Map(found.candidates.map((candidate) => [candidate.file, candidate]));
  for (const sidecar of found.sidecars) {
    for (const record of sidecar.records) {
      if (record.object) byFile.get(record.object.file)?.records.push(record);
    }
  }
  return found;
}

function decide(candidate: Candidate, options: RetentionOptions, cutoff: number): void {
  if (candidate.to > cutoff) {
    candidate.reason = "recent";
    return;
  }
  const golden = goldenOverlap(candidate.from, candidate.to, options.goldenDays);
  if (golden) {
    candidate.reason = "golden";
    candidate.detail = golden;
    return;
  }
  if (candidate.records.length === 0) {
    candidate.reason = "unindexed";
    candidate.detail = "no sidecar line names this file";
    return;
  }
  const seqs = candidate.records
    .flatMap((record) => (record.object?.seq === undefined ? [] : [record.object.seq]))
    .sort((a, b) => a - b);
  if (seqs.some((seq, index) => seq !== index)) {
    candidate.reason = "unindexed";
    candidate.detail = "sidecar lines missing for some frames";
  }
}

function newestBefore(
  candidates: readonly Candidate[],
  writer: string,
  before: number,
): Candidate | null {
  let newest: { at: number; candidate: Candidate } | null = null;
  for (const candidate of candidates) {
    for (const record of candidate.records) {
      const at = Date.parse(record.observedAt);
      if (record.writer !== writer || at >= before) continue;
      if (!newest || at > newest.at) newest = { at, candidate };
    }
  }
  return newest?.candidate ?? null;
}

/**
 * An unreadable sidecar line may name any frame of its hour, or by sameAs the object stored last before it: every
 * file of the sidecar's period and that object's file stay.
 */
function keepAroundDamagedSidecars(
  sidecars: readonly Sidecar[],
  candidates: readonly Candidate[],
): void {
  for (const sidecar of sidecars.filter((s) => s.badLines.length > 0)) {
    const detail = `damaged sidecar ${sidecar.path} (unreadable lines ${sidecar.badLines.join(", ")})`;
    const folder = sidecar.path.slice(0, sidecar.path.lastIndexOf("/") + 1);
    for (const candidate of candidates) {
      const sameFolder = candidate.file.startsWith(folder);
      if (candidate.reason !== "deletable" || !sameFolder) continue;
      if (candidate.from < sidecar.to && candidate.to > sidecar.from) {
        candidate.reason = "unindexed";
        candidate.detail = detail;
      }
    }
    const target = newestBefore(candidates, sidecar.writer, sidecar.from);
    if (target?.reason === "deletable") {
      target.reason = "same-as-target";
      target.detail = `may be named by ${detail}`;
    }
  }
}

/** Writers whose payloads were stored so they can be processed: only processed evidence lets them go. */
const PROCESS_FIRST: ReadonlySet<string> = new Set(["archive", "backfill"]);

async function judgeRecoverable(
  candidates: readonly Candidate[],
  evidence: RecoveryEvidence,
): Promise<void> {
  const open = candidates.filter((candidate) => candidate.reason === "deletable");
  const ids = open.flatMap((candidate) =>
    candidate.records.flatMap((record) => (record.object ? [record.object.id] : [])),
  );
  const processed = ids.length > 0 ? await evidence.processed(ids) : new Set<string>();
  for (const candidate of open) {
    const kinds = new Set<string>();
    let waiting = 0;
    const missing = candidate.records.filter((record) => {
      const inArchive =
        record.sha256 !== undefined && evidence.archived(candidate.source, record.sha256);
      const archived = inArchive && !PROCESS_FIRST.has(record.writer);
      const done = record.object !== undefined && processed.has(record.object.id);
      if (archived) kinds.add("archive");
      if (done) kinds.add("processed");
      if (inArchive && !archived && !done) waiting += 1;
      return !archived && !done;
    });
    if (missing.length > waiting) {
      candidate.reason = "not-recoverable";
      candidate.detail = `${missing.length} of ${candidate.records.length} payloads in no archive and not processed`;
    } else if (waiting > 0) {
      candidate.reason = "unprocessed";
      candidate.detail = `${waiting} of ${candidate.records.length} payloads stored by the archive or backfill writer wait to be processed`;
    } else {
      candidate.evidence = ([...kinds].sort().join("+") || null) as Evidence | null;
    }
  }
}

interface SameAsIndex {
  readonly byKey: ReadonlyMap<string, Candidate>;
  readonly byFile: ReadonlyMap<string, Candidate>;
  readonly pruned: ReadonlySet<string>;
  readonly unitsOf: ReadonlyMap<string, readonly string[]>;
}

function sameAsIndex(
  sidecars: readonly Sidecar[],
  candidates: readonly Candidate[],
  pruned: ReadonlySet<string>,
): SameAsIndex {
  const byKey = new Map<string, Candidate>();
  for (const candidate of candidates) {
    for (const record of candidate.records) {
      if (record.object) byKey.set(record.object.key, candidate);
    }
  }
  const unitsOf = new Map<string, string[]>();
  for (const sidecar of sidecars) {
    const files = sidecar.records.flatMap((record) => (record.object ? [record.object.file] : []));
    unitsOf.set(sidecar.path, [...new Set(files)]);
  }
  return { byKey, byFile: new Map(candidates.map((c) => [c.file, c])), pruned, unitsOf };
}

/** Every file that holds the sidecar's stored payloads is going, or was pruned by an earlier apply. */
function sidecarGoes(index: SameAsIndex, sidecar: Sidecar): boolean {
  const units = index.unitsOf.get(sidecar.path) ?? [];
  const going = (file: string) => {
    const candidate = index.byFile.get(file);
    return candidate ? candidate.reason === "deletable" : index.pruned.has(file);
  };
  return units.length > 0 && units.every(going);
}

function keepTargetsOnce(
  source: string,
  sidecars: readonly Sidecar[],
  index: SameAsIndex,
  evidence: RecoveryEvidence,
): boolean {
  let changed = false;
  for (const sidecar of sidecars) {
    const goes = sidecarGoes(index, sidecar);
    for (const record of sidecar.records) {
      const target = record.sameAs ? index.byKey.get(record.sameAs) : undefined;
      if (target?.reason !== "deletable") continue;
      const bytesSafe = record.sha256 !== undefined && evidence.archived(source, record.sha256);
      if (goes && bytesSafe) continue;
      target.reason = "same-as-target";
      target.detail = `named by ${sidecar.path} at ${record.observedAt}`;
      changed = true;
    }
  }
  return changed;
}

/**
 * A segment named by a sameAs line stays, unless the line's own segments go too and the line's bytes are
 * recoverable themselves; repeated until nothing changes, since keeping one file can keep the next.
 */
function keepSameAsTargets(
  source: string,
  sidecars: readonly Sidecar[],
  candidates: readonly Candidate[],
  evidence: RecoveryEvidence,
  pruned: ReadonlySet<string>,
): void {
  const index = sameAsIndex(sidecars, candidates, pruned);
  let changed: boolean;
  do {
    changed = keepTargetsOnce(source, sidecars, index, evidence);
  } while (changed);
}

function keepNewest(candidates: readonly Candidate[]): void {
  let newest: { at: number; candidate: Candidate } | null = null;
  for (const candidate of candidates) {
    for (const record of candidate.records) {
      const at = Date.parse(record.observedAt);
      if (!newest || at > newest.at) newest = { at, candidate };
    }
  }
  if (newest && newest.candidate.reason === "deletable") {
    newest.candidate.reason = "newest";
    newest.candidate.detail = "holds the newest object of the source";
  }
}

const REASONS: readonly RetentionReason[] = [
  "recent",
  "golden",
  "unindexed",
  "not-recoverable",
  "unprocessed",
  "same-as-target",
  "newest",
  "deletable",
];

function emptyTotals(): Record<RetentionReason, ReasonTotals> {
  return Object.fromEntries(REASONS.map((reason) => [reason, { files: 0, bytes: 0 }])) as Record<
    RetentionReason,
    ReasonTotals
  >;
}

/**
 * Which recorded files may go, never deleting history: a segment or stored file goes only when it ends
 * more than `keepDays` before `now`, touches no golden day, every payload in it is in a public archive (a
 * complete manifest holds its sha256) or was processed into the database, no remaining sidecar line names it
 * by sameAs, and it does not hold the newest object of its source. Sidecars are never deleted. Read only.
 */
export async function planRetention(options: RetentionOptions): Promise<RetentionPlan> {
  const cutoff = options.now - options.keepDays * DAY_MS;
  const sources =
    options.sources ??
    (await listDirIfExists(options.root)).filter((name) => /^[a-z][a-z0-9-]+$/.test(name)).sort();
  const pruned = await readPrunedFiles(options.root);
  const all: Candidate[] = [];
  for (const source of sources) {
    const { sidecars, candidates } = await readSource(options.root, source);
    for (const candidate of candidates) decide(candidate, options, cutoff);
    keepAroundDamagedSidecars(sidecars, candidates);
    await judgeRecoverable(candidates, options.evidence);
    keepNewest(candidates);
    keepSameAsTargets(source, sidecars, candidates, options.evidence, pruned);
    all.push(...candidates);
  }
  const bySource: Record<string, Record<RetentionReason, ReasonTotals>> = {};
  for (const candidate of all) {
    const totals = bySource[candidate.source] ?? emptyTotals();
    bySource[candidate.source] = totals;
    totals[candidate.reason].files += 1;
    totals[candidate.reason].bytes += candidate.bytes;
  }
  const deletable = all.filter((candidate) => candidate.reason === "deletable");
  return {
    dryRun: true,
    asOf: new Date(options.now).toISOString(),
    keepDays: options.keepDays,
    cutoff: new Date(cutoff).toISOString(),
    goldenDays: Object.fromEntries(options.goldenDays),
    evidence: options.evidence.describe(),
    totals: {
      files: all.length,
      bytes: all.reduce((sum, candidate) => sum + candidate.bytes, 0),
      deletableFiles: deletable.length,
      deletableBytes: deletable.reduce((sum, candidate) => sum + candidate.bytes, 0),
    },
    bySource,
    units: all.map((candidate) => ({
      source: candidate.source,
      file: candidate.file,
      bytes: candidate.bytes,
      objects: candidate.records.length,
      from: new Date(candidate.from).toISOString(),
      to: new Date(candidate.to).toISOString(),
      reason: candidate.reason,
      evidence: candidate.evidence,
      detail: candidate.detail,
    })),
  };
}

export interface ApplyResult {
  readonly deleted: RetentionUnit[];
  readonly skipped: { file: string; why: string }[];
  readonly freedBytes: number;
}

/**
 * Deletes the deletable files of a plan made just now. Each file is checked again (same size), its sha256 and
 * evidence are appended to `retention.jsonl` before it is unlinked, so a pruned file is always explained.
 */
/** Why a planned file must not be deleted now: gone, changed, not a regular file, or outside the root. */
async function refusal(
  realRoot: string,
  path: string,
  unit: RetentionUnit,
): Promise<string | null> {
  const entry = await lstat(path).catch(() => null);
  if (entry === null) return "file is gone";
  if (!entry.isFile()) return "not a regular file";
  if (entry.size !== unit.bytes) return "size changed since the plan";
  const real = await realpath(path);
  if (!real.startsWith(`${realRoot}${sep}`)) return "resolves outside the recordings folder";
  return null;
}

export async function applyRetention(
  root: string,
  plan: RetentionPlan,
  now: Date,
  run: string,
): Promise<ApplyResult> {
  if (Math.abs(Date.parse(plan.asOf) - now.getTime()) > HOUR_MS) {
    throw new Error(`the plan is as of ${plan.asOf}, not now: plan again before deleting`);
  }
  const deleted: RetentionUnit[] = [];
  const skipped: { file: string; why: string }[] = [];
  const repaired = new Set<string>();
  const realRoot = await realpath(root);
  for (const unit of plan.units.filter((candidate) => candidate.reason === "deletable")) {
    const path = resolveInside(root, unit.file);
    const why = await refusal(realRoot, path, unit);
    if (why !== null) {
      skipped.push({ file: unit.file, why });
      continue;
    }
    const { sha256 } = await sha256OfFile(path);
    await appendJsonLine(
      resolveInside(root, RETENTION_JOURNAL),
      {
        v: STORAGE_FORMAT_VERSION,
        type: "pruned",
        run,
        at: now.toISOString(),
        file: unit.file,
        bytes: unit.bytes,
        sha256,
        objects: unit.objects,
        evidence: unit.evidence,
        from: unit.from,
        to: unit.to,
      },
      repaired,
    );
    await unlink(path);
    await syncDir(join(root, unit.file, ".."));
    deleted.push(unit);
  }
  return { deleted, skipped, freedBytes: deleted.reduce((sum, unit) => sum + unit.bytes, 0) };
}

/** Files that retention deleted on purpose, so readers report them as pruned rather than lost. */
export async function readPrunedFiles(root: string): Promise<Set<string>> {
  const lines = await readJsonLinesFile<{ type?: string; file?: string }>(
    resolveInside(root, RETENTION_JOURNAL),
  );
  return new Set(lines.flatMap((line) => (line.type === "pruned" && line.file ? [line.file] : [])));
}

/** Throws on an unreadable line, since a golden day silently dropped would let its files go. */
export async function readGoldenDays(root: string): Promise<Map<string, string>> {
  const days = new Map(CONFIGURED_GOLDEN_DAYS);
  const { values: marked, badLines } = await readJsonLinesDetailed<{
    day?: string;
    reason?: string;
  }>(resolveInside(root, GOLDEN_DAYS_FILE));
  if (badLines.length > 0) {
    throw new Error(
      `${GOLDEN_DAYS_FILE} has unreadable line ${badLines.join(", ")}: repair it before planning retention`,
    );
  }
  for (const line of marked)
    if (line.day && DATE.test(line.day)) days.set(line.day, line.reason ?? "marked");
  return days;
}

export async function markGoldenDay(
  root: string,
  day: string,
  reason: string,
  at: Date,
): Promise<void> {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (
    !DATE.test(day) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== day
  ) {
    throw new Error(`golden day must be a date as YYYY-MM-DD, got ${JSON.stringify(day)}`);
  }
  await appendJsonLine(
    resolveInside(root, GOLDEN_DAYS_FILE),
    { v: STORAGE_FORMAT_VERSION, day, reason, at: at.toISOString() },
    new Set(),
  );
}

interface ManifestHead {
  readonly type: "archive";
  readonly source: string;
  readonly complete?: boolean;
}

export interface ArchiveEvidence {
  readonly manifests: string[];
  archived(source: string, sha256: string): boolean;
}

/** The snapshot sha256 values of one manifest, or null when it is not complete or not of this source. */
async function readManifest(path: string, source: string): Promise<string[] | null> {
  const lines = await readJsonLinesFile<ManifestHead | { type: "snapshot"; sha256: string }>(path);
  const head = lines[0];
  if (head?.type !== "archive" || head.complete !== true || head.source !== source) return null;
  return lines.flatMap((line) => (line.type === "snapshot" ? [line.sha256] : []));
}

/** The sha256 of every snapshot in complete archive manifests (`<dir>/<source>/<day>.jsonl`). */
export async function loadArchiveEvidence(dirs: readonly string[]): Promise<ArchiveEvidence> {
  const known = new Map<string, Set<string>>();
  const manifests: string[] = [];
  for (const dir of dirs) {
    for (const source of await listDirIfExists(dir)) {
      const names = (await listDirIfExists(join(dir, source))).filter((f) => f.endsWith(".jsonl"));
      for (const name of names.sort()) {
        const hashes = await readManifest(join(dir, source, name), source);
        if (!hashes) continue;
        const set = known.get(source) ?? new Set<string>();
        for (const hash of hashes) set.add(hash);
        known.set(source, set);
        manifests.push(`${source}/${name}`);
      }
    }
  }
  return {
    manifests,
    archived: (source, sha256) => known.get(source)?.has(sha256) ?? false,
  };
}
