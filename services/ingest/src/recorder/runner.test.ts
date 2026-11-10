import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { type Logger, silentLogger } from "../log.ts";
import type { SourceDefinition } from "../sources.ts";
import { TMP_DIR } from "../storage/paths.ts";
import { listSidecars, readFetchRecords, readSegmentPayloads } from "../storage/reader.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { IndexSink } from "./index-sink.ts";
import { type RunnerContext, redirectAllowed, SourceRunner } from "./source-runner.ts";

const secret = "s3cr3t-token-0123456789";
const requests: {
  method: string;
  url: string;
  authorization?: string | undefined;
  accept?: string | undefined;
  dbApiKey?: string | undefined;
  ifNoneMatch?: string | undefined;
  partnerKey?: string | undefined;
}[] = [];
const timetable = '<?xml version="1.0" encoding="UTF-8"?><timetable station="Test" eva="8000105"/>';
const feed = readFileSync(new URL("../../test/fixtures/vbn-gtfs-rt-first40.pb", import.meta.url));
let lastModified = "Mon, 19 Oct 2026 07:35:00 GMT";
let etagVersion = 1;
const pauses: [string, number][] = [];
let server: Server;
let base: string;
let root: string;

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

const redirectTo = (location: string, status = 303): Answer => ({
  status,
  headers: { location },
});

function etagFile(conditional: boolean, request: IncomingMessage): Answer {
  const etag = `"e${etagVersion}"`;
  if (conditional && request.headers["if-none-match"] === etag)
    return { status: 304, headers: { etag } };
  return {
    status: 200,
    headers: { etag, "content-type": "application/zip" },
    body: `zip ${etagVersion}`,
  };
}

const exactRoutes: Readonly<Record<string, (request: IncomingMessage) => Answer>> = {
  "/signed.pb": () =>
    redirectTo(
      "/bucket/feed.pb?Expires=1792940000&Signature=abcdef0123456789abcdef&Key-Pair-Id=K0TEST",
      302,
    ),
  "/moved.pb": () => redirectTo(`/elsewhere/${secret}`, 302),
  "/sharing": () => redirectTo("/files/20261019_feed.zip"),
  "/sharing-downgrade": () => redirectTo("ftp://127.0.0.1/x.zip"),
  "/files/20261019_feed.zip": () => ({
    status: 200,
    headers: { "last-modified": lastModified, "content-type": "application/zip" },
    body: `zip ${lastModified}`,
  }),
  "/sharing-etag": () => redirectTo("/files/etag.zip"),
  "/sharing-etag-plain": () => redirectTo("/files/etag-plain.zip"),
  "/files/etag.zip": (request) => etagFile(true, request),
  "/files/etag-plain.zip": (request) => etagFile(false, request),
  "/maintenance": () => ({
    status: 200,
    headers: { "content-type": "text/html" },
    body: "<html>down</html>",
  }),
  "/facilities.json": () => ({ status: 200, body: '[{"equipmentnumber":1}]' }),
  "/facilities-cut.json": () => ({ status: 200, body: '[{"equipmentnumber":' }),
  "/limited": () => ({ status: 429, headers: { "retry-after": "30" } }),
  "/limited-long": () => ({ status: 429, headers: { "retry-after": "7200" } }),
  "/unavailable": () => ({ status: 503 }),
};

function handle(request: IncomingMessage): Answer {
  const url = request.url ?? "";
  const exact = exactRoutes[url];
  if (exact) return exact(request);
  if (url.startsWith("/bucket/feed.pb")) {
    return { status: 200, headers: { "content-type": "application/x-protobuf" }, body: feed };
  }
  if (url.startsWith("/sncb-moved/")) return redirectTo(`/elsewhere${url}`, 302);
  if (url.startsWith("/iris/")) {
    return { status: 200, headers: { "content-type": "application/xml" }, body: timetable };
  }
  return { status: 404 };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      accept: request.headers.accept,
      dbApiKey: request.headers["db-api-key"] as string | undefined,
      ifNoneMatch: request.headers["if-none-match"],
      partnerKey: request.headers["bmc-partner-key"] as string | undefined,
    });
    const answer = handle(request);
    response.writeHead(answer.status, answer.headers).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-runner-"));
  await mkdir(join(root, TMP_DIR), { recursive: true });
  requests.length = 0;
  pauses.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function source(
  id: string,
  path: string,
  overrides: Partial<SourceDefinition> = {},
): SourceDefinition {
  return {
    id,
    kind: "gtfs-rt",
    url: `${base}${path}`,
    provider: id,
    periodMs: 60_000,
    offsetMs: 0,
    jitterMs: 0,
    segmentPeriod: "hour",
    maxBytes: 1024 * 1024,
    headersTimeoutMs: 1_000,
    totalTimeoutMs: 2_000,
    contentType: "application/x-protobuf",
    headers: {},
    secrets: [],
    redirectHosts: [],
    skipReason: null,
    metadata: {
      name: id,
      homepageUrl: base,
      licence: "CC0-1.0",
      licenceUrl: null,
      attribution: "test",
    },
    ...overrides,
  };
}

const recordingGate: RunnerContext["gate"] = {
  run: async (_provider, _signal, task) => {
    await task();
    return { ran: true };
  },
  pause: (provider, ms) => {
    pauses.push([provider, ms]);
  },
};

async function runner(definition: SourceDefinition, logger: Logger = silentLogger) {
  const created = new SourceRunner(
    definition,
    {
      root,
      userAgent: "gerlines/0.1.0 (+test@example.org)",
      clock: systemClock,
      random: () => 0,
      logger,
      index: new IndexSink(null, silentLogger),
      gate: recordingGate,
      isPaused: () => false,
      seedDir: null,
      signal: new AbortController().signal,
    },
    "0199f000-0000-7000-8000-000000000000",
  );
  await created.init();
  return created;
}

async function records(id: string): Promise<FetchRecord[]> {
  return readFetchRecords(root, await listSidecars(root, id));
}

describe("SourceRunner", () => {
  it("follows one redirect to an allowed host without the Authorization header", async () => {
    const bearer = "made-up-bearer-0123456789";
    const swiss = await runner(
      source("test-signed", "/signed.pb", {
        headers: { authorization: `Bearer ${bearer}` },
        secrets: [bearer],
        redirectHosts: ["127.0.0.1"],
      }),
    );
    await swiss.attempt();
    const [record] = await records("test-signed");
    expect(record).toMatchObject({ outcome: "stored", status: 200 });
    expect(record?.url).toBe(
      `${base}/bucket/feed.pb?Expires=1792940000&Signature=redacted&Key-Pair-Id=redacted`,
    );
    expect(requests.find((r) => r.url === "/signed.pb")?.authorization).toBe(`Bearer ${bearer}`);
    expect(requests.find((r) => r.url.startsWith("/bucket/"))?.authorization).toBeUndefined();
  });

  it("drops every header of the source on the redirect hop, not only Authorization", async () => {
    const dbKey = "made-up-db-api-key-5555555";
    const partnerKey = "made-up-sncb-key-6666666666";
    const keyed = await runner(
      source("test-signed-keys", "/signed.pb", {
        headers: { "db-api-key": dbKey, "bmc-partner-key": partnerKey, authorization: "Bearer x" },
        secrets: [dbKey, partnerKey],
        redirectHosts: ["127.0.0.1"],
      }),
    );
    await keyed.attempt();
    const first = requests.find((r) => r.url === "/signed.pb");
    const hop = requests.find((r) => r.url.startsWith("/bucket/"));
    expect([first?.dbApiKey, first?.partnerKey]).toEqual([dbKey, partnerKey]);
    expect(hop).toBeDefined();
    expect([hop?.dbApiKey, hop?.partnerKey, hop?.authorization]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect((await records("test-signed-keys"))[0]).toMatchObject({ outcome: "stored" });
  });

  it("keeps the SNCB key out of sidecars and logs, also when the gateway redirects", async () => {
    const partnerKey = "made-up-sncb-key-7777777777";
    const lines: string[] = [];
    const logger: Logger = {
      log: (level, message, fields) => lines.push(`${level} ${message} ${JSON.stringify(fields)}`),
    };
    const sncb = (id: string, path: string) =>
      source(id, path, {
        headers: { "bmc-partner-key": partnerKey },
        secrets: [partnerKey],
      });
    await (await runner(sncb("test-sncb", "/bucket/feed.pb"), logger)).attempt();
    await (await runner(sncb("test-sncb-moved", `/sncb-moved/${partnerKey}`), logger)).attempt();
    expect(requests.every((r) => r.partnerKey === partnerKey)).toBe(true);
    const stored = await records("test-sncb");
    const moved = await records("test-sncb-moved");
    expect(stored[0]).toMatchObject({ outcome: "stored" });
    expect(moved[0]).toMatchObject({ outcome: "http-error", status: 302 });
    expect(moved[0]?.headers.location).toContain("redacted");
    expect(JSON.stringify([...stored, ...moved])).not.toContain(partnerKey);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.join("\n")).not.toContain(partnerKey);
  });

  it("does not follow a redirect of a realtime source and stores its Location redacted", async () => {
    const moved = await runner(source("test-moved", "/moved.pb", { secrets: [secret] }));
    await moved.attempt();
    const [record] = await records("test-moved");
    expect(record).toMatchObject({ outcome: "http-error", status: 302 });
    expect(record?.headers.location).toBe(`${base}/elsewhere/redacted`);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(requests.some((r) => r.url.startsWith("/elsewhere"))).toBe(false);
  });

  it("downloads a static file behind a redirect once, then checks Last-Modified with HEAD", async () => {
    const delfi = await runner(
      source("test-static", "/sharing", {
        kind: "static-redirect",
        segmentPeriod: "day",
        contentType: "application/zip",
        fileName: "feed.zip",
      }),
    );
    await delfi.attempt();
    await delfi.attempt();
    const gets = () =>
      requests.filter((r) => r.method === "GET" && r.url.startsWith("/files/")).length;
    expect(gets()).toBe(1);
    expect(requests.filter((r) => r.method === "HEAD")).toHaveLength(1);

    lastModified = "Mon, 26 Oct 2026 07:35:00 GMT";
    await delfi.attempt();
    expect(gets()).toBe(2);
    const stored = (await records("test-static")).filter((r) => r.outcome === "stored");
    expect(stored).toHaveLength(2);
    expect(stored[1]?.headers["last-modified"]).toBe(lastModified);
    const head = (await records("test-static")).find((r) => r.method === "HEAD");
    expect(head).toMatchObject({ outcome: "not-modified", status: 200 });
  });

  it("takes a 304 to the conditional HEAD as not changed, not as an HTTP error", async () => {
    etagVersion = 1;
    const delfi = await runner(
      source("test-head-304", "/sharing-etag", {
        kind: "static-redirect",
        segmentPeriod: "day",
        contentType: "application/zip",
        fileName: "feed.zip",
      }),
    );
    await delfi.attempt();
    await delfi.attempt();
    const head = requests.find((r) => r.method === "HEAD");
    expect(head?.ifNoneMatch).toBe('"e1"');
    const outcomes = (await records("test-head-304")).map((r) => [r.method, r.outcome, r.status]);
    expect(outcomes).toEqual([
      ["GET", "redirect", 303],
      ["GET", "stored", 200],
      ["GET", "redirect", 303],
      ["HEAD", "not-modified", 304],
    ]);
  });

  it("compares the ETag when the file has no Last-Modified", async () => {
    etagVersion = 1;
    const delfi = await runner(
      source("test-head-etag", "/sharing-etag-plain", {
        kind: "static-redirect",
        segmentPeriod: "day",
        contentType: "application/zip",
        fileName: "feed.zip",
      }),
    );
    await delfi.attempt();
    await delfi.attempt();
    etagVersion = 2;
    await delfi.attempt();
    const gets = requests.filter((r) => r.method === "GET" && r.url.startsWith("/files/"));
    expect(gets).toHaveLength(2);
    const stored = (await records("test-head-etag")).filter((r) => r.outcome === "stored");
    expect(stored.map((r) => r.headers.etag)).toEqual(['"e1"', '"e2"']);
  });

  it("refuses a redirect that leaves http and https", async () => {
    const delfi = await runner(
      source("test-downgrade", "/sharing-downgrade", {
        kind: "static-redirect",
        segmentPeriod: "day",
        contentType: "application/zip",
      }),
    );
    await delfi.attempt();
    const [record] = await records("test-downgrade");
    expect(record).toMatchObject({ outcome: "http-error", status: 303 });
    expect(record?.error).toMatch(/refused/);
  });
});

describe("SourceRunner with an http-document source", () => {
  const apiKey = "made-up-db-api-key-2222222";
  const document = (id: string, path: string, overrides: Partial<SourceDefinition> = {}) =>
    source(id, path, {
      kind: "http-document",
      contentType: "application/xml",
      headers: { "db-client-id": "made-up-db-client-id-0000", "db-api-key": apiKey },
      secrets: ["made-up-db-client-id-0000", apiKey],
      ...overrides,
    });

  it("fetches the URL of the slot with the source headers and stores the body verbatim", async () => {
    const plan = await runner(
      document("test-iris-plan", "/iris/plan", {
        urlAt: (slotMs) => `${base}/iris/plan/${new Date(slotMs).getUTCFullYear()}`,
      }),
    );
    await plan.attempt();
    const [record] = await records("test-iris-plan");
    expect(record).toMatchObject({ outcome: "stored", status: 200, bytes: timetable.length });
    expect(record?.url).toBe(`${base}/iris/plan/${new Date().getUTCFullYear()}`);
    expect(record?.feed).toBeUndefined();
    expect(record?.object?.contentType).toBe("application/xml");
    expect(JSON.stringify(record)).not.toContain(apiKey);
    const sent = requests.at(-1);
    expect(sent?.dbApiKey).toBe(apiKey);
    expect(sent?.accept).toBe("application/xml");
    const file = record?.object?.file ?? "";
    const recovered = [];
    for await (const item of readSegmentPayloads(root, file, [record as FetchRecord])) {
      recovered.push(item.payload.toString("utf8"));
    }
    expect(recovered).toEqual([timetable]);
  });

  it("owes the catch-up URLs at a start without a recent success, one request each", async () => {
    const plan = await runner(
      document("test-iris-catch-up", "/iris/plan/3", {
        urlAt: () => `${base}/iris/plan/3`,
        catchUpUrlsAt: () => [`${base}/iris/plan/0`, `${base}/iris/plan/1`],
      }),
    );
    const now = Date.now();
    const owed = plan.catchUpUrls(now);
    expect(owed).toEqual([`${base}/iris/plan/0`, `${base}/iris/plan/1`]);
    for (const url of owed) await plan.attempt(url);
    await plan.attempt();
    const stored = await records("test-iris-catch-up");
    expect(stored.map((record) => record.url)).toEqual([...owed, `${base}/iris/plan/3`]);
    expect(stored.map((record) => record.outcome)).toEqual(["stored", "unchanged", "unchanged"]);
    const restarted = await runner(
      document("test-iris-catch-up", "/iris/plan/3", {
        catchUpUrlsAt: () => [`${base}/iris/plan/0`],
      }),
    );
    expect(restarted.catchUpUrls(Date.now())).toEqual([]);
  });

  it("uses the fixed URL without urlAt and notes an unchanged body without storing it twice", async () => {
    const rchg = await runner(document("test-iris-rchg", "/iris/rchg"));
    await rchg.attempt();
    await rchg.attempt();
    const outcomes = (await records("test-iris-rchg")).map((record) => record.outcome);
    expect(outcomes).toEqual(["stored", "unchanged"]);
    expect(requests.map((r) => r.url)).toEqual(["/iris/rchg", "/iris/rchg"]);
  });

  it("stores an XML answer whose root is not timetable as invalid", async () => {
    const wrong = await runner(
      document("test-iris-html", "/maintenance", { documentRoot: "timetable" }),
    );
    await wrong.attempt();
    const [record] = await records("test-iris-html");
    expect(record).toMatchObject({ outcome: "invalid", status: 200 });
    expect(record?.error).toMatch(/timetable/);
    expect(record?.object).toBeDefined();
  });

  it("accepts a JSON document and stores one that does not parse as invalid", async () => {
    const json = { contentType: "application/json" };
    const good = await runner(document("test-fasta", "/facilities.json", json));
    const cut = await runner(document("test-fasta-cut", "/facilities-cut.json", json));
    await good.attempt();
    await cut.attempt();
    expect((await records("test-fasta"))[0]).toMatchObject({ outcome: "stored" });
    const [invalid] = await records("test-fasta-cut");
    expect(invalid).toMatchObject({ outcome: "invalid", status: 200 });
    expect(invalid?.error).toMatch(/JSON/);
    expect(requests.find((r) => r.url === "/facilities.json")?.accept).toBe("application/json");
  });

  it("records a missing document as an HTTP error", async () => {
    const missing = await runner(document("test-missing", "/nothing"));
    await missing.attempt();
    expect((await records("test-missing"))[0]).toMatchObject({
      outcome: "http-error",
      status: 404,
    });
  });
});

describe("SourceRunner and the provider pause", () => {
  it("pauses the whole provider on a 429 or 503: Retry-After, else a minute, at most 15 minutes", async () => {
    for (const path of ["/limited", "/unavailable", "/limited-long", "/nothing"]) {
      await (
        await runner(source(`test${path.replace("/", "-")}`, path, { provider: "p" }))
      ).attempt();
    }
    expect(pauses).toEqual([
      ["p", 30_000],
      ["p", 60_000],
      ["p", 900_000],
    ]);
  });
});

describe("redirectAllowed", () => {
  it("never lets an https source fall back to http", () => {
    expect(redirectAllowed("https://a.example/x", new URL("https://b.example/y"))).toBe(true);
    expect(redirectAllowed("https://a.example/x", new URL("http://a.example/y"))).toBe(false);
    expect(redirectAllowed("http://a.example/x", new URL("http://a.example/y"))).toBe(true);
    expect(redirectAllowed("https://a.example/x", new URL("file:///etc/passwd"))).toBe(false);
  });
});
