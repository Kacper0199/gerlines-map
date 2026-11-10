import type { RecordedHeaders } from "../fetch/http-fetch.ts";
import type { FeedSummary } from "../gtfs-rt/feed-summary.ts";

export type Writer = "live" | "backfill" | "archive";

export type Outcome =
  | "stored"
  | "unchanged"
  | "not-modified"
  | "redirect"
  | "http-error"
  | "failure"
  | "too-large"
  | "invalid";

export const SUCCESS_OUTCOMES: ReadonlySet<Outcome> = new Set([
  "stored",
  "unchanged",
  "not-modified",
  "redirect",
]);

export interface StoredObject {
  readonly id: string;
  readonly key: string;
  readonly encoding: string;
  readonly file: string;
  readonly contentType: string;
  readonly seq?: number;
  readonly base?: number | null;
  readonly offset?: number;
  readonly length?: number;
}

export interface FetchRecord {
  readonly v: number;
  readonly type: "fetch";
  readonly source: string;
  readonly run: string;
  readonly writer: Writer;
  readonly url: string;
  readonly method: "GET" | "HEAD";
  readonly startedAt: string;
  readonly observedAt: string;
  readonly durationMs: number;
  readonly outcome: Outcome;
  readonly status: number | null;
  readonly headers: RecordedHeaders;
  readonly error?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly object?: StoredObject;
  readonly sameAs?: string;
  readonly feed?: FeedSummary;
  readonly provenance?: string;
}

export interface RunStartRecord {
  readonly v: number;
  readonly type: "run-start";
  readonly run: string;
  readonly source: string;
  readonly job: string;
  readonly appVersion: string;
  readonly at: string;
}

export interface RunEndRecord {
  readonly v: number;
  readonly type: "run-end";
  readonly run: string;
  readonly source: string;
  readonly status: "succeeded" | "failed";
  readonly at: string;
  readonly error?: string;
}

export type RunRecord = RunStartRecord | RunEndRecord;

export function isSuccess(record: FetchRecord): boolean {
  return SUCCESS_OUTCOMES.has(record.outcome);
}

/** Parses JSON lines; a last line without its newline is an interrupted append and is ignored. */
export function parseJsonLines<T>(text: string): T[] {
  return parseJsonLinesDetailed<T>(text).values;
}

export interface ParsedLines<T> {
  readonly values: T[];
  readonly badLines: number[];
}

/** Like `parseJsonLines`, but a line that is not JSON is skipped and its 1-based number reported. */
export function parseJsonLinesDetailed<T>(text: string): ParsedLines<T> {
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const values: T[] = [];
  const badLines: number[] = [];
  complete.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      badLines.push(index + 1);
    }
  });
  return { values, badLines };
}
