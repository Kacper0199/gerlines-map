import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "@gerlines/db";
import { serviceInstant } from "@gerlines/schema/service-day";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import { bytesField, intField, textField } from "../gtfs-rt/encode.test-support.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { DELFI_MOBILITHEK_RT, DELFI_RT } from "./adapters.ts";
import { FEED_OVER_LIMIT, FEED_REJECTED, refusal } from "./check.ts";
import { readCheckpoint } from "./checkpoint.ts";
import { DataClock } from "./data-clock.ts";
import { RecordingFollower } from "./follow.ts";
import { LiveRunner } from "./live.ts";
import { Matcher } from "./matcher.ts";
import { FOLD_TABLES, MemorySink } from "./memory-sink.test-support.ts";
import type { StoredPayload } from "./payload-stream.ts";
import { compareRecords } from "./payload-stream.ts";
import {
  FALLBACK_HOLD_MS,
  Processor,
  type ProcessorSnapshot,
  snapshotFromLines,
} from "./processor.ts";
import { seededRandom, shuffle } from "./replay.ts";
import { type StaticTrip, Timetable } from "./timetable.ts";

const DAY = "2026-10-27";
const NEXT_DAY = "2026-10-28";
const H = 3600;
const place = (n: number) => `00000000-0000-5000-8000-${String(n).padStart(12, "0")}`;
const point = (n: number) => `00000000-0000-5000-9000-${String(n).padStart(12, "0")}`;
const dhid = (n: number) => `de:11000:${n}::1`;

function table(
  feedVersionId: number,
  feedVersion: string,
  publishedOn: string,
  tripKey: string,
  places: number[],
  start: number,
): Timetable {
  const trip: StaticTrip = {
    tripKey,
    routeKey: "R_106",
    serviceKey: "S",
    operatorId: "op",
    trainNumber: tripKey.replace(/\D/g, ""),
    categoryCode: "reg",
    isForeign: false,
    stopPoints: places.map(point),
    stopPlaces: places.map(place),
    stopSequences: Int32Array.from(places, (_, index) => index),
    arrivals: Int32Array.from(places, (_, index) => start + index * 600),
    departures: Int32Array.from(places, (_, index) => start + index * 600),
  };
  const all = [1, 2, 3, 4];
  return new Timetable({
    feedVersionId,
    feedVersion,
    publishedOn,
    trips: [trip],
    calendars: new Map([
      [
        "S",
        {
          weekdays: 127,
          startDate: "2026-10-01",
          endDate: "2026-12-01",
          added: new Set(),
          removed: new Set(),
        },
      ],
    ]),
    routes: new Map([["R_106", { operatorId: "op", categoryCode: "reg" }]]),
    stopPoints: new Map(all.map((n) => [point(n), { stopPlaceId: place(n), platform: null }])),
    stopPlaces: new Map(
      all.map((n) => [
        place(n),
        {
          name: `p${n}`,
          eva: null,
          uic: null,
          lon: null,
          lat: null,
          countryCode: "DE",
          dhid: null,
        },
      ]),
    ),
    delfiStopPoints: new Map(all.map((n) => [dhid(n), point(n)])),
    delfiStopPlaces: new Map(),
  });
}

const OLD = table(1, "2026-10-17T14:46:34", "2026-10-19", "T1", [1, 2, 3], 12 * H);
const NEW = table(2, "2026-10-24T14:58:08", "2026-10-26", "N7", [3, 4], 15 * H);

interface FeedSpec {
  readonly version?: string;
  readonly tripId?: string;
  readonly places?: number[];
  readonly start?: number;
  readonly date?: string;
  readonly delay?: number;
  readonly header?: number;
}

/** A DELFI trip update of one trip, every stop `delay` seconds late, naming a feed version. */
function delfiFeed(spec: FeedSpec = {}): Uint8Array {
  const date = spec.date ?? DAY;
  const delay = spec.delay ?? 60;
  const start = spec.start ?? 12 * H;
  const tripId = spec.tripId ?? "T1";
  const stops = (spec.places ?? [1, 2, 3]).map((n, index) => {
    const time = serviceInstant(date, start + index * 600) / 1000 + delay;
    const event = [...intField(1, delay), ...intField(2, time)];
    return bytesField(2, [
      ...intField(1, index),
      ...bytesField(2, event),
      ...bytesField(3, event),
      ...textField(4, dhid(n)),
    ]);
  });
  const trip = [
    ...textField(1, tripId),
    ...textField(3, date.replaceAll("-", "")),
    ...textField(5, "r_106"),
  ];
  const update = [...bytesField(1, trip), ...stops.flat()];
  const entity = [...textField(1, tripId), ...bytesField(3, update)];
  const header = [
    ...textField(1, "2.0"),
    ...intField(3, spec.header ?? 1_800_000_000),
    ...textField(4, spec.version ?? (OLD.data.feedVersion as string)),
  ];
  return Uint8Array.from([...bytesField(1, header), ...bytesField(2, entity)]);
}

/** A DELFI service alert naming trip T1 on `DAY`, and the stop place of `stops` when given. */
function alertFeed(text: string, stops: number[] = []): Uint8Array {
  const tripSelector = bytesField(4, [...textField(1, "T1"), ...textField(3, "20261027")]);
  const selectors = [
    bytesField(5, tripSelector),
    ...stops.map((n) => bytesField(5, textField(5, dhid(n)))),
  ];
  const headerText = bytesField(10, bytesField(1, [...textField(1, text), ...textField(2, "de")]));
  const alert = [...selectors.flat(), ...intField(6, 1), ...intField(7, 2), ...headerText];
  const entity = [...textField(1, "A1"), ...bytesField(5, alert)];
  const header = [
    ...textField(1, "2.0"),
    ...intField(3, 1_800_000_000),
    ...textField(4, OLD.data.feedVersion as string),
  ];
  return Uint8Array.from([...bytesField(1, header), ...bytesField(2, entity)]);
}

let nextId = 1;

function stored(
  observedAt: string,
  payload: Uint8Array,
  source = DELFI_RT,
  header: number | null = null,
): StoredPayload {
  const id = nextId++;
  const record = {
    source,
    observedAt,
    feed:
      header === null
        ? undefined
        : { ok: true, headerTimestamp: header, gtfsRealtimeVersion: "2.0" },
    object: { id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, key: `k${id}` },
  } as unknown as FetchRecord;
  return { record, payload: Buffer.from(payload) };
}

class TestClock implements Clock {
  value: number;
  constructor(iso: string) {
    this.value = Date.parse(iso);
  }
  now(): number {
    return this.value;
  }
  async sleep(): Promise<void> {}
}

function processorWith(
  matcher: Matcher,
  sink: MemorySink,
  payloads: readonly StoredPayload[],
  clock: Clock = new TestClock("2026-10-29T12:00:00Z"),
  sources?: readonly string[],
): Processor {
  const byId = new Map(payloads.map((item) => [item.record.object?.id, item]));
  return new Processor(
    {} as Kysely<DB>,
    matcher,
    clock,
    async function* (records) {
      for (const record of [...records].sort(compareRecords)) {
        const item = byId.get(record.object?.id);
        if (item) yield item;
      }
    },
    { sink, ...(sources ? { sources } : {}) },
  );
}

const rebuiltDays = (sink: MemorySink) =>
  sink.rebuilds.map(({ source, days }) => ({ source, days }));

const byTime = (a: StoredPayload, b: StoredPayload) =>
  Date.parse(a.record.observedAt) - Date.parse(b.record.observedAt);

async function inOrder(payloads: readonly StoredPayload[]): Promise<MemorySink> {
  const sink = new MemorySink();
  const processor = processorWith(new Matcher([OLD]), sink, payloads);
  for (const item of [...payloads].sort(byTime)) await processor.processBatch([item]);
  await processor.flush();
  return sink;
}

/** Two service days of train T1; the second day's 12:00 payload is the one that comes late. */
function twoDays(): { early: StoredPayload[]; late: StoredPayload; after: StoredPayload } {
  const day = (date: string, minute: string, delay: number) =>
    stored(`${date}T${minute}:00Z`, delfiFeed({ date, delay }));
  const early = [
    day(DAY, "10:55", 60),
    day(DAY, "11:05", 120),
    day(DAY, "11:15", 120),
    day(NEXT_DAY, "10:55", 60),
    day(NEXT_DAY, "11:05", 180),
    day(NEXT_DAY, "11:15", 180),
  ];
  return { early, late: day(NEXT_DAY, "11:00", 300), after: day(NEXT_DAY, "11:25", 240) };
}

describe("Processor", () => {
  it("folds the service days a version names again once that version is loaded", async () => {
    const payload = stored(
      "2026-10-27T14:10:00Z",
      delfiFeed({
        version: NEW.data.feedVersion as string,
        tripId: "N7",
        places: [3, 4],
        start: 15 * H,
      }),
    );
    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, [payload]);
    await processor.processBatch([payload]);
    expect([...sink.tables.match_backlog.values()].map((row) => row.reason)).toEqual([
      "feed_version_not_loaded",
    ]);
    expect(sink.tables.trip_instance.size).toBe(0);

    processor.timetableLoaded(NEW);
    await processor.flush();
    expect(rebuiltDays(sink)).toEqual([{ source: DELFI_RT, days: [DAY] }]);
    expect(
      [...sink.tables.trip_instance.values()].map((row) => [row.tripKey, row.feedVersionId]),
    ).toEqual([["N7", 2]]);
    expect(sink.tables.stop_event_forecast.size).toBeGreaterThan(0);
  });

  it("keeps what named a missing version across a checkpoint restore", async () => {
    const payload = stored(
      "2026-10-27T14:10:00Z",
      delfiFeed({
        version: NEW.data.feedVersion as string,
        tripId: "N7",
        places: [3, 4],
        start: 15 * H,
      }),
    );
    const sink = new MemorySink();
    const first = processorWith(new Matcher([OLD]), sink, [payload]);
    await first.processBatch([payload]);
    const lines = JSON.parse(JSON.stringify([...first.checkpointLines("gerlines_test")]));
    const snapshot = snapshotFromLines(lines) as ProcessorSnapshot;
    expect(snapshot.database).toBe("gerlines_test");

    const second = processorWith(new Matcher([OLD]), sink, [payload]);
    expect(
      second.restore(snapshot, (id) =>
        id === payload.record.object?.id ? payload.record : undefined,
      ),
    ).toBe(true);
    expect(second.versionLastNamed.get(NEW.data.feedVersion as string)).toBe(
      Date.parse("2026-10-27T14:10:00Z"),
    );
    second.timetableLoaded(NEW);
    expect(second.settled()).toBe(false);
    await second.flush();
    expect(rebuiltDays(sink)).toEqual([{ source: DELFI_RT, days: [DAY] }]);
    expect(
      [...sink.tables.trip_instance.values()].map((row) => [row.tripKey, row.feedVersionId]),
    ).toEqual([["N7", 2]]);
  });

  it("matches a payload of a version not loaded yet by stops and times meanwhile", async () => {
    const payload = stored(
      "2026-10-27T11:10:00Z",
      delfiFeed({ version: "2026-10-31T00:00:00", tripId: "Z1" }),
    );
    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, [payload]);
    await processor.processBatch([payload]);
    expect(sink.logs[0]?.counts["matched:stops_and_times"]).toBe(1);
    expect(
      [...sink.tables.trip_instance.values()].map((row) => [row.tripKey, row.feedVersionId]),
    ).toEqual([["T1", 1]]);
  });

  it("records a payload that fails as an error and goes on with the next", async () => {
    const first = stored("2026-10-27T11:10:00Z", delfiFeed());
    const second = stored("2026-10-27T11:11:00Z", delfiFeed());
    const sink = new MemorySink();
    sink.failWrites = 1;
    const processor = processorWith(new Matcher([OLD]), sink, [first, second]);
    await processor.processBatch([first, second]);
    expect(
      sink.logs.map((log) => [log?.rawObjectId === first.record.object?.id, log?.error]),
    ).toEqual([
      [true, 'write failed: invalid byte sequence for encoding "UTF8": 0x00'],
      [false, null],
    ]);
    expect(processor.coverageOf(DELFI_RT).failedPayloads).toBe(1);
  });

  it("keeps the feed versions of sources with their own ids out of the version book", async () => {
    const swiss = stored(
      "2026-10-27T11:10:00Z",
      delfiFeed({ version: "20261021" }),
      "ch-otd-gtfs-rt",
    );
    const delfi = stored("2026-10-27T11:11:00Z", delfiFeed({ version: "20261024" }));
    const processor = processorWith(new Matcher([OLD]), new MemorySink(), [swiss, delfi]);
    await processor.processBatch([swiss, delfi]);
    expect(processor.versionLastNamed.has("20261021")).toBe(false);
    expect(processor.versionLastNamed.has("20261024")).toBe(true);
  });

  it("keeps refusals for our own decode limits apart from broken source feeds", () => {
    expect(refusal("feed has more than 200000 entities")).toBe(
      `${FEED_OVER_LIMIT}feed has more than 200000 entities`,
    );
    expect(refusal("string longer than 1048576 bytes")).toMatch(FEED_OVER_LIMIT);
    expect(refusal("stop time updates: more than 500")).toMatch(FEED_OVER_LIMIT);
    expect(refusal("varint longer than 10 bytes")).toBe(
      `${FEED_REJECTED}varint longer than 10 bytes`,
    );
    expect(refusal("feed has no header")).toBe(`${FEED_REJECTED}feed has no header`);
  });

  it("marks a payload the adapter refuses as a defect of the source feed", async () => {
    const empty = stored("2026-10-27T11:10:00Z", new Uint8Array());
    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, [empty]);
    await processor.processBatch([empty]);
    expect(sink.logs[0]?.error).toBe(`${FEED_REJECTED}feed has no header`);
    expect(processor.coverageOf(DELFI_RT).failedPayloads).toBe(1);
  });

  it("counts implausible early delays and reordered times per payload", async () => {
    const payload = stored("2026-10-27T11:10:00Z", delfiFeed({ delay: -10_800 }));
    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, [payload]);
    await processor.processBatch([payload]);
    expect(sink.logs[0]?.counts.implausible_early_delay).toBe(3);
    expect(processor.coverageOf(DELFI_RT).implausibleDelays).toBe(3);
  });

  it("reads the late payloads of one flush back in a single pass", async () => {
    const { early, late, after } = twoDays();
    const second = stored(`${NEXT_DAY}T11:10:00Z`, delfiFeed({ date: NEXT_DAY, delay: 200 }));
    const all = [...early, late, second, after];
    const byId = new Map(all.map((item) => [item.record.object?.id, item]));
    const reads: number[] = [];
    const processor = new Processor(
      {} as Kysely<DB>,
      new Matcher([OLD]),
      new TestClock("2026-10-29T12:00:00Z"),
      async function* (records) {
        reads.push(records.length);
        for (const record of [...records].sort(compareRecords)) {
          const item = byId.get(record.object?.id);
          if (item) yield item;
        }
      },
      { sink: new MemorySink() },
    );
    for (const item of early) await processor.processBatch([item]);
    await processor.processBatch([late]);
    await processor.processBatch([second]);
    await processor.flush();
    expect(reads[0]).toBe(2);
    expect(processor.coverageOf(DELFI_RT).rebuilds).toBe(1);
  });

  it("rebuilds only the service day a late payload touches and keeps the outbox", async () => {
    const { early, late, after } = twoDays();
    const all = [...early, late, after];
    const expected = await inOrder(all);

    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, all);
    for (const item of early) await processor.processBatch([item]);
    const firstDayRows = [...sink.tables.stop_event.values()].filter(
      (row) => row.serviceDate === DAY,
    );
    const eventsBefore = new Set(sink.tables.event.keys());
    expect(processor.settled()).toBe(true);
    await processor.processBatch([late]);
    expect(processor.settled()).toBe(false);
    await processor.flush();
    expect(processor.settled()).toBe(true);
    await processor.processBatch([after]);
    await processor.flush();

    expect(rebuiltDays(sink)).toEqual([{ source: DELFI_RT, days: [NEXT_DAY] }]);
    expect([...sink.tables.stop_event.values()].filter((row) => row.serviceDate === DAY)).toEqual(
      firstDayRows,
    );
    const folded = ["stop_event", "stop_event_forecast", "segment_obs", "trip_instance"] as const;
    expect(sink.fingerprint(folded)).toBe(expected.fingerprint(folded));
    for (const key of eventsBefore) expect(sink.tables.event.has(key)).toBe(true);
    for (const key of expected.tables.event.keys()) expect(sink.tables.event.has(key)).toBe(true);
    expect(sink.tables.rt_payload.get(late.record.object?.id ?? "")?.counts).toMatchObject({
      "matched:trip_id": 1,
    });
  });

  it("runs a rebuild in slices beside the live tail and swaps it in once caught up", async () => {
    const { early, late, after } = twoDays();
    const later = stored(`${NEXT_DAY}T11:35:00Z`, delfiFeed({ date: NEXT_DAY, delay: 420 }));
    const all = [...early, late, after, later];
    const expected = await inOrder(all);

    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, all);
    for (const item of early) await processor.processBatch([item]);
    await processor.processBatch([late]);
    await processor.flush({ budgetPayloads: 1 });
    expect(processor.rebuildProgress()).toMatchObject({ source: DELFI_RT, phase: "refold" });
    await processor.processBatch([after]);
    const liveRows = [...sink.tables.stop_event_forecast.values()].filter(
      (row) => row.rawObjectId === after.record.object?.id,
    );
    expect(liveRows.length).toBeGreaterThan(0);
    expect(sink.rebuilds).toHaveLength(0);
    await processor.flush({ budgetPayloads: 1 });
    await processor.processBatch([later]);
    for (let step = 0; step < 20 && processor.rebuilding(); step += 1) {
      await processor.flush({ budgetPayloads: 1 });
    }
    expect(processor.rebuilding()).toBe(false);
    expect(rebuiltDays(sink)).toEqual([{ source: DELFI_RT, days: [NEXT_DAY] }]);
    const [report] = processor.takeRebuildReports();
    expect(report).toMatchObject({ source: DELFI_RT, latePayloads: 1, refoldedPayloads: 6 });
    const cut = Date.parse(report?.cut ?? "");
    expect(cut).toBe(Date.parse(`${NEXT_DAY}T10:55:00Z`));
    for (const batch of sink.staged) {
      for (const row of batch.forecasts) expect(row.observedAt).toBeGreaterThanOrEqual(cut);
    }
    const folded = ["stop_event", "stop_event_forecast", "segment_obs", "trip_instance"] as const;
    expect(sink.fingerprint(folded)).toBe(expected.fingerprint(folded));
  });

  it("stamps late payloads' log lines with the swap's time, after every line the tail wrote", async () => {
    const { early, late, after } = twoDays();
    const all = [...early, late, after];
    const byId = new Map(all.map((item) => [item.record.object?.id, item]));
    const wall = new TestClock("2026-11-05T20:00:00Z");
    const sink = new MemorySink();
    const processor = new Processor(
      {} as Kysely<DB>,
      new Matcher([OLD]),
      new TestClock("2026-10-29T12:00:00Z"),
      async function* (records) {
        for (const record of [...records].sort(compareRecords)) {
          const item = byId.get(record.object?.id);
          if (item) yield item;
        }
      },
      { sink, wallClock: wall },
    );
    for (const item of early) await processor.processBatch([item]);
    await processor.processBatch([late]);
    await processor.flush({ budgetPayloads: 2 });
    wall.value += 60_000;
    await processor.processBatch([after]);
    const tailStamp = wall.value;
    wall.value += 60_000;
    await processor.flush();
    const line = sink.logs.find((log) => log?.rawObjectId === late.record.object?.id);
    expect(line?.processedAt).toBe(wall.value);
    expect(line?.processedAt).toBeGreaterThan(tailStamp);
  });

  it("starts a rebuild again when its staged rows were lost before the swap", async () => {
    const { early, late, after } = twoDays();
    const all = [...early, late, after];
    const expected = await inOrder(all);
    const sink = new MemorySink();
    sink.loseStaging = 1;
    const processor = processorWith(new Matcher([OLD]), sink, all);
    for (const item of [...early, after]) await processor.processBatch([item]);
    await processor.processBatch([late]);
    await processor.flush();
    const [lost, swapped] = processor.takeRebuildReports();
    expect(lost?.counts).toBeNull();
    expect(swapped?.counts).not.toBeNull();
    expect(processor.settled()).toBe(true);
    const folded = ["stop_event", "stop_event_forecast", "segment_obs", "trip_instance"] as const;
    expect(sink.fingerprint(folded)).toBe(expected.fingerprint(folded));
    expect(sink.tables.rt_payload.has(late.record.object?.id ?? "")).toBe(true);
  });

  it("starts a rebuild cut short by a restart again from the checkpoint", async () => {
    const { early, late, after } = twoDays();
    const all = [...early, late, after];
    const expected = await inOrder(all);
    const sink = new MemorySink();
    const first = processorWith(new Matcher([OLD]), sink, all);
    for (const item of [...early, after]) await first.processBatch([item]);
    await first.processBatch([late]);
    await first.flush({ budgetPayloads: 2 });
    expect(first.rebuildProgress()).not.toBeNull();
    const lines = JSON.parse(JSON.stringify([...first.checkpointLines("gerlines_test")]));
    const snapshot = snapshotFromLines(lines) as ProcessorSnapshot;
    expect(snapshot.sources[0]?.late).toEqual([late.record.object?.id]);

    const second = processorWith(new Matcher([OLD]), sink, all);
    const byId = new Map(all.map((item) => [item.record.object?.id, item.record]));
    expect(second.restore(snapshot, (id) => byId.get(id))).toBe(true);
    expect(second.rebuilding()).toBe(true);
    await second.flush();
    expect(second.settled()).toBe(true);
    const folded = ["stop_event", "stop_event_forecast", "segment_obs", "trip_instance"] as const;
    expect(sink.fingerprint(folded)).toBe(expected.fingerprint(folded));
    expect(sink.tables.rt_payload.has(late.record.object?.id ?? "")).toBe(true);
  });

  it("writes when a source last named an instance at most once a minute of payload time", async () => {
    const at = (time: string) => `${DAY}T${time}Z`;
    const payloads = ["10:00:00", "10:00:20", "10:00:50", "10:01:10"].map((time, index) =>
      stored(at(time), delfiFeed({ delay: 60 + index })),
    );
    const sink = new MemorySink();
    let written = 0;
    const counting = Object.assign(Object.create(sink) as MemorySink, {
      write: (
        batch: Parameters<MemorySink["write"]>[0],
        log: Parameters<MemorySink["write"]>[1],
      ) => {
        written += batch.instanceSeen.length;
        return sink.write(batch, log);
      },
    });
    const processor = processorWith(new Matcher([OLD]), counting, payloads);
    for (const item of payloads) await processor.processBatch([item]);
    await processor.flush();
    expect(written).toBe(2);
    const [row] = [...sink.tables.trip_instance_source.values()];
    expect(row?.first).toBe(Date.parse(at("10:00:00")));
  });

  it("converges to the in-order rows whatever order and duplicates the payloads arrive in", async () => {
    const { early, late, after } = twoDays();
    const all = [...early, late, after];
    const expected = await inOrder(all);
    const random = seededRandom(7);
    for (let round = 0; round < 30; round += 1) {
      const sink = new MemorySink();
      const processor = processorWith(new Matcher([OLD]), sink, all);
      const deliveries = shuffle([...all, ...all.slice(0, 3)], random);
      for (let start = 0; start < deliveries.length; start += 3) {
        await processor.processBatch(deliveries.slice(start, start + 3));
        if (random() < 0.5) await processor.flush();
        else await processor.flush({ budgetPayloads: 1 + Math.floor(random() * 3) });
      }
      await processor.flush();
      const folded = ["stop_event", "stop_event_forecast", "segment_obs", "trip_instance"] as const;
      expect(sink.fingerprint(folded)).toBe(expected.fingerprint(folded));
      expect([...sink.tables.rt_payload.keys()].sort()).toEqual(
        [...expected.tables.rt_payload.keys()].sort(),
      );
    }
  });

  it("checkpoints while a mirror payload is held and ends equal after a restore", async () => {
    const header = (minute: number) => 1_793_300_000 + minute * 60;
    const at = (minute: number, second: number) =>
      new Date(Date.parse("2026-10-27T11:00:00Z") + minute * 60_000 + second * 1000).toISOString();
    const payloads: StoredPayload[] = [];
    for (let minute = 0; minute < 12; minute += 1) {
      const feed = delfiFeed({ delay: 60 + minute * 10, header: header(minute) });
      payloads.push(stored(at(minute, 5), feed, DELFI_MOBILITHEK_RT, header(minute)));
      payloads.push(stored(at(minute, 6), feed, DELFI_RT, header(minute)));
    }
    const sources = [DELFI_MOBILITHEK_RT, DELFI_RT];
    const deliver = async (processor: Processor, clock: TestClock, items: StoredPayload[]) => {
      for (const item of items) {
        clock.value = Date.parse(item.record.observedAt) + 1000;
        await processor.processBatch([item]);
        await processor.flush({ budgetMs: 0 });
      }
    };
    const finish = async (processor: Processor, clock: TestClock) => {
      clock.value = Date.parse(at(20, 0));
      await processor.flush({ releaseAll: true });
    };
    const whole = new MemorySink();
    const wholeClock = new TestClock(at(0, 0));
    const uninterrupted = processorWith(new Matcher([OLD]), whole, payloads, wholeClock, sources);
    await deliver(uninterrupted, wholeClock, payloads);
    await finish(uninterrupted, wholeClock);

    const sink = new MemorySink();
    const firstClock = new TestClock(at(0, 0));
    const first = processorWith(new Matcher([OLD]), sink, payloads, firstClock, sources);
    await deliver(first, firstClock, payloads.slice(0, 13));
    expect(first.holding()).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "gerlines-held-"));
    try {
      const runner = new LiveRunner({
        db: {} as Kysely<DB>,
        root,
        processor: first,
        follower: new RecordingFollower(root, [], firstClock.now()),
        clock: firstClock,
        logger: { log: () => {} },
        index: async (records) => ({ indexed: [...records], unregistered: [] }),
        checkpointPath: join(root, "live.checkpoint.gz"),
        horizonMs: 48 * 3_600_000,
      });
      await runner.checkpoint();
      const snapshot = await readCheckpoint(join(root, "live.checkpoint.gz"));
      expect(snapshot).toBeDefined();
      const secondClock = new TestClock(at(0, 0));
      const second = processorWith(new Matcher([OLD]), sink, payloads, secondClock, sources);
      const byId = new Map(payloads.map((item) => [item.record.object?.id, item.record]));
      expect(second.restore(snapshot as ProcessorSnapshot, (id) => byId.get(id))).toBe(true);
      await deliver(second, secondClock, payloads);
      await finish(second, secondClock);
      expect(second.coverageOf(DELFI_RT).rebuilds).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const folded = FOLD_TABLES.filter((name) => name !== "event");
    expect(sink.fingerprint(folded)).toBe(whole.fingerprint(folded));
  });

  it("folds each DELFI snapshot once, preferring the Mobilithek copy over the mirror", async () => {
    const header = (minute: number) => 1_793_300_000 + minute * 60;
    const minute = (n: number, second: number) =>
      `2026-10-27T11:${String(n).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;
    const mob = (n: number, delay: number) =>
      stored(minute(n, 5), delfiFeed({ delay, header: header(n) }), DELFI_MOBILITHEK_RT, header(n));
    const mirror = (n: number, delay: number) =>
      stored(minute(n, 20), delfiFeed({ delay, header: header(n) }), DELFI_RT, header(n));
    const payloads = [
      mob(0, 60),
      mirror(0, 60),
      mob(1, 90),
      mirror(1, 90),
      mirror(2, 120),
      mob(4, 150),
      stored(minute(5, 1), delfiFeed({ delay: 180, header: header(5) }), DELFI_RT, header(5)),
      stored(
        minute(5, 30),
        delfiFeed({ delay: 180, header: header(5) }),
        DELFI_MOBILITHEK_RT,
        header(5),
      ),
    ];
    const run = async (order: readonly StoredPayload[], live: boolean) => {
      const sink = new MemorySink();
      const clock = new TestClock(minute(0, 0));
      const processor = processorWith(new Matcher([OLD]), sink, payloads, clock, [
        DELFI_MOBILITHEK_RT,
        DELFI_RT,
      ]);
      for (const item of order) {
        if (live) clock.value = Date.parse(item.record.observedAt) + 1000;
        await processor.processBatch([item]);
        if (live) await processor.flush();
      }
      clock.value = Date.parse(minute(10, 0));
      await processor.flush({ releaseAll: true });
      return { sink, processor };
    };
    const { sink, processor } = await run(payloads, true);
    const counts = (item: StoredPayload) =>
      sink.tables.rt_payload.get(item.record.object?.id ?? "")?.counts;
    expect(counts(payloads[1] as StoredPayload)).toEqual({ skipped_snapshot_already_folded: 1 });
    expect(counts(payloads[3] as StoredPayload)).toEqual({ skipped_snapshot_already_folded: 1 });
    expect(counts(payloads[0] as StoredPayload)).toMatchObject({ "matched:trip_id": 1 });
    expect(counts(payloads[4] as StoredPayload)).toMatchObject({ "matched:trip_id": 1 });
    expect(counts(payloads[6] as StoredPayload)).toEqual({ skipped_snapshot_already_folded: 1 });
    expect(counts(payloads[7] as StoredPayload)).toMatchObject({ "matched:trip_id": 1 });
    expect(processor.coverageOf(DELFI_RT).skipped).toBe(3);
    expect(processor.coverageOf(DELFI_RT).rebuilds).toBe(0);
    const sources = new Set([...sink.tables.stop_event.values()].map((row) => row.sourceId));
    expect(sources).toEqual(new Set([DELFI_RT]));
    const mirrorIds = new Set([1, 3].map((index) => payloads[index]?.record.object?.id));
    for (const row of sink.tables.stop_event_forecast.values()) {
      expect(mirrorIds.has(row.rawObjectId as string)).toBe(false);
    }
    expect(sink.tables.rt_payload.get(payloads[0]?.record.object?.id ?? "")?.foldSourceId).toBe(
      DELFI_RT,
    );
    expect(sink.tables.rt_payload.get(payloads[0]?.record.object?.id ?? "")?.sourceId).toBe(
      DELFI_MOBILITHEK_RT,
    );

    const reversed = await run([...payloads].reverse(), false);
    const folded = FOLD_TABLES.filter((name) => name !== "event");
    expect(reversed.sink.fingerprint(folded)).toBe(sink.fingerprint(folded));
    for (const key of sink.tables.event.keys())
      expect(reversed.sink.tables.event.has(key)).toBe(true);
    expect(FALLBACK_HOLD_MS).toBe(60_000);

    const lagging = new DataClock(new TestClock("2026-10-27T13:00:00Z"), Date.parse(minute(0, 0)));
    const behind = processorWith(new Matcher([OLD]), new MemorySink(), payloads, lagging, [
      DELFI_MOBILITHEK_RT,
      DELFI_RT,
    ]);
    for (const item of payloads) {
      lagging.observe(Date.parse(item.record.observedAt));
      await behind.processBatch([item]);
      await behind.flush();
    }
    await behind.flush({ releaseAll: true });
    expect(behind.coverageOf(DELFI_RT).rebuilds).toBe(0);
    expect(behind.coverageOf(DELFI_RT).skipped).toBe(3);
  });

  it("goes on from a checkpoint with the rows an uninterrupted run writes", async () => {
    const { early, late, after } = twoDays();
    const all = [...early, late, after].sort(byTime);
    const expected = await inOrder(all);
    const sink = new MemorySink();
    const first = processorWith(new Matcher([OLD]), sink, all);
    for (const item of all.slice(0, 4)) await first.processBatch([item]);
    const snapshot = JSON.parse(JSON.stringify(first.snapshot())) as ProcessorSnapshot;
    await first.processBatch([all[4] as StoredPayload]);
    const records = new Map(all.map((item) => [item.record.object?.id ?? "", item.record]));
    const second = processorWith(new Matcher([OLD]), sink, all);
    expect(second.restore(snapshot, (id) => records.get(id))).toBe(true);
    for (const item of all.slice(4)) await second.processBatch([item]);
    await second.flush();
    expect(sink.fingerprint(["stop_event", "stop_event_forecast", "segment_obs", "event"])).toBe(
      expected.fingerprint(["stop_event", "stop_event_forecast", "segment_obs", "event"]),
    );
  });

  it("refuses a checkpoint taken with other feed versions loaded", () => {
    const first = processorWith(new Matcher([OLD]), new MemorySink(), []);
    const second = processorWith(new Matcher([OLD, NEW]), new MemorySink(), []);
    expect(second.restore(first.snapshot(), () => undefined)).toBe(false);
  });

  it("counts trips of a source without a static timetable instead of a backlog row each", async () => {
    const trip = [...textField(1, "ch-1"), ...textField(3, "20261027")];
    const stop = bytesField(2, [...intField(1, 1), ...textField(4, "Bern-A")]);
    const entity = [...textField(1, "ch-1"), ...bytesField(3, [...bytesField(1, trip), ...stop])];
    const feed = Uint8Array.from([
      ...bytesField(1, [...textField(1, "2.0"), ...intField(3, 1_800_000_000)]),
      ...bytesField(2, entity),
    ]);
    const payload = stored("2026-10-27T11:10:00Z", feed, "ch-otd-gtfs-rt");
    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, [payload]);
    await processor.processBatch([payload]);
    expect(sink.logs[0]?.counts["unmatched:no_static_for_source"]).toBe(1);
    expect(sink.tables.match_backlog.size).toBe(0);
  });

  it("stores an alert's message once and each trip and place it names as its scope", async () => {
    const first = stored("2026-10-27T11:10:00Z", alertFeed("Bauarbeiten"), "delfi-gtfs-sa");
    const second = stored("2026-10-27T11:15:00Z", alertFeed("Bauarbeiten", [2]), "delfi-gtfs-sa");
    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, [first, second]);
    await processor.processBatch([first]);
    await processor.processBatch([second]);
    expect(sink.tables.alert_message.size).toBe(1);
    const message = [...sink.tables.alert_message.values()][0];
    expect(message).toMatchObject({ alertKey: "A1", cause: 1, effect: 2, selectorCount: 1 });
    const scopes = [...sink.tables.alert_scope.values()];
    expect(scopes.map((row) => [row.tripInstanceId !== null, row.stopPlaceId])).toEqual([
      [true, null],
      [false, place(2)],
    ]);
    expect(sink.logs.flatMap((log) => (log ? [log.counts.alert] : []))).toEqual([1, 1]);
  });

  it("still counts the trips of a late payload whose day is too old to rebuild", async () => {
    const { early } = twoDays();
    const late = stored(`${DAY}T11:00:00Z`, delfiFeed({ date: DAY, delay: 300 }));
    const sink = new MemorySink();
    const processor = processorWith(new Matcher([OLD]), sink, [...early, late]);
    for (const item of early) await processor.processBatch([item]);
    processor.dropBefore(NEXT_DAY, Date.parse("2026-10-28T12:00:00Z"));
    await processor.processBatch([late]);
    await processor.flush();
    expect(sink.tables.rt_payload.get(late.record.object?.id ?? "")?.counts).toMatchObject({
      trip: 1,
      "matched:trip_id": 1,
      day_not_rebuilt: 1,
    });
  });

  it("forgets per-day state of days before the one it keeps from", async () => {
    const { early } = twoDays();
    const processor = processorWith(new Matcher([OLD]), new MemorySink(), early);
    for (const item of early) await processor.processBatch([item]);
    expect(processor.stats().instanceSeen).toBe(2);
    processor.dropBefore(NEXT_DAY, Date.parse("2026-10-28T12:00:00Z"));
    expect(processor.stats().instanceSeen).toBe(1);
    expect(processor.stats().evicted).toBe(0);
  });
});
