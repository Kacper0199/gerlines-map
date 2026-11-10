import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { NO_MOBILITHEK, type RecorderConfig } from "../env.ts";
import { silentLogger } from "../log.ts";
import { travelPlan } from "../policy/travel.ts";
import type { SourceDefinition } from "../sources.ts";
import { recorderStatus } from "../status.ts";
import { readJsonLinesFile } from "../storage/files.ts";
import { MODE_PATH, readMode, writeMode } from "../storage/mode.ts";
import { EVENTS_PATH } from "../storage/paths.ts";
import { until } from "../testing/until.ts";
import { runRecorder } from "./recorder.ts";

const feed = readFileSync(new URL("../../test/fixtures/vbn-gtfs-rt-first40.pb", import.meta.url));
const hits: Record<string, number> = {};
let server: Server;
let base: string;
let root: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const name = (request.url ?? "").slice(1);
    hits[name] = (hits[name] ?? 0) + 1;
    response.writeHead(200, { "content-type": "application/x-protobuf" }).end(feed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-mode-"));
  for (const key of Object.keys(hits)) delete hits[key];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mode file", () => {
  it("reads full when there is no file, and back what was written", async () => {
    expect((await readMode(root)).mode).toBe("full");
    await writeMode(root, "travel", new Date("2026-10-29T21:00:00Z"), "train wifi");
    expect(await readMode(root)).toEqual({
      mode: "travel",
      at: "2026-10-29T21:00:00.000Z",
      reason: "train wifi",
    });
  });

  it("falls back to full for a file it cannot use, so a broken switch never stops recording", async () => {
    for (const text of ["", "{", '{"mode":"off"}', "[]"]) {
      await writeFile(join(root, MODE_PATH), text);
      expect((await readMode(root)).mode, text).toBe("full");
    }
  });
});

describe("travelPlan", () => {
  it("keeps the official DELFI feed every 5 minutes and alerts every 15", () => {
    const plan = travelPlan([
      "delfi-mobilithek-rt",
      "delfi-gtfs-rt",
      "delfi-gtfs-rt-deincr",
      "delfi-gtfs-sa",
      "gtfsde-rt",
    ]);
    expect([...plan]).toEqual([
      ["delfi-mobilithek-rt", 300_000],
      ["delfi-gtfs-sa", 900_000],
    ]);
  });

  it("falls back to the hourly de-incremented mirror copy without Mobilithek", () => {
    const plan = travelPlan(["delfi-gtfs-rt", "delfi-gtfs-rt-deincr", "delfi-gtfs-sa"]);
    expect(Object.fromEntries(plan)).toEqual({
      "delfi-gtfs-sa": 900_000,
      "delfi-gtfs-rt-deincr": 3_600_000,
    });
  });
});

function source(id: string): SourceDefinition {
  return {
    id,
    kind: "gtfs-rt",
    url: `${base}/${id}`,
    provider: id,
    periodMs: 200,
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
    database: "off",
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runRecorder and the mode switch", () => {
  it("records nothing while paused, only the travel set in travel, everything in full", async () => {
    await writeMode(root, "paused", new Date(), "test");
    const controller = new AbortController();
    const running = runRecorder({
      config: config(),
      clock: systemClock,
      logger: silentLogger,
      index: null,
      signal: controller.signal,
      sources: [source("light"), source("heavy")],
      providerLimits: {
        light: { capacity: 100, refillEveryMs: 1 },
        heavy: { capacity: 100, refillEveryMs: 1 },
      },
      freeBytes: async () => 10,
      modeCheckMs: 50,
      travelPeriods: () => new Map([["light", 250]]),
    });
    try {
      await pause(700);
      expect(hits).toEqual({});

      await writeMode(root, "travel", new Date(), "test");
      await until(() => (hits.light ?? 0) >= 2, "light recorded in travel mode");
      expect(hits.heavy ?? 0).toBe(0);
      const status = await recorderStatus(root, [source("light")], Date.now(), 1);
      expect(status.mode.mode).toBe("travel");

      await writeMode(root, "full", new Date(), null);
      await until(() => (hits.heavy ?? 0) >= 2, "heavy recorded again in full mode");
    } finally {
      controller.abort();
      await running;
    }
    const events = await readJsonLinesFile<{ type: string; mode?: string }>(
      join(root, EVENTS_PATH),
    );
    expect(events.filter((event) => event.type === "mode").map((event) => event.mode)).toEqual([
      "paused",
      "travel",
      "full",
    ]);
  });
});
