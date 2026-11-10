import { rm } from "node:fs/promises";
import type { Clock } from "../clock.ts";
import { documentProblem } from "../db-apis/document.ts";
import {
  type FetchRequest,
  type FetchResult,
  fetchPayload,
  type RecordedHeaders,
} from "../fetch/http-fetch.ts";
import { openGap } from "../gaps.ts";
import { summarizeFeed } from "../gtfs-rt/feed-summary.ts";
import { errorMessage, type Logger } from "../log.ts";
import { backoffForPeriod, type Random } from "../policy/backoff.ts";
import { parseRetryAfter, providerPauseMs } from "../policy/retry-after.ts";
import { nextAttemptAt } from "../policy/schedule.ts";
import { redactText, redactUrl } from "../redact.ts";
import type { SourceDefinition } from "../sources.ts";
import { resolveInside } from "../storage/files.ts";
import { STORAGE_FORMAT_VERSION } from "../storage/frame.ts";
import { TMP_DIR } from "../storage/paths.ts";
import { PayloadStore, type RecordDraft } from "../storage/payload-store.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { applyRecord, EMPTY_STATE, restoreState, type SourceState } from "../storage/state.ts";
import type { IndexSink } from "./index-sink.ts";
import type { ProviderGate } from "./provider-gate.ts";
import { copySeed, findSeed, type SeedMatch } from "./seed.ts";

const DAY_MS = 86_400_000;
const HOLD_RECHECK_MS = 60_000;
const START_STAGGER_MS = 5_000;
const ACCEPT_PROTOBUF = "application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1";

export interface RunnerContext {
  readonly root: string;
  readonly userAgent: string;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  readonly index: IndexSink;
  readonly gate: Pick<ProviderGate, "run" | "pause">;
  readonly isPaused: () => boolean;
  /** The cadence the recorder's mode gives this source now, or null while the mode holds it back. */
  readonly periodFor?: (source: SourceDefinition) => number | null;
  readonly seedDir: string | null;
  readonly signal: AbortSignal;
}

function redactHeaders(
  headers: RecordedHeaders,
  requestUrl: string,
  secrets: readonly string[],
): RecordedHeaders {
  return headers.location === undefined
    ? headers
    : { ...headers, location: redactUrl(headers.location, secrets, requestUrl) };
}

/** A redirect keeps the scheme of the source URL: https never falls back to plain http. */
export function redirectAllowed(from: string, to: URL): boolean {
  const scheme = new URL(from).protocol;
  return to.protocol === "https:" || (scheme === "http:" && to.protocol === "http:");
}

export class SourceRunner {
  readonly source: SourceDefinition;
  readonly runId: string;
  private readonly context: RunnerContext;
  private state: SourceState = EMPTY_STATE;
  private store: PayloadStore | null = null;
  private failures = 0;
  private retryAfterMs: number | null = null;
  private tempCounter = 0;

  constructor(source: SourceDefinition, context: RunnerContext, runId: string) {
    this.source = source;
    this.context = context;
    this.runId = runId;
  }

  async init(): Promise<void> {
    const days = this.source.periodMs >= DAY_MS ? 35 : 3;
    this.state = await restoreState(
      this.context.root,
      this.source.id,
      this.context.clock.now(),
      days,
    );
    this.store = new PayloadStore({
      root: this.context.root,
      source: this.source.id,
      writer: "live",
      period: this.source.segmentPeriod,
      contentType: this.source.contentType,
      last: this.state.last,
    });
  }

  async loop(): Promise<void> {
    const { clock, signal } = this.context;
    let due = this.firstDue(clock.now());
    let owed = this.catchUpUrls(clock.now());
    while (!signal.aborted) {
      await clock.sleep(due - clock.now(), signal);
      if (signal.aborted) break;
      if (this.context.isPaused() || this.currentPeriod() === null) {
        due = clock.now() + Math.min(HOLD_RECHECK_MS, this.source.periodMs);
        continue;
      }
      for (const url of owed) {
        await this.context.gate.run(this.source.provider, signal, () => this.attemptSafely(url));
      }
      owed = [];
      await this.context.gate.run(this.source.provider, signal, () => this.attemptSafely());
      due = this.nextDue(clock.now());
    }
    await this.store?.close();
  }

  private currentPeriod(): number | null {
    return this.context.periodFor ? this.context.periodFor(this.source) : this.source.periodMs;
  }

  firstDue(now: number): number {
    const periodMs = this.currentPeriod() ?? this.source.periodMs;
    const stagger = Math.min(START_STAGGER_MS, periodMs);
    return this.recentSuccess(now)
      ? this.nextDue(now)
      : now + Math.floor(this.context.random() * stagger);
  }

  /** The catch-up URLs a start at `now` owes: none after a success within the period. */
  catchUpUrls(now: number): string[] {
    if (!this.source.catchUpUrlsAt || this.recentSuccess(now)) return [];
    return [...this.source.catchUpUrlsAt(now)];
  }

  private recentSuccess(now: number): boolean {
    const periodMs = this.currentPeriod() ?? this.source.periodMs;
    return this.state.lastSuccessAt !== null && now - this.state.lastSuccessAt < periodMs;
  }

  private nextDue(now: number): number {
    const periodMs = this.currentPeriod() ?? this.source.periodMs;
    return nextAttemptAt({
      now,
      periodMs,
      offsetMs: this.source.offsetMs % periodMs,
      jitterMs: this.source.jitterMs,
      failures: this.failures,
      retryAfterMs: this.retryAfterMs,
      backoff: backoffForPeriod(periodMs),
      random: this.context.random,
    });
  }

  private async attemptSafely(url?: string): Promise<void> {
    try {
      await this.attempt(url);
    } catch (error) {
      this.failures += 1;
      this.context.logger.log("error", "attempt failed inside the recorder", {
        source: this.source.id,
        error: redactText(errorMessage(error), this.source.secrets),
        failures: this.failures,
      });
    }
  }

  /** One request: the source's URL, or `url` (a catch-up) for an `http-document` source. */
  async attempt(url?: string): Promise<void> {
    this.retryAfterMs = null;
    switch (this.source.kind) {
      case "gtfs-rt":
        await this.attemptInMemory(this.source.url ?? "", (draft, body, sha256) =>
          this.storeRealtime(draft, body, sha256),
        );
        break;
      case "http-document":
        await this.attemptInMemory(url ?? this.documentUrl(), (draft, body, sha256) =>
          this.storeDocument(draft, body, sha256),
        );
        break;
      case "static-file":
        await this.attemptStaticFile(this.source.url ?? "");
        break;
      case "static-redirect":
        await this.attemptStaticRedirect();
        break;
    }
  }

  private documentUrl(): string {
    return this.source.urlAt?.(this.context.clock.now()) ?? this.source.url ?? "";
  }

  private accept(): string {
    if (this.source.kind === "gtfs-rt") return ACCEPT_PROTOBUF;
    if (this.source.kind === "http-document") return this.source.contentType;
    return "*/*";
  }

  private request(url: string, overrides: Partial<FetchRequest> = {}): FetchRequest {
    const conditional: Record<string, string> = {};
    if (this.state.last && this.state.objectUrl === redactUrl(url, this.source.secrets)) {
      if (this.state.etag) conditional["if-none-match"] = this.state.etag;
      if (this.state.lastModified) conditional["if-modified-since"] = this.state.lastModified;
    }
    return {
      url,
      method: "GET",
      headers: {
        accept: this.accept(),
        ...this.source.headers,
        ...conditional,
        "user-agent": this.context.userAgent,
      },
      redirect: "manual",
      maxBytes: this.source.maxBytes,
      headersTimeoutMs: this.source.headersTimeoutMs,
      totalTimeoutMs: this.source.totalTimeoutMs,
      sink: { kind: "memory" },
      ...(this.source.clientCertificate
        ? { clientCertificate: this.source.clientCertificate }
        : {}),
      ...overrides,
    };
  }

  private draft(url: string, result: FetchResult, method: "GET" | "HEAD" = "GET"): RecordDraft {
    const startedAt = new Date(result.startedAt).toISOString();
    return {
      v: STORAGE_FORMAT_VERSION,
      type: "fetch",
      source: this.source.id,
      run: this.runId,
      writer: "live",
      url: redactUrl(url, this.source.secrets),
      method,
      startedAt,
      observedAt: startedAt,
      durationMs: Math.round(result.durationMs),
      status: result.kind === "response" ? result.status : (result.status ?? null),
      headers: redactHeaders(result.headers ?? {}, url, this.source.secrets),
    };
  }

  private async fetch(request: FetchRequest): Promise<FetchResult | null> {
    const result = await fetchPayload(request, this.context.clock, this.context.signal);
    return result.kind === "failure" && result.reason === "aborted" ? null : result;
  }

  /** The target of a redirect to a host this source allows, without a scheme downgrade; one hop at most. */
  private allowedRedirect(from: string, result: FetchResult): string | null {
    if (result.kind !== "response" || result.status < 300 || result.status >= 400) return null;
    const location = result.headers.location;
    if (!location) return null;
    const target = new URL(location, from);
    const allowed =
      redirectAllowed(from, target) && this.source.redirectHosts.includes(target.hostname);
    return allowed ? target.toString() : null;
  }

  /**
   * Fetches, following one redirect to an allowed host without Authorization or any other header the
   * source declares, since those carry its keys (the target of opentransportdata.swiss is a signed URL).
   * Returns the URL that answered.
   */
  private async fetchFollowing(
    request: FetchRequest,
  ): Promise<{ result: FetchResult; url: string } | null> {
    const first = await this.fetch(request);
    if (!first) return null;
    const target = this.allowedRedirect(request.url, first);
    if (!target) return { result: first, url: request.url };
    const sourceHeaders = new Set(
      ["authorization", ...Object.keys(this.source.headers)].map((name) => name.toLowerCase()),
    );
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !sourceHeaders.has(name.toLowerCase())),
    );
    const second = await this.fetch({ ...request, url: target, headers });
    return second ? { result: second, url: target } : null;
  }

  private async attemptInMemory(
    url: string,
    store: (draft: RecordDraft, body: Buffer, sha256: string) => Promise<void>,
  ): Promise<void> {
    const answered = await this.fetchFollowing(this.request(url));
    if (!answered) return;
    const { result } = answered;
    const draft = this.draft(answered.url, result);
    if (result.kind === "failure") {
      await this.fail(
        draft,
        result.reason === "too-large" ? "too-large" : "failure",
        `${result.reason}: ${result.message}`,
      );
    } else if (result.status === 304) {
      await this.succeed(await this.note({ ...draft, outcome: "not-modified" }));
    } else if (result.body && result.sha256 && result.status >= 200 && result.status < 300) {
      await store(draft, result.body, result.sha256);
    } else {
      await this.httpError(draft, result);
    }
  }

  private async storeRealtime(draft: RecordDraft, body: Buffer, sha256: string): Promise<void> {
    const feed = summarizeFeed(body);
    if (!feed.ok) {
      await this.storeInvalid(
        { ...draft, feed },
        body,
        sha256,
        `payload is not a GTFS-RT feed: ${feed.error}`,
      );
      return;
    }
    const at = Date.parse(draft.observedAt);
    await this.succeed(
      await this.requireStore().storePayload({ ...draft, feed }, body, sha256, at),
    );
  }

  /** An `http-document` body is stored byte for byte; one that is not what the source declares is kept as invalid. */
  private async storeDocument(draft: RecordDraft, body: Buffer, sha256: string): Promise<void> {
    const problem = documentProblem(this.source.contentType, body, this.source.documentRoot);
    if (problem) {
      await this.storeInvalid(draft, body, sha256, problem);
      return;
    }
    const at = Date.parse(draft.observedAt);
    await this.succeed(await this.requireStore().storePayload(draft, body, sha256, at));
  }

  private async storeInvalid(
    draft: RecordDraft,
    body: Buffer,
    sha256: string,
    message: string,
  ): Promise<void> {
    const error = redactText(message, this.source.secrets);
    const invalid = { ...draft, outcome: "invalid" as const, error };
    const at = Date.parse(draft.observedAt);
    const record = await this.requireStore().storePayload(invalid, body, sha256, at);
    if (record.object) await this.context.index.objects([record]);
    this.recordFailure(record);
  }

  private async attemptStaticFile(url: string, provenance?: string): Promise<void> {
    const temp = this.tempPath();
    const result = await this.fetch(this.request(url, { sink: { kind: "file", path: temp } }));
    try {
      if (!result) return;
      const draft = { ...this.draft(url, result), ...(provenance ? { provenance } : {}) };
      if (result.kind === "failure") {
        await this.fail(
          draft,
          result.reason === "too-large" ? "too-large" : "failure",
          `${result.reason}: ${result.message}`,
        );
      } else if (result.status === 304) {
        await this.succeed(await this.note({ ...draft, outcome: "not-modified" }));
      } else if (
        result.sha256 &&
        result.bytes !== undefined &&
        result.status >= 200 &&
        result.status < 300
      ) {
        const name = this.source.fileName ?? "payload";
        const at = Date.parse(draft.observedAt);
        await this.succeed(
          await this.requireStore().storeFile(draft, temp, name, result.sha256, result.bytes, at),
        );
      } else {
        await this.httpError(draft, result);
      }
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async attemptStaticRedirect(): Promise<void> {
    const link = this.source.url ?? "";
    const result = await this.fetch(
      this.request(link, { redirect: "manual", headers: { "user-agent": this.context.userAgent } }),
    );
    if (!result) return;
    const draft = this.draft(link, result);
    const location = result.kind === "response" ? result.headers.location : undefined;
    if (result.kind === "failure") {
      await this.fail(draft, "failure", `${result.reason}: ${result.message}`);
      return;
    }
    if (result.status < 300 || result.status >= 400 || !location) {
      await this.httpError(draft, result);
      return;
    }
    const target = new URL(location, link);
    if (!redirectAllowed(link, target)) {
      await this.fail(draft, "http-error", `redirect to a ${target.protocol} URL refused`);
      return;
    }
    const known =
      this.state.last !== null &&
      this.state.objectUrl === redactUrl(target.toString(), this.source.secrets);
    await this.succeed(await this.note({ ...draft, outcome: "redirect" }));
    if (known && !(await this.targetChanged(target.toString()))) return;
    const seed = known ? null : await findSeed(this.context.seedDir, target.toString());
    if (seed) await this.storeSeed(target.toString(), seed);
    else await this.attemptStaticFile(target.toString());
  }

  /**
   * Conditional HEAD on the file we already hold. A 304 is the answer to our If-None-Match or
   * If-Modified-Since and means not changed. On a 200 the file changed when Last-Modified differs from the
   * one recorded with it, else when the ETag differs, else (a seed has neither) when the length differs.
   */
  private async targetChanged(url: string): Promise<boolean> {
    const result = await this.fetch(this.request(url, { method: "HEAD" }));
    if (!result) return false;
    const draft = this.draft(url, result, "HEAD");
    if (result.kind === "failure") {
      await this.fail(draft, "failure", `${result.reason}: ${result.message}`);
      return false;
    }
    if (result.status !== 200 && result.status !== 304) {
      await this.httpError(draft, result);
      return false;
    }
    const changed = result.status === 200 && this.differsFromHeld(result.headers);
    if (!changed) await this.succeed(await this.note({ ...draft, outcome: "not-modified" }));
    return changed;
  }

  private differsFromHeld(headers: RecordedHeaders): boolean {
    if (this.state.lastModified !== null) {
      return (headers["last-modified"] ?? null) !== this.state.lastModified;
    }
    if (this.state.etag !== null) return (headers.etag ?? null) !== this.state.etag;
    const length = headers["content-length"] ?? null;
    return length !== null && Number(length) !== this.state.bytes;
  }

  private async storeSeed(url: string, seed: SeedMatch): Promise<void> {
    const temp = this.tempPath();
    const now = this.context.clock.now();
    await copySeed(seed, temp);
    const iso = new Date(now).toISOString();
    const draft: RecordDraft = {
      v: STORAGE_FORMAT_VERSION,
      type: "fetch",
      source: this.source.id,
      run: this.runId,
      writer: "live",
      url: redactUrl(url, this.source.secrets),
      method: "GET",
      startedAt: seed.fetchedAt ?? iso,
      observedAt: iso,
      durationMs: 0,
      status: null,
      headers: {},
      provenance: `seed:${seed.relativePath}`,
    };
    const name = new URL(url).pathname.split("/").at(-1) ?? this.source.fileName ?? "payload";
    await this.succeed(
      await this.requireStore().storeFile(draft, temp, name, seed.sha256, seed.bytes, now),
    );
  }

  private requireStore(): PayloadStore {
    if (!this.store) throw new Error(`${this.source.id}: init() was not called`);
    return this.store;
  }

  private tempPath(): string {
    this.tempCounter += 1;
    return resolveInside(
      this.context.root,
      `${TMP_DIR}/${this.source.id}-${this.runId}-${this.tempCounter}.part`,
    );
  }

  private note(draft: RecordDraft, extra: Partial<FetchRecord> = {}): Promise<FetchRecord> {
    return this.requireStore().note(draft, Date.parse(draft.observedAt), extra);
  }

  private async httpError(
    draft: RecordDraft,
    result: FetchResult & { kind: "response" },
  ): Promise<void> {
    const now = this.context.clock.now();
    this.retryAfterMs = parseRetryAfter(result.headers["retry-after"], now);
    const pause = providerPauseMs(result.status, result.headers["retry-after"], now);
    if (pause !== null) this.context.gate.pause(this.source.provider, pause);
    await this.fail(draft, "http-error", `HTTP ${result.status}`);
  }

  private async fail(
    draft: RecordDraft,
    outcome: FetchRecord["outcome"],
    message: string,
    extra: Partial<FetchRecord> = {},
  ): Promise<void> {
    const error = redactText(message, this.source.secrets);
    this.recordFailure(await this.note({ ...draft, outcome, error }, extra));
  }

  private recordFailure(record: FetchRecord): void {
    this.failures += 1;
    this.state = applyRecord(this.state, record);
    this.context.logger.log("warn", "fetch failed", {
      source: this.source.id,
      outcome: record.outcome,
      status: record.status,
      error: record.error,
      stored: record.object?.key,
      failures: this.failures,
      retryAfterMs: this.retryAfterMs,
    });
  }

  private async succeed(record: FetchRecord): Promise<void> {
    this.failures = 0;
    const at = Date.parse(record.observedAt);
    const gap = openGap(this.state.lastSuccessAt, at, this.source.periodMs);
    if (gap) {
      this.context.logger.log("warn", "gap closed", {
        source: this.source.id,
        from: new Date(gap.start).toISOString(),
        to: new Date(gap.end).toISOString(),
      });
      await this.context.index.gap(this.source.id, gap);
    }
    const unchangedHeader =
      record.feed?.ok && record.feed.headerTimestamp === this.state.feedTimestamp;
    this.state = applyRecord(this.state, record);
    if (record.object) await this.context.index.objects([record]);
    this.context.logger.log("info", "fetched", {
      source: this.source.id,
      outcome: record.outcome,
      status: record.status,
      bytes: record.bytes,
      frameBytes: record.object?.length,
      durationMs: record.durationMs,
      feedTimestamp: record.feed?.ok ? record.feed.headerTimestamp : undefined,
      ...(unchangedHeader ? { feedHeaderUnchanged: true } : {}),
    });
  }
}
