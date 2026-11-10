import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HttpFetchInit {
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

function headersOf(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/** Above this a router answer is refused; the largest detailed plan seen is about 600 KB. */
export const HTTP_FETCH_MAX_BYTES = 8 * 1024 * 1024;

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * A GET through `node:http`, answered as a fetch `Response` once the whole body has arrived.
 * MOTIS 2.11 sends its answers without a length, ending them by closing the connection; Node 24's
 * bundled undici fails an internal assertion and ends the process when such a large answer
 * (hundreds of KB with leg lines) is read, so the router client does not use the global fetch.
 * Every failure rejects: a body above `maxBytes`, a status a `Response` cannot hold, a broken or
 * aborted connection.
 */
export function nodeHttpFetch(
  input: URL | string,
  init: HttpFetchInit = {},
  maxBytes: number = HTTP_FETCH_MAX_BYTES,
): Promise<Response> {
  const url = new URL(String(input));
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const { signal } = init;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const outgoing = send(url, { method: "GET", headers: { ...init.headers } }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          fail(new Error(`answer larger than ${maxBytes} bytes`));
          outgoing.destroy();
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("error", fail);
      incoming.on("end", () => {
        if (settled) return;
        const status = incoming.statusCode ?? 502;
        try {
          const response = new Response(
            NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks),
            { status, headers: headersOf(incoming) },
          );
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        } catch (error) {
          fail(error);
        }
      });
    });
    const onAbort = () =>
      outgoing.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    outgoing.on("error", fail);
    outgoing.end();
  });
}
