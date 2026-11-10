import { createHash, type Hash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import type { Clock } from "../clock.ts";
import type { ClientCertificate } from "./client-certificate.ts";
import { fetchWithCertificate } from "./https-fetch.ts";

export const RECORDED_HEADERS = [
  "content-encoding",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "location",
  "retry-after",
] as const;

export type RecordedHeaders = Partial<Record<(typeof RECORDED_HEADERS)[number], string>>;

export type BodySink =
  | { readonly kind: "memory" }
  | { readonly kind: "file"; readonly path: string };

export interface FetchRequest {
  readonly url: string;
  readonly method: "GET" | "HEAD";
  readonly headers: Readonly<Record<string, string>>;
  readonly redirect: "follow" | "manual";
  readonly maxBytes: number;
  readonly headersTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly sink: BodySink;
  /** Sends the request over node:https with this certificate (mutual TLS) instead of the global fetch. */
  readonly clientCertificate?: ClientCertificate;
}

export interface FetchResponse {
  readonly kind: "response";
  readonly status: number;
  readonly headers: RecordedHeaders;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly body?: Buffer;
  readonly sha256?: string;
  readonly bytes?: number;
}

export type FailureReason = "timeout" | "network" | "too-large" | "truncated" | "aborted";

export interface FetchFailure {
  readonly kind: "failure";
  readonly reason: FailureReason;
  readonly message: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status?: number;
  readonly headers?: RecordedHeaders;
}

export type FetchResult = FetchResponse | FetchFailure;

export class BodyLimitError extends Error {}

export function recordHeaders(headers: Pick<Headers, "get">): RecordedHeaders {
  const recorded: RecordedHeaders = {};
  for (const name of RECORDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) {
      recorded[name] = value;
    }
  }
  return recorded;
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  const code =
    error.cause && typeof error.cause === "object" && "code" in error.cause
      ? ` (${String(error.cause.code)})`
      : "";
  return `${error.message}${cause}${code}`;
}

export interface Collected {
  readonly body?: Buffer;
  readonly sha256: string;
  readonly bytes: number;
}

async function writeChunk(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function closeFile(stream: WriteStream): Promise<void> {
  const closed = once(stream, "close");
  stream.end();
  await closed;
}

export async function collectBody(
  body: AsyncIterable<Uint8Array>,
  sink: BodySink,
  maxBytes: number,
): Promise<Collected> {
  const hash: Hash = createHash("sha256");
  const chunks: Buffer[] = [];
  const file = sink.kind === "file" ? createWriteStream(sink.path, { flags: "w" }) : undefined;
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new BodyLimitError(`body exceeds ${maxBytes} bytes`);
      }
      hash.update(chunk);
      if (file) await writeChunk(file, chunk);
      else chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  } finally {
    if (file) await closeFile(file);
  }
  return {
    ...(file ? {} : { body: Buffer.concat(chunks, bytes) }),
    sha256: hash.digest("hex"),
    bytes,
  };
}

function declaredLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * One HTTP request with a headers deadline, a total deadline and a body limit. Never throws:
 * every outcome is a response (any status) or a classified failure.
 */
export function fetchPayload(
  request: FetchRequest,
  clock: Clock,
  signal?: AbortSignal,
): Promise<FetchResult> {
  return request.clientCertificate
    ? fetchWithCertificate(request, clock, signal)
    : fetchGlobal(request, clock, signal);
}

async function fetchGlobal(
  request: FetchRequest,
  clock: Clock,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const startedAt = clock.now();
  const controller = new AbortController();
  let abortReason: FailureReason | null = null;
  const abort = (reason: FailureReason) => {
    abortReason ??= reason;
    controller.abort();
  };
  const onOuterAbort = () => abort("aborted");
  if (signal?.aborted) abort("aborted");
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  const headersTimer = setTimeout(() => abort("timeout"), request.headersTimeoutMs);
  const totalTimer = setTimeout(() => abort("timeout"), request.totalTimeoutMs);
  let status: number | undefined;
  let headers: RecordedHeaders | undefined;
  const fail = (reason: FailureReason, message: string): FetchFailure => ({
    kind: "failure",
    reason,
    message,
    startedAt,
    durationMs: clock.now() - startedAt,
    ...(status === undefined ? {} : { status }),
    ...(headers === undefined ? {} : { headers }),
  });
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      signal: controller.signal,
    });
    clearTimeout(headersTimer);
    status = response.status;
    headers = recordHeaders(response.headers);
    const wantsBody = request.method === "GET" && response.status >= 200 && response.status < 300;
    if (!wantsBody || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "response", status, headers, startedAt, durationMs: clock.now() - startedAt };
    }
    const declared = declaredLength(response.headers);
    if (declared !== null && declared > request.maxBytes) {
      abort("too-large");
      return fail("too-large", `declared length ${declared} exceeds ${request.maxBytes} bytes`);
    }
    try {
      const collected = await collectBody(response.body, request.sink, request.maxBytes);
      if (declared !== null && !headers["content-encoding"] && collected.bytes !== declared) {
        return fail("truncated", `received ${collected.bytes} of ${declared} declared bytes`);
      }
      return {
        kind: "response",
        status,
        headers,
        startedAt,
        durationMs: clock.now() - startedAt,
        ...collected,
      };
    } catch (error) {
      if (error instanceof BodyLimitError) {
        abort("too-large");
        return fail("too-large", error.message);
      }
      return fail(abortReason ?? "truncated", describeError(error));
    }
  } catch (error) {
    return fail(abortReason ?? "network", describeError(error));
  } finally {
    clearTimeout(headersTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
