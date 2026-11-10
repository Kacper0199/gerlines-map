import { describe, expect, it } from "vitest";
import type { CarView } from "../cars/car-instances.ts";
import { parseCatalog } from "../cars/catalog.ts";
import { testManifest } from "../cars/test-catalog.ts";
import type { DeckWindows } from "../map/terrain/deck-windows.ts";
import { CAR_LIFT_M, FLAT, terrainElevation } from "../map/terrain/elevation.ts";
import type { Palette } from "../motion/frame.ts";
import type { ChainChanges } from "./chain.ts";
import { LiveTrains } from "./live-trains.ts";
import { ShapeStore } from "./shape-store.ts";
import { SHAPE_X0, SHAPE_Y, stop, straightPack, TIME_BASE, trip } from "./test-frames.ts";
import { liveTrainId } from "./train-ids.ts";

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
};

const T0 = TIME_BASE;
const RUN = {
  stops: [stop(T0, T0 + 60), stop(T0 + 600, T0 + 660), stop(T0 + 1200, T0 + 1260), stop(T0 + 2400)],
};
const CLIMB = { start: 300, slope: 0.01 };
const EXAGGERATION = 1.5;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function changes(changed: ReturnType<typeof trip>[]): ChainChanges {
  return {
    time: 0,
    shapeEpoch: 3,
    reloaded: false,
    keys: null,
    changed,
    removed: [],
  };
}

async function climbing(): Promise<LiveTrains> {
  const store = new ShapeStore({
    fetchPack: async (_epoch, id) => straightPack(Number(id), 40_000, 3, Number(id), CLIMB),
    onLoaded: () => undefined,
    now: () => 0,
  });
  const trains = new LiveTrains(store, PALETTE);
  store.request(3, 7);
  await settle();
  trains.apply(changes([trip(1, { ...RUN, category: "hsr" })]), T0 + 700);
  for (let t = T0 + 700; t <= T0 + 760; t += 1 / 30) trains.advance(t);
  return trains;
}

function bakedHeightAtHead(trains: LiveTrains): number {
  const entry = trains.entry(1);
  return CLIMB.start + CLIMB.slope * (trains.fleet.s[entry?.slot ?? 0] as number);
}

describe("trains on the relief", () => {
  it("draws markers at sea level on a flat map", async () => {
    const trains = await climbing();
    const [group] = trains.buildFrame({ includeIds: false }).groups;
    expect(group?.positions[2]).toBe(0);
  });

  it("lifts a marker to the baked shape height times the exaggeration", async () => {
    const trains = await climbing();
    const elevation = terrainElevation(EXAGGERATION);
    trains.setElevation(elevation);
    const [group] = trains.buildFrame({ includeIds: false }).groups;
    expect(group?.positions[2]).toBeCloseTo(
      bakedHeightAtHead(trains) * EXAGGERATION + elevation.liftM,
      6,
    );
    expect(group?.positions[2]).toBeGreaterThan(300 * EXAGGERATION);
  });

  it("puts the selected marker at the height of its train and drops it with the terrain", async () => {
    const trains = await climbing();
    trains.select(1);
    trains.setElevation(terrainElevation(EXAGGERATION));
    const frame = trains.buildFrame({ includeIds: false });
    expect(frame.selected?.id).toBe(liveTrainId(1));
    expect(frame.selected?.z).toBeCloseTo(frame.groups[0]?.positions[2] as number, 9);
    trains.setElevation(FLAT);
    expect(trains.buildFrame({ includeIds: false }).selected?.z).toBe(0);
  });

  it("gives the route a height at every vertex, none on a flat map", async () => {
    const trains = await climbing();
    trains.select(1);
    expect(trains.selectedRoute()?.heights).toBeUndefined();
    trains.setElevation(terrainElevation(EXAGGERATION, 40));
    const route = trains.selectedRoute();
    const heights = route?.heights;
    expect(heights).toHaveLength((route?.path.length ?? 0) / 2);
    expect(heights?.[0]).toBeCloseTo(CLIMB.start * EXAGGERATION, 3);
    expect(heights?.[heights.length - 1]).toBeCloseTo(
      (CLIMB.start + CLIMB.slope * 40_000) * EXAGGERATION,
      3,
    );
  });
});

describe("cars on the relief", () => {
  const catalog = parseCatalog(testManifest());
  const view: CarView = {
    zoom: 17,
    centerX: SHAPE_X0 + 5_000,
    centerY: SHAPE_Y,
    radiusM: 20_000,
    fineRadiusM: 20_000,
  };

  it("keeps cars at sea level on a flat map", async () => {
    const trains = await climbing();
    const frame = trains.buildCars(catalog, view, [255, 176, 0]);
    const heights = frame.meshes.flatMap((mesh) =>
      Array.from(mesh.positions).filter((_, i) => i % 3 === 2),
    );
    expect(heights.length).toBeGreaterThan(0);
    expect(heights.every((height) => height === 0)).toBe(true);
  });

  it("places every bogie and car body on the exaggerated relief of its shape point", async () => {
    const trains = await climbing();
    trains.setElevation(terrainElevation(EXAGGERATION, 40));
    const frame = trains.buildCars(catalog, view, [255, 176, 0]);
    const head = bakedHeightAtHead(trains);
    const consistM = 400;
    const heights = frame.meshes.flatMap((mesh) =>
      Array.from(mesh.positions).filter((_, i) => i % 3 === 2),
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const height of heights) {
      expect(height).toBeLessThanOrEqual(head * EXAGGERATION + CAR_LIFT_M + 1e-6);
      expect(height).toBeGreaterThan((head - CLIMB.slope * consistM) * EXAGGERATION);
    }
  });

  it("pitches cars with the exaggerated climb", async () => {
    const trains = await climbing();
    const flat = trains.buildCars(catalog, view, [255, 176, 0]);
    trains.setElevation(terrainElevation(EXAGGERATION));
    const lifted = trains.buildCars(catalog, view, [255, 176, 0]);
    const pitchOf = (mesh: { matrices: Float32Array } | undefined) =>
      Math.abs(mesh?.matrices[2] ?? 0);
    const body = (frame: typeof flat) => frame.meshes.find((mesh) => mesh.mesh.endsWith("/end"));
    expect(pitchOf(lifted.meshes.length ? body(lifted) : undefined)).toBeGreaterThan(
      pitchOf(body(flat)),
    );
  });
});

describe("the line under the trains", () => {
  const box = (minX: number, maxX: number) => ({
    minX,
    maxX,
    minY: SHAPE_Y - 5000,
    maxY: SHAPE_Y + 5000,
  });
  const STEP = 1000;

  it("is empty on a flat map", async () => {
    const trains = await climbing();
    expect(trains.deckWindows(box(SHAPE_X0, SHAPE_X0 + 40_000))?.paths).toHaveLength(0);
  });

  it("holds the shape vertices inside the box and one more on each side, at their drawn heights", async () => {
    const trains = await climbing();
    trains.setElevation(terrainElevation(EXAGGERATION, 40));
    const deck = trains.deckWindows(box(SHAPE_X0 + 5500, SHAPE_X0 + 10_500)) as DeckWindows;

    expect(deck.shapeIds).toHaveLength(1);
    expect(deck.first[0]).toBe(5);
    expect(deck.counts[0]).toBe(7);
    expect(deck.paths).toHaveLength(3 * 7);
    for (let k = 0; k < 7; k++) {
      const baked = CLIMB.start + CLIMB.slope * (5 + k) * STEP;
      expect(deck.paths[3 * k + 2]).toBeCloseTo(baked * EXAGGERATION, 2);
    }
  });

  it("holds the track where no train is near, since a bridge is there with or without one", async () => {
    const trains = await climbing();
    trains.setElevation(terrainElevation(EXAGGERATION));
    const headS = trains.fleet.s[trains.entry(1)?.slot ?? 0] as number;
    const farFromTrain = SHAPE_X0 + headS + 20_000;
    const deck = trains.deckWindows(box(farFromTrain, farFromTrain + 4000));
    expect(deck?.counts).toHaveLength(1);
    expect(deck?.counts[0]).toBeGreaterThanOrEqual(5);
  });

  it("holds the whole shape when the box covers it and nothing when the box is away", async () => {
    const trains = await climbing();
    trains.setElevation(terrainElevation(EXAGGERATION));
    const whole = trains.deckWindows(box(SHAPE_X0 - 100, SHAPE_X0 + 41_000));
    expect(whole?.counts).toEqual(Uint32Array.from([41]));
    const outside = trains.deckWindows(box(0, 1000));
    expect(outside?.counts).toHaveLength(0);
  });

  it("leaves out the hidden categories", async () => {
    const trains = await climbing();
    trains.setElevation(terrainElevation(EXAGGERATION));
    trains.setHiddenCategories(["hsr"]);
    expect(trains.deckWindows(box(SHAPE_X0, SHAPE_X0 + 10_000))?.counts).toHaveLength(0);
  });

  it("returns a deck only when it differs from the last one, and again after a reset", async () => {
    const trains = await climbing();
    trains.setElevation(terrainElevation(EXAGGERATION));
    const where = box(SHAPE_X0, SHAPE_X0 + 10_000);
    expect(trains.deckWindows(where)).toBeDefined();
    expect(trains.deckWindows(where)).toBeUndefined();
    expect(trains.deckWindows(box(SHAPE_X0, SHAPE_X0 + 20_000))).toBeDefined();
    trains.resetDeck();
    expect(trains.deckWindows(box(SHAPE_X0, SHAPE_X0 + 20_000))).toBeDefined();
  });

  it("holds a track that two shapes share once", async () => {
    const store = new ShapeStore({
      fetchPack: async (_epoch, id) => straightPack(Number(id), 40_000, 3, 5, CLIMB),
      onLoaded: () => undefined,
      now: () => 0,
    });
    const trains = new LiveTrains(store, PALETTE);
    store.request(3, 7);
    store.request(3, 8);
    await settle();
    trains.apply(
      changes([
        trip(1, { ...RUN, category: "hsr", shapeId: 7 }),
        trip(2, { ...RUN, category: "hsr", shapeId: 8 }),
      ]),
      T0 + 700,
    );
    trains.setElevation(terrainElevation(EXAGGERATION));
    const deck = trains.deckWindows(box(SHAPE_X0, SHAPE_X0 + 10_000));
    expect(deck?.shapeIds).toHaveLength(1);
  });

  it("keeps the shape nearest the view centre when the vertex limit leaves room for one", async () => {
    const far = { x: SHAPE_X0, y: SHAPE_Y + 50_000 };
    const store = new ShapeStore({
      fetchPack: async (_epoch, id) =>
        straightPack(Number(id), 40_000, 3, Number(id), CLIMB, Number(id) === 7 ? far : undefined),
      onLoaded: () => undefined,
      now: () => 0,
    });
    const trains = new LiveTrains(store, PALETTE);
    store.request(3, 7);
    store.request(3, 8);
    await settle();
    trains.apply(
      changes([
        trip(1, { ...RUN, category: "hsr", shapeId: 7 }),
        trip(2, { ...RUN, category: "hsr", shapeId: 8 }),
      ]),
      T0 + 700,
    );
    trains.setElevation(terrainElevation(EXAGGERATION));
    const view = {
      minX: SHAPE_X0 - 100,
      maxX: SHAPE_X0 + 41_000,
      minY: SHAPE_Y - 60_000,
      maxY: SHAPE_Y + 60_000,
    };
    const deck = trains.deckWindows(view, 41);
    expect(deck?.shapeIds).toEqual([trains.entry(2)?.shapeId]);
  });

  it("stops adding shapes past the vertex limit", async () => {
    const trains = await climbing();
    trains.setElevation(terrainElevation(EXAGGERATION));
    const deck = trains.deckWindows(box(SHAPE_X0, SHAPE_X0 + 40_000), 10);
    expect(deck?.counts).toHaveLength(0);
  });
});
