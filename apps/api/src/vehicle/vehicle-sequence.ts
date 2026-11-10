import { sha256Hex, VehicleSequenceAnswer } from "./formation.ts";

export const VEHICLE_SEQUENCE_URL =
  "https://www.bahn.de/web/api/reisebegleitung/wagenreihung/vehicle-sequence";

export interface SequenceQuery {
  readonly category: string;
  readonly trainNumber: string;
  readonly serviceDate: string;
  readonly eva: number;
  readonly departure: string;
}

export type SequenceResult =
  | { readonly status: "ok"; readonly answer: VehicleSequenceAnswer; readonly sha256: string }
  | { readonly status: "missing" }
  | { readonly status: "blocked" }
  | { readonly status: "busy" }
  | { readonly status: "failed"; readonly reason: string };

export interface SequenceClientOptions {
  readonly userAgent: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly blockedForMs?: number;
  readonly baseUrl?: string;
  readonly maxQueued?: number;
  readonly maxCallsPerHour?: number;
  readonly retryAfterMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly maxBodyBytes?: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_ASKED = 50_000;
const BLOCKED: SequenceResult = { status: "blocked" };
const BUSY: SequenceResult = { status: "busy" };

interface Asked {
  readonly serviceDate: string;
  readonly result: Promise<SequenceResult>;
  readonly failures: number;
  retryAt: number;
}

function failed(error: unknown): SequenceResult {
  return { status: "failed", reason: error instanceof Error ? error.name : String(error) };
}

async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("Content-Length") ?? Number.NaN);
  if (declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sequenceUrl(query: SequenceQuery, baseUrl = VEHICLE_SEQUENCE_URL): string {
  const params = new URLSearchParams({
    administrationId: "80",
    category: query.category,
    date: query.serviceDate,
    evaNumber: String(query.eva),
    number: query.trainNumber,
    time: new Date(query.departure).toISOString(),
  });
  return `${baseUrl}?${params}`;
}

/**
 * The unofficial bahn.de coach sequence, one call at a time with a pause between calls and at most
 * `maxCallsPerHour` calls an hour. Each train and day is asked once per process (answers and misses
 * are kept until the service day is two days old); a failed call is retried for that train only after
 * a backoff that doubles per failure. A 403 or 429 blocks every call for `blockedForMs`, so the
 * endpoint is never pressed after it refuses. At most `maxQueued` calls wait; more answer busy.
 */
export class VehicleSequenceClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly blockedForMs: number;
  private readonly baseUrl: string;
  private readonly maxQueued: number;
  private readonly maxCallsPerHour: number;
  private readonly retryAfterMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxBodyBytes: number;
  private readonly asked = new Map<string, Asked>();
  private readonly callTimes: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private blockedUntil = Number.NEGATIVE_INFINITY;
  private evictedDay = "";
  calls = 0;

  private readonly options: SequenceClientOptions;

  constructor(options: SequenceClientOptions) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minIntervalMs = options.minIntervalMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.blockedForMs = options.blockedForMs ?? HOUR_MS;
    this.baseUrl = options.baseUrl ?? VEHICLE_SEQUENCE_URL;
    this.maxQueued = options.maxQueued ?? 20;
    this.maxCallsPerHour = options.maxCallsPerHour ?? 600;
    this.retryAfterMs = options.retryAfterMs ?? 300_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 6 * HOUR_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? 262_144;
  }

  get blocked(): boolean {
    return this.now() < this.blockedUntil;
  }

  get size(): number {
    return this.asked.size;
  }

  /** True while this train and day has an answer, a call in flight or a failure in its backoff. */
  knows(serviceDate: string, trainNumber: string): boolean {
    const known = this.asked.get(`${serviceDate}|${trainNumber}`);
    return known !== undefined && this.now() < known.retryAt;
  }

  get(query: SequenceQuery): Promise<SequenceResult> {
    const at = this.now();
    this.evict(at);
    const key = `${query.serviceDate}|${query.trainNumber}`;
    const known = this.asked.get(key);
    if (known && at < known.retryAt) return known.result;
    if (this.blocked) return Promise.resolve(BLOCKED);
    if (this.queued >= this.maxQueued || !this.withinBudget(at)) return Promise.resolve(BUSY);
    const failures = known?.failures ?? 0;
    const result = this.enqueue(query);
    const entry: Asked = {
      serviceDate: query.serviceDate,
      result,
      failures,
      retryAt: Number.POSITIVE_INFINITY,
    };
    this.asked.set(key, entry);
    result.then(
      (value) => {
        if (this.asked.get(key) !== entry) return;
        if (value.status === "failed") {
          const backoff = Math.min(this.retryAfterMs * 2 ** failures, this.maxRetryAfterMs);
          this.asked.set(key, { ...entry, failures: failures + 1, retryAt: this.now() + backoff });
        } else if (value.status === "blocked" || value.status === "busy") {
          this.asked.delete(key);
        }
      },
      () => {
        if (this.asked.get(key) === entry) this.asked.delete(key);
      },
    );
    return result;
  }

  private withinBudget(at: number): boolean {
    while (this.callTimes.length > 0 && (this.callTimes[0] ?? at) <= at - HOUR_MS) {
      this.callTimes.shift();
    }
    return this.callTimes.length + this.queued < this.maxCallsPerHour;
  }

  private evict(at: number): void {
    const oldest = new Date(at - 2 * DAY_MS).toISOString().slice(0, 10);
    if (oldest === this.evictedDay && this.asked.size < MAX_ASKED) return;
    this.evictedDay = oldest;
    for (const [key, known] of this.asked) {
      if (known.serviceDate < oldest) this.asked.delete(key);
    }
    if (this.asked.size >= MAX_ASKED) this.asked.clear();
  }

  private enqueue(query: SequenceQuery): Promise<SequenceResult> {
    this.queued += 1;
    const run = this.queue.then(() => {
      this.queued -= 1;
      return this.call(query);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async call(query: SequenceQuery): Promise<SequenceResult> {
    if (this.blocked) return BLOCKED;
    const wait = this.lastCallAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = this.now();
    this.callTimes.push(this.lastCallAt);
    this.calls += 1;
    try {
      const response = await this.fetch(sequenceUrl(query, this.baseUrl), {
        headers: { "User-Agent": this.options.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 403 || response.status === 429) {
        await response.body?.cancel();
        this.blockedUntil = this.now() + this.blockedForMs;
        return BLOCKED;
      }
      if (response.status === 404 || response.status === 204 || !response.ok) {
        await response.body?.cancel();
        return response.ok || response.status === 404
          ? { status: "missing" }
          : { status: "failed", reason: `HTTP ${response.status}` };
      }
      const body = await boundedText(response, this.maxBodyBytes);
      if (body === null) return { status: "failed", reason: "too large" };
      return this.read(body);
    } catch (error) {
      return failed(error);
    }
  }

  private read(body: string): SequenceResult {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { status: "failed", reason: "not JSON" };
    }
    const parsed = VehicleSequenceAnswer.safeParse(json);
    if (!parsed.success) return { status: "failed", reason: "unexpected structure" };
    return { status: "ok", answer: parsed.data, sha256: sha256Hex(body) };
  }
}
