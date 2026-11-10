import { readFileSync } from "node:fs";
import type { DB } from "@gerlines/db";
import { serviceInstant } from "@gerlines/schema/service-day";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import { parseIrisTimetable } from "../db-apis/iris.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { parseIrisStopId } from "./iris.ts";
import { Matcher } from "./matcher.ts";
import { FOLD_TABLES, MemorySink } from "./memory-sink.test-support.ts";
import { compareRecords, type StoredPayload } from "./payload-stream.ts";
import { IRIS_HOLD_MS, Processor } from "./processor.ts";
import { seededRandom } from "./replay.ts";
import { type StaticTrip, Timetable } from "./timetable.ts";

const PROBE = new URL("../../test/fixtures/db-apis/probe-8000105-2026-11-08/", import.meta.url);
const FRANKFURT = 8000105;
const PLACE = "00000000-0000-5000-8000-000008000105";
const POINT = "00000000-0000-5000-9000-000008000105";
const CATEGORY: Readonly<Record<string, string>> = {
  ICE: "hsr",
  IC: "ld",
  EC: "ld",
  ECE: "ld",
  FLX: "ld",
  RJ: "ld",
  RJX: "hsr",
  TGV: "hsr",
  NJ: "night",
  EN: "night",
};

interface ProbeLine {
  readonly endpoint: "plan" | "fchg";
  readonly startedAt: string;
  readonly file: string;
}

const lines: ProbeLine[] = readFileSync(new URL("requests.jsonl", PROBE), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as ProbeLine);

const payloads: StoredPayload[] = lines.map((line, index) => ({
  record: {
    source: `db-iris-${line.endpoint}-${FRANKFURT}`,
    observedAt: line.startedAt,
    object: {
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      key: line.file,
    },
  } as unknown as FetchRecord,
  payload: readFileSync(new URL(line.file, PROBE)),
}));

/** One single-stop run at Frankfurt per long distance train the probe's plans name, at its planned time. */
function probeTimetable(): Timetable {
  const trips = new Map<string, StaticTrip>();
  for (const line of lines.filter((item) => item.endpoint === "plan")) {
    const answer = parseIrisTimetable(
      readFileSync(new URL(line.file, PROBE)),
      FRANKFURT,
      Date.parse(line.startedAt),
    );
    for (const stop of answer.stops) {
      const key = parseIrisStopId(stop.id);
      const category = CATEGORY[stop.tripLabel?.category ?? ""];
      const planned = stop.departure?.plannedTime ?? stop.arrival?.plannedTime ?? null;
      if (!key || !category || !stop.tripLabel?.number || planned === null) continue;
      const seconds = (Date.parse(planned) - serviceInstant(key.startDate, 0)) / 1000;
      trips.set(key.tripId, {
        tripKey: key.tripId,
        routeKey: "R",
        serviceKey: key.startDate,
        operatorId: "op",
        trainNumber: stop.tripLabel.number,
        categoryCode: category,
        isForeign: false,
        stopPoints: [POINT],
        stopPlaces: [PLACE],
        stopSequences: Int32Array.from([0]),
        arrivals: Int32Array.from([seconds]),
        departures: Int32Array.from([seconds]),
      });
    }
  }
  const days = new Set([...trips.values()].map((trip) => trip.serviceKey));
  return new Timetable({
    feedVersionId: 1,
    feedVersion: "probe",
    publishedOn: "2026-11-01",
    trips: [...trips.values()],
    calendars: new Map(
      [...days].map((day) => [
        day,
        { weekdays: 0, startDate: day, endDate: day, added: new Set([day]), removed: new Set() },
      ]),
    ),
    routes: new Map(),
    stopPoints: new Map([[POINT, { stopPlaceId: PLACE, platform: null }]]),
    stopPlaces: new Map([
      [
        PLACE,
        {
          name: "Frankfurt",
          eva: FRANKFURT,
          uic: null,
          lon: null,
          lat: null,
          countryCode: "DE",
          dhid: null,
        },
      ],
    ]),
    delfiStopPoints: new Map(),
    delfiStopPlaces: new Map(),
  });
}

class SettableClock implements Clock {
  at = 0;
  now(): number {
    return this.at;
  }
  async sleep(): Promise<void> {}
}

/**
 * Hands the probe's answers on as the live follower might: each one some seconds after it was asked
 * for (0 to `lagMs`, seeded), in the order they become readable, the processing clock at that time;
 * flushes after each one as the live run does. Returns the rebuilds and the answers they folded again.
 */
async function deliver(
  holdMs: number,
  seed: number,
  lagMs: number,
): Promise<{ rebuilds: number; refolded: number; matched: number; sink: MemorySink }> {
  const random = seededRandom(seed);
  const byId = new Map(payloads.map((item) => [item.record.object?.id, item]));
  const clock = new SettableClock();
  const sink = new MemorySink();
  const processor = new Processor(
    {} as Kysely<DB>,
    new Matcher([probeTimetable()]),
    clock,
    async function* (records) {
      for (const record of [...records].sort(compareRecords)) {
        const item = byId.get(record.object?.id);
        if (item) yield item;
      }
    },
    { sink, irisHoldMs: holdMs },
  );
  const arrivals = payloads
    .map((item) => ({ item, at: Date.parse(item.record.observedAt) + random() * lagMs }))
    .sort((a, b) => a.at - b.at);
  let refolded = 0;
  const step = async () => {
    await processor.flush();
    for (const report of processor.takeRebuildReports()) refolded += report.refoldedPayloads;
  };
  for (const { item, at } of arrivals) {
    clock.at = at;
    await processor.processBatch([item]);
    await step();
  }
  clock.at = Date.parse(payloads.at(-1)?.record.observedAt ?? "") + 120_000;
  await step();
  const coverage = processor.coverage.get("db-iris");
  return {
    rebuilds: coverage?.rebuilds ?? 0,
    refolded,
    matched: coverage?.matched.size ?? 0,
    sink,
  };
}

const total = (runs: readonly { rebuilds: number; refolded: number }[]) => ({
  rebuilds: runs.reduce((sum, run) => sum + run.rebuilds, 0),
  refolded: runs.reduce((sum, run) => sum + run.refolded, 0),
});

/** Rows of the fold proper; sightings and backlog keep when a late answer was first read. */
const FOLDED = ["trip_instance", "stop_event", "stop_event_forecast", "segment_obs"] as const;

describe("IRIS answers held before folding", () => {
  it("folds the probe's answers once, in order, when the follower reads them up to 20 s late", async () => {
    const seeds = [1, 2, 3, 4, 5];
    const ordered = await deliver(0, 1, 0);
    const without = await Promise.all(seeds.map((seed) => deliver(0, seed, 20_000)));
    const held = await Promise.all(seeds.map((seed) => deliver(IRIS_HOLD_MS, seed, 20_000)));
    process.stdout.write(
      `probe replay, 5 seeds, lag up to 20 s: without hold ${JSON.stringify(total(without))}, ` +
        `held ${IRIS_HOLD_MS} ms ${JSON.stringify(total(held))}, matched ${ordered.matched}\n`,
    );
    expect(ordered).toMatchObject({ rebuilds: 0, refolded: 0 });
    expect(ordered.matched).toBeGreaterThan(40);
    expect(total(without).rebuilds).toBeGreaterThan(0);
    expect(total(held)).toEqual({ rebuilds: 0, refolded: 0 });
    const all = FOLD_TABLES.filter((name) => name !== "event");
    for (const run of held)
      expect(run.sink.fingerprint(all)).toEqual(ordered.sink.fingerprint(all));
    for (const run of without) {
      expect(run.sink.fingerprint(FOLDED)).toEqual(ordered.sink.fingerprint(FOLDED));
    }
  }, 120_000);
});
