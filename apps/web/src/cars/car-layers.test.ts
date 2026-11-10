import { describe, expect, it } from "vitest";
import type { CarFrame, MeshInstances } from "./car-instances.ts";
import {
  carLayerList,
  pickedCarKey,
  retryDelayMs,
  StaticAttributes,
  selectedMarkerFade,
  widenMatrices,
} from "./car-layers.ts";
import { FleetMerger } from "./fleet.ts";

function instances(mesh: string, lod: number, trainKeys: number[]): MeshInstances {
  const count = trainKeys.length;
  return {
    mesh,
    lod,
    count,
    positions: new Float64Array(3 * count),
    matrices: new Float32Array(12 * count),
    colors: new Uint8Array(4 * count),
    liveryRows: new Float32Array(count),
    lamps: new Float32Array(2 * count),
    selected: new Float32Array(count),
    trainKeys: Int32Array.from(trainKeys),
  };
}

function frame(drawn: number[], placed = drawn, fade = 0.6): CarFrame {
  return {
    meshes: [instances("a/end", 1, [11, 12, 13]), instances("a/bogie", 2, [21, 22])],
    trainKeys: Int32Array.from(placed),
    drawnKeys: Int32Array.from(drawn),
    blends: new Float32Array(drawn.length).fill(1),
    wanted: [],
    fade,
  };
}

describe("selectedMarkerFade", () => {
  it("keeps the marker while the cars of the selected train are narrow", () => {
    expect(selectedMarkerFade(frame([5, 7]), "live:7", 16, 50)).toBe(0);
  });

  it("fades the marker as the cars become wide, only for a train drawn as cars", () => {
    expect(selectedMarkerFade(frame([5, 7]), "live:7", 17.2, 50)).toBe(1);
    const half = selectedMarkerFade(frame([5, 7]), "live:7", 16.8, 50);
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.9);
    expect(selectedMarkerFade(frame([5], [5, 7]), "live:7", 17.2, 50)).toBe(0);
  });

  it("keeps the marker where the relief covers the cars, in step with the cover", () => {
    expect(selectedMarkerFade(frame([5, 7]), "live:7", 17.2, 50, 1)).toBe(0);
    expect(selectedMarkerFade(frame([5, 7]), "live:7", 17.2, 50, 0.25)).toBeCloseTo(0.75, 12);
    expect(selectedMarkerFade(frame([5, 7]), "live:7", 17.2, 50, 0)).toBe(1);
  });

  it("multiplies the zoom fade by the share the relief leaves uncovered", () => {
    const plain = selectedMarkerFade(frame([5, 7]), "live:7", 16.8, 50);
    expect(selectedMarkerFade(frame([5, 7]), "live:7", 16.8, 50, 0.5)).toBeCloseTo(plain * 0.5, 12);
  });

  it("keeps the marker for a train beyond the cap, a foreign id or no frame", () => {
    expect(selectedMarkerFade(frame([5]), "live:9", 17.2, 50)).toBe(0);
    expect(selectedMarkerFade(frame([5]), "gtfs:5", 17.2, 50)).toBe(0);
    expect(selectedMarkerFade(undefined, "live:5", 17.2, 50)).toBe(0);
  });
});

describe("pickedCarKey", () => {
  it("maps a picked instance of the car layer to its train key by its index in the whole fleet", () => {
    expect(pickedCarKey(frame([11]), "cars-fleet", 2)).toBe(13);
    expect(pickedCarKey(frame([11]), "cars-fleet", 3)).toBe(21);
    expect(pickedCarKey(frame([11]), "cars-fleet", 4)).toBe(22);
  });

  it("returns nothing for other layers, a missing instance or a missing frame", () => {
    expect(pickedCarKey(frame([11]), "train-chevrons", 1)).toBeUndefined();
    expect(pickedCarKey(frame([11]), "cars-fleet", -1)).toBeUndefined();
    expect(pickedCarKey(frame([11]), "cars-fleet", 5)).toBeUndefined();
    expect(pickedCarKey(undefined, "cars-fleet", 0)).toBeUndefined();
  });
});

describe("retryDelayMs", () => {
  it("waits one second after the first failure, doubling to one minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
    expect(retryDelayMs(0)).toBe(1000);
  });
});

describe("widenMatrices (satellite outline)", () => {
  it("stretches only the across axis of each instance and leaves the input alone", () => {
    const matrices = Float32Array.from([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    ]);
    const wide = widenMatrices(matrices, 2);
    expect([...wide.slice(0, 12)]).toEqual([1, 2, 3, 8, 10, 12, 7, 8, 9, 0, 0, 0]);
    expect([...wide.slice(12)]).toEqual([1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
    expect(matrices[3]).toBe(4);
  });
});

describe("carLayerList (T-5.2-a: one deck layer for all meshes)", () => {
  const deps = {
    mesh: () => ({}) as never,
    palette: {} as never,
    extension: {} as never,
    outlineExtension: {} as never,
    statics: new StaticAttributes(),
  };
  type FleetProps = { fleet: { id: string; start: number; count: number }[] };
  const fleetOfLayer = (layer: unknown) => (layer as { props: FleetProps }).props.fleet;

  it("holds every mesh in one layer, each with its own slice of the instances", () => {
    const layers = carLayerList(frame([1]), deps);
    expect(layers.map((layer) => layer.id)).toEqual(["cars-fleet"]);
    expect(fleetOfLayer(layers[0]).map(({ id, start, count }) => ({ id, start, count }))).toEqual([
      { id: "a/end@1", start: 0, count: 3 },
      { id: "a/bogie@2", start: 3, count: 2 },
    ]);
  });

  it("puts the casings in a layer before the cars, and skips meshes that are not loaded", () => {
    expect(carLayerList(frame([1]), deps).length).toBe(1);
    expect(carLayerList(frame([1]), deps, true).map((layer) => layer.id)).toEqual([
      "car-outline-fleet",
      "cars-fleet",
    ]);
    const half = { ...deps, mesh: (key: string) => (key === "a/end" ? ({} as never) : undefined) };
    const layers = carLayerList(frame([1]), half, true);
    expect(layers.map((layer) => layer.id)).toEqual(["car-outline-fleet", "cars-fleet"]);
    expect(fleetOfLayer(layers[1]).map((draw) => draw.id)).toEqual(["a/end@1"]);
  });

  it("draws nothing while no mesh is loaded", () => {
    const none = { ...deps, mesh: () => undefined };
    expect(carLayerList(frame([1]), none, true)).toEqual([]);
  });

  it("hands deck the same widened matrices while the instances are unchanged", () => {
    const f = frame([1]);
    const a = carLayerList(f, deps, true)[0]?.props as {
      data: { attributes: { instanceModelMatrix: { value: Float32Array } } };
    };
    const b = carLayerList(f, deps, true)[0]?.props as typeof a;
    expect(b.data.attributes.instanceModelMatrix.value).toBe(
      a.data.attributes.instanceModelMatrix.value,
    );
  });

  it("gives every instance its index in the fleet, as one attribute that is never re-sent", () => {
    type Attrs = { data: { attributes: { getFleetIndex: { value: Float32Array } } } };
    const a = carLayerList(frame([1]), deps)[0]?.props as Attrs;
    const b = carLayerList(frame([1]), deps)[0]?.props as Attrs;
    expect([...a.data.attributes.getFleetIndex.value.slice(0, 5)]).toEqual([0, 1, 2, 3, 4]);
    expect(b.data.attributes.getFleetIndex).toBe(a.data.attributes.getFleetIndex);
  });
});

describe("StaticAttributes and unchanged instance attributes (T-5.2-a)", () => {
  const deps = {
    mesh: () => ({}) as never,
    palette: {} as never,
    extension: {} as never,
    outlineExtension: {} as never,
    statics: new StaticAttributes(),
  };
  type Attributes = Record<string, { value: ArrayBufferView }>;
  const attributesOf = (layer: unknown): Attributes =>
    (layer as { props: { data: { attributes: Attributes } } }).props.data.attributes;

  it("hands deck the same attribute objects while colour, livery, lamps and selection are equal", () => {
    const a = attributesOf(carLayerList(frame([1]), deps)[0]);
    const next = frame([1]);
    const b = attributesOf(carLayerList(next, deps)[0]);
    for (const name of ["getColor", "getLiveryRow", "getLamps", "getSelected"]) {
      expect(b[name]).toBe(a[name]);
    }
    expect(b.getPosition).not.toBe(a.getPosition);
  });

  it("hands over a new attribute when one value changed, and only for that attribute", () => {
    const first = attributesOf(carLayerList(frame([1]), deps)[0]);
    const changed = frame([1]);
    (changed.meshes[0]?.lamps as Float32Array)[1] = 2;
    const second = attributesOf(carLayerList(changed, deps)[0]);
    expect(second.getLamps).not.toBe(first.getLamps);
    expect(second.getColor).toBe(first.getColor);
  });

  it("forgets the attributes when the layer is no longer drawn", () => {
    const statics = new StaticAttributes();
    const own = { ...deps, statics };
    const a = attributesOf(carLayerList(frame([1]), own)[0]);
    carLayerList(frame([1]), { ...own, mesh: () => undefined });
    const back = attributesOf(carLayerList(frame([1]), own)[0]);
    expect(back.getColor).not.toBe(a.getColor);
  });
});

describe("StaticAttributes with a statics version", () => {
  it("returns the same attribute for the same version without looking at the values", () => {
    const statics = new StaticAttributes();
    statics.begin();
    const a = statics.attribute("l", "color", Uint8Array.from([1, 2, 3, 4]), 4, true, 7);
    statics.end();
    statics.begin();
    const b = statics.attribute("l", "color", Uint8Array.from([9, 9, 9, 9]), 4, true, 7);
    statics.end();
    expect(b).toBe(a);
  });

  it("returns a new attribute when the version moved, even for equal values", () => {
    const statics = new StaticAttributes();
    statics.begin();
    const a = statics.attribute("l", "color", Uint8Array.from([1, 2, 3, 4]), 4, true, 7);
    statics.end();
    statics.begin();
    const b = statics.attribute("l", "color", Uint8Array.from([1, 2, 3, 4]), 4, true, 8);
    statics.end();
    expect(b).not.toBe(a);
    expect(b.value).toEqual(Uint8Array.from([1, 2, 3, 4]));
  });

  it("carLayerList passes the fleet's version to every static attribute", () => {
    const statics = new StaticAttributes();
    const parts = {
      mesh: () => ({}) as never,
      palette: {} as never,
      extension: {} as never,
      outlineExtension: {} as never,
      statics,
    };
    const first = frame([1]);
    const fleet = new FleetMerger().merge(first.meshes);
    const withFleet: CarFrame = { ...first, meshes: [], fleet };
    type Attributes = Record<string, unknown>;
    const attributes = (layer: unknown) =>
      (layer as { props: { data: { attributes: Attributes } } }).props.data.attributes;
    const a = attributes(carLayerList(withFleet, parts)[0]);
    const again: CarFrame = {
      ...withFleet,
      fleet: { ...fleet, colors: Uint8Array.from(fleet.colors).fill(9) },
    };
    const b = attributes(carLayerList(again, parts)[0]);
    for (const name of ["getColor", "getLiveryRow", "getLamps", "getSelected"]) {
      expect(b[name], name).toBe(a[name]);
    }
  });

  it("does not reuse an attribute across two mergers that both are at version 1", () => {
    const statics = new StaticAttributes();
    const first = frame([1]);
    const a = new FleetMerger().merge(first.meshes);
    const b = new FleetMerger().merge(first.meshes);
    expect(a.staticsVersion).toBe(b.staticsVersion);
    const parts = {
      mesh: () => ({}) as never,
      palette: {} as never,
      extension: {} as never,
      outlineExtension: {} as never,
      statics,
    };
    const attributes = (layer: unknown) =>
      (layer as { props: { data: { attributes: Record<string, unknown> } } }).props.data.attributes;
    const one = attributes(carLayerList({ ...first, meshes: [], fleet: a }, parts)[0]);
    const two = attributes(carLayerList({ ...first, meshes: [], fleet: b }, parts)[0]);
    expect(two.getColor).not.toBe(one.getColor);
  });
});
