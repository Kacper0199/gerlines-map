import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "@gerlines/db";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { RecordingFollower } from "./follow.ts";
import { LiveRunner, truncated, WaitingForSource } from "./live.ts";
import { Matcher } from "./matcher.ts";
import { MemorySink } from "./memory-sink.test-support.ts";
import { Processor } from "./processor.ts";
import { Timetable } from "./timetable.ts";
import { zip } from "./zip.test-support.ts";

const record = (source: string, observedAt: string, id: string): FetchRecord =>
  ({
    v: 1,
    type: "fetch",
    source,
    run: "0199f000-0000-7000-8000-000000000000",
    writer: "live",
    url: "https://example.org/latest.pbf",
    method: "GET",
    startedAt: observedAt,
    observedAt,
    durationMs: 1,
    status: 200,
    headers: {},
    object: { id, key: id, file: `${source}/f.seg.zst` },
  }) as unknown as FetchRecord;

describe("WaitingForSource", () => {
  it("indexes waiting payloads again in order until their source is registered", () => {
    const waiting = new WaitingForSource();
    const early = record("new-source", "2026-10-29T10:00:00Z", "a");
    const later = record("new-source", "2026-10-29T10:01:00Z", "b");
    const other = record("delfi-gtfs-rt", "2026-10-29T10:00:30Z", "c");
    expect(waiting.settle([early], 0)).toEqual([early]);
    expect(waiting.withWaiting([later, other])).toEqual([early, other, later]);
    expect(waiting.settle([early, later], 0)).toEqual([later]);
    expect(waiting.size).toBe(2);
    expect(waiting.settle([], 0)).toEqual([]);
    expect(waiting.size).toBe(0);
  });

  it("forgets payloads older than the horizon", () => {
    const waiting = new WaitingForSource();
    const old = record("new-source", "2026-10-27T10:00:00Z", "a");
    waiting.settle([old], Date.parse("2026-10-28T00:00:00Z"));
    expect(waiting.size).toBe(0);
  });
});

describe("truncated", () => {
  it("cuts long text without splitting a surrogate pair", () => {
    expect(truncated("abc", 5)).toBe("abc");
    expect(truncated("abcdef", 3)).toBe("abc…");
    expect(truncated("ab\u{1F686}cd", 3)).toBe("ab…");
  });
});

const clock: Clock = { now: () => Date.parse("2026-10-25T12:00:00Z"), sleep: async () => {} };

const gtfsde = () =>
  zip([
    {
      name: "stops.txt",
      data: Buffer.from("stop_id,stop_lat,stop_lon,parent_station\ns1,52.5,13.4,\n"),
    },
    { name: "routes.txt", data: Buffer.from("route_id,route_short_name\nr1,RE 1\n") },
    { name: "trips.txt", data: Buffer.from("route_id,trip_id\nr1,t1\n") },
    {
      name: "stop_times.txt",
      data: Buffer.from(
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,s1,1\n",
      ),
    },
  ]);

describe("LiveRunner gtfs.de statics", () => {
  it("takes the first recorded statics when the run started before any, and each newer one once", async () => {
    const root = await mkdtemp(join(tmpdir(), "gerlines-live-"));
    try {
      const timetable = new Timetable({
        feedVersionId: 1,
        feedVersion: "v1",
        trips: [],
        calendars: new Map(),
        routes: new Map(),
        stopPoints: new Map(),
        stopPlaces: new Map(),
        delfiStopPoints: new Map(),
        delfiStopPlaces: new Map(),
      });
      const matcher = new Matcher([timetable]);
      const processor = new Processor({} as Kysely<DB>, matcher, clock, async function* () {}, {
        sink: new MemorySink(),
      });
      const logged: string[] = [];
      const runner = new LiveRunner({
        db: {} as Kysely<DB>,
        root,
        processor,
        follower: new RecordingFollower(root, ["gtfsde-rt"], clock.now()),
        clock,
        logger: { log: (_level, message) => logged.push(message) },
        index: async (records) => ({ indexed: [...records], unregistered: [] }),
        checkpointPath: null,
        horizonMs: 48 * 3_600_000,
      });
      await runner.reloadForeign(clock.now());
      expect(matcher.foreign.has("gtfsde-rt")).toBe(false);
      await mkdir(join(root, "gtfsde-static-rv", "2026-10-25"), { recursive: true });
      await writeFile(join(root, "gtfsde-static-rv", "2026-10-25", "100200Z-rv.zip"), gtfsde());
      await runner.reloadForeign(clock.now());
      const first = matcher.foreign.get("gtfsde-rt");
      expect(first?.trip("t1")?.stopIds).toEqual(["s1"]);
      await runner.reloadForeign(clock.now());
      expect(matcher.foreign.get("gtfsde-rt")).toBe(first);
      await writeFile(join(root, "gtfsde-static-rv", "2026-10-25", "110200Z-rv.zip"), gtfsde());
      await runner.reloadForeign(clock.now());
      expect(matcher.foreign.get("gtfsde-rt")).not.toBe(first);
      expect(logged).toEqual(["gtfs.de statics loaded", "gtfs.de statics reloaded"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
