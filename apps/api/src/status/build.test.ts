import { readFileSync } from "node:fs";
import { DataStatus } from "@gerlines/schema/status";
import { describe, expect, it } from "vitest";
import { buildDataStatus, DOWN_AFTER_MS, type RecordedSource } from "./build.ts";
import { STATUS_FEEDS } from "./feeds.ts";

interface RecorderFixture {
  readonly capturedAt: string;
  readonly sources: readonly {
    readonly source: string;
    readonly staleAfterSeconds: number;
    readonly lastSuccess: string | null;
    readonly condition: string;
  }[];
  readonly database: {
    readonly rows: readonly { source: string; recordedAt: string | null; recording: boolean }[];
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/recorder-status-2026-11-08.json", import.meta.url), "utf8"),
) as RecorderFixture;
const CAPTURED = Date.parse(fixture.capturedAt);
const recorded: RecordedSource[] = fixture.database.rows.map((row) => ({
  source: row.source,
  recordedAt: row.recordedAt === null ? null : Date.parse(row.recordedAt),
  recording: row.recording,
}));

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-08T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function one(
  feedId: string,
  rows: readonly RecordedSource[],
  feeds: Record<string, string> = {},
  now = NOW,
) {
  const status = buildDataStatus({ recorded: rows, live: { confirmed: iso(now), feeds } }, now);
  const found = status.sources.find((source) => source.id === feedId);
  if (!found) throw new Error(`no ${feedId}`);
  return found;
}

describe("data status from a copy of the recorder status", () => {
  const status = buildDataStatus({ recorded, live: null }, CAPTURED);

  it("is a valid answer that names every feed of the map once", () => {
    expect(DataStatus.parse(status)).toEqual(status);
    expect(status.sources.map((source) => source.id)).toEqual(STATUS_FEEDS.map((feed) => feed.id));
  });

  it("agrees with the recorder: every recorded feed ok, DB IRIS not recorded while its lane is off", () => {
    expect(fixture.sources.every((source) => source.condition === "ok")).toBe(true);
    const states = Object.fromEntries(status.sources.map((source) => [source.id, source.state]));
    expect(states).toEqual({
      "delfi-timetable": "ok",
      "delfi-realtime": "ok",
      "gtfsde-realtime": "ok",
      "db-iris": "not_recorded",
      "nl-ovapi": "ok",
      "be-sncb": "ok",
      "fr-sncf": "ok",
      "ch-otd": "ok",
      "cz-czptt": "ok",
      "pl-pkpic": "ok",
      "pl-trains": "ok",
    });
  });

  it("uses the recorder's staleness thresholds for every realtime feed", () => {
    for (const feed of STATUS_FEEDS) {
      const thresholds = fixture.sources
        .filter((source) => feed.sources.includes(source.source))
        .map((source) => source.staleAfterSeconds);
      if (feed.kind === "timetable") {
        expect(feed.staleAfterSeconds, feed.id).toBeNull();
      } else if (feed.kind !== "iris") {
        expect(thresholds.length, feed.id).toBe(feed.sources.length);
        expect(new Set(thresholds), feed.id).toEqual(new Set([feed.staleAfterSeconds]));
      }
    }
  });

  it("never claims data newer than the recorder's last success, and stays within one threshold of it", () => {
    for (const source of status.sources) {
      const feed = STATUS_FEEDS.find((entry) => entry.id === source.id);
      const lastSuccess = fixture.sources
        .filter((entry) => feed?.sources.includes(entry.source))
        .map((entry) => Date.parse(entry.lastSuccess ?? ""));
      if (source.recordedAt === null) continue;
      const newest = Math.max(...lastSuccess);
      expect(Date.parse(source.recordedAt), source.id).toBeLessThanOrEqual(newest);
      if (source.staleAfterSeconds !== null) {
        expect(newest - Date.parse(source.recordedAt)).toBeLessThan(
          source.staleAfterSeconds * 1000,
        );
      }
    }
  });

  it("takes the newest of the feeds' recorder sources", () => {
    const delfi = status.sources.find((source) => source.id === "delfi-realtime");
    expect(delfi?.recordedAt).toBe("2026-11-08T07:09:13.185Z");
    expect(delfi?.dataTime).toBeNull();
    expect(status.live).toEqual({
      confirmedAt: null,
      frameAgeSeconds: null,
      staleAfterSeconds: 30,
      state: "not_recorded",
    });
  });
});

describe("source states", () => {
  const row = (source: string, ageMs: number | null, recording = true): RecordedSource => ({
    source,
    recordedAt: ageMs === null ? null : NOW - ageMs,
    recording,
  });

  it("is ok within the threshold and stale past it", () => {
    expect(one("gtfsde-realtime", [row("gtfsde-rt", 5 * MINUTE)]).state).toBe("ok");
    expect(one("gtfsde-realtime", [row("gtfsde-rt", 5 * MINUTE + 1000)]).state).toBe("stale");
  });

  it("is down after an hour without new data, or when the recorder does not fetch it", () => {
    expect(one("gtfsde-realtime", [row("gtfsde-rt", DOWN_AFTER_MS)]).state).toBe("stale");
    expect(one("gtfsde-realtime", [row("gtfsde-rt", DOWN_AFTER_MS + 1000)]).state).toBe("down");
    expect(one("gtfsde-realtime", [row("gtfsde-rt", MINUTE, false)]).state).toBe("down");
  });

  it("is not recorded without any stored payload or row", () => {
    expect(one("gtfsde-realtime", [row("gtfsde-rt", null)]).state).toBe("not_recorded");
    expect(one("gtfsde-realtime", []).state).toBe("not_recorded");
  });

  it("is stale when the map carries an older payload than the threshold allows", () => {
    const fresh = [row("gtfsde-rt", MINUTE)];
    expect(one("gtfsde-realtime", fresh, { "gtfsde-rt": iso(NOW - 2 * MINUTE) }).state).toBe("ok");
    const lagging = one("gtfsde-realtime", fresh, { "gtfsde-rt": iso(NOW - 6 * MINUTE) });
    expect(lagging.state).toBe("stale");
    expect(lagging.dataTime).toBe(iso(NOW - 6 * MINUTE));
  });

  it("judges a timetable only by whether it is recorded and fetched", () => {
    const old = [row("delfi-gtfs", 9 * 24 * 60 * MINUTE)];
    expect(one("delfi-timetable", old).state).toBe("ok");
    expect(one("delfi-timetable", [row("delfi-gtfs", MINUTE, false)]).state).toBe("down");
  });

  it("is ok while one of two DELFI channels is fresh, and takes the map time of either", () => {
    const rows = [row("delfi-mobilithek-rt", 2 * 60 * MINUTE), row("delfi-gtfs-rt", MINUTE)];
    const feeds = {
      "delfi-mobilithek-rt": iso(NOW - 90 * MINUTE),
      "delfi-gtfs-rt": iso(NOW - 2 * MINUTE),
    };
    const delfi = one("delfi-realtime", rows, feeds);
    expect(delfi.state).toBe("ok");
    expect(delfi.recordedAt).toBe(iso(NOW - MINUTE));
    expect(delfi.dataTime).toBe(iso(NOW - 2 * MINUTE));
  });

  it("reads DB IRIS from every station's change answers", () => {
    const rows = [row("db-iris-fchg-8000105", 2 * MINUTE), row("db-iris-fchg-8011160", MINUTE)];
    const iris = one("db-iris", rows, { "db-iris-fchg-8000105": iso(NOW - 3 * MINUTE) });
    expect(iris).toMatchObject({ state: "ok", recordedAt: iso(NOW - MINUTE) });
    expect(iris.dataTime).toBe(iso(NOW - 3 * MINUTE));
    expect(one("db-iris", [row("db-iris-plan-8000105", MINUTE)]).state).toBe("not_recorded");
  });

  it("ignores a map time it cannot read", () => {
    expect(
      one("gtfsde-realtime", [row("gtfsde-rt", MINUTE)], { "gtfsde-rt": "soon" }).dataTime,
    ).toBe(null);
  });
});

describe("live engine state", () => {
  const live = (confirmed: string | null | undefined) =>
    buildDataStatus(
      { recorded: [], live: confirmed === undefined ? null : { confirmed, feeds: {} } },
      NOW,
    ).live;

  it("is ok up to 30 s after its last tick, then stale, then down after 15 min", () => {
    expect(live(iso(NOW - 30_000))).toEqual({
      confirmedAt: iso(NOW - 30_000),
      frameAgeSeconds: 30,
      staleAfterSeconds: 30,
      state: "ok",
    });
    expect(live(iso(NOW - 31_000)).state).toBe("stale");
    expect(live(iso(NOW - 15 * MINUTE - 1000)).state).toBe("down");
  });

  it("is down without a confirmation and not recorded without a reading", () => {
    expect(live(null)).toMatchObject({ confirmedAt: null, frameAgeSeconds: null, state: "down" });
    expect(live(undefined).state).toBe("not_recorded");
  });

  it("counts a tick ahead of the server clock as age 0", () => {
    expect(live(iso(NOW + 4000))).toMatchObject({ frameAgeSeconds: 0, state: "ok" });
  });
});
