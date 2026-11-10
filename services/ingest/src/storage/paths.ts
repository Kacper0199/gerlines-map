import { utcDate, utcHour } from "../clock.ts";
import type { Writer } from "./sidecar.ts";

export type SegmentPeriod = "hour" | "day";

export interface SegmentLocation {
  readonly periodKey: string;
  readonly segment: string;
  readonly sidecar: string;
}

function writerSuffix(writer: Writer): string {
  return writer === "live" ? "" : `.${writer}`;
}

/** Relative paths of the segment and sidecar that hold fetches of `source` at `epochMs` (UTC). */
export function segmentLocation(
  source: string,
  epochMs: number,
  period: SegmentPeriod,
  writer: Writer,
): SegmentLocation {
  const date = utcDate(epochMs);
  const stem = period === "hour" ? utcHour(epochMs) : "day";
  const base = `${source}/${date}/${stem}${writerSuffix(writer)}`;
  return { periodKey: `${date}/${stem}`, segment: `${base}.seg.zst`, sidecar: `${base}.jsonl` };
}

/** `<HH>.seg.zst` for n = 0, then `<HH>.1.seg.zst`, `<HH>.2.seg.zst` for rotated segments. */
export function rotatedSegment(segment: string, n: number): string {
  return n === 0 ? segment : segment.replace(/\.seg\.zst$/, `.${n}.seg.zst`);
}

export function objectKey(segment: string, seq: number): string {
  return `${segment.replace(/\.seg\.zst$/, "")}/${String(seq).padStart(5, "0")}`;
}

export function rawFilePath(source: string, epochMs: number, name: string): string {
  const iso = new Date(epochMs).toISOString();
  const stamp = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return `${source}/${utcDate(epochMs)}/${stamp}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

export function runsPath(source: string): string {
  return `${source}/runs.jsonl`;
}

export const EVENTS_PATH = "recorder-events.jsonl";
export const LOCK_PATH = ".recorder.lock";
export const TMP_DIR = ".tmp";

export const SIDECAR_PATTERN = /^(\d{4}-\d{2}-\d{2})\/(\d{2}|day)(\.backfill|\.archive)?\.jsonl$/;
