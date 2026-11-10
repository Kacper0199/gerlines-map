import { TrainDetail } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { DetailDispatcher } from "../engine/detail-feed.ts";
import type { DetailRef } from "./model.ts";
import type { LiveInstanceState, LiveTickUpdate } from "./port.ts";
import { PUSH_BATCH, pushDetails, TrainDetailPublisher } from "./publisher.ts";
import type { LoadedDetails, LoadedInstance, ReadMode } from "./repository.ts";

const A = "0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c01";
const B = "0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c02";
const PLACE_1 = "6f1c2a1e-1a52-4c8e-9a3b-0d6a2f4c1b01";
const PLACE_2 = "6f1c2a1e-1a52-4c8e-9a3b-0d6a2f4c1b02";
const AT = Date.parse("2026-10-26T22:00:00Z");

function instance(ref: DetailRef, placeId = PLACE_2): LoadedInstance {
  return {
    ref,
    trip: {
      feedVersionId: 3,
      tripKey: ref.tripKey ?? "k",
      categoryCode: "rfast",
      isForeign: false,
      line: "RE10",
      tripShortName: "18396",
      headsign: null,
      operatorId: null,
      product: null,
      shapeQaStatus: "pass",
    },
    staticStops: [
      {
        index: 0,
        stopPlaceId: PLACE_1,
        scheduledArrival: null,
        scheduledDeparture: AT - 600_000,
        platform: "Gl. 2",
        passenger: true,
      },
      {
        index: 1,
        stopPlaceId: placeId,
        scheduledArrival: AT + 600_000,
        scheduledDeparture: null,
        platform: "3",
        passenger: true,
      },
    ],
    instance: null,
    events: [],
    activity: [],
  };
}

function loaded(refs: readonly DetailRef[]): LoadedDetails {
  return {
    instances: refs.map((ref) =>
      ref.tripInstanceId === B
        ? instance(ref, "6f1c2a1e-1a52-4c8e-9a3b-0d6a2f4c1b09")
        : instance(ref),
    ),
    places: new Map([
      [PLACE_1, { name: "Köln Hbf", displayName: null, location: null }],
      [PLACE_2, { name: "Hauptbahnhof", displayName: "Stuttgart Hbf", location: null }],
    ]),
    operators: new Map(),
    sources: new Map(),
    feedObservedAt: new Map([["delfi-gtfs-rt", AT - 30_000]]),
  };
}

function state(id: string): LiveInstanceState {
  return {
    tripInstanceId: id,
    key: 17,
    serviceDate: "2026-10-26",
    feedVersionId: 3,
    tripKey: `trip-${id.slice(-2)}`,
    category: "rfast",
    source: null,
    geometry: { available: true, reason: null },
    delaySeconds: null,
    cancelled: false,
    lastPassedIndex: 0,
    nextIndex: 1,
    endsAt: (AT + 600_000) / 1000,
    at: AT / 1000,
  };
}

function harness(options: { failStore?: boolean; failWrites?: number; hangPush?: boolean } = {}) {
  let failWrites = options.failWrites ?? 0;
  const loads: {
    refs: readonly DetailRef[];
    asOf: number;
    mode: ReadMode;
    options: { activity?: boolean } | undefined;
  }[] = [];
  const written: TrainDetail[][] = [];
  const ttls: (ReadonlyMap<string, number> | undefined)[] = [];
  const lefts: (ReadonlyMap<string, number> | undefined)[] = [];
  const discarded: string[][] = [];
  const confirmed: [number, ReadonlyMap<string, number>][] = [];
  const published: { channel: string; data: unknown }[][] = [];
  const errors: string[] = [];
  const publisher = new TrainDetailPublisher({
    mode: "current",
    repository: {
      async load(refs, asOf, mode, options) {
        loads.push({ refs, asOf, mode, options });
        return loaded(refs);
      },
      async feeds() {
        return new Map([["gtfsde-rt", AT - 10_000]]);
      },
    },
    store: {
      async write(details, ttl, left) {
        lefts.push(left);
        if (options.failStore) throw new Error("connection refused");
        if (failWrites > 0) {
          failWrites -= 1;
          throw new Error("connection reset");
        }
        written.push([...details]);
        ttls.push(ttl);
      },
      async discard(ids) {
        discarded.push([...ids]);
      },
      async confirm(at, feeds) {
        confirmed.push([at, feeds]);
      },
    },
    push: {
      async publish(items) {
        published.push([...items]);
        if (options.hangPush) await new Promise(() => undefined);
        return 0;
      },
    },
    logger: { info: () => undefined, error: (line) => errors.push(line) },
    pushBudgetMs: 20,
  });
  return { publisher, loads, written, ttls, lefts, discarded, confirmed, published, errors };
}

const update = (changed: LiveInstanceState[]): LiveTickUpdate => ({
  at: AT / 1000,
  sequence: 4711,
  timetableVersion: 3,
  changed,
  removed: [],
});

describe("TrainDetailPublisher", () => {
  it("builds the changed trains with the tick's values, writes them and confirms the tick", async () => {
    const h = harness();
    await h.publisher.publish(update([state(A)]));
    expect(h.loads[0]?.refs).toEqual([
      {
        tripInstanceId: A,
        serviceDate: "2026-10-26",
        feedVersionId: 3,
        tripKey: "trip-01",
        frameKey: 17,
      },
    ]);
    const [detail] = h.written[0] ?? [];
    expect(TrainDetail.parse(detail)).toMatchObject({
      tripInstanceId: A,
      frameKey: 17,
      version: 4711,
      timetableVersion: "3",
      productName: "RE",
      progress: { lastPassedIndex: 0, nextIndex: 1 },
      destination: { name: "Stuttgart Hbf" },
    });
    expect(h.confirmed).toEqual([[AT, new Map([["delfi-gtfs-rt", AT - 30_000]])]]);
    expect(h.publisher.lastReport).toMatchObject({ changed: 1, written: 1, pushed: 1, errors: [] });
  });

  it("keeps each detail until 15 minutes after its run ends", async () => {
    const h = harness();
    await h.publisher.publish(update([{ ...state(A), endsAt: AT / 1000 + 3_600 }]));
    expect(h.ttls[0]?.get(A)).toBe(4_500);
  });

  it("writes a final detail for a train that left and marks when it left", async () => {
    const h = harness();
    const final = {
      ...state(A),
      key: null,
      lastPassedIndex: 1,
      nextIndex: null,
      endsAt: AT / 1000,
    };
    await h.publisher.publish({ ...update([]), removed: [final] });
    const [detail] = h.written[0] ?? [];
    expect(detail).toMatchObject({
      tripInstanceId: A,
      progress: { lastPassedIndex: 1, nextIndex: null },
    });
    expect(h.lefts[0]).toEqual(new Map([[A, AT]]));
    expect(h.ttls[0]?.get(A)).toBe(900);
    expect(h.loads).toHaveLength(1);
  });

  it("writes nothing for a train whose run ended more than 15 minutes before it left", async () => {
    const h = harness();
    const C = "0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c03";
    const ended = { ...state(A), key: null, lastPassedIndex: 1, nextIndex: null };
    await h.publisher.publish({
      ...update([]),
      removed: [
        { ...ended, endsAt: AT / 1000 - 901 },
        { ...ended, tripInstanceId: C, endsAt: AT / 1000 - 899 },
      ],
    });
    expect(h.loads[0]?.refs.map((ref) => ref.tripInstanceId)).toEqual([C]);
    expect(h.written[0]?.map((detail) => detail.tripInstanceId)).toEqual([C]);
    expect(h.discarded.flat()).toEqual([A]);
    expect(h.confirmed).toHaveLength(1);
  });

  it("never writes a train's progress behind what its last detail could have served", async () => {
    const h = harness();
    await h.publisher.publish(update([state(A)]));
    expect(h.written[0]?.[0]?.progress).toEqual({ lastPassedIndex: 0, nextIndex: 1 });
    const back = { ...state(A), lastPassedIndex: null, nextIndex: 0 };
    await h.publisher.publish({ ...update([back]), at: AT / 1000 + 60 });
    expect(h.written[1]?.[0]?.progress).toEqual({ lastPassedIndex: 0, nextIndex: 1 });
  });

  it("discards the stored detail of a changed train that fails to build", async () => {
    const h = harness();
    await h.publisher.publish(update([state(A), { ...state(B), tripKey: "trip-02" }]));
    expect(h.written[0]?.map((detail) => detail.tripInstanceId)).toEqual([A]);
    expect(h.discarded).toEqual([[B]]);
  });

  it("skips the source activity read, since the tick has chosen every source", async () => {
    const h = harness();
    await h.publisher.publish(update([state(A)]));
    expect(h.loads[0]?.options).toEqual({ activity: false });
  });

  it("labels each train with its own timetable version", async () => {
    const h = harness();
    await h.publisher.publish(update([{ ...state(A), feedVersionId: 2 }]));
    expect(h.written[0]?.[0]?.timetableVersion).toBe("2");
  });

  it("gives up on a hanging push within its time budget", async () => {
    const h = harness({ hangPush: true });
    const started = performance.now();
    await h.publisher.publish(update([state(A)]));
    expect(performance.now() - started).toBeLessThan(500);
    expect(h.written).toHaveLength(1);
    expect(h.publisher.lastReport?.errors).toEqual(["push: over the 20 ms budget"]);
    expect(h.publisher.lastReport?.written).toBe(1);
  });

  it("pushes every built detail to its channel without asking for subscribers", async () => {
    const h = harness();
    await h.publisher.publish(update([state(A), { ...state(B), tripKey: "trip-02" }]));
    expect(h.published[0]?.map((item) => item.channel)).toEqual([`train:${A}`]);
    expect(h.publisher.lastReport?.failures).toEqual({ unknown_place: 1 });
  });

  it("confirms an empty tick with fresh feed times and loads nothing", async () => {
    const h = harness();
    await h.publisher.publish(update([]));
    expect(h.loads).toHaveLength(0);
    expect(h.confirmed[0]?.[1]).toEqual(new Map([["gtfsde-rt", AT - 10_000]]));
  });

  it("writes the trains of a failed write with the next update and confirms only then", async () => {
    const h = harness({ failWrites: 1 });
    await expect(h.publisher.publish(update([state(A)]))).rejects.toThrow("connection reset");
    expect(h.confirmed).toHaveLength(0);
    await h.publisher.publish({ ...update([]), at: AT / 1000 + 10 });
    const ids = () =>
      h.written
        .filter((batch) => batch.length > 0)
        .map((batch) => batch.map((detail) => detail.tripInstanceId));
    expect(ids()).toEqual([[A]]);
    expect(h.confirmed.map(([at]) => at)).toEqual([AT + 10_000]);
    await h.publisher.publish({ ...update([]), at: AT / 1000 + 20 });
    expect(ids()).toEqual([[A]]);
  });

  it("keeps a train that left in a failed write as left, unless it runs again", async () => {
    const h = harness({ failWrites: 1 });
    await expect(
      h.publisher.publish({ ...update([]), removed: [state(A), state(B)] }),
    ).rejects.toThrow();
    await h.publisher.publish({ ...update([state(B)]), at: AT / 1000 + 10 });
    expect(h.loads[1]?.refs.map((ref) => ref.tripInstanceId).sort()).toEqual([A, B]);
    expect([...(h.lefts[1]?.keys() ?? [])]).toEqual([A]);
  });

  it("rejects a failed store write after keeping its trains, and pushes nothing unstored", async () => {
    const h = harness({ failStore: true });
    await expect(h.publisher.publish(update([state(A)]))).rejects.toThrow("connection refused");
    expect(h.publisher.lastReport).toMatchObject({ written: 0, pushed: 0 });
    expect(h.published).toEqual([]);
  });

  it("discards a train that left long after its end once a later write succeeds", async () => {
    const h = harness({ failWrites: 1 });
    const ended = {
      ...state(A),
      key: null,
      lastPassedIndex: 1,
      nextIndex: null,
      endsAt: AT / 1000 - 901,
    };
    await expect(h.publisher.publish({ ...update([]), removed: [ended] })).rejects.toThrow();
    await h.publisher.publish({ ...update([]), at: AT / 1000 + 10 });
    expect(h.discarded.flat()).toEqual([A]);
    await h.publisher.publish({ ...update([]), at: AT / 1000 + 20 });
    expect(h.discarded.flat()).toEqual([A]);
  });

  it("lets the dispatcher back off and count each failed write", async () => {
    const h = harness({ failWrites: 3 });
    const waits: number[] = [];
    const failures: unknown[] = [];
    const dispatcher = new DetailDispatcher(
      h.publisher,
      (error) => void failures.push(error),
      async (ms) => void waits.push(ms),
    );
    dispatcher.offer(update([state(A)]));
    await dispatcher.idle();
    expect(h.loads).toHaveLength(4);
    expect(waits).toEqual([500, 1000, 2000]);
    expect(dispatcher.stats).toMatchObject({ published: 1, failed: 3, dropped: 0 });
    expect(failures).toHaveLength(3);
    expect(h.written.filter((batch) => batch.length > 0)).toHaveLength(1);
  });
});

describe("pushDetails", () => {
  const detail = (index: number) =>
    ({
      tripInstanceId: `0b7e6c1a-3f2d-5a4b-8c9d-${String(index).padStart(12, "0")}`,
    }) as TrainDetail;

  it("splits a burst into batches and counts refused publications", async () => {
    const sizes: number[] = [];
    const client = {
      async publish(items: readonly { channel: string }[]) {
        sizes.push(items.length);
        return items.length === PUSH_BATCH ? 1 : 0;
      },
    };
    const details = Array.from({ length: PUSH_BATCH * 2 + 5 }, (_, index) => detail(index));
    expect(await pushDetails(client, details)).toEqual({
      pushed: details.length - 2,
      error: "2 publications refused",
    });
    expect(sizes).toEqual([PUSH_BATCH, PUSH_BATCH, 5]);
  });

  it("reports what reached Centrifugo before a batch failed", async () => {
    let calls = 0;
    const client = {
      async publish() {
        calls += 1;
        if (calls === 2) throw new Error("batch failed: TimeoutError");
        return 0;
      },
    };
    const details = Array.from({ length: PUSH_BATCH + 1 }, (_, index) => detail(index));
    expect(await pushDetails(client, details)).toEqual({
      pushed: PUSH_BATCH,
      error: "batch failed: TimeoutError",
    });
  });
});
