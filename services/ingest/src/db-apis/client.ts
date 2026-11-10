import type { Clock } from "../clock.ts";
import { type FetchResult, fetchPayload } from "../fetch/http-fetch.ts";
import { providerPauseMs } from "../policy/retry-after.ts";
import { redactText, redactUrl } from "../redact.ts";
import { berlinPlanSlot } from "./berlin-time.ts";
import { ApiLimiter, DB_API_LIMITS, type DbApi } from "./limits.ts";

export const DB_API_BASE_URL = "https://apis.deutschebahn.com/db-api-marketplace/apis";

export const DB_API_PATHS: Readonly<Record<DbApi, string>> = {
  timetables: "/timetables/v1",
  stada: "/station-data/v2",
  fasta: "/fasta/v2",
};

export const DB_CLIENT_ID_HEADER = "db-client-id";
export const DB_API_KEY_HEADER = "db-api-key";

export interface DbCredentials {
  readonly clientId: string;
  readonly apiKey: string;
}

export type DbEnv = Readonly<Record<string, string | undefined>>;

/** K1 from the environment, or null when either value is missing. */
export function loadDbCredentials(env: DbEnv): DbCredentials | null {
  const clientId = env.DB_CLIENT_ID?.trim();
  const apiKey = env.DB_API_KEY?.trim();
  return clientId && apiKey ? { clientId, apiKey } : null;
}

export function dbApiHeaders(credentials: DbCredentials): Record<string, string> {
  return {
    [DB_CLIENT_ID_HEADER]: credentials.clientId,
    [DB_API_KEY_HEADER]: credentials.apiKey,
  };
}

export function dbApiSecrets(credentials: DbCredentials | null): string[] {
  return credentials ? [credentials.clientId, credentials.apiKey] : [];
}

export type IrisEndpoint = "plan" | "fchg" | "rchg";

/** The path of one DB Timetables call; `plan` takes the German local hour that `at` falls in. */
export function irisPath(endpoint: IrisEndpoint, eva: number, at?: number): string {
  if (!Number.isInteger(eva) || eva < 1 || eva > 9_999_999) throw new Error(`invalid EVA ${eva}`);
  if (endpoint !== "plan") return `/${endpoint}/${eva}`;
  if (at === undefined) throw new Error("a plan path needs the hour it covers");
  const slot = berlinPlanSlot(at);
  return `/plan/${eva}/${slot.date}/${slot.hour}`;
}

export interface DbApiResponse {
  readonly api: DbApi;
  readonly url: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: number | null;
  readonly body: Buffer | null;
  readonly sha256: string | null;
  readonly contentType: string | null;
  readonly retryAfterMs: number | null;
  readonly error: string | null;
}

export interface DbApiClientOptions {
  readonly credentials: DbCredentials;
  readonly userAgent: string;
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly limiters?: Partial<Record<DbApi, ApiLimiter>>;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

const ACCEPT: Readonly<Record<DbApi, string>> = {
  timetables: "application/xml",
  stada: "application/json",
  fasta: "application/json",
};

/**
 * Calls the three free DB APIs with the K1 headers, one shared limiter per API and `Retry-After`
 * honoured for every later caller. Never throws for HTTP or network trouble, and never returns or
 * logs a key: the URL and every error text pass through the redaction of both header values.
 */
export class DbApiClient {
  private readonly options: DbApiClientOptions;
  private readonly limiters: Record<DbApi, ApiLimiter>;
  private readonly secrets: readonly string[];

  constructor(options: DbApiClientOptions) {
    this.options = options;
    this.secrets = dbApiSecrets(options.credentials);
    this.limiters = {
      timetables:
        options.limiters?.timetables ?? new ApiLimiter(DB_API_LIMITS.timetables, options.clock),
      stada: options.limiters?.stada ?? new ApiLimiter(DB_API_LIMITS.stada, options.clock),
      fasta: options.limiters?.fasta ?? new ApiLimiter(DB_API_LIMITS.fasta, options.clock),
    };
  }

  limiter(api: DbApi): ApiLimiter {
    return this.limiters[api];
  }

  async get(api: DbApi, pathAndQuery: string, signal?: AbortSignal): Promise<DbApiResponse> {
    const { clock } = this.options;
    const url = `${this.options.baseUrl ?? DB_API_BASE_URL}${DB_API_PATHS[api]}${pathAndQuery}`;
    await this.limiters[api].acquire(signal);
    const result: FetchResult = await fetchPayload(
      {
        url,
        method: "GET",
        headers: {
          accept: ACCEPT[api],
          ...dbApiHeaders(this.options.credentials),
          "user-agent": this.options.userAgent,
        },
        redirect: "manual",
        maxBytes: this.options.maxBytes ?? 64 * 1024 * 1024,
        headersTimeoutMs: this.options.timeoutMs ?? 20_000,
        totalTimeoutMs: (this.options.timeoutMs ?? 20_000) * 3,
        sink: { kind: "memory" },
      },
      clock,
      signal,
    );
    const retryAfterMs = backOffAfter(result, clock.now());
    if (retryAfterMs !== null) this.limiters[api].pauseFor(retryAfterMs);
    return this.toResponse(api, url, result, retryAfterMs);
  }

  private toResponse(
    api: DbApi,
    url: string,
    result: FetchResult,
    retryAfterMs: number | null,
  ): DbApiResponse {
    const body = result.kind === "response" ? (result.body ?? null) : null;
    return {
      api,
      url: redactUrl(url, this.secrets),
      startedAt: result.startedAt,
      durationMs: Math.round(result.durationMs),
      status: result.status ?? null,
      body,
      sha256: body && result.kind === "response" ? (result.sha256 ?? null) : null,
      contentType: result.headers?.["content-type"] ?? null,
      retryAfterMs,
      error:
        result.kind === "failure"
          ? redactText(`${result.reason}: ${result.message}`, this.secrets)
          : null,
    };
  }
}

/** How long every caller of the API waits after a 429 or 503: `Retry-After`, else a minute, at most 15. */
export function backOffAfter(result: FetchResult, now: number): number | null {
  return providerPauseMs(result.status, result.headers?.["retry-after"], now);
}
