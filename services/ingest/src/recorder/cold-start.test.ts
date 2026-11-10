import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NO_MOBILITHEK, type RecorderConfig } from "../env.ts";
import type { Logger } from "../log.ts";
import type { SourceDefinition } from "../sources.ts";
import { listSidecars, readFetchRecords } from "../storage/reader.ts";
import { FakeIndex } from "../testing/fake-index.ts";
import { VirtualClock } from "../testing/virtual-clock.ts";
import { runRecorder } from "./recorder.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));
const feeds = [fixture("vbn-gtfs-rt-first40.pb"), fixture("gtfsde-rt-first40.pb")];
const START = Date.parse("2026-11-08T15:00:00.000Z");
const PERIOD_MS = 30_000;
const STEP_MS = 5_000;
let server: Server;
let base: string;
let root: string;

beforeAll(async () => {
  const served = new Map<string, number>();
  server = createServer((request, response) => {
    const version = (served.get(request.url ?? "") ?? 0) + 1;
    served.set(request.url ?? "", version);
    response
      .writeHead(200, { "content-type": "application/x-protobuf", etag: `"v${version}"` })
      .end(feeds[version % 2]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-cold-start-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function source(id: string): SourceDefinition {
  return {
    id,
    kind: "gtfs-rt",
    url: `${base}/${id}`,
    provider: id,
    periodMs: PERIOD_MS,
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
    database: "on",
  };
}

function capture(): { logger: Logger; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    logger: { log: (_level, message) => messages.push(message) },
  };
}

/** Moves virtual time on in small steps and lets each fetch to the local server finish in real time. */
async function advance(clock: VirtualClock, until: number): Promise<void> {
  while (clock.now() < until) {
    await clock.runUntil(Math.min(until, clock.now() + STEP_MS));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function recordedObjects(ids: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const id of ids) {
    for (const record of await readFetchRecords(root, await listSidecars(root, id))) {
      if (record.object) found.push(record.object.id);
    }
  }
  return found.sort();
}

async function coldStart(dbUpAfterMs: number, checkAfterMs: number) {
  const clock = new VirtualClock(START);
  const index = new FakeIndex({ down: true });
  const { logger, messages } = capture();
  const sources = [source("cold-a"), source("cold-b")];
  const controller = new AbortController();
  const running = runRecorder({
    config: config(),
    clock,
    logger,
    index,
    signal: controller.signal,
    sources,
    providerLimits: Object.fromEntries(
      sources.map((s) => [s.id, { capacity: 100, refillEveryMs: 1 }]),
    ),
    freeBytes: async () => 10,
  });
  try {
    await advance(clock, START + dbUpAfterMs);
    index.down = false;
    await advance(clock, START + checkAfterMs);
  } finally {
    controller.abort();
    await running;
  }
  return { index, messages, recorded: await recordedObjects(sources.map((s) => s.id)) };
}

describe("recorder started before the database accepts connections", () => {
  it("indexes every object recorded meanwhile within three minutes of the database coming up", async () => {
    const { index, recorded } = await coldStart(45_000, 45_000 + 3 * 60_000);

    expect(recorded.length).toBeGreaterThanOrEqual(4);
    expect([...index.objects.keys()].sort()).toEqual(recorded);
    expect([...index.sources].sort()).toEqual(["cold-a", "cold-b"]);
    expect([...index.runs.values()].map((run) => run.source).sort()).toEqual(["cold-a", "cold-b"]);
  });

  it("still heals when the database takes six minutes, on the backoff", async () => {
    const { index, recorded, messages } = await coldStart(6 * 60_000, 6 * 60_000 + 6 * 60_000);

    expect(recorded.length).toBeGreaterThanOrEqual(4);
    expect([...index.objects.keys()].sort()).toEqual(recorded);
    expect(messages).toContain("database index healed from files");
  });

  it("heals within two minutes when the database comes up after the backoff reached the hour", async () => {
    const { index, recorded, messages } = await coldStart(15 * 60_000, 17 * 60_000);

    expect(recorded.length).toBeGreaterThanOrEqual(4);
    expect([...index.objects.keys()].sort()).toEqual(recorded);
    expect(messages).toContain("database index healed from files");
  });
});
