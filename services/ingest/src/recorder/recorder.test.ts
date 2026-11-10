import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { NO_MOBILITHEK, type RecorderConfig } from "../env.ts";
import { silentLogger } from "../log.ts";
import type { SourceDefinition } from "../sources.ts";
import { recorderStatus } from "../status.ts";
import { listSidecars, readFetchRecords } from "../storage/reader.ts";
import { RunLog } from "../storage/runs.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { until } from "../testing/until.ts";
import { verifySource } from "../verify.ts";
import { runRecorder } from "./recorder.ts";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));
const feeds: [Buffer, Buffer] = [
  fixture("vbn-gtfs-rt-first40.pb"),
  fixture("gtfsde-rt-first40.pb"),
];
const zip = Buffer.from("PK static timetable bytes");
const seen: Record<string, IncomingMessage["headers"][]> = {};
const count = (name: string) => seen[name]?.length ?? 0;
let feedVersion = 0;
let server: Server;
let base: string;
let root: string;

function remember(name: string, request: IncomingMessage): void {
  seen[name] = [...(seen[name] ?? []), request.headers];
}

const routes: Record<
  string,
  (request: IncomingMessage) => {
    status: number;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }
> = {
  "/rt.pb": (request) => {
    remember("rt", request);
    const etag = `"v${feedVersion}"`;
    if (request.headers["if-none-match"] === etag) {
      feedVersion += 1;
      return { status: 304, headers: { etag } };
    }
    return {
      status: 200,
      headers: { etag, "content-type": "application/x-protobuf" },
      body: feedVersion % 2 === 0 ? feeds[0] : feeds[1],
    };
  },
  "/limited.pb": (request) => {
    remember("limited", request);
    return { status: 429, headers: { "retry-after": "1" }, body: "slow down" };
  },
  "/html.pb": (request) => {
    remember("html", request);
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html>maintenance</html>",
    };
  },
  "/static.zip": (request) => {
    remember("static", request);
    if (request.headers["if-none-match"] === '"z1"')
      return { status: 304, headers: { etag: '"z1"' } };
    return { status: 200, headers: { etag: '"z1"', "content-type": "application/zip" }, body: zip };
  },
};

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
    periodMs: 300,
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

function config(): RecorderConfig {
  return {
    recordingsDir: root,
    userAgent: "gerlines/0.1.0 (+test@example.org)",
    appVersion: "0.1.0",
    otdChApiKey: null,
    sncbApiKey: null,
    dbCredentials: null,
    dbApis: false,
    mobilithek: NO_MOBILITHEK,
    diskFloorBytes: 1,
    maxInFlight: 2,
    onlySources: null,
    seedDir: null,
    database: "off",
  };
}

function stallEventLoop(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

/**
 * Records until `done` holds, then shuts down. Waiting on a condition, not a fixed time, keeps the test
 * independent of how busy the machine is; `stallMs` blocks the event loop once to prove it.
 */
async function record(
  done: () => boolean | Promise<boolean>,
  what: string,
  stallMs = 0,
): Promise<void> {
  const controller = new AbortController();
  const sources = [
    source("test-rt", "/rt.pb"),
    source("test-limited", "/limited.pb"),
    source("test-html", "/html.pb"),
    source("test-silent", "/silent.pb", { headersTimeoutMs: 150, totalTimeoutMs: 250 }),
    source("test-static", "/static.zip", {
      kind: "static-file",
      segmentPeriod: "day",
      contentType: "application/zip",
      fileName: "latest.zip",
    }),
  ];
  const limits = Object.fromEntries(
    sources.map((s) => [s.id, { capacity: 100, refillEveryMs: 1 }]),
  );
  const running = runRecorder({
    config: config(),
    clock: systemClock,
    logger: silentLogger,
    index: null,
    signal: controller.signal,
    sources,
    providerLimits: limits,
    freeBytes: async () => 10,
  });
  if (stallMs > 0) setTimeout(() => stallEventLoop(stallMs), 50);
  try {
    await until(done, what);
  } finally {
    controller.abort();
    await running;
  }
}

async function records(id: string): Promise<FetchRecord[]> {
  return readFetchRecords(root, await listSidecars(root, id));
}

/** The stall outlasts the 1 s headers timeout, so a request in flight when it starts may time out on any machine. */
function answered(list: readonly FetchRecord[]): FetchRecord[] {
  return list.filter((r) => !(r.outcome === "failure" && /^timeout: /.test(r.error ?? "")));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/silent.pb") {
      remember("silent", request);
      return;
    }
    const route = routes[request.url ?? ""];
    const answer = route ? route(request) : { status: 404 };
    response.writeHead(answer.status, answer.headers).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "gerlines-recorder-"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

describe("runRecorder against a local server", () => {
  it("records every outcome, honours Retry-After and closes its runs on shutdown, also after a stalled event loop", async () => {
    await record(
      async () => {
        const rt = await records("test-rt");
        return (
          rt.filter((r) => r.outcome === "stored").length >= 2 &&
          rt.some((r) => r.outcome === "not-modified") &&
          answered(await records("test-limited")).length >= 2 &&
          answered(await records("test-html")).length >= 1 &&
          (await records("test-silent")).length >= 1 &&
          answered(await records("test-static")).length >= 2
        );
      },
      "every source to have recorded each outcome",
      1_500,
    );

    const rt = await records("test-rt");
    expect(rt.filter((r) => r.outcome === "stored").length).toBeGreaterThanOrEqual(2);
    expect(rt.some((r) => r.outcome === "not-modified")).toBe(true);
    expect(rt.find((r) => r.outcome === "stored")?.feed).toMatchObject({ ok: true, entities: 40 });
    expect(seen.rt?.[0]?.["user-agent"]).toBe("gerlines/0.1.0 (+test@example.org)");

    const limited = await records("test-limited");
    expect(answered(limited).length).toBeGreaterThanOrEqual(1);
    expect(answered(limited).map((r) => [r.outcome, r.status])).toEqual(
      answered(limited).map(() => ["http-error", 429]),
    );
    const starts = limited.map((r) => Date.parse(r.startedAt));
    for (const [index, start] of starts.slice(1).entries()) {
      expect(start - (starts[index] ?? 0)).toBeGreaterThanOrEqual(1_000);
    }

    const html = answered(await records("test-html"));
    expect(html.length).toBeGreaterThanOrEqual(1);
    expect(html.map((r) => [r.outcome, r.status])).toEqual(html.map(() => ["invalid", 200]));

    const silent = await records("test-silent");
    expect(silent[0]).toMatchObject({ outcome: "failure", status: null });
    expect(silent[0]?.error).toMatch(/^timeout: /);

    const statics = answered(await records("test-static"));
    expect(statics[0]?.outcome).toBe("stored");
    expect(statics.slice(1).map((r) => r.outcome)).toEqual(
      statics.slice(1).map(() => "not-modified"),
    );

    for (const id of ["test-rt", "test-static"]) {
      const report = await verifySource(root, id);
      expect(report.mismatched).toEqual([]);
      expect(report.errors).toEqual([]);
      expect(report.checked).toBeGreaterThan(0);
      expect(report.matched).toBe(report.checked);
    }
    const runs = await new RunLog(root).read("test-rt");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", job: "record" });
    const lock = await readFile(join(root, ".recorder.lock"), "utf8").catch(() => null);
    expect(lock).toBeNull();
  }, 30_000);

  it("resumes after a crash: closes the orphaned run, continues with conditional GETs, duplicates nothing", async () => {
    const orphan = "0199f000-0000-7000-8000-00000000dead";
    await new RunLog(root).start({
      run: orphan,
      source: "test-rt",
      job: "record",
      appVersion: "0.1.0",
      at: new Date().toISOString(),
    });
    const before = await records("test-rt");
    const staticBefore = count("static");
    const rtBefore = count("rt");

    await record(
      () => count("static") > staticBefore && count("rt") >= rtBefore + 2,
      "the static and realtime sources to run again",
    );

    const runs = await new RunLog(root).read("test-rt");
    expect(runs.find((run) => run.id === orphan)).toMatchObject({ status: "failed" });
    expect(runs.filter((run) => run.status === "succeeded")).toHaveLength(2);
    const after = await records("test-rt");
    const keys = after.flatMap((r) => (r.object ? [r.object.key] : []));
    expect(new Set(keys).size).toBe(keys.length);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(seen.static?.[staticBefore]?.["if-none-match"]).toBe('"z1"');
    expect((await records("test-static")).filter((r) => r.outcome === "stored")).toHaveLength(1);
    const verified = await verifySource(root, "test-rt");
    expect(verified).toMatchObject({ mismatched: [], errors: [] });
    expect(verified.checked).toBeGreaterThan(0);
    expect(verified.matched).toBe(verified.checked);
  });

  it("reports per source status from the files", async () => {
    const sources = [source("test-rt", "/rt.pb"), source("test-limited", "/limited.pb")];
    const status = await recorderStatus(root, sources, Date.now());
    const rt = status.sources[0];
    expect(rt?.lastSuccess).not.toBeNull();
    expect(rt?.today.stored).toBeGreaterThanOrEqual(2);
    expect(status.sources[1]?.lastError).toMatchObject({ outcome: "http-error", status: 429 });
    expect(status.sources[1]?.condition).toBe("failing");
    expect(rt?.condition).toBe("ok");
    expect(status.heartbeat).toBeNull();
  });
});
