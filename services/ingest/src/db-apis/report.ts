import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../log.ts";
import { type IrisEvent, type IrisStop, parseIrisTimetable, stopChanged } from "./iris.ts";
import type { RequestLogLine } from "./live.ts";

const MINUTE = 60_000;

export interface SizeSummary {
  readonly count: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly total: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export function sizeSummary(values: readonly number[]): SizeSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    total: sorted.reduce((sum, value) => sum + value, 0),
  };
}

/** The most requests started inside any window of `windowMs`. */
export function maxInWindow(startTimes: readonly number[], windowMs = MINUTE): number {
  const sorted = [...startTimes].sort((a, b) => a - b);
  let best = 0;
  let from = 0;
  for (let to = 0; to < sorted.length; to += 1) {
    while ((sorted[to] ?? 0) - (sorted[from] ?? 0) >= windowMs) from += 1;
    best = Math.max(best, to - from + 1);
  }
  return best;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

interface ParsedPayload {
  readonly line: RequestLogLine;
  readonly stops: readonly IrisStop[];
}

export interface ChangeShare {
  readonly plannedCalls: number;
  readonly callsWithRealtimeChange: number;
  readonly share: number;
  readonly delayedAtLeastOneMinute: number;
  readonly cancelled: number;
  readonly byCategory: Readonly<Record<string, { planned: number; changed: number }>>;
}

function collect(payloads: readonly ParsedPayload[]) {
  const planned = new Map<string, IrisStop>();
  const changed = new Map<string, IrisStop[]>();
  for (const { line, stops } of payloads) {
    for (const stop of stops) {
      const key = `${line.eva}:${stop.id}`;
      if (line.endpoint === "plan") planned.set(key, stop);
      else if (stopChanged(stop)) changed.set(key, [...(changed.get(key) ?? []), stop]);
    }
  }
  return { planned, changed };
}

type Side = "arrival" | "departure";

function latest(updates: readonly IrisStop[], side: Side, pick: (e: IrisEvent) => string | null) {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const event = updates[i]?.[side];
    const value = event ? pick(event) : null;
    if (value !== null) return value;
  }
  return null;
}

function assess(stop: IrisStop, updates: readonly IrisStop[]) {
  const sides: Side[] = ["arrival", "departure"];
  const late = sides.some((side) => {
    const plannedAt = stop[side]?.plannedTime ?? null;
    const changedAt = latest(updates, side, (event) => event.changedTime);
    return (
      plannedAt !== null &&
      changedAt !== null &&
      Date.parse(changedAt) - Date.parse(plannedAt) >= MINUTE
    );
  });
  const cancelled = sides.some(
    (side) => latest(updates, side, (event) => event.changedStatus) === "cancelled",
  );
  return { changed: updates.length > 0, late, cancelled };
}

/**
 * Calls are the stops (`s` ids, a train at one station) that a `plan` payload of the run announced; a
 * call has a realtime change when any `fchg` or `rchg` payload carries a changed time, platform, path,
 * status or a cancellation for it. Delay and cancellation use the latest value of each event.
 */
export function changeShare(payloads: readonly ParsedPayload[]): ChangeShare {
  const { planned, changed } = collect(payloads);
  const byCategory: Record<string, { planned: number; changed: number }> = {};
  const totals = { changed: 0, late: 0, cancelled: 0 };
  for (const [key, stop] of planned) {
    const category = stop.tripLabel?.category ?? "unknown";
    const row = byCategory[category] ?? { planned: 0, changed: 0 };
    const verdict = assess(stop, changed.get(key) ?? []);
    row.planned += 1;
    row.changed += verdict.changed ? 1 : 0;
    totals.changed += verdict.changed ? 1 : 0;
    totals.late += verdict.late ? 1 : 0;
    totals.cancelled += verdict.cancelled ? 1 : 0;
    byCategory[category] = row;
  }
  return {
    plannedCalls: planned.size,
    callsWithRealtimeChange: totals.changed,
    share: planned.size === 0 ? 0 : totals.changed / planned.size,
    delayedAtLeastOneMinute: totals.late,
    cancelled: totals.cancelled,
    byCategory,
  };
}

/** Reads a run folder written by `iris-run` and summarises load, sizes, parse errors and changes. */
export async function irisRunReport(outDir: string) {
  const text = await readFile(join(outDir, "requests.jsonl"), "utf8");
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RequestLogLine);
  const starts = lines.map((line) => Date.parse(line.startedAt));
  const parsed: ParsedPayload[] = [];
  const parseErrors: { file: string; error: string }[] = [];
  for (const line of lines) {
    if (!line.file) continue;
    try {
      const timetable = parseIrisTimetable(
        await readFile(join(outDir, line.file)),
        line.eva,
        Date.parse(line.startedAt),
      );
      parsed.push({ line, stops: timetable.stops });
    } catch (error) {
      parseErrors.push({ file: line.file, error: errorMessage(error) });
    }
  }
  const firstStart = Math.min(...starts);
  const lastStart = Math.max(...starts);
  const minutes = Math.max((lastStart - firstStart) / MINUTE, 1 / 60);
  const endpoints = [...new Set(lines.map((line) => line.endpoint))];
  return {
    firstRequestAt: new Date(firstStart).toISOString(),
    lastRequestAt: new Date(lastStart).toISOString(),
    requests: lines.length,
    byEndpointAndStatus: countBy(lines, (line) => `${line.endpoint} ${line.status ?? "none"}`),
    responses429: lines.filter((line) => line.status === 429).length,
    failures: lines.filter((line) => line.status !== 200).length,
    meanPerMinute: lines.length / minutes,
    maxInAnyRollingMinute: maxInWindow(starts),
    payloadBytes: Object.fromEntries(
      endpoints.map((endpoint) => [
        endpoint,
        sizeSummary(
          lines
            .filter((line) => line.endpoint === endpoint && line.bytes !== null)
            .map((line) => line.bytes ?? 0),
        ),
      ]),
    ),
    payloadsParsed: parsed.length,
    parseErrors: parseErrors.length,
    parseErrorSamples: parseErrors.slice(0, 5),
    realtime: changeShare(parsed),
  };
}
