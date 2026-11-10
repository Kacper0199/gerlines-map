import { utcDate } from "./clock.ts";
import { findGaps, type Gap, openGap } from "./gaps.ts";
import { travelPlan } from "./policy/travel.ts";
import type { SourceDefinition } from "./sources.ts";
import { readJsonLinesFile, readTextIfExists, resolveInside } from "./storage/files.ts";
import { type ModeSetting, type RecorderMode, readMode } from "./storage/mode.ts";
import { EVENTS_PATH, LOCK_PATH } from "./storage/paths.ts";
import { listSidecars, readFetchRecords } from "./storage/reader.ts";
import { type FetchRecord, isSuccess } from "./storage/sidecar.ts";
import { foldState, lastSuccessBefore } from "./storage/state.ts";

export interface DayCounts {
  attempts: number;
  stored: number;
  unchanged: number;
  notModified: number;
  failed: number;
  payloadBytes: number;
  storedBytes: number;
}

export interface SourceStatus {
  readonly source: string;
  readonly cadenceSeconds: number;
  readonly lastSuccess: string | null;
  readonly lastError: { at: string; outcome: string; status: number | null; error: string } | null;
  readonly today: DayCounts;
  readonly feedTimestamp: string | null;
  readonly feedUnchangedSeconds: number | null;
  /** `held`: the current mode does not fetch this source; its time becomes a gap, not a failure. */
  readonly condition: "ok" | "failing" | "stale" | "held";
  readonly heldBy: RecorderMode | null;
  readonly stale: string | null;
  readonly staleAfterSeconds: number;
  readonly openGap: { from: string; seconds: number } | null;
  readonly gaps: { from: string; to: string; seconds: number }[];
}

export interface RecorderStatus {
  readonly at: string;
  readonly heartbeat: { at: string; ageSeconds: number; host: string } | null;
  readonly lastDiskEvent: Record<string, unknown> | null;
  readonly mode: ModeSetting;
  readonly sources: SourceStatus[];
}

function emptyCounts(): DayCounts {
  return {
    attempts: 0,
    stored: 0,
    unchanged: 0,
    notModified: 0,
    failed: 0,
    payloadBytes: 0,
    storedBytes: 0,
  };
}

function countRecord(counts: DayCounts, record: FetchRecord): void {
  counts.attempts += 1;
  if (record.outcome === "stored") {
    counts.stored += 1;
    counts.payloadBytes += record.bytes ?? 0;
    counts.storedBytes += record.object?.length ?? record.bytes ?? 0;
  } else if (record.outcome === "unchanged") counts.unchanged += 1;
  else if (record.outcome === "not-modified") counts.notModified += 1;
  else if (!isSuccess(record)) counts.failed += 1;
}

function lastErrorOf(records: readonly FetchRecord[]): SourceStatus["lastError"] {
  const failed = records.findLast((record) => !isSuccess(record));
  return failed
    ? {
        at: failed.startedAt,
        outcome: failed.outcome,
        status: failed.status,
        error: failed.error ?? "",
      }
    : null;
}

const iso = (t: number) => new Date(t).toISOString();
const seconds = (ms: number) => Math.round(ms / 1000);

const MIN_STALE_MS = 5 * 60_000;

/** How long a feed header may stand still before the source counts as stale. */
export function staleThresholdMs(source: SourceDefinition): number {
  return source.staleAfterMs ?? Math.max(MIN_STALE_MS, 3 * source.periodMs);
}

/** The cadence the current mode fetches a source at, or null when the mode holds it. */
export interface EffectiveCadence {
  readonly mode: RecorderMode;
  readonly periodMs: number | null;
}

export function effectiveCadences(
  mode: RecorderMode,
  sources: readonly SourceDefinition[],
): Map<string, EffectiveCadence> {
  const travel = travelPlan(sources.map((source) => source.id));
  const periodOf = (source: SourceDefinition): number | null => {
    if (mode === "paused") return null;
    if (mode === "travel") return travel.get(source.id) ?? null;
    return source.periodMs;
  };
  return new Map(
    sources.map((source): [string, EffectiveCadence] => [
      source.id,
      { mode, periodMs: periodOf(source) },
    ]),
  );
}

function staleness(
  source: SourceDefinition,
  periodMs: number,
  now: number,
  open: Gap | null,
  unchangedMs: number | null,
): string | null {
  if (open) return `no successful fetch for ${seconds(now - open.start)} s`;
  if (unchangedMs === null) return null;
  const threshold = Math.max(staleThresholdMs(source), 3 * periodMs);
  if (source.kind === "gtfs-rt" && unchangedMs > threshold) {
    return `feed header timestamp has not advanced for ${seconds(unchangedMs)} s`;
  }
  return null;
}

async function readRecent(root: string, source: SourceDefinition, now: number, days: number) {
  const since = utcDate(now - days * 86_400_000);
  const records = await readFetchRecords(root, await listSidecars(root, source.id, since));
  records.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const live = records.filter((record) => record.writer === "live");
  const folded = foldState(live);
  const state =
    folded.lastSuccessAt === null
      ? { ...folded, lastSuccessAt: await lastSuccessBefore(root, source.id, now) }
      : folded;
  const today = emptyCounts();
  const todayDate = utcDate(now);
  for (const record of records) {
    if (record.observedAt.startsWith(todayDate)) countRecord(today, record);
  }
  return { records, live, state, today };
}

function conditionOf(
  held: boolean,
  stale: string | null,
  failing: boolean,
): SourceStatus["condition"] {
  if (held) return "held";
  if (stale) return "stale";
  return failing ? "failing" : "ok";
}

export async function sourceStatus(
  root: string,
  source: SourceDefinition,
  now: number,
  days: number,
  cadence: EffectiveCadence = { mode: "full", periodMs: source.periodMs },
): Promise<SourceStatus> {
  const held = cadence.periodMs === null;
  const periodMs = cadence.periodMs ?? source.periodMs;
  const { records, live, state, today } = await readRecent(root, source, now, days);
  const open = held ? null : openGap(state.lastSuccessAt, now, periodMs);
  const unchangedMs =
    state.feedTimestampSince === null
      ? null
      : (state.lastSuccessAt ?? now) - state.feedTimestampSince;
  const gaps = findGaps(
    records.filter(isSuccess).map((record) => Date.parse(record.observedAt)),
    periodMs,
  );
  const lastError = lastErrorOf(live);
  const failing =
    lastError !== null &&
    Date.parse(lastError.at) > (state.lastSuccessAt ?? Number.NEGATIVE_INFINITY);
  const stale = held ? null : staleness(source, periodMs, now, open, unchangedMs);
  return {
    source: source.id,
    cadenceSeconds: seconds(periodMs),
    lastSuccess: state.lastSuccessAt === null ? null : iso(state.lastSuccessAt),
    lastError,
    condition: conditionOf(held, stale, failing),
    heldBy: held ? cadence.mode : null,
    today,
    feedTimestamp: state.feedTimestamp === null ? null : iso(state.feedTimestamp * 1000),
    feedUnchangedSeconds: unchangedMs === null ? null : seconds(unchangedMs),
    stale,
    staleAfterSeconds: seconds(Math.max(staleThresholdMs(source), 3 * periodMs)),
    openGap: open ? { from: iso(open.start), seconds: seconds(now - open.start) } : null,
    gaps: gaps.map((gap) => ({
      from: iso(gap.start),
      to: iso(gap.end),
      seconds: seconds(gap.end - gap.start),
    })),
  };
}

export async function recorderStatus(
  root: string,
  sources: readonly SourceDefinition[],
  now: number,
  days = 3,
): Promise<RecorderStatus> {
  const lockText = await readTextIfExists(resolveInside(root, LOCK_PATH));
  const lock = lockText ? (JSON.parse(lockText) as { heartbeatAt: string; host: string }) : null;
  const events = await readJsonLinesFile<Record<string, unknown>>(resolveInside(root, EVENTS_PATH));
  const disk =
    events.findLast((event) => event.type === "disk-pause" || event.type === "disk-resume") ?? null;
  const mode = await readMode(root);
  const cadences = effectiveCadences(mode.mode, sources);
  const statuses: SourceStatus[] = [];
  for (const source of sources) {
    statuses.push(await sourceStatus(root, source, now, days, cadences.get(source.id)));
  }
  return {
    at: iso(now),
    heartbeat: lock
      ? {
          at: lock.heartbeatAt,
          ageSeconds: seconds(now - Date.parse(lock.heartbeatAt)),
          host: lock.host,
        }
      : null,
    lastDiskEvent: disk,
    mode,
    sources: statuses,
  };
}

const MIB = 1024 * 1024;

function conditionText(status: SourceStatus): string {
  if (status.condition === "held") return `held (${status.heldBy})`;
  if (status.condition === "stale") return `STALE, ${status.stale}`;
  if (status.condition === "failing")
    return `FAILING, latest fetch failed at ${status.lastError?.at}`;
  return "ok";
}

function formatSource(status: SourceStatus): string[] {
  const t = status.today;
  const lines = [
    `${status.source} (every ${status.cadenceSeconds} s, stale after ${status.staleAfterSeconds} s): ${conditionText(status)}`,
    `  last success ${status.lastSuccess ?? "never"}; feed header ${status.feedTimestamp ?? "n/a"}${status.feedUnchangedSeconds ? `, unchanged for ${status.feedUnchangedSeconds} s` : ""}`,
    `  today: ${t.attempts} fetches, ${t.stored} stored, ${t.unchanged} unchanged, ${t.notModified} not modified, ${t.failed} failed; payload ${(t.payloadBytes / MIB).toFixed(1)} MiB, on disk ${(t.storedBytes / MIB).toFixed(2)} MiB`,
  ];
  if (status.lastError) {
    lines.push(
      `  last error ${status.lastError.at}: ${status.lastError.outcome} ${status.lastError.status ?? ""} ${status.lastError.error}`.trimEnd(),
    );
  }
  if (status.openGap)
    lines.push(`  open gap since ${status.openGap.from} (${status.openGap.seconds} s)`);
  for (const gap of status.gaps) lines.push(`  gap ${gap.from} to ${gap.to} (${gap.seconds} s)`);
  return lines;
}

export function formatStatus(status: RecorderStatus): string {
  const header = [
    `recorder status at ${status.at}`,
    status.heartbeat
      ? `heartbeat ${status.heartbeat.at} (${status.heartbeat.ageSeconds} s ago, host ${status.heartbeat.host})`
      : "no recorder lock: the recorder is not running",
    status.lastDiskEvent
      ? `last disk event: ${JSON.stringify(status.lastDiskEvent)}`
      : "disk: no pause recorded",
    `mode: ${status.mode.mode}${status.mode.at ? ` since ${status.mode.at}` : ""}${status.mode.reason ? ` (${status.mode.reason})` : ""}`,
  ];
  return [...header, ...status.sources.flatMap(formatSource)].join("\n");
}
