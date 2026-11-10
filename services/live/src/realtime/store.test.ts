import { describe, expect, it } from "vitest";
import { EVERYTHING, NoticeQueue, parseRebuildNotice } from "./notices.ts";
import { mergeNotices } from "./readers.ts";
import { type ForecastRow, RealtimeStore } from "./store.ts";

const A = "00000000-0000-5000-a000-000000000001";
const B = "00000000-0000-5000-a000-000000000002";
const DAY = "2026-10-29";

function row(
  instanceId: string,
  sourceId: string,
  stopIndex: number,
  at: number,
  delay = 0,
): ForecastRow {
  return {
    instanceId,
    serviceDate: DAY,
    stopIndex,
    sourceId,
    observedAt: at,
    predictedArrival: 1_000 + delay,
    predictedDeparture: 1_000 + delay,
    arrivalDelay: delay,
    departureDelay: delay,
    cancelled: false,
    explicit: true,
    stopPlaceId: "p",
  };
}

describe("RealtimeStore sightings (F-02)", () => {
  it("keeps a source active while it reports unchanged predictions", () => {
    const store = new RealtimeStore();
    store.apply([row(A, "delfi-gtfs-rt", 0, 100)]);
    expect(store.activity(A, 2_000)).toEqual([
      { sourceId: "delfi-gtfs-rt", firstSeen: 100, lastSeen: 100 },
    ]);
    store.noteSeen([{ instanceId: A, sourceId: "delfi-gtfs-rt", firstSeen: 90, lastSeen: 1_990 }]);
    expect(store.activity(A, 2_000)).toEqual([
      { sourceId: "delfi-gtfs-rt", firstSeen: 90, lastSeen: 1_990 },
    ]);
    store.noteSeen([{ instanceId: A, sourceId: "delfi-gtfs-rt", firstSeen: 95, lastSeen: 1_500 }]);
    expect(store.activity(A, 2_000)[0]?.lastSeen).toBe(1_990);
  });

  it("counts a sighting only up to the instant evaluated, and not before it began", () => {
    const store = new RealtimeStore();
    store.apply([row(A, "gtfsde-rt", 0, 100)]);
    store.noteSeen([{ instanceId: A, sourceId: "gtfsde-rt", firstSeen: 50, lastSeen: 5_000 }]);
    expect(store.activity(A, 600)[0]).toMatchObject({ firstSeen: 50, lastSeen: 600 });
    store.noteSeen([{ instanceId: A, sourceId: "delfi-gtfs-rt", firstSeen: 700, lastSeen: 900 }]);
    store.apply([row(A, "delfi-gtfs-rt", 0, 650)]);
    expect(store.activity(A, 600).find((s) => s.sourceId === "delfi-gtfs-rt")).toMatchObject({
      firstSeen: 650,
      lastSeen: 650,
    });
  });

  it("ignores sightings of instances it does not hold and of sources without predictions", () => {
    const store = new RealtimeStore();
    store.noteSeen([{ instanceId: A, sourceId: "gtfsde-rt", firstSeen: 1, lastSeen: 2 }]);
    expect(store.has(A)).toBe(false);
    store.apply([row(A, "delfi-gtfs-rt", 0, 100)]);
    store.noteSeen([{ instanceId: A, sourceId: "gtfsde-rt", firstSeen: 1, lastSeen: 200 }]);
    expect(store.activity(A, 300).map((s) => s.sourceId)).toEqual(["delfi-gtfs-rt"]);
  });
});

describe("RealtimeStore reload after a rebuild (F-03)", () => {
  it("replaces one source's rows of held instances, deleted rows included", () => {
    const store = new RealtimeStore();
    store.apply([
      row(A, "delfi-gtfs-rt", 0, 100, 60),
      row(A, "delfi-gtfs-rt", 1, 160, 120),
      row(A, "gtfsde-rt", 0, 100, 30),
      row(B, "delfi-gtfs-rt", 0, 100, 60),
    ]);
    const touched = store.replace(
      "delfi-gtfs-rt",
      [A, "not-held"],
      [row(A, "delfi-gtfs-rt", 0, 120, 90), row("not-held", "delfi-gtfs-rt", 0, 120, 90)],
    );
    expect([...touched]).toEqual([A]);
    expect([...(store.source(A, "delfi-gtfs-rt")?.stops.keys() ?? [])]).toEqual([0]);
    expect(store.source(A, "delfi-gtfs-rt")?.stops.get(0)?.arrivalDelay).toBe(90);
    expect(store.source(A, "gtfsde-rt")?.stops.get(0)?.arrivalDelay).toBe(30);
    expect(store.source(B, "delfi-gtfs-rt")?.stops.get(0)?.arrivalDelay).toBe(60);
    expect(store.has("not-held")).toBe(false);
  });

  it("an older row from a rebuild replaces a newer one the old order wrote", () => {
    const store = new RealtimeStore();
    store.apply([row(A, "delfi-gtfs-rt", 0, 300, 600)]);
    store.replace("delfi-gtfs-rt", [A], [row(A, "delfi-gtfs-rt", 0, 200, 60)]);
    expect(store.source(A, "delfi-gtfs-rt")?.stops.get(0)).toMatchObject({
      observedAt: 200,
      arrivalDelay: 60,
    });
  });

  it("a reload of every source clears them all and drops a source left without rows", () => {
    const store = new RealtimeStore();
    store.apply([row(A, "delfi-gtfs-rt", 0, 100), row(A, "gtfsde-rt", 0, 100)]);
    store.replace(null, [A], [row(A, "gtfsde-rt", 0, 110, 5)]);
    expect(store.activity(A, 200).map((s) => s.sourceId)).toEqual(["gtfsde-rt"]);
  });
});

describe("rebuild notices", () => {
  it("reads WP-2.3b's notice and turns anything else into a notice for everything", () => {
    expect(
      parseRebuildNotice(
        JSON.stringify({ foldSourceId: "delfi-gtfs-rt", serviceDates: ["2026-10-30", DAY] }),
      ),
    ).toEqual({ foldSourceId: "delfi-gtfs-rt", serviceDates: [DAY, "2026-10-30"] });
    for (const bad of [
      undefined,
      "not json",
      "null",
      JSON.stringify({ foldSourceId: "", serviceDates: [DAY] }),
      JSON.stringify({ foldSourceId: "x", serviceDates: [] }),
      JSON.stringify({ foldSourceId: "x", serviceDates: ["29.10.2026"] }),
    ]) {
      expect(parseRebuildNotice(bad)).toEqual(EVERYTHING);
    }
  });

  it("merges notices per source; one for everything wins", () => {
    expect(mergeNotices([])).toEqual([]);
    expect(
      mergeNotices([
        { foldSourceId: "gtfsde-rt", serviceDates: [DAY] },
        { foldSourceId: "delfi-gtfs-rt", serviceDates: [DAY] },
        { foldSourceId: "delfi-gtfs-rt", serviceDates: ["2026-10-30"] },
      ]),
    ).toEqual([
      { sourceId: "delfi-gtfs-rt", serviceDates: new Set([DAY, "2026-10-30"]) },
      { sourceId: "gtfsde-rt", serviceDates: new Set([DAY]) },
    ]);
    expect(mergeNotices([{ foldSourceId: "x", serviceDates: [DAY] }, EVERYTHING])).toEqual([
      { sourceId: null, serviceDates: null },
    ]);
  });

  it("a queue hands each notice over once", () => {
    const queue = new NoticeQueue();
    queue.push(EVERYTHING);
    expect(queue.drain()).toEqual([EVERYTHING]);
    expect(queue.drain()).toEqual([]);
  });
});
