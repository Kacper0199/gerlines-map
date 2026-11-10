import { join } from "node:path";
import { listDirIfExists } from "./files.ts";
import type { LastObject } from "./payload-store.ts";
import { listSidecars, readFetchRecords } from "./reader.ts";
import { type FetchRecord, isSuccess } from "./sidecar.ts";

export interface SourceState {
  readonly last: LastObject | null;
  readonly lastSuccessAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly objectUrl: string | null;
  readonly bytes: number | null;
  readonly feedTimestamp: number | null;
  readonly feedTimestampSince: number | null;
}

export const EMPTY_STATE: SourceState = {
  last: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  etag: null,
  lastModified: null,
  objectUrl: null,
  bytes: null,
  feedTimestamp: null,
  feedTimestampSince: null,
};

function lastObjectOf(record: FetchRecord): LastObject | null {
  if (record.object && record.sha256) return { sha256: record.sha256, key: record.object.key };
  if (record.sameAs && record.sha256) return { sha256: record.sha256, key: record.sameAs };
  return null;
}

function feedUpdate(state: SourceState, record: FetchRecord, at: number): Partial<SourceState> {
  const timestamp = record.feed?.ok ? record.feed.headerTimestamp : null;
  if (timestamp === null || timestamp === undefined) return {};
  return timestamp === state.feedTimestamp
    ? {}
    : { feedTimestamp: timestamp, feedTimestampSince: at };
}

/** One sidecar record applied to what the next fetch of the source needs to know. */
export function applyRecord(state: SourceState, record: FetchRecord): SourceState {
  const at = Date.parse(record.observedAt);
  const last = lastObjectOf(record);
  return {
    ...state,
    lastAttemptAt: Math.max(state.lastAttemptAt ?? at, at),
    ...(isSuccess(record) ? { lastSuccessAt: Math.max(state.lastSuccessAt ?? at, at) } : {}),
    ...(last
      ? {
          last,
          etag: record.headers.etag ?? null,
          lastModified: record.headers["last-modified"] ?? null,
          objectUrl: record.url,
          bytes: record.bytes ?? null,
        }
      : {}),
    ...feedUpdate(state, record, at),
  };
}

export function foldState(records: readonly FetchRecord[]): SourceState {
  return records.reduce(applyRecord, EMPTY_STATE);
}

/**
 * The latest successful fetch observed before `beforeMs`, with no bound on how far back: date folders
 * are read newest first until one holds a success, so an outage of any length still yields its gap.
 */
export async function lastSuccessBefore(
  root: string,
  source: string,
  beforeMs: number,
): Promise<number | null> {
  const lastDate = new Date(beforeMs).toISOString().slice(0, 10);
  const dates = (await listDirIfExists(join(root, source)))
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && name <= lastDate)
    .sort()
    .reverse();
  for (const date of dates) {
    const sidecars = (await listSidecars(root, source, date)).filter((file) => file.date === date);
    const times = (await readFetchRecords(root, sidecars))
      .filter(isSuccess)
      .map((record) => Date.parse(record.observedAt))
      .filter((at) => at < beforeMs);
    if (times.length > 0) return Math.max(...times);
  }
  return null;
}

export async function restoreState(
  root: string,
  source: string,
  now: number,
  days: number,
): Promise<SourceState> {
  const sinceMs = now - days * 86_400_000;
  const since = new Date(sinceMs).toISOString().slice(0, 10);
  const sidecars = (await listSidecars(root, source, since)).filter(
    (file) => !file.path.includes(".backfill.") && !file.path.includes(".archive."),
  );
  const records = await readFetchRecords(root, sidecars);
  records.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const state = foldState(records);
  if (state.lastSuccessAt !== null) return state;
  return { ...state, lastSuccessAt: await lastSuccessBefore(root, source, now) };
}
