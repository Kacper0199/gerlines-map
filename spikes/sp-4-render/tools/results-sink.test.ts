import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkSinkRequest,
  createSinkHandler,
  exceedsBodyLimit,
  isSafeResultName,
  MAX_BODY_BYTES,
  TOKEN_HEADER,
} from "./results-sink.ts";

const TOKEN = "a".repeat(48);
const SCRATCH = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/.cache");

describe("isSafeResultName", () => {
  it("accepts plain ndjson file names", () => {
    expect(isSafeResultName("main.phone.trains.close-z16.plain.r1.ndjson")).toBe(true);
    expect(isSafeResultName("a.ndjson")).toBe(true);
  });

  it("rejects dots, traversal, other extensions, separators and empty names", () => {
    for (const name of [
      "",
      ".",
      "..",
      ".ndjson",
      ".hidden.ndjson",
      "../x.ndjson",
      "a/b.ndjson",
      "a\\b.ndjson",
      "x.html",
      "x.ndjson.html",
      "x.json",
      "a b.ndjson",
      "x.ndjson\n",
      "a+b.ndjson",
    ]) {
      expect(isSafeResultName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("exceedsBodyLimit", () => {
  it("allows exactly one megabyte and rejects one byte more", () => {
    expect(MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(exceedsBodyLimit(MAX_BODY_BYTES)).toBe(false);
    expect(exceedsBodyLimit(MAX_BODY_BYTES + 1)).toBe(true);
    expect(exceedsBodyLimit(0)).toBe(false);
  });
});

describe("checkSinkRequest", () => {
  const request = (headers: Record<string, string>, url = "/__results/x.ndjson", method = "POST") =>
    checkSinkRequest({ method, url, headers }, TOKEN);

  it("lets requests outside the sink prefix and other methods fall through", () => {
    expect(request({}, "/index.html")).toEqual({ kind: "skip" });
    expect(request({}, "/__results/x.ndjson", "GET")).toEqual({ kind: "skip" });
  });

  it("accepts a same-origin post with the token", () => {
    expect(request({ [TOKEN_HEADER]: TOKEN, "sec-fetch-site": "same-origin" })).toEqual({
      kind: "accept",
      name: "x.ndjson",
    });
    expect(request({ [TOKEN_HEADER]: TOKEN })).toMatchObject({ kind: "accept" });
  });

  it("answers 403 without the token or with a wrong one", () => {
    expect(request({})).toMatchObject({ kind: "reject", status: 403 });
    expect(request({ [TOKEN_HEADER]: "b".repeat(48) })).toMatchObject({ status: 403 });
    expect(request({ [TOKEN_HEADER]: "short" })).toMatchObject({ status: 403 });
  });

  it("answers 403 for a cross-site or same-site fetch even with the token", () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(request({ [TOKEN_HEADER]: TOKEN, "sec-fetch-site": site })).toMatchObject({
        status: 403,
      });
    }
  });

  it("answers 400 for unsafe or undecodable names", () => {
    const headers = { [TOKEN_HEADER]: TOKEN };
    expect(request(headers, "/__results/..")).toMatchObject({ status: 400 });
    expect(request(headers, "/__results/.")).toMatchObject({ status: 400 });
    expect(request(headers, "/__results/x.html")).toMatchObject({ status: 400 });
    expect(request(headers, "/__results/%2e%2e%2fx.ndjson")).toMatchObject({ status: 400 });
    expect(request(headers, "/__results/%E0%A4%A.ndjson")).toMatchObject({ status: 400 });
  });

  it("answers 413 when the declared length is over the cap", () => {
    const headers = { [TOKEN_HEADER]: TOKEN, "content-length": String(MAX_BODY_BYTES + 1) };
    expect(request(headers)).toMatchObject({ status: 413 });
  });
});

describe("sink handler over HTTP", () => {
  let server: Server;
  let directory: string;
  let base: string;

  beforeAll(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    directory = mkdtempSync(join(SCRATCH, "sp4-sink-"));
    const handler = createSinkHandler({ directory, token: TOKEN });
    server = createServer((request, response) =>
      handler(request, response, () => {
        response.statusCode = 404;
        response.end("next");
      }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  });

  const post = (name: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/__results/${name}`, {
      method: "POST",
      body,
      headers: { [TOKEN_HEADER]: TOKEN, ...headers },
    });

  it("writes a new file and answers 204", async () => {
    const response = await post("one.ndjson", '{"a":1}\n');
    expect(response.status).toBe(204);
    expect(readFileSync(join(directory, "one.ndjson"), "utf8")).toBe('{"a":1}\n');
  });

  it("never overwrites an existing result", async () => {
    writeFileSync(join(directory, "kept.ndjson"), "original");
    const response = await post("kept.ndjson", "replacement");
    expect(response.status).toBe(409);
    expect(readFileSync(join(directory, "kept.ndjson"), "utf8")).toBe("original");
  });

  it("answers 403 without the token and writes nothing", async () => {
    const response = await fetch(`${base}/__results/nope.ndjson`, { method: "POST", body: "x" });
    expect(response.status).toBe(403);
    expect(existsSync(join(directory, "nope.ndjson"))).toBe(false);
  });

  const rawPost = (path: string) =>
    new Promise<number>((done, fail) => {
      const url = new URL(base);
      const outgoing = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path,
          method: "POST",
          headers: { [TOKEN_HEADER]: TOKEN },
        },
        (incoming) => {
          incoming.resume();
          done(incoming.statusCode ?? 0);
        },
      );
      outgoing.on("error", fail);
      outgoing.end("x");
    });

  it("answers 400 for a dot name and keeps serving afterwards", async () => {
    expect(await rawPost("/__results/..")).toBe(400);
    expect(await rawPost("/__results/.")).toBe(400);
    expect((await post("again.ndjson", "x")).status).toBe(204);
  });

  it("answers 413 for a body over one megabyte", async () => {
    const response = await post("big.ndjson", "x".repeat(MAX_BODY_BYTES + 1));
    expect(response.status).toBe(413);
    expect(existsSync(join(directory, "big.ndjson"))).toBe(false);
  });

  it("passes other requests on", async () => {
    const response = await fetch(`${base}/other`, { method: "POST", body: "x" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("next");
  });
});
