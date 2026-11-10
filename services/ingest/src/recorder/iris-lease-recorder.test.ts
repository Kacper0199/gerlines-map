import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { IRIS_LEASE_PATH, IrisLease } from "../db-apis/iris-lease.ts";
import { NO_MOBILITHEK, type RecorderConfig } from "../env.ts";
import type { Logger } from "../log.ts";
import type { SourceDefinition } from "../sources.ts";
import { listSidecars, readFetchRecords } from "../storage/reader.ts";
import { until } from "../testing/until.ts";
import { runRecorder } from "./recorder.ts";

const feed = readFileSync(new URL("../../test/fixtures/vbn-gtfs-rt-first40.pb", import.meta.url));
const timetable = '<?xml version="1.0" encoding="UTF-8"?><timetable station="Test" eva="8000105"/>';
const hits: string[] = [];
let server: Server;
let base: string;
let root: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(request.url ?? "");
    if (request.url === "/iris") {
      response.writeHead(200, { "content-type": "application/xml" }).end(timetable);
    } else {
      response.writeHead(200, { "content-type": "application/x-protobuf" }).end(feed);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "gerlines-iris-lease-recorder-"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

function source(id: string, overrides: Partial<SourceDefinition>): SourceDefinition {
  return {
    id,
    kind: "gtfs-rt",
    url: `${base}/${id}`,
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
      attribution: "t",
    },
    ...overrides,
  };
}

const config = (): RecorderConfig => ({
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
});

describe("the recorder and the IRIS lease", () => {
  it("skips IRIS sources with a log line while another process holds the lease, then takes it over", async () => {
    const cli = new IrisLease({ root, clock: systemClock, pid: 4242, host: "laptop" });
    expect(await cli.hold()).toBeNull();
    const lines: string[] = [];
    const logger: Logger = {
      log: (level, message, fields) => lines.push(`${level} ${message} ${JSON.stringify(fields)}`),
    };
    const controller = new AbortController();
    const running = runRecorder({
      config: config(),
      clock: systemClock,
      logger,
      index: null,
      signal: controller.signal,
      sources: [
        source("db-iris-rchg-test", {
          kind: "http-document",
          url: `${base}/iris`,
          provider: "db-timetables",
          contentType: "application/xml",
          documentRoot: "timetable",
        }),
        source("other-feed", {}),
      ],
      providerLimits: {
        "db-timetables": { capacity: 100, refillEveryMs: 1, serial: true },
        "other-feed": { capacity: 100, refillEveryMs: 1 },
      },
      freeBytes: async () => 10,
    });
    try {
      await until(
        () => hits.filter((hit) => hit === "/other-feed").length >= 3,
        "the other source to run",
      );
      await until(
        () => lines.some((line) => line.includes("IRIS lease is held by pid 4242 on laptop")),
        "the skip to be logged",
      );
      expect(hits).not.toContain("/iris");
      expect(lines.filter((line) => line.includes("IRIS lease is held")).length).toBe(1);

      await cli.release();
      await until(() => hits.includes("/iris"), "IRIS to resume");
      const owner = JSON.parse(await readFile(join(root, IRIS_LEASE_PATH), "utf8"));
      expect(owner.pid).toBe(process.pid);
      expect(await cli.hold()).toMatch(new RegExp(`pid ${process.pid} on `));
    } finally {
      controller.abort();
      await running;
    }
    const stored = await readFetchRecords(root, await listSidecars(root, "db-iris-rchg-test"));
    expect(stored.some((record) => record.outcome === "stored")).toBe(true);
    await expect(stat(join(root, IRIS_LEASE_PATH))).rejects.toThrow(/ENOENT/);
  }, 45_000);
});
