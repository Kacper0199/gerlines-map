import type { DB } from "@gerlines/db";
import { chooseSource, type SourceActivity, sourceRank } from "@gerlines/schema/source-priority";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { foldSourceOf } from "./adapters.ts";
import { sourcesArg } from "./args.ts";
import { Matcher } from "./matcher.ts";
import { FOLD_TABLES, MemorySink } from "./memory-sink.test-support.ts";
import { compareRecords, type StoredPayload } from "./payload-stream.ts";
import { type CheckpointLine, Processor, snapshotFromLines } from "./processor.ts";
import { type StaticTrip, Timetable } from "./timetable.ts";

const H = 3600;
const STUTTGART = 8000096;
const MANNHEIM = 8000244;
const FRANKFURT = 8000105;
const EVAS = [STUTTGART, MANNHEIM, FRANKFURT];
const place = (eva: number) => `00000000-0000-5000-8000-${String(eva).padStart(12, "0")}`;
const point = (eva: number) => `00000000-0000-5000-9000-${String(eva).padStart(12, "0")}`;
const TRIP_ID = "-2320340282101811304-2610252045";

/** ICE 990 on 2026-10-25: Stuttgart 22:41, Mannheim 23:33, Frankfurt 00:09 local, platform 9. */
const ICE: StaticTrip = {
  tripKey: "ICE990",
  routeKey: "R",
  serviceKey: "S",
  operatorId: "op",
  trainNumber: "990",
  categoryCode: "hsr",
  isForeign: false,
  stopPoints: EVAS.map(point),
  stopPlaces: EVAS.map(place),
  stopSequences: Int32Array.from([0, 1, 2]),
  arrivals: Int32Array.from([22 * H + 41 * 60, 23 * H + 31 * 60, 24 * H + 9 * 60]),
  departures: Int32Array.from([22 * H + 41 * 60, 23 * H + 33 * 60, 24 * H + 9 * 60]),
};

const TABLE = new Timetable({
  feedVersionId: 1,
  feedVersion: "2026-10-17T14:46:34",
  publishedOn: "2026-10-19",
  trips: [ICE],
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
  routes: new Map(),
  stopPoints: new Map(
    EVAS.map((eva) => [
      point(eva),
      { stopPlaceId: place(eva), platform: eva === FRANKFURT ? "9" : null },
    ]),
  ),
  stopPlaces: new Map(
    EVAS.map((eva) => [
      place(eva),
      { name: String(eva), eva, uic: null, lon: null, lat: null, countryCode: "DE", dhid: null },
    ]),
  ),
  delfiStopPoints: new Map(),
  delfiStopPlaces: new Map(),
});

const xml = (eva: number, body: string) =>
  `<timetable station="s${eva}" eva="${eva}">${body}</timetable>`;

const PLAN_FRANKFURT = xml(
  FRANKFURT,
  `<s id="${TRIP_ID}-7"><tl f="F" t="p" o="80" c="ICE" n="990"/><ar pt="2610260009" pp="9"/></s>`,
);
const PLAN_MANNHEIM = xml(
  MANNHEIM,
  `<s id="${TRIP_ID}-6"><tl f="F" t="p" o="80" c="ICE" n="990"/><ar pt="2610252331" pp="3"/><dp pt="2610252333" pp="3"/></s>`,
);
const change = (eva: number, index: number, body: string) =>
  xml(eva, `<s id="${TRIP_ID}-${index}" eva="${eva}">${body}</s>`);

let nextId = 1;

function stored(source: string, observedAt: string, body: string): StoredPayload {
  const id = nextId++;
  const record = {
    source,
    observedAt,
    object: { id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, key: `k${id}` },
  } as unknown as FetchRecord;
  return { record, payload: Buffer.from(body) };
}

class TestClock implements Clock {
  now(): number {
    return Date.parse("2026-10-26T01:00:00Z");
  }
  async sleep(): Promise<void> {}
}

function processorFor(sink: MemorySink, payloads: readonly StoredPayload[]): Processor {
  const byId = new Map(payloads.map((item) => [item.record.object?.id, item]));
  return new Processor(
    {} as Kysely<DB>,
    new Matcher([TABLE]),
    new TestClock(),
    async function* (records) {
      for (const record of [...records].sort(compareRecords)) {
        const item = byId.get(record.object?.id);
        if (item) yield item;
      }
    },
    { sink },
  );
}

async function fold(payloads: readonly StoredPayload[], order = payloads): Promise<MemorySink> {
  const sink = new MemorySink();
  const processor = processorFor(sink, payloads);
  for (const item of order) await processor.processBatch([item]);
  await processor.flush();
  return sink;
}

const frankfurtStop = (sink: MemorySink) =>
  [...sink.tables.stop_event.values()].find((row) => row.stopPlaceId === place(FRANKFURT));

describe("Processor with DB Timetables (IRIS) answers", () => {
  const plans = [
    stored("db-iris-plan-8000244", "2026-10-25T21:00:00Z", PLAN_MANNHEIM),
    stored("db-iris-plan-8000105", "2026-10-25T21:00:01Z", PLAN_FRANKFURT),
  ];

  it("folds every recorded IRIS answer under one logical source", () => {
    expect(foldSourceOf("db-iris-fchg-8000105")).toBe("db-iris");
    expect(foldSourceOf("db-iris-plan-8098160")).toBe("db-iris");
    expect(sourcesArg("db-iris,gtfsde-rt")).toContain("db-iris-fchg-8000152");
    expect(sourcesArg("db-iris,gtfsde-rt")).toContain("gtfsde-rt");
    expect(sourcesArg(undefined)).not.toContain("db-iris-fchg-8000152");
  });

  it("writes nothing for a plan alone", async () => {
    const sink = await fold(plans);
    expect(sink.tables.trip_instance.size).toBe(0);
    expect(sink.tables.stop_event.size).toBe(0);
    expect([...sink.tables.rt_payload.values()].map((row) => row.foldSourceId)).toEqual([
      "db-iris",
      "db-iris",
    ]);
  });

  it("folds a change against the plan: delay, platform change and the source seen", async () => {
    const fchg = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:00:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260019" cp="7"/>`),
    );
    const sink = await fold([...plans, fchg]);
    const instance = [...sink.tables.trip_instance.values()];
    expect(instance.map((row) => row.tripKey)).toEqual(["ICE990"]);
    expect([...sink.tables.trip_instance_source.keys()].map((key) => key.split("|")[1])).toEqual([
      "db-iris",
    ]);
    expect(frankfurtStop(sink)).toMatchObject({
      sourceId: "db-iris",
      arrivalDelay: 600,
      platformScheduled: "9",
      platformActual: "7",
      predictionKind: "explicit",
    });
    const events = [...sink.tables.event.values()].map((row) => row.eventType);
    expect(events).toContain("PlatformChanged");
    const log = [...sink.tables.rt_payload.values()].at(-1);
    expect(log).toMatchObject({ sourceId: "db-iris-fchg-8000105", foldSourceId: "db-iris" });
    expect(log?.error).toBeNull();
  });

  it("carries the Mannheim delay on to Frankfurt until Frankfurt names its own", async () => {
    const mannheim = stored(
      "db-iris-fchg-8000244",
      "2026-10-25T22:00:00Z",
      change(MANNHEIM, 6, `<ar ct="2610252336"/><dp ct="2610252338"/>`),
    );
    const sink = await fold([...plans, mannheim]);
    expect(frankfurtStop(sink)).toMatchObject({ arrivalDelay: 300, predictionKind: "propagated" });
    const frankfurt = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:03:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260011"/>`),
    );
    const both = await fold([...plans, mannheim, frankfurt]);
    expect(frankfurtStop(both)).toMatchObject({ arrivalDelay: 120, predictionKind: "explicit" });
  });

  it("carries a Frankfurt delay back to Mannheim, which IRIS left out", async () => {
    const frankfurt = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:00:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260019"/>`),
    );
    const sink = await fold([...plans, frankfurt]);
    const mannheim = [...sink.tables.stop_event.values()].find(
      (row) => row.stopPlaceId === place(MANNHEIM),
    );
    expect(mannheim).toMatchObject({
      arrivalDelay: 600,
      departureDelay: 600,
      predictionKind: "propagated",
    });
  });

  it("cancels a stop IRIS cancels", async () => {
    const fchg = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:00:00Z",
      change(FRANKFURT, 7, `<ar cs="c" clt="2610252150"/>`),
    );
    expect(frankfurtStop(await fold([...plans, fchg]))?.cancelled).toBe(true);
  });

  it("leaves the same rows when an earlier change answer arrives late", async () => {
    const first = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:00:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260014"/>`),
    );
    const second = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:03:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260019"/>`),
    );
    const payloads = [...plans, first, second];
    const ordered = await fold(payloads);
    const late = await fold(payloads, [...plans, second, first]);
    const folded = FOLD_TABLES.filter((name) => name !== "event");
    expect(late.fingerprint(folded)).toEqual(ordered.fingerprint(folded));
    expect(frankfurtStop(late)?.arrivalDelay).toBe(600);
  });

  it("keeps the IRIS books over a checkpoint restart, so upstream delays stay", async () => {
    const mannheim = stored(
      "db-iris-fchg-8000244",
      "2026-10-25T22:00:00Z",
      change(MANNHEIM, 6, `<ar ct="2610252336"/><dp ct="2610252338"/>`),
    );
    const frankfurt = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:01:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260019"/>`),
    );
    const again = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:04:00Z",
      change(
        FRANKFURT,
        7,
        `<tl f="F" t="p" o="80" c="ICE" n="990"/><ar pt="2610260009" ct="2610260019"/>`,
      ),
    );
    const all = [...plans, mannheim, frankfurt, again];
    const before = new MemorySink();
    const first = processorFor(before, all);
    for (const item of [...plans, mannheim, frankfurt]) await first.processBatch([item]);
    await first.flush();
    const lines = [...first.checkpointLines()].map(
      (line) => JSON.parse(JSON.stringify(line)) as CheckpointLine,
    );
    expect(lines.some((line) => line.kind === "iris-plan")).toBe(true);
    expect(lines.some((line) => line.kind === "iris-change")).toBe(true);
    const snapshot = snapshotFromLines(lines);
    const after = new MemorySink();
    const second = processorFor(after, all);
    const byId = new Map(all.map((item) => [item.record.object?.id, item.record]));
    expect(snapshot && second.restore(snapshot, (id) => byId.get(id))).toBe(true);
    await second.processBatch([again]);
    await second.flush();
    const rows = new Map([...before.tables.stop_event, ...after.tables.stop_event]);
    const mannheimRow = [...rows.values()].find((row) => row.stopPlaceId === place(MANNHEIM));
    expect(mannheimRow).toMatchObject({ arrivalDelay: 300, predictionKind: "explicit" });
    const stuttgartRow = [...rows.values()].find((row) => row.stopPlaceId === place(STUTTGART));
    expect(stuttgartRow).toMatchObject({ departureDelay: 300 });
    const ordered = await fold(all);
    expect(new Map(rows)).toEqual(ordered.tables.stop_event);
  });

  it("rebuilds from the first answer of a trip, before its instance existed", async () => {
    const early = stored(
      "db-iris-fchg-8000244",
      "2026-10-25T20:50:00Z",
      change(MANNHEIM, 6, `<ar ct="2610252336"/><dp ct="2610252338"/>`),
    );
    const mannheimPlan = stored("db-iris-plan-8000244", "2026-10-25T21:00:00Z", PLAN_MANNHEIM);
    const frankfurtPlan = stored("db-iris-plan-8000105", "2026-10-25T21:00:01Z", PLAN_FRANKFURT);
    const first = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:00:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260014"/>`),
    );
    const second = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:03:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260019"/>`),
    );
    const payloads = [early, mannheimPlan, frankfurtPlan, first, second];
    const ordered = await fold(payloads);
    const late = await fold(payloads, [early, mannheimPlan, frankfurtPlan, second, first]);
    const folded = FOLD_TABLES.filter((name) => name !== "event");
    expect(late.fingerprint(folded)).toEqual(ordered.fingerprint(folded));
    const mannheimRow = [...late.tables.stop_event.values()].find(
      (row) => row.stopPlaceId === place(MANNHEIM),
    );
    expect(mannheimRow).toMatchObject({ arrivalDelay: 300, predictionKind: "explicit" });
  });

  it("reports an unmatched IRIS trip in the backlog with its reason", async () => {
    const other = xml(
      FRANKFURT,
      `<s id="77-2610252000-4" eva="${FRANKFURT}"><tl f="F" t="p" o="80" c="ICE" n="4711"/>` +
        `<ar pt="2610260030" ct="2610260035"/></s>`,
    );
    const sink = await fold([stored("db-iris-fchg-8000105", "2026-10-25T22:00:00Z", other)]);
    expect([...sink.tables.match_backlog.values()].map((row) => row.reason)).toEqual([
      "train_number_not_in_timetable",
    ]);
  });

  it("gives IRIS the instance for hsr and ld over gtfs.de and DELFI, sticky once held (D-041, D-038)", async () => {
    const fchg = stored(
      "db-iris-fchg-8000105",
      "2026-10-25T22:00:00Z",
      change(FRANKFURT, 7, `<ar ct="2610260019"/>`),
    );
    const sink = await fold([...plans, fchg]);
    const [seen] = [...sink.tables.trip_instance_source.entries()];
    const iris: SourceActivity = {
      sourceId: (seen?.[0] ?? "").split("|")[1] ?? "",
      firstSeen: Math.floor((seen?.[1].first as number) / 1000),
      lastSeen: Math.floor((seen?.[1].last as number) / 1000),
    };
    const now = iris.lastSeen + 30;
    const gtfsde = { sourceId: "gtfsde-rt", firstSeen: iris.firstSeen - 600, lastSeen: now };
    const delfi = { sourceId: "delfi-gtfs-rt", firstSeen: iris.firstSeen - 600, lastSeen: now };
    for (const category of ["hsr", "ld"]) {
      expect(sourceRank(category, iris.sourceId)).toBe(0);
      expect(chooseSource(category, null, [delfi, gtfsde, iris], now)?.sourceId).toBe("db-iris");
      const held = { sourceId: "gtfsde-rt", since: iris.firstSeen - 600 };
      expect(chooseSource(category, held, [delfi, gtfsde, iris], now)).toBe(held);
    }
    expect(chooseSource("reg", null, [gtfsde, iris], now)?.sourceId).toBe("gtfsde-rt");
  });
});
