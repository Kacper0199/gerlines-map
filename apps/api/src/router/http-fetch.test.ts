import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HTTP_FETCH_MAX_BYTES, nodeHttpFetch } from "./http-fetch.ts";

const BIG = JSON.stringify({
  itineraries: Array.from({ length: 4000 }, (_, i) => ({ i, pad: "x".repeat(200) })),
});
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/close-delimited") {
      request.socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${BIG}`);
      return;
    }
    if (request.url === "/no-content") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/not-modified") {
      response.writeHead(304);
      response.end();
      return;
    }
    if (request.url === "/odd-status") {
      request.socket.end("HTTP/1.1 999 Odd\r\nContent-Length: 2\r\n\r\n{}");
      return;
    }
    if (request.url === "/huge") {
      response.writeHead(200, { "Content-Type": "application/json" });
      const piece = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < HTTP_FETCH_MAX_BYTES + piece.length * 4) {
          sent += piece.length;
          if (!response.write(piece)) {
            response.once("drain", pump);
            return;
          }
        }
        response.end();
      };
      response.on("error", () => undefined);
      pump();
      return;
    }
    if (request.url === "/slow") {
      setTimeout(() => response.end("{}"), 2_000);
      return;
    }
    if (request.url === "/missing") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "X-Agent": String(request.headers["user-agent"]),
    });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

describe("nodeHttpFetch", () => {
  it("reads a large body that ends with the connection, as MOTIS sends it", async () => {
    const response = await nodeHttpFetch(new URL("/close-delimited", base));
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBe(BIG.length);
  });

  it("sends the headers and answers status, headers and body", async () => {
    const response = await nodeHttpFetch(new URL("/", base), {
      headers: { "User-Agent": "gerlines/0.0.0" },
    });
    expect(response.ok).toBe(true);
    expect(response.headers.get("x-agent")).toBe("gerlines/0.0.0");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers a 4xx as a response", async () => {
    const response = await nodeHttpFetch(new URL("/missing", base));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("gives up when the signal times out", async () => {
    await expect(
      nodeHttpFetch(new URL("/slow", base), { signal: AbortSignal.timeout(100) }),
    ).rejects.toThrow();
  });

  it("rejects when nobody listens", async () => {
    await expect(nodeHttpFetch("http://127.0.0.1:1/")).rejects.toThrow();
  });

  it("answers 204 and 304 with an empty body instead of throwing", async () => {
    const empty = await nodeHttpFetch(new URL("/no-content", base));
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    const unchanged = await nodeHttpFetch(new URL("/not-modified", base));
    expect(unchanged.status).toBe(304);
  });

  it("rejects a status a Response cannot hold, and the process lives on", async () => {
    await expect(nodeHttpFetch(new URL("/odd-status", base))).rejects.toThrow();
  });

  it("stops reading and rejects a body above the size cap", async () => {
    await expect(nodeHttpFetch(new URL("/huge", base))).rejects.toThrow(/larger than/);
  });
});
