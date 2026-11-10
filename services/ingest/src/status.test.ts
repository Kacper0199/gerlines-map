import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recorderSources, type SourceDefinition } from "./sources.ts";
import { formatStatus, recorderStatus, sourceStatus, staleThresholdMs } from "./status.ts";
import { appendJsonLine } from "./storage/files.ts";
import { writeMode } from "./storage/mode.ts";
import type { FetchRecord } from "./storage/sidecar.ts";

const MINUTE = 60_000;
const sources = recorderSources({ otdChApiKey: null, sncbApiKey: null });
const byId = (id: string): SourceDefinition => {
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`no source ${id}`);
  return source;
};

describe("staleThresholdMs", () => {
  it("gives each feed the threshold its recorded header advances call for", () => {
    expect(staleThresholdMs(byId("delfi-gtfs-rt"))).toBe(10 * MINUTE);
    expect(staleThresholdMs(byId("delfi-gtfs-sa"))).toBe(60 * MINUTE);
    expect(staleThresholdMs(byId("ovapi-train-updates"))).toBe(20 * MINUTE);
    expect(staleThresholdMs(byId("pl-pkpic-gtfs-rt"))).toBe(10 * MINUTE);
  });

  it("falls back to three cadences, at least five minutes", () => {
    expect(staleThresholdMs(byId("gtfsde-rt"))).toBe(5 * MINUTE);
    expect(staleThresholdMs(byId("delfi-gtfs-rt-deincr"))).toBe(3 * 60 * MINUTE);
  });
});

describe("sourceStatus staleness", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function recordAlerts(headerAgesMinutes: readonly number[], now: number): Promise<void> {
    root = await mkdtemp(join(tmpdir(), "status-"));
    const header = Math.floor((now - 40 * MINUTE) / 1000);
    const repaired = new Set<string>();
    for (const [index, ago] of headerAgesMinutes.entries()) {
      const at = new Date(now - ago * MINUTE).toISOString();
      const record: FetchRecord = {
        v: 1,
        type: "fetch",
        source: "delfi-gtfs-sa",
        run: "run",
        writer: "live",
        url: "https://example.test/sa",
        method: "GET",
        startedAt: at,
        observedAt: at,
        durationMs: 10,
        outcome: index === 0 ? "stored" : "unchanged",
        status: 200,
        headers: {},
        sha256: "a".repeat(64),
        bytes: 10,
        feed: {
          ok: true,
          gtfsRealtimeVersion: "2.0",
          incrementality: "FULL_DATASET",
          headerTimestamp: header,
          entities: 1,
          tripUpdates: 0,
          vehicles: 0,
          alerts: 1,
          deleted: 0,
        },
      };
      await appendJsonLine(
        join(root, "delfi-gtfs-sa", at.slice(0, 10), `${at.slice(11, 13)}.jsonl`),
        record,
        repaired,
      );
    }
  }

  it("does not call the alerts feed stale after 35 unchanged minutes, as recorded on a Sunday", async () => {
    const now = Date.parse("2026-10-29T12:00:30Z");
    await recordAlerts([35, 30, 25, 20, 15, 10, 5, 0], now);
    const status = await sourceStatus(root, byId("delfi-gtfs-sa"), now, 1);
    expect(status.condition).toBe("ok");
    expect(status.staleAfterSeconds).toBe(3600);
  });

  it("calls it stale once the header has not advanced for over an hour", async () => {
    const now = Date.parse("2026-10-29T12:00:30Z");
    await recordAlerts([65, 60, 50, 40, 30, 20, 10, 0], now);
    const status = await sourceStatus(root, byId("delfi-gtfs-sa"), now, 1);
    expect(status.condition).toBe("stale");
    expect(status.stale).toMatch(/has not advanced for 3900 s/);
  });
});

describe("status in travel and paused mode", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const NOW = Date.parse("2026-11-03T12:04:00Z");

  async function fetches(source: string, times: readonly number[]): Promise<void> {
    const repaired = new Set<string>();
    for (const [index, t] of times.entries()) {
      const at = new Date(t).toISOString();
      const record: FetchRecord = {
        v: 1,
        type: "fetch",
        source,
        run: "run",
        writer: "live",
        url: "https://example.test/feed",
        method: "GET",
        startedAt: at,
        observedAt: at,
        durationMs: 10,
        outcome: "stored",
        status: 200,
        headers: {},
        sha256: index.toString(16).padStart(64, "0"),
        bytes: 10,
        feed: {
          ok: true,
          gtfsRealtimeVersion: "2.0",
          incrementality: "FULL_DATASET",
          headerTimestamp: Math.floor((t - 30_000) / 1000),
          entities: 1,
          tripUpdates: 1,
          vehicles: 0,
          alerts: 0,
          deleted: 0,
        },
      };
      await appendJsonLine(
        join(root, source, at.slice(0, 10), `${at.slice(11, 13)}.jsonl`),
        record,
        repaired,
      );
    }
  }

  const everyFive = Array.from(
    { length: 12 },
    (_, i) => NOW - 4 * MINUTE - i * 5 * MINUTE,
  ).reverse();
  const everyMinuteUntilAnHourAgo = Array.from(
    { length: 30 },
    (_, i) => NOW - 60 * MINUTE - i * MINUTE,
  ).reverse();

  it("judges the travel source by its travel cadence and holds the others", async () => {
    root = await mkdtemp(join(tmpdir(), "status-travel-"));
    await writeMode(root, "travel", new Date(NOW - 2 * 60 * MINUTE), "trip");
    await fetches("delfi-mobilithek-rt", everyFive);
    await fetches("gtfsde-rt", everyMinuteUntilAnHourAgo);
    const status = await recorderStatus(
      root,
      [byId("delfi-mobilithek-rt"), byId("gtfsde-rt")],
      NOW,
    );
    const [mobilithek, gtfsde] = status.sources;
    expect(mobilithek).toMatchObject({ condition: "ok", stale: null, openGap: null, gaps: [] });
    expect(mobilithek?.cadenceSeconds).toBe(300);
    expect(gtfsde).toMatchObject({ condition: "held", stale: null, openGap: null });
    expect(formatStatus(status)).toMatch(/gtfsde-rt .*: held \(travel\)/);
  });

  it("still calls the travel source stale when its travel fetches stop", async () => {
    root = await mkdtemp(join(tmpdir(), "status-travel-"));
    await writeMode(root, "travel", new Date(NOW - 2 * 60 * MINUTE), "trip");
    await fetches(
      "delfi-mobilithek-rt",
      everyFive.map((t) => t - 30 * MINUTE),
    );
    const status = await recorderStatus(root, [byId("delfi-mobilithek-rt")], NOW);
    expect(status.sources[0]?.condition).toBe("stale");
  });

  it("holds every source while paused", async () => {
    root = await mkdtemp(join(tmpdir(), "status-paused-"));
    await writeMode(root, "paused", new Date(NOW - 2 * 60 * MINUTE), "no network");
    await fetches("delfi-mobilithek-rt", everyMinuteUntilAnHourAgo);
    const status = await recorderStatus(root, [byId("delfi-mobilithek-rt")], NOW);
    expect(status.sources[0]).toMatchObject({ condition: "held", stale: null, openGap: null });
    expect(formatStatus(status)).toMatch(/held \(paused\)/);
  });
});
