import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Clock } from "../clock.ts";
import {
  BodyLimitError,
  type Collected,
  collectBody,
  describeError,
  type FailureReason,
  type FetchFailure,
  type FetchRequest,
  type FetchResult,
  type RecordedHeaders,
  recordHeaders,
} from "./http-fetch.ts";

const ACCEPT_ENCODING = "gzip, deflate, br";

function headerGetter(message: IncomingMessage): Pick<Headers, "get"> {
  return {
    get: (name: string) => {
      const value = message.headers[name.toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? value.join(", ") : value;
    },
  };
}

function decoderFor(encoding: string | undefined): Transform | "identity" | null {
  switch ((encoding ?? "identity").trim().toLowerCase()) {
    case "identity":
      return "identity";
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return null;
  }
}

function declaredLength(message: IncomingMessage): number | null {
  const value = message.headers["content-length"];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function send(request: FetchRequest, signal: AbortSignal): Promise<IncomingMessage> {
  const certificate = request.clientCertificate;
  if (!certificate) throw new Error("fetchWithCertificate needs a client certificate");
  const headers = { "accept-encoding": ACCEPT_ENCODING, ...request.headers };
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(request.url, {
      method: request.method,
      headers,
      agent: certificate.agent(),
      signal,
    });
    outgoing.once("response", resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });
}

type BodyOutcome =
  | { readonly kind: "body"; readonly collected: Collected }
  | { readonly kind: "failed"; readonly reason: FailureReason; readonly message: string };

/** Reads a 2xx body through its transfer decoder; `abortReason` names a deadline that cut it. */
async function readBody(
  response: IncomingMessage,
  request: FetchRequest,
  encoding: string | undefined,
  abortReason: () => FailureReason | null,
): Promise<BodyOutcome> {
  const failed = (reason: FailureReason, message: string): BodyOutcome => {
    response.destroy();
    return { kind: "failed", reason, message };
  };
  const declared = declaredLength(response);
  if (declared !== null && declared > request.maxBytes) {
    return failed("too-large", `declared length ${declared} exceeds ${request.maxBytes} bytes`);
  }
  const decoder = decoderFor(encoding);
  if (decoder === null) return failed("network", `unsupported content-encoding ${encoding}`);
  let received = 0;
  response.on("data", (chunk: Buffer) => {
    received += chunk.length;
  });
  const body = decoder === "identity" ? response : pipeline(response, decoder, () => undefined);
  try {
    const collected = await collectBody(body, request.sink, request.maxBytes);
    if (declared !== null && received !== declared) {
      return failed("truncated", `received ${received} of ${declared} declared bytes`);
    }
    return { kind: "body", collected };
  } catch (error) {
    if (error instanceof BodyLimitError) return failed("too-large", error.message);
    return failed(abortReason() ?? "truncated", describeError(error));
  }
}

/**
 * `fetchPayload` over node:https for sources that need a client certificate (mutual TLS), with the same
 * contract: a headers deadline, a total deadline, a limit on the decoded body, transfer decoding of gzip,
 * deflate and br, a truncation check against the declared length, and never a throw. Redirects are returned,
 * not followed.
 */
export async function fetchWithCertificate(
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
    const response = await send(request, controller.signal);
    clearTimeout(headersTimer);
    status = response.statusCode ?? 0;
    headers = recordHeaders(headerGetter(response));
    if (request.method !== "GET" || status < 200 || status >= 300) {
      response.resume();
      return { kind: "response", status, headers, startedAt, durationMs: clock.now() - startedAt };
    }
    const outcome = await readBody(
      response,
      request,
      headers["content-encoding"],
      () => abortReason,
    );
    if (outcome.kind === "failed") {
      if (outcome.reason === "too-large") abort("too-large");
      return fail(outcome.reason, outcome.message);
    }
    return {
      kind: "response",
      status,
      headers,
      startedAt,
      durationMs: clock.now() - startedAt,
      ...outcome.collected,
    };
  } catch (error) {
    return fail(abortReason ?? "network", describeError(error));
  } finally {
    clearTimeout(headersTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
