import type { TripRecord } from "@gerlines/live-frame";
import { describe, expect, it, vi } from "vitest";
import type { CarFrame, CarView } from "../cars/car-instances.ts";
import { modelForTrain, parseCatalog } from "../cars/catalog.ts";
import { liveryManifest, seriesManifest, testManifest } from "../cars/test-catalog.ts";
import type { Palette } from "../motion/frame.ts";
import type { ChainChanges } from "./chain.ts";
import { bearingOf, latOf, lonOf } from "./geometry.ts";
import { LiveTrains } from "./live-trains.ts";
import { ShapeStore, URGENT_PRIORITY } from "./shape-store.ts";
import { SHAPE_X0, SHAPE_Y, stop, straightPack, TIME_BASE, trip } from "./test-frames.ts";
import { liveKeyOf, liveTrainId } from "./train-ids.ts";
import { stopsOf } from "./trip-plan.ts";

const PALETTE: Palette = {
  fill: {
    hsr: [1, 1, 1],
    ld: [2, 2, 2],
    night: [3, 3, 3],
    rfast: [4, 4, 4],
    reg: [5, 5, 5],
    sbahn: [6, 6, 6],
    foreign: [7, 7, 7],
  },
  land: [9, 9, 9],
  delay: {
    ok: [11, 11, 11],
    minor: [12, 12, 12],
    major: [13, 13, 13],
    severe: [14, 14, 14],
    none: [15, 15, 15],
    foreign: [16, 16, 16],
  },
  operator: {
    db: [21, 21, 21],
    transdev: [22, 22, 22],
    kvvh: [23, 23, 23],
    netinera: [24, 24, 24],
    hlb: [25, 25, 25],
    sweg: [26, 26, 26],
    other: [29, 29, 29],
    unknown: [30, 30, 30],
  },
};

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function world(options: { packs?: number[]; sameGeometry?: boolean } = {}) {
  const loaded: string[] = [];
  const store = new ShapeStore({
    fetchPack: async (_epoch, id) =>
      straightPack(Number(id), 40_000, 3, options.sameGeometry ? 1 : Number(id)),
    onLoaded: (id) => loaded.push(id),
    now: () => 0,
  });
  const trains = new LiveTrains(store, PALETTE);
  for (const number of options.packs ?? []) store.request(3, number);
  return { store, trains, loaded };
}

function changes(
  changed: ReturnType<typeof trip>[],
  removed: number[] = [],
  reloaded = false,
): ChainChanges {
  return {
    time: 0,
    shapeEpoch: 3,
    reloaded,
    keys: reloaded ? new Set(changed.map((entry) => entry.key)) : null,
    changed,
    removed,
  };
}

const T0 = TIME_BASE;
const RUN = {
  stops: [stop(T0, T0 + 60), stop(T0 + 600, T0 + 660), stop(T0 + 1200, T0 + 1260), stop(T0 + 2400)],
};

function advanceTo(trains: LiveTrains, from: number, to: number, step = 1 / 30): void {
  for (let t = from; t <= to; t += step) trains.advance(t);
}

describe("stopsOf", () => {
  it("reads the shape's stops from firstStop and explicit arcs when given", () => {
    const plain = stopsOf(
      trip(1, { firstStop: 1, stops: [stop(10), stop(20, 30)] }),
      [0, 100, 200],
    );
    expect(plain.map((s) => s.s)).toEqual([100, 200]);
    expect(plain[1]).toMatchObject({ arrival: 20, departure: 30, cancelled: false });
    const explicit = stopsOf(
      trip(1, {
        stops: [
          { ...stop(10), s: 5 },
          { ...stop(20), s: 55 },
        ],
      }),
      [0, 100],
    );
    expect(explicit.map((s) => s.s)).toEqual([5, 55]);
  });

  it("fills an unknown arrival with the departure and the reverse", () => {
    const [first, second] = stopsOf(
      trip(1, {
        stops: [
          { arrival: null, departure: 10, cancelled: false, realtime: false, s: null },
          { arrival: 20, departure: null, cancelled: false, realtime: false, s: null },
        ],
      }),
      [0, 100],
    );
    expect(first).toMatchObject({ arrival: 10, departure: 10 });
    expect(second).toMatchObject({ arrival: 20, departure: 20 });
  });

  it("throws for a stop the shape does not have", () => {
    expect(() => stopsOf(trip(1, { firstStop: 3 }), [0, 100])).toThrow(RangeError);
  });
});

describe("ids and angles", () => {
  it("round-trips the live id and rejects foreign ids", () => {
    expect(liveKeyOf(liveTrainId(25714801))).toBe(25714801);
    expect(liveKeyOf("20261024_12:00_de-DELFI_a")).toBeNull();
    expect(liveKeyOf("live:0")).toBeNull();
    expect(liveKeyOf("live:1.5")).toBeNull();
    expect(liveKeyOf(null)).toBeNull();
  });

  it("converts mercator to degrees and tangents to compass bearings", () => {
    expect(lonOf(0)).toBe(0);
    expect(latOf(0)).toBe(0);
    expect(lonOf(20_037_508.342789244)).toBeCloseTo(180, 9);
    expect(latOf(6_800_000)).toBeCloseTo(52.0, 0);
    expect(bearingOf(1, 0)).toBeCloseTo(90, 9);
    expect(bearingOf(0, 1)).toBeCloseTo(0, 9);
    expect(bearingOf(-1, 0)).toBeCloseTo(-90, 9);
    expect(bearingOf(0, -1)).toBeCloseTo(180, 9);
  });
});

describe("LiveTrains", () => {
  it("draws a trip on its shape and moves it east along the track", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN)]), T0 + 100);
    advanceTo(trains, T0 + 100, T0 + 400);
    const [normal] = trains.buildFrame({ includeIds: true }).groups;
    expect(normal?.count).toBe(1);
    expect(normal?.ids).toEqual([liveTrainId(1)]);
    const lon = normal?.positions[0] as number;
    const lat = normal?.positions[1] as number;
    expect(lat).toBeCloseTo(latOf(SHAPE_Y), 9);
    expect(lon).toBeGreaterThan(lonOf(SHAPE_X0));
    expect(lon).toBeLessThan(lonOf(SHAPE_X0 + 10_000 + 1));
    expect(normal?.iconAngles[0]).toBeCloseTo(-90, 3);
    expect(normal?.fillColors[3]).toBe(255);
    expect(normal?.positions).toBeInstanceOf(Float64Array);
  });

  it("never moves backwards and stays on the line while following the plan", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN)]), T0 - 30);
    let previous = Number.NEGATIVE_INFINITY;
    for (let t = T0 - 30; t <= T0 + 2500; t += 1 / 20) {
      trains.advance(t);
      const [frame] = trains.buildFrame({ includeIds: false }).groups;
      const lon = frame?.positions[0] as number;
      expect(lon).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(frame?.positions[1]).toBeCloseTo(latOf(SHAPE_Y), 9);
      previous = lon;
    }
    expect(previous).toBeCloseTo(lonOf(SHAPE_X0 + 40_000), 4);
  });

  it("waits for a shape pack and adds the trip when it arrives", async () => {
    const { trains, store, loaded } = world();
    trains.apply(changes([trip(1, RUN)]), T0 + 100);
    expect(trains.size).toBe(0);
    expect(trains.waitingCount).toBe(1);
    expect(trains.stats().untracked).toBe(1);
    await settle();
    expect(store.get("3/7")).toBeDefined();
    for (const id of loaded) trains.onShapeLoaded(id, T0 + 101);
    expect(trains.size).toBe(1);
    expect(trains.waitingCount).toBe(0);
    expect(trains.stats()).toMatchObject({ trips: 1, untracked: 0 });
  });

  it("uses the newest plan of a waiting trip and forgets a removed one", async () => {
    const { trains, loaded } = world();
    trains.apply(changes([trip(1, RUN), trip(2, RUN)]), T0);
    trains.apply(changes([trip(1, { ...RUN, line: "RE 9" })], [2]), T0);
    await settle();
    for (const id of loaded) trains.onShapeLoaded(id, T0 + 1);
    expect(trains.size).toBe(1);
    expect(trains.entry(1)?.trip.line).toBe("RE 9");
    expect(trains.entry(2)).toBeUndefined();
  });

  it("counts a trip whose shape the server does not have and does not draw it", async () => {
    const store = new ShapeStore({
      fetchPack: async () => null,
      onLoaded: () => undefined,
      now: () => 0,
    });
    const trains = new LiveTrains(store, PALETTE);
    trains.apply(changes([trip(1, RUN)]), T0);
    await settle();
    trains.apply(changes([trip(2, RUN)]), T0 + 1);
    expect(trains.size).toBe(0);
    expect(trains.stats().untracked).toBeGreaterThanOrEqual(1);
    expect(trains.failedCount).toBe(1);
  });

  it("does not draw a trip whose stops the shape cannot place", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, { ...RUN, firstStop: 9 })]), T0);
    expect(trains.size).toBe(0);
    expect(trains.failedCount).toBe(1);
  });

  it("does not draw a cancelled trip and removes one that becomes cancelled", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN)]), T0);
    expect(trains.size).toBe(1);
    trains.apply(changes([trip(1, { ...RUN, cancelled: true })]), T0 + 1);
    expect(trains.size).toBe(0);
  });

  it("updates a plan in place and keeps one slot per key", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN)]), T0);
    const slot = trains.entry(1)?.slot;
    advanceTo(trains, T0, T0 + 100);
    trains.apply(changes([trip(1, { ...RUN, realtime: true })]), T0 + 100);
    expect(trains.entry(1)?.slot).toBe(slot);
    expect(trains.size).toBe(1);
    expect(trains.updates).toBe(1);
    expect(trains.stats().realtime).toBe(1);
  });

  it("moves a train to another shape with a crossfade and moves its shape reference", async () => {
    const { trains, store } = world({ packs: [7, 8] });
    await settle();
    trains.apply(changes([trip(1, RUN)]), T0);
    advanceTo(trains, T0, T0 + 50);
    trains.apply(changes([trip(1, { ...RUN, shapeId: 8 })]), T0 + 50);
    expect(trains.entry(1)?.shapeId).toBe("3/8");
    expect(trains.crossfades.shape).toBe(1);
    const references = (store as unknown as { references: Map<string, number> }).references;
    expect([...references.keys()]).toEqual(["3/8"]);
  });

  it("keeps an old shape's train drawn while the pack of its new shape is loading", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN)]), T0);
    trains.apply(changes([trip(1, { ...RUN, shapeId: 55 })]), T0 + 1);
    expect(trains.size).toBe(1);
    expect(trains.waitingCount).toBe(1);
    expect(trains.entry(1)?.shapeId).toBe("3/7");
  });

  it("does not count a drawn train as untracked while it waits for the pack of a new shape", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN), trip(2, RUN)]), T0);
    trains.apply(changes([trip(1, { ...RUN, shapeId: 55 })]), T0 + 1);
    expect(trains.waitingCount).toBe(1);
    expect(trains.stats().untracked).toBe(0);
    trains.apply(changes([trip(3, { ...RUN, shapeId: 99 })]), T0 + 2);
    expect(trains.stats().untracked).toBe(1);
  });

  it("keeps the slot without a crossfade when the new shape has the same geometry", async () => {
    const { trains, store } = world({ packs: [7, 8], sameGeometry: true });
    await settle();
    trains.apply(changes([trip(1, RUN)]), T0);
    advanceTo(trains, T0, T0 + 50);
    const before = trains.fleet.s[trains.entry(1)?.slot ?? 0];
    trains.apply(changes([trip(1, { ...RUN, shapeId: 8 })]), T0 + 50);
    expect(trains.entry(1)?.shapeId).toBe("3/8");
    expect(trains.crossfades.shape).toBe(0);
    expect(trains.fleet.s[trains.entry(1)?.slot ?? 0]).toBe(before);
    const references = (store as unknown as { references: Map<string, number> }).references;
    expect([...references.keys()]).toEqual(["3/8"]);
  });

  it("does not draw a bus or a trip without a category and counts it as not shown", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(
      changes([
        trip(1, RUN),
        trip(2, { ...RUN, category: "bus" }),
        trip(3, { ...RUN, category: "unknown" }),
      ]),
      T0,
    );
    expect(trains.size).toBe(1);
    expect(trains.stats().counts.reg).toBe(1);
    expect(trains.stats().untracked).toBe(2);
    trains.apply(changes([trip(1, { ...RUN, category: "bus" })]), T0 + 1);
    expect(trains.size).toBe(0);
    expect(trains.stats().untracked).toBe(3);
  });

  it("removes trips a reload no longer holds, including leftovers of a failed follow", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN), trip(2, RUN), trip(3, RUN)]), T0);
    trains.apply(changes([trip(2, RUN)], [], true), T0 + 1);
    expect([trains.entry(1), trains.entry(2), trains.entry(3)].map((e) => e !== undefined)).toEqual(
      [false, true, false],
    );
  });

  it("clears every train, waiting one and failed one, and frees their shapes", async () => {
    const { trains, store } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN), trip(2, { ...RUN, firstStop: 9 })]), T0);
    trains.apply(changes([trip(3, { ...RUN, shapeId: 99 })]), T0);
    expect([trains.size, trains.failedCount, trains.waitingCount]).toEqual([1, 1, 1]);
    trains.clear();
    expect([trains.size, trains.failedCount, trains.waitingCount]).toEqual([0, 0, 0]);
    expect((store as unknown as { references: Map<string, number> }).references.size).toBe(0);
    trains.apply(changes([trip(1, RUN)]), T0 + 1);
    expect(trains.size).toBe(1);
  });

  it("frees a shape reference when a train goes", async () => {
    const { trains, store } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, RUN)]), T0);
    trains.apply(changes([], [1]), T0 + 1);
    const capacityStore = store as unknown as { references: Map<string, number> };
    expect(capacityStore.references.size).toBe(0);
  });

  it("orders groups by draw order, puts night trains in the hollow group and hides categories", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(
      changes([
        trip(1, { ...RUN, category: "hsr" }),
        trip(2, { ...RUN, category: "reg" }),
        trip(3, { ...RUN, category: "night" }),
        trip(4, { ...RUN, category: "ld", foreign: true }),
      ]),
      T0 + 100,
    );
    advanceTo(trains, T0 + 100, T0 + 102);
    const { groups } = trains.buildFrame({ includeIds: true });
    expect(groups[0]?.ids).toEqual(["live:4", "live:2", "live:1"]);
    expect(groups[1]?.ids).toEqual(["live:3"]);
    expect(groups[1]?.hollow).toBe(true);
    expect(groups[0]?.sizes[0]).toBeCloseTo(0.8);
    expect(groups[0]?.sizes[2]).toBeCloseTo(1.25);
    const foreignAlpha = groups[0]?.fillColors[3] as number;
    expect(foreignAlpha).toBeLessThanOrEqual(Math.round(255 * 0.7));
    expect(Array.from(groups[0]?.fillColors.subarray(0, 3) ?? [])).toEqual([7, 7, 7]);
    expect(Array.from(groups[1]?.fillColors.subarray(0, 3) ?? [])).toEqual([9, 9, 9]);
    expect(Array.from(groups[1]?.lineColors.subarray(0, 3) ?? [])).toEqual([3, 3, 3]);
    const version = trains.idsVersion;
    trains.setHiddenCategories(["hsr", "night"]);
    expect(trains.idsVersion).toBeGreaterThan(version);
    const hidden = trains.buildFrame({ includeIds: true }).groups;
    expect(hidden[0]?.ids).toEqual(["live:4", "live:2"]);
    expect(hidden[1]?.count).toBe(0);
  });

  it("describes the selected train and its route", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(5, RUN)]), T0 + 700);
    advanceTo(trains, T0 + 700, T0 + 900);
    expect(trains.buildFrame({ includeIds: false }).selected).toBeNull();
    trains.select(5);
    const { selected } = trains.buildFrame({ includeIds: false });
    expect(selected?.id).toBe("live:5");
    expect(selected?.legKey).toBe("3/7");
    expect(selected?.vertex).toBeGreaterThanOrEqual(10);
    expect(selected?.vertex).toBeLessThanOrEqual(20);
    expect(selected?.bearing).toBeCloseTo(90, 3);
    const route = trains.selectedRoute();
    expect(route?.path.length).toBe(82);
    expect(route?.legKey).toBe("3/7");
    expect(Array.from(route?.stops?.vertices ?? [])).toEqual([0, 10, 20, 40]);
    expect(route?.stops?.firstStop).toBe(0);
    trains.apply(changes([], [5]), T0 + 901);
    expect(trains.buildFrame({ includeIds: false }).selected).toBeNull();
    expect(trains.selectedRoute()).toBeNull();
  });
});

describe("LiveTrains.selectedRoute stops", () => {
  it("places every stop of the shape even when the plan holds only the stops ahead", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    const ahead = {
      stops: [stop(T0, T0 + 60), stop(T0 + 600, T0 + 660), stop(T0 + 1800)],
      firstStop: 1,
    };
    trains.apply(changes([trip(5, ahead)]), T0 + 100);
    advanceTo(trains, T0 + 100, T0 + 200);
    trains.select(5);
    const stops = trains.selectedRoute()?.stops;
    expect(Array.from(stops?.vertices ?? [])).toEqual([0, 10, 20, 40]);
    expect(stops?.firstStop).toBe(1);
    expect(Array.from(stops?.arrivals ?? [])).toEqual([T0, T0 + 600, T0 + 1800]);
    expect(Array.from(stops?.departures ?? [])).toEqual([T0 + 60, T0 + 660, T0 + 1800]);
  });

  it("has no stop positions for a trip with explicit arcs", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    const explicit = {
      stops: [
        { ...stop(T0, T0 + 60), s: 0 },
        { ...stop(T0 + 1800), s: 40_000 },
      ],
    };
    trains.apply(changes([trip(5, explicit)]), T0 + 100);
    advanceTo(trains, T0 + 100, T0 + 200);
    trains.select(5);
    expect(trains.selectedRoute()?.stops).toBeUndefined();
  });
});

describe("LiveTrains.buildCars", () => {
  const catalog = parseCatalog(testManifest());
  const SELECTION: [number, number, number] = [255, 176, 0];
  const view = (overrides: Partial<CarView> = {}): CarView => ({
    zoom: 17,
    centerX: SHAPE_X0 + 5_000,
    centerY: SHAPE_Y,
    radiusM: 20_000,
    fineRadiusM: 20_000,
    ...overrides,
  });
  const colourOf = (frame: ReturnType<LiveTrains["buildCars"]>, key: number) => {
    const instances = frame.meshes.find((entry) => entry.trainKeys.includes(key));
    const index = instances?.trainKeys.indexOf(key) ?? -1;
    return Array.from(instances?.colors.subarray(4 * index, 4 * index + 4) ?? []);
  };

  async function running(
    categories: Record<number, Parameters<typeof trip>[1] & object>,
  ): Promise<LiveTrains> {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(
      changes(
        Object.entries(categories).map(([key, extra]) => trip(Number(key), { ...RUN, ...extra })),
      ),
      T0 + 700,
    );
    advanceTo(trains, T0 + 700, T0 + 760);
    return trains;
  }

  it("places each shown train as the generic model of its frame category and skips categories without one", async () => {
    const trains = await running({
      1: { category: "hsr" },
      2: { category: "sbahn" },
      3: { category: "rfast" },
    });
    const frame = trains.buildCars(catalog, view(), SELECTION);
    expect([...frame.trainKeys].sort()).toEqual([1, 2]);
    expect(frame.meshes.map((entry) => entry.mesh).sort()).toEqual([
      "generic-hsr/bogie-a",
      "generic-hsr/end",
      "generic-sbahn/bogie-a",
      "generic-sbahn/bogie-j",
      "generic-sbahn/end",
    ]);
    expect(colourOf(frame, 1).slice(0, 3)).toEqual([1, 1, 1]);
    expect(colourOf(frame, 2).slice(0, 3)).toEqual([6, 6, 6]);
  });

  it("places a train of a series the forge has as that series' model, coupled by its units", async () => {
    const trains = await running({
      1: { category: "hsr", series: "db-412", operator: "db-fernverkehr-ag", units: null },
      2: { category: "sbahn", series: "db-423", operator: null, units: 2 },
      3: { category: "hsr", series: "db-401", operator: null, units: null },
    });
    const frame = trains.buildCars(parseCatalog(seriesManifest()), view(), SELECTION);
    expect([...frame.trainKeys].sort()).toEqual([1, 2, 3]);
    const meshes = frame.meshes.map((entry) => entry.mesh);
    expect(meshes).toContain("db-412-7/end");
    expect(meshes).not.toContain("db-412-12/end");
    expect(meshes).toContain("generic-hsr/end");
    const sbahn = frame.meshes.find((entry) => entry.mesh === "db-423/end");
    expect(sbahn?.trainKeys.filter((key) => key === 2)).toHaveLength(4);
  });

  it("paints each series train in the livery of its operator, the neutral row for any other", async () => {
    const trains = await running({
      1: { category: "hsr", series: "db-412", operator: "db-fernverkehr-ag", units: null },
      2: { category: "hsr", series: "db-412", operator: "some-bahn", units: null },
      3: { category: "sbahn", series: "db-423", operator: "db-regio-ag-nrw", line: "S1", units: 1 },
      4: { category: "sbahn", series: "db-423", operator: "db-regio-ag-nrw", line: "S6", units: 1 },
      5: { category: "sbahn", series: "db-423", operator: null, units: 1 },
      6: { category: "hsr", series: "db-401", operator: "db-fernverkehr-ag", units: null },
    });
    const frame = trains.buildCars(parseCatalog(liveryManifest()), view(), SELECTION);
    const rowOf = (key: number) => {
      const instances = frame.meshes.find((entry) => entry.trainKeys.includes(key));
      return instances?.liveryRows[instances.trainKeys.indexOf(key)];
    };
    expect([1, 2, 3, 4, 5, 6].map(rowOf)).toEqual([2, 0, 4, 3, 0, 0]);
  });

  it("chooses the livery by the day of the plan clock", async () => {
    const trains = await running({
      1: { category: "hsr", series: "db-412", operator: "db-fernverkehr-ag", units: null },
    });
    const manifest = liveryManifest();
    const dated = {
      ...manifest,
      liveries: {
        ...manifest.liveries,
        rules: manifest.liveries.rules.map((rule) =>
          rule.livery === "ice" ? { ...rule, validFrom: "2026-11-09" } : rule,
        ),
      },
    };
    const rowAt = (isoDay: string) => {
      const frame = trains.buildCars(
        parseCatalog(dated),
        view(),
        SELECTION,
        0,
        Date.parse(`${isoDay}T12:00:00Z`) / 1000,
      );
      return frame.meshes.find((entry) => entry.trainKeys.includes(1))?.liveryRows[0];
    };
    expect([rowAt("2026-11-08"), rowAt("2026-11-09")]).toEqual([0, 2]);
  });

  it.skipIf(Boolean(process.env.CI))(
    "adds a small fraction of a frame to 1,500 trains in view, a cold choice included (budgets 8 times the measured 0.5 and 5 ms)",
    async () => {
      const operators = ["db-fernverkehr-ag", "db-regio-ag-nrw", "db-regio-ag-bayern", "some-bahn"];
      const trains = await running(
        Object.fromEntries(
          Array.from({ length: 1_500 }, (_, i) => [
            i + 1,
            {
              category: i % 2 ? ("hsr" as const) : ("sbahn" as const),
              series: i % 2 ? "db-412" : "db-423",
              operator: operators[i % operators.length] as string,
              line: i % 3 ? "S1" : "S6",
              units: 1,
            },
          ]),
        ),
      );
      const median = (catalog: ReturnType<typeof parseCatalog>, frames: number): number => {
        const times: number[] = [];
        for (let i = 0; i < frames; i++) {
          const started = performance.now();
          trains.buildCars(catalog, view(), SELECTION);
          times.push(performance.now() - started);
        }
        return [...times].sort((a, b) => a - b)[Math.floor(frames / 2)] as number;
      };
      const plain = parseCatalog(seriesManifest());
      const liveried = parseCatalog(liveryManifest());
      median(plain, 5);
      const without = median(plain, 40);
      const started = performance.now();
      trains.buildCars(liveried, view(), SELECTION);
      const cold = performance.now() - started;
      const warm = median(liveried, 40);
      expect(warm - without).toBeLessThan(4);
      expect(cold - without).toBeLessThan(40);
    },
  );

  it("leaves out hidden categories, trains outside the radius and trains at alpha 0", async () => {
    const trains = await running({ 1: { category: "hsr" }, 2: { category: "sbahn" } });
    trains.setHiddenCategories(["hsr"]);
    expect([...trains.buildCars(catalog, view(), SELECTION).trainKeys]).toEqual([2]);
    trains.setHiddenCategories([]);
    expect(
      trains.buildCars(catalog, view({ radiusM: 100, centerX: SHAPE_X0 - 500_000 }), SELECTION)
        .trainKeys,
    ).toHaveLength(0);
    const fresh = world({ packs: [7] });
    await settle();
    fresh.trains.apply(changes([trip(9, { ...RUN, category: "hsr" })]), T0 + 700);
    const zero = fresh.trains.buildCars(catalog, view(), SELECTION);
    expect([...zero.trainKeys]).toEqual([]);
  });

  it("keeps a train dwelling at its first stop a chevron until its whole consist lies on the shape (D-055)", async () => {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(changes([trip(1, { ...RUN, category: "hsr" })]), T0 - 20);
    const atOrigin = view({ centerX: SHAPE_X0, radiusM: 5_000, fineRadiusM: 5_000 });
    advanceTo(trains, T0 - 20, T0 + 30);
    const dwelling = trains.entry(1);
    expect(trains.fleet.alive[dwelling?.slot as number]).toBe(1);
    expect(trains.fleet.s[dwelling?.slot as number]).toBe(0);
    expect(trains.fleet.alpha[dwelling?.slot as number]).toBeGreaterThan(0);
    expect(trains.buildCars(catalog, atOrigin, SELECTION).trainKeys).toHaveLength(0);
    const slot = dwelling?.slot as number;
    const length = modelForTrain(catalog, dwelling?.trip as TripRecord)?.consist.length as number;
    advanceTo(trains, T0 + 30, T0 + 200);
    expect(trains.fleet.s[slot] as number).toBeGreaterThan(length);
    expect([...trains.buildCars(catalog, atOrigin, SELECTION).trainKeys]).toEqual([1]);
  });

  it("paints the selected train's mode band in the selection colour", async () => {
    const trains = await running({ 1: { category: "hsr" }, 2: { category: "hsr" } });
    trains.select(2);
    const frame = trains.buildCars(catalog, view(), SELECTION);
    expect(colourOf(frame, 2).slice(0, 3)).toEqual(SELECTION);
    expect(colourOf(frame, 1).slice(0, 3)).toEqual([1, 1, 1]);
  });

  it("returns no cars before the cars fade in", async () => {
    const trains = await running({ 1: { category: "hsr" } });
    const frame = trains.buildCars(catalog, view({ zoom: 13 }), SELECTION);
    expect(frame.meshes).toEqual([]);
    expect(frame.fade).toBe(0);
  });
});

describe("chevron fade of car-drawn trains (writeGroup)", () => {
  const cars = (
    drawn: number[],
    placed: number[],
    fade: number,
    blends = drawn.map(() => 1),
  ): CarFrame => ({
    meshes: [],
    trainKeys: Int32Array.from(placed),
    drawnKeys: Int32Array.from(drawn),
    blends: Float32Array.from(blends),
    wanted: [],
    fade,
  });

  async function fleet(): Promise<LiveTrains> {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(
      changes([trip(1, RUN), trip(2, RUN), trip(3, { ...RUN, category: "ld", foreign: true })]),
      T0 + 700,
    );
    advanceTo(trains, T0 + 700, T0 + 760);
    return trains;
  }

  const alphas = (trains: LiveTrains, frameCars?: CarFrame): Record<string, number> => {
    const group = trains.buildFrame({ includeIds: true, cars: frameCars }).groups[0];
    return Object.fromEntries(
      (group?.ids ?? []).map((id, i) => [id, group?.fillColors[4 * i + 3] as number]),
    );
  };

  it("fades only the chevrons of trains drawn as cars, by one minus the car fade", async () => {
    const trains = await fleet();
    expect(alphas(trains)).toEqual({ "live:1": 255, "live:2": 255, "live:3": 179 });
    expect(alphas(trains, cars([2], [2], 0.25))).toEqual({
      "live:1": 255,
      "live:2": 191,
      "live:3": 179,
    });
    expect(alphas(trains, cars([2], [2], 1))).toEqual({
      "live:1": 255,
      "live:2": 0,
      "live:3": 179,
    });
  });

  it("keeps the chevron of a train placed but not drawn (meshes missing) and at fade 0", async () => {
    const trains = await fleet();
    const plain = { "live:1": 255, "live:2": 255, "live:3": 179 };
    expect(alphas(trains, cars([], [1, 2], 1))).toEqual(plain);
    expect(alphas(trains, cars([2], [1, 2], 0))).toEqual(plain);
  });

  it("hands a train over with its own blend, so a newly complete train does not pop", async () => {
    const trains = await fleet();
    expect(alphas(trains, cars([2], [2], 1, [0.5]))["live:2"]).toBe(128);
    expect(alphas(trains, cars([2], [2], 0.5, [0.5]))["live:2"]).toBe(191);
    expect(alphas(trains, cars([2], [2], 1, [0]))["live:2"]).toBe(255);
  });

  it("scales the foreign opacity with the car fade", async () => {
    const trains = await fleet();
    expect(alphas(trains, cars([3], [3], 0.5))["live:3"]).toBe(89);
  });
});

describe("LiveTrains colour modes", () => {
  const fillOf = (group: { fillColors: Uint8Array } | undefined, index: number) =>
    Array.from(group?.fillColors.subarray(4 * index, 4 * index + 3) ?? []);

  async function mixed() {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(
      changes([
        trip(1, { ...RUN, category: "hsr", realtime: true, delay: 0 }),
        trip(2, { ...RUN, category: "reg", realtime: true, delay: 400 }),
        trip(3, { ...RUN, category: "sbahn", realtime: true, delay: 1000 }),
        trip(4, { ...RUN, category: "rfast", realtime: false }),
        trip(5, { ...RUN, category: "ld", foreign: true, realtime: true, delay: 2000 }),
        trip(6, { ...RUN, category: "night", realtime: true, delay: 200 }),
      ]),
      T0 + 100,
    );
    advanceTo(trains, T0 + 100, T0 + 102);
    return trains;
  }

  it("keeps the category colours until the delay mode is chosen", async () => {
    const trains = await mixed();
    const { groups } = trains.buildFrame({ includeIds: true });
    expect(groups[0]?.ids).toEqual(["live:5", "live:2", "live:4", "live:3", "live:1"]);
    expect(fillOf(groups[0], 1)).toEqual([5, 5, 5]);
  });

  it("colours every train by its delay class and draws the worse ones on top", async () => {
    const trains = await mixed();
    trains.setColourMode("delay");
    const { groups } = trains.buildFrame({ includeIds: true });
    expect(groups[0]?.ids).toEqual(["live:5", "live:4", "live:1", "live:2", "live:3"]);
    expect(groups[0]?.ids?.map((_, index) => fillOf(groups[0], index))).toEqual([
      [16, 16, 16],
      [15, 15, 15],
      [11, 11, 11],
      [13, 13, 13],
      [14, 14, 14],
    ]);
    expect(Array.from(groups[1]?.lineColors.subarray(0, 3) ?? [])).toEqual([12, 12, 12]);
  });

  it("changes the ids version when the mode changes so the page redraws the order", async () => {
    const trains = await mixed();
    const version = trains.idsVersion;
    trains.setColourMode("delay");
    expect(trains.idsVersion).toBeGreaterThan(version);
    trains.setColourMode("delay");
    expect(trains.idsVersion).toBe(version + 1);
  });

  it("counts the domestic trains per delay class and the foreign ones apart", async () => {
    const trains = await mixed();
    expect(trains.stats().delayCounts).toEqual({
      ok: 1,
      minor: 1,
      major: 1,
      severe: 1,
      none: 1,
      foreign: 1,
    });
  });

  it("follows a delay that changes in a later frame without a new order", async () => {
    const trains = await mixed();
    trains.setColourMode("delay");
    trains.apply(
      changes([trip(2, { ...RUN, category: "reg", realtime: true, delay: 1000 })]),
      T0 + 110,
    );
    expect(trains.stats().delayCounts).toMatchObject({ major: 0, severe: 2 });
    const { groups } = trains.buildFrame({ includeIds: true });
    expect(groups[0]?.ids?.slice(-2).sort()).toEqual(["live:2", "live:3"]);
  });
});

describe("LiveTrains operator colour mode", () => {
  const fillOf = (group: { fillColors: Uint8Array } | undefined, index: number) =>
    Array.from(group?.fillColors.subarray(4 * index, 4 * index + 3) ?? []);

  async function operators() {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(
      changes([
        trip(1, { ...RUN, category: "reg", operator: "db-regio-ag-nrw" }),
        trip(2, { ...RUN, category: "reg", operator: "db-fernverkehr-ag" }),
        trip(3, { ...RUN, category: "reg", operator: "nordwestbahn" }),
        trip(4, { ...RUN, category: "reg", operator: "vlexx" }),
        trip(5, { ...RUN, category: "reg", operator: null }),
        trip(6, { ...RUN, category: "reg" }),
        trip(7, { ...RUN, category: "hsr", operator: "oesterreichische-bundesbahnen" }),
        trip(8, { ...RUN, category: "night", operator: "hessische-landesbahn-gmbh" }),
      ]),
      T0 + 100,
    );
    advanceTo(trains, T0 + 100, T0 + 102);
    return trains;
  }

  it("colours every train by the group of its operator and draws the smaller groups on top", async () => {
    const trains = await operators();
    trains.setColourMode("operator");
    const { groups } = trains.buildFrame({ includeIds: true });
    expect(groups[0]?.ids).toEqual([
      "live:5",
      "live:6",
      "live:4",
      "live:7",
      "live:1",
      "live:2",
      "live:3",
    ]);
    expect(groups[0]?.ids?.map((_, index) => fillOf(groups[0], index))).toEqual([
      [30, 30, 30],
      [30, 30, 30],
      [29, 29, 29],
      [29, 29, 29],
      [21, 21, 21],
      [21, 21, 21],
      [22, 22, 22],
    ]);
    expect(Array.from(groups[1]?.lineColors.subarray(0, 3) ?? [])).toEqual([25, 25, 25]);
  });

  it("shows a train without an operator as unknown, never as other", async () => {
    const trains = await operators();
    expect(trains.stats().operatorCounts).toEqual({
      db: 2,
      transdev: 1,
      netinera: 0,
      kvvh: 0,
      hlb: 1,
      sweg: 0,
      other: 2,
      unknown: 2,
    });
  });

  it("draws Other and Unknown as smaller dots, so colour is not their only channel", async () => {
    const trains = await operators();
    trains.setColourMode("operator");
    const { groups } = trains.buildFrame({ includeIds: true });
    const sizes = Array.from(groups[0]?.sizes ?? []);
    expect(groups[0]?.ids).toEqual([
      "live:5",
      "live:6",
      "live:4",
      "live:7",
      "live:1",
      "live:2",
      "live:3",
    ]);
    expect(sizes[0]).toBeCloseTo(0.8);
    expect(sizes[1]).toBeCloseTo(0.8);
    expect(sizes[2]).toBeCloseTo(0.8);
    expect(sizes[3]).toBeCloseTo(1);
    expect(sizes.slice(4)).toEqual([1, 1, 1]);
    trains.setColourMode("category");
    expect(Array.from(trains.buildFrame({ includeIds: true }).groups[0]?.sizes ?? [])).toEqual(
      [1, 1, 1, 1, 1, 1, 1.25].map((size) => expect.closeTo(size)),
    );
  });

  it("keeps the category colours in the other modes", async () => {
    const trains = await operators();
    const { groups } = trains.buildFrame({ includeIds: true });
    expect(fillOf(groups[0], 0)).toEqual([5, 5, 5]);
  });

  it("hides the chosen groups only while the operator mode is on", async () => {
    const trains = await operators();
    trains.setHiddenOperatorGroups(["db", "unknown"]);
    expect(trains.buildFrame({ includeIds: true }).groups[0]?.count).toBe(7);
    trains.setColourMode("operator");
    expect(trains.buildFrame({ includeIds: true }).groups[0]?.ids).toEqual([
      "live:4",
      "live:7",
      "live:3",
    ]);
    trains.setColourMode("category");
    expect(trains.buildFrame({ includeIds: true }).groups[0]?.count).toBe(7);
  });

  it("counts a hidden group and applies the category hide on top of the group hide", async () => {
    const trains = await operators();
    trains.setColourMode("operator");
    trains.setHiddenOperatorGroups(["db"]);
    trains.setHiddenCategories(["reg"]);
    expect(trains.stats().operatorCounts?.db).toBe(2);
    expect(trains.buildFrame({ includeIds: true }).groups[0]?.count).toBe(1);
  });

  it("moves a deck rebuild along with the groups that are hidden", async () => {
    const trains = await operators();
    trains.setColourMode("operator");
    const version = trains.hiddenVersion;
    trains.setHiddenOperatorGroups(["db"]);
    expect(trains.hiddenVersion).toBeGreaterThan(version);
  });

  it("follows an operator that changes in a later frame", async () => {
    const trains = await operators();
    trains.setColourMode("operator");
    const version = trains.idsVersion;
    trains.apply(
      changes([trip(6, { ...RUN, category: "reg", operator: "db-regio-ag-bayern" })]),
      T0 + 110,
    );
    expect(trains.stats().operatorCounts).toMatchObject({ db: 3, unknown: 1 });
    expect(trains.idsVersion).toBeGreaterThan(version);
  });

  it("takes the 3D car colour from the group of the operator", async () => {
    const trains = await operators();
    trains.setColourMode("operator");
    const catalog = parseCatalog(testManifest());
    const frame = trains.buildCars(
      catalog,
      {
        zoom: 17,
        centerX: SHAPE_X0 + 5_000,
        centerY: SHAPE_Y,
        radiusM: 20_000,
        fineRadiusM: 20_000,
      },
      [255, 176, 0],
    );
    const instances = frame.meshes.find((entry) => entry.trainKeys.includes(7));
    const index = instances?.trainKeys.indexOf(7) ?? -1;
    expect(Array.from(instances?.colors.subarray(4 * index, 4 * index + 3) ?? [])).toEqual([
      29, 29, 29,
    ]);
  });
});

describe("LiveTrains label mode", () => {
  async function labelled() {
    const { trains } = world({ packs: [7] });
    await settle();
    trains.apply(
      changes([
        trip(1, { ...RUN, category: "reg", line: "RE 1", realtime: true, delay: 200 }),
        trip(2, { ...RUN, category: "sbahn", line: null, trainNumber: 31, realtime: false }),
      ]),
      T0 + 100,
    );
    advanceTo(trains, T0 + 100, T0 + 102);
    return trains;
  }

  it("sends no labels until a label mode is chosen", async () => {
    const trains = await labelled();
    expect(trains.buildFrame({ includeIds: true }).groups[0]?.labels).toBeUndefined();
  });

  it("sends the label of every drawn train beside its id and bumps the ids version", async () => {
    const trains = await labelled();
    const version = trains.idsVersion;
    trains.setLabelMode("line");
    expect(trains.idsVersion).toBeGreaterThan(version);
    const group = trains.buildFrame({ includeIds: true }).groups[0];
    expect(group?.ids).toEqual(["live:1", "live:2"]);
    expect(group?.labels).toEqual(["RE 1", "31"]);
    trains.setLabelMode("delay");
    expect(trains.buildFrame({ includeIds: true }).groups[0]?.labels).toEqual(["+3", ""]);
  });

  it("leaves the labels out of a frame that carries no ids", async () => {
    const trains = await labelled();
    trains.setLabelMode("line");
    expect(trains.buildFrame({ includeIds: false }).groups[0]?.labels).toBeUndefined();
  });

  it("asks for a new id list when a delay label changes", async () => {
    const trains = await labelled();
    trains.setLabelMode("delay");
    const version = trains.idsVersion;
    trains.apply(
      changes([trip(1, { ...RUN, category: "reg", line: "RE 1", realtime: true, delay: 200 })]),
      T0 + 110,
    );
    expect(trains.idsVersion).toBe(version);
    trains.apply(
      changes([trip(1, { ...RUN, category: "reg", line: "RE 1", realtime: true, delay: 500 })]),
      T0 + 120,
    );
    expect(trains.idsVersion).toBeGreaterThan(version);
    expect(trains.buildFrame({ includeIds: true }).groups[0]?.labels?.[0]).toBe("+8");
  });
});

describe("LiveTrains shape priority", () => {
  it("asks for the selected train's shape ahead of a loading pack set", async () => {
    const { store, trains } = world();
    void store.loadSets(3, [() => new Promise<Uint8Array | null>(() => {})]);
    const request = vi.spyOn(store, "request");
    trains.apply(changes([trip(1, { shapeId: 41 }), trip(2, { shapeId: 42 })]), 0);
    expect(request).toHaveBeenCalledWith(3, 41, 0);
    trains.select(2);
    expect(request).toHaveBeenLastCalledWith(3, 42, URGENT_PRIORITY);
    await settle();
    expect(store.get("3/42")).toBeDefined();
    expect(store.get("3/41")).toBeUndefined();
  });
});
