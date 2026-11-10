import type { Head } from "@gerlines/live-frame";

export const WINDOW_SECONDS = 3600;

/** The first head of each state: [publication time, sequence, keyframe, oldest delta, timetable version]. */
export type HeadEntry = readonly [number, number, number, number, number];

export interface WindowIndex {
  readonly start: number;
  readonly end: number;
  readonly revision: string;
  readonly shapeEpoch: number;
  readonly heads: readonly HeadEntry[];
}

export interface WindowSummary {
  readonly start: number;
  readonly end: number;
  readonly revision: string;
  readonly shapeEpoch: number;
}

export interface PlaybackLimits {
  readonly windowSeconds: number;
  readonly maxAgeSeconds: number;
  readonly settleSeconds: number;
}

export interface WindowList {
  readonly windows: readonly WindowSummary[];
  readonly limits: PlaybackLimits;
}

const REVISION = /^[0-9a-f]{12}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function aligned(start: unknown, end: unknown): start is number {
  return whole(start) && end === start + WINDOW_SECONDS && start % WINDOW_SECONDS === 0;
}

function headEntry(value: unknown, previous: HeadEntry | undefined): HeadEntry | null {
  if (!(Array.isArray(value) && value.length === 5 && value.every(whole))) return null;
  const [time, sequence, keyframe, oldest, version] = value as number[] as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (keyframe < 1 || keyframe > sequence || oldest < 2 || oldest > keyframe + 1) return null;
  if (previous && (time < previous[0] || sequence < previous[1])) return null;
  return [time, sequence, keyframe, oldest, version];
}

/** A window's index as the service sends it (`{ data }`), null when it is not one this client can play. */
export function parseWindowIndex(body: unknown): WindowIndex | null {
  const data = record(record(body)?.data);
  if (data?.format !== 1 || !Array.isArray(data.heads) || data.heads.length === 0) {
    return null;
  }
  const { start, end, revision, shapeEpoch } = data;
  if (!(aligned(start, end) && typeof revision === "string" && REVISION.test(revision))) {
    return null;
  }
  if (!whole(shapeEpoch)) return null;
  const heads: HeadEntry[] = [];
  for (const raw of data.heads) {
    const entry = headEntry(raw, heads.at(-1));
    if (!entry) return null;
    heads.push(entry);
  }
  return { start, end: start + WINDOW_SECONDS, revision, shapeEpoch, heads };
}

function summary(value: unknown): WindowSummary | null {
  const item = record(value);
  if (!item) return null;
  const { start, end, revision, shapeEpoch } = item;
  if (!(aligned(start, end) && typeof revision === "string" && REVISION.test(revision))) {
    return null;
  }
  return whole(shapeEpoch) ? { start, end: start + WINDOW_SECONDS, revision, shapeEpoch } : null;
}

/** `/playback/v1/windows`: the windows that can be played now, oldest first, and the limits. */
export function parseWindowList(body: unknown): WindowList | null {
  const data = record(record(body)?.data);
  const limits = record(data?.limits);
  if (!(data && limits && Array.isArray(data.windows))) return null;
  const { windowSeconds, maxAgeSeconds, settleSeconds } = limits;
  if (!(whole(windowSeconds) && whole(maxAgeSeconds) && whole(settleSeconds))) return null;
  const windows = data.windows
    .map(summary)
    .filter((window): window is WindowSummary => window !== null)
    .sort((a, b) => a.start - b.start);
  return { windows, limits: { windowSeconds, maxAgeSeconds, settleSeconds } };
}

export function windowStartOf(instant: number): number {
  return Math.floor(instant / WINDOW_SECONDS) * WINDOW_SECONDS;
}

function lastPublishedBy(heads: readonly HeadEntry[], at: number): HeadEntry | undefined {
  let low = 0;
  let high = heads.length - 1;
  let found: HeadEntry | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = heads[middle] as HeadEntry;
    if (entry[0] <= at) {
      found = entry;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * The head a client of the live chain saw at `at` (the service's `head?at=`): the newest state
 * published by then, stamped with the instant, at most the window's end. Before the first head the
 * first head answers at its own time.
 */
export function headAt(index: WindowIndex, at: number): Head | null {
  const entry = lastPublishedBy(index.heads, at) ?? index.heads[0];
  if (!entry) return null;
  const [published, sequence, keyframeSequence, oldestSequence, timetableVersion] = entry;
  return {
    kind: "head",
    sequence,
    timetableVersion,
    timeBase: Math.max(published, Math.min(Math.floor(at), index.end)),
    keyframeSequence,
    oldestSequence,
  };
}
