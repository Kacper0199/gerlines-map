import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { type FetchRequest, fetchPayload } from "./http-fetch.ts";

const body = Buffer.from("gtfs-rt payload bytes ".repeat(200));
const sha = createHash("sha256").update(body).digest("hex");
const seenHeaders: Record<string, IncomingMessage["headers"]> = {};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const routes: Record<string, Handler> = {
  "/ok": (request, response) => {
    seenHeaders.ok = request.headers;
    if (request.headers["if-none-match"] === '"v1"') {
      response.writeHead(304, { etag: '"v1"' }).end();
      return;
    }
    response
      .writeHead(200, {
        "content-type": "application/x-protobuf",
        "content-length": body.length,
        etag: '"v1"',
        "last-modified": "Sun, 25 Oct 2026 09:00:00 GMT",
        "set-cookie": "session=never-recorded",
      })
      .end(body);
  },
  "/429-seconds": (_request, response) => {
    response.writeHead(429, { "retry-after": "120" }).end("slow down");
  },
  "/429-date": (_request, response) => {
    response.writeHead(429, { "retry-after": "Sun, 25 Oct 2026 10:00:00 GMT" }).end();
  },
  "/503": (_request, response) => {
    response.writeHead(503, { "content-type": "text/html" }).end("<html>down</html>");
  },
  "/never": () => {},
  "/stall-body": (_request, response) => {
    response.writeHead(200, { "content-length": 1000 });
    response.write("x".repeat(10));
  },
  "/declared-oversize": (_request, response) => {
    response.writeHead(200, { "content-length": 5000 }).end("y".repeat(5000));
  },
  "/chunked-oversize": (_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("z".repeat(3000));
    response.end("z".repeat(3000));
  },
  "/truncated": (_request, response) => {
    response.writeHead(200, { "content-length": 1000 });
    response.write("t".repeat(500), () => response.socket?.destroy());
  },
  "/redirect": (_request, response) => {
    response.writeHead(303, { location: "/files/20261019_feed.zip" }).end();
  },
};

let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const handler = routes[request.url ?? ""];
    if (handler) handler(request, response);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "gerlines-fetch-"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

function request(path: string, overrides: Partial<FetchRequest> = {}): FetchRequest {
  return {
    url: `${base}${path}`,
    method: "GET",
    headers: { "user-agent": "gerlines/0.1.0 (+test@example.org)" },
    redirect: "follow",
    maxBytes: 4096,
    headersTimeoutMs: 1_000,
    totalTimeoutMs: 2_000,
    sink: { kind: "memory" },
    ...overrides,
  };
}

describe("fetchPayload", () => {
  it("returns the body with its sha256 and the recorded header subset", async () => {
    const result = await fetchPayload(request("/ok", { maxBytes: 1_000_000 }), systemClock);
    expect(result).toMatchObject({
      kind: "response",
      status: 200,
      sha256: sha,
      bytes: body.length,
    });
    expect(result.kind === "response" && result.body?.equals(body)).toBe(true);
    expect(result.kind === "response" && result.headers).toEqual({
      "content-length": String(body.length),
      "content-type": "application/x-protobuf",
      etag: '"v1"',
      "last-modified": "Sun, 25 Oct 2026 09:00:00 GMT",
    });
    expect(seenHeaders.ok?.["user-agent"]).toBe("gerlines/0.1.0 (+test@example.org)");
  });

  it("passes conditional headers and reports 304 without a body", async () => {
    const result = await fetchPayload(
      request("/ok", { headers: { "if-none-match": '"v1"' } }),
      systemClock,
    );
    expect(result).toMatchObject({ kind: "response", status: 304, headers: { etag: '"v1"' } });
    expect(result.kind === "response" && result.body).toBeUndefined();
  });

  it.each([
    ["/429-seconds", 429, "120"],
    ["/429-date", 429, "Sun, 25 Oct 2026 10:00:00 GMT"],
  ])("reports %s with its Retry-After", async (path, status, retryAfter) => {
    const result = await fetchPayload(request(path), systemClock);
    expect(result).toMatchObject({
      kind: "response",
      status,
      headers: { "retry-after": retryAfter },
    });
  });

  it("reports a 503 without keeping its body", async () => {
    const result = await fetchPayload(request("/503"), systemClock);
    expect(result).toMatchObject({ kind: "response", status: 503 });
    expect(result.kind === "response" && result.body).toBeUndefined();
  });

  it("gives up when no response headers arrive before the headers deadline", async () => {
    const result = await fetchPayload(request("/never", { headersTimeoutMs: 200 }), systemClock);
    expect(result).toMatchObject({ kind: "failure", reason: "timeout" });
  });

  it("gives up when the body stalls past the total deadline", async () => {
    const result = await fetchPayload(request("/stall-body", { totalTimeoutMs: 300 }), systemClock);
    expect(result).toMatchObject({ kind: "failure", reason: "timeout", status: 200 });
  });

  it("refuses a body whose declared length exceeds the limit", async () => {
    const result = await fetchPayload(request("/declared-oversize"), systemClock);
    expect(result).toMatchObject({ kind: "failure", reason: "too-large", status: 200 });
  });

  it("stops reading a chunked body once it exceeds the limit", async () => {
    const result = await fetchPayload(request("/chunked-oversize"), systemClock);
    expect(result).toMatchObject({ kind: "failure", reason: "too-large" });
  });

  it("reports a body cut short by the server as truncated", async () => {
    const result = await fetchPayload(request("/truncated"), systemClock);
    expect(result).toMatchObject({ kind: "failure", reason: "truncated", status: 200 });
  });

  it("reports a refused connection as a network failure", async () => {
    const result = await fetchPayload(
      request("/ok", { url: "http://127.0.0.1:9/ok" }),
      systemClock,
    );
    expect(result).toMatchObject({ kind: "failure", reason: "network" });
  });

  it("returns the Location of a redirect when redirects are manual", async () => {
    const result = await fetchPayload(request("/redirect", { redirect: "manual" }), systemClock);
    expect(result).toMatchObject({
      kind: "response",
      status: 303,
      headers: { location: "/files/20261019_feed.zip" },
    });
  });

  it("streams a body into a file and hashes it on the way", async () => {
    const path = join(dir, "payload.part");
    const result = await fetchPayload(
      request("/ok", { maxBytes: 1_000_000, sink: { kind: "file", path } }),
      systemClock,
    );
    expect(result).toMatchObject({
      kind: "response",
      status: 200,
      sha256: sha,
      bytes: body.length,
    });
    expect((await readFile(path)).equals(body)).toBe(true);
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = fetchPayload(
      request("/never", { headersTimeoutMs: 5_000 }),
      systemClock,
      controller.signal,
    );
    controller.abort();
    expect(await pending).toMatchObject({ kind: "failure", reason: "aborted" });
  });
});
