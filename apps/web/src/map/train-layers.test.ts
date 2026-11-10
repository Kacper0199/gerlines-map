import type { Layer } from "@deck.gl/core";
import { describe, expect, it } from "vitest";
import type { FrameGroup, SelectedFrame } from "../motion/frame.ts";
import { TRAIN_ANCHOR_LAYER_ID } from "./style/build-style.ts";
import {
  buildTrainLayers,
  chevronOpacity,
  chevronPixels,
  dotOpacity,
  dotRadiusPixels,
  GHOST_OPACITY,
} from "./train-layers.ts";

function group(count: number, hollow = false): FrameGroup {
  return {
    hollow,
    count,
    positions: new Float32Array(3 * count),
    iconAngles: new Float32Array(count),
    sizes: new Float32Array(count).fill(1),
    fillColors: new Uint8Array(4 * count),
    lineColors: new Uint8Array(4 * count),
    ids: undefined,
  };
}

const SELECTED: SelectedFrame = {
  id: "trip",
  lon: 8.5,
  lat: 50.1,
  bearing: 90,
  z: 0,
  alpha: 1,
  legKey: "leg",
  vertex: 0,
};

const ROUTE = {
  passed: Float32Array.from([8, 50, 0, 8.5, 50.1, 0]),
  ahead: Float32Array.from([8.5, 50.1, 0, 9, 50.2, 0]),
};

function idsOf(zoom: number, selected = false): string[] {
  return buildTrainLayers({
    groups: [group(3), group(1, true)],
    selected: selected ? SELECTED : null,
    route: selected ? ROUTE : undefined,
    zoom,
    theme: "dark",
    iconAtlas: undefined,
  })
    .filter((layer) => (layer.props as { visible?: boolean }).visible !== false)
    .map((layer) => layer.id);
}

describe("level of detail curves", () => {
  it("shows dots below zoom 9.5, chevrons above zoom 10.5 and both in between", () => {
    expect(dotOpacity(8)).toBe(1);
    expect(chevronOpacity(8)).toBe(0);
    expect(dotOpacity(10)).toBeCloseTo(0.5);
    expect(chevronOpacity(10)).toBeCloseTo(0.5);
    expect(dotOpacity(11)).toBe(0);
    expect(chevronOpacity(11)).toBe(1);
  });

  it("grows dots and chevrons with the zoom", () => {
    expect(dotRadiusPixels(4)).toBeCloseTo(2.5);
    expect(dotRadiusPixels(8)).toBeCloseTo(3.6);
    expect(dotRadiusPixels(11)).toBeCloseTo(5);
    expect(dotRadiusPixels(15)).toBeCloseTo(5);
    expect(chevronPixels(13)).toBeGreaterThan(chevronPixels(10));
    expect(chevronPixels(17)).toBeGreaterThan(chevronPixels(13));
  });
});

describe("buildTrainLayers", () => {
  it("draws dots and hollow night dots at national zoom", () => {
    expect(idsOf(6)).toEqual(["trains-dots", "trains-dots-night"]);
  });

  it("draws chevrons from zoom 11", () => {
    expect(idsOf(12)).toEqual(["trains-chevrons", "trains-chevrons-night"]);
  });

  it("draws both kinds while the zoom crosses 10", () => {
    expect(idsOf(10)).toEqual([
      "trains-dots",
      "trains-dots-night",
      "trains-chevrons",
      "trains-chevrons-night",
    ]);
  });

  it("puts the selected train and its route on top in the selection colour", () => {
    const layers = buildTrainLayers({
      groups: [group(3), group(1, true)],
      selected: SELECTED,
      route: ROUTE,
      zoom: 6,
      theme: "dark",
      iconAtlas: undefined,
    });
    const ids = layers.map((layer) => layer.id);

    expect(ids.slice(0, 3)).toEqual([
      "selected-route-casing",
      "selected-route-past",
      "selected-route-ahead",
    ]);
    expect(ids.indexOf("selected-dot")).toBeGreaterThan(ids.indexOf("trains-dots"));
    const ahead = layers.find((layer) => layer.id === "selected-route-ahead") as Layer;
    expect((ahead.props as { getColor?: number[] }).getColor).toEqual([255, 176, 0, 255]);
  });

  it("fades the selected chevron marker by the car fade and hides it once the cars are opaque", () => {
    const marker = (carFade: number) => {
      const layer = buildTrainLayers({
        groups: [group(3), group(1, true)],
        selected: SELECTED,
        route: ROUTE,
        zoom: 15,
        theme: "dark",
        iconAtlas: undefined,
        carFade,
      }).find((entry) => entry.id === "selected-chevron") as Layer;
      return layer.props as { opacity: number; visible: boolean };
    };
    expect(marker(0)).toMatchObject({ opacity: 1, visible: true });
    expect(marker(0.25)).toMatchObject({ opacity: 0.75, visible: true });
    expect(marker(1)).toMatchObject({ opacity: 0, visible: false });
  });

  it("adds nothing for a selection when no train is selected", () => {
    expect(idsOf(6).some((id) => id.startsWith("selected"))).toBe(false);
  });

  it("draws the marker of the selected train above the place labels and everything else under them", () => {
    const layers = buildTrainLayers({
      groups: [group(3), group(1, true)],
      selected: SELECTED,
      route: ROUTE,
      zoom: 10,
      theme: "dark",
      iconAtlas: undefined,
    });
    const above = ["selected-halo", "selected-dot", "selected-chevron-ring", "selected-chevron"];
    for (const layer of layers) {
      const beforeId = (layer.props as { beforeId?: string }).beforeId;
      expect(beforeId).toBe(above.includes(layer.id) ? undefined : TRAIN_ANCHOR_LAYER_ID);
    }
    expect(layers.filter((layer) => above.includes(layer.id))).toHaveLength(4);
  });

  it("lets only the trains be picked", () => {
    const layers = buildTrainLayers({
      groups: [group(3), group(1, true)],
      selected: SELECTED,
      route: ROUTE,
      zoom: 10,
      theme: "dark",
      iconAtlas: undefined,
    });

    const pickable = layers.filter((layer) => (layer.props as { pickable?: boolean }).pickable);
    expect(pickable.map((layer) => layer.id).sort()).toEqual([
      "trains-chevrons",
      "trains-chevrons-night",
      "trains-dots",
      "trains-dots-night",
    ]);
  });

  it("hands the typed arrays of a frame to the layers without copying them", () => {
    const normal = group(3);
    const layers = buildTrainLayers({
      groups: [normal, group(0, true)],
      selected: null,
      route: undefined,
      zoom: 6,
      theme: "dark",
      iconAtlas: undefined,
    });
    const dots = layers.find((layer) => layer.id === "trains-dots") as Layer;
    const data = (
      dots.props as { data: { length: number; attributes: Record<string, { value: unknown }> } }
    ).data;

    expect(data.length).toBe(3);
    expect(data.attributes.getPosition?.value).toBe(normal.positions);
  });
});

describe("the selection over the relief", () => {
  const drawn = (terrain: boolean) =>
    buildTrainLayers({
      groups: [group(1)],
      selected: SELECTED,
      route: ROUTE,
      zoom: 14,
      theme: "light",
      iconAtlas: undefined,
      terrain,
    });
  const parametersOf = (layer: Layer) =>
    (layer.props as { parameters?: Record<string, unknown> }).parameters ?? {};

  it("draws the route and the markers without the depth test and without writing depth", () => {
    for (const id of [
      "selected-route-casing",
      "selected-route-past",
      "selected-route-ahead",
      "selected-halo",
      "selected-dot",
      "selected-chevron-ring",
      "selected-chevron",
    ]) {
      const layer = drawn(true).find((entry) => entry.id === id) as Layer;
      expect(parametersOf(layer), id).toMatchObject({
        depthCompare: "always",
        depthWriteEnabled: false,
      });
    }
  });

  it("leaves the depth state alone on a flat map and on the other trains", () => {
    expect(drawn(false).every((layer) => !("depthCompare" in parametersOf(layer)))).toBe(true);
    const others = drawn(true).filter(
      (layer) => layer.id.startsWith("trains-") && !layer.id.endsWith("-ghost"),
    );
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((layer) => !("depthCompare" in parametersOf(layer)))).toBe(true);
  });
});

describe("the selection on a tilted flat map", () => {
  const tilted = buildTrainLayers({
    groups: [group(1)],
    selected: SELECTED,
    route: ROUTE,
    zoom: 12,
    theme: "dark",
    iconAtlas: undefined,
    terrain: false,
    pitched: true,
  });
  const parametersOf = (layer: Layer) =>
    (layer.props as { parameters?: Record<string, unknown> }).parameters ?? {};

  it("draws the route and the markers without the depth test, so the casing and the line do not fight", () => {
    for (const id of ["selected-route-casing", "selected-route-ahead", "selected-chevron"]) {
      const layer = tilted.find((entry) => entry.id === id) as Layer;
      expect(parametersOf(layer), id).toMatchObject({
        depthCompare: "always",
        depthWriteEnabled: false,
      });
    }
  });

  it("keeps the other trains out of the depth buffer and draws no ghosts", () => {
    const chevrons = tilted.filter((layer) => layer.id.startsWith("trains-chevrons"));
    expect(chevrons).toHaveLength(1);
    for (const layer of chevrons) expect(parametersOf(layer)).toEqual({ depthWriteEnabled: false });
    expect(tilted.some((layer) => layer.id.endsWith("-ghost"))).toBe(false);
  });
});

describe("the track under the trains on the relief", () => {
  const deck = [
    { path: Float32Array.from([8, 50, 300, 8.001, 50, 300]) },
    { path: Float32Array.from([8.01, 50, 280, 8.011, 50, 281]) },
  ];
  const input = {
    groups: [group(1)],
    selected: null,
    route: undefined,
    zoom: 14,
    theme: "light",
    iconAtlas: undefined,
    terrain: true,
    deck,
  } as const;

  it("draws the stretches below the markers, with a casing and without writing depth", () => {
    const layers = buildTrainLayers(input);
    const ids = layers.map((layer) => layer.id);

    expect(ids.indexOf("deck-casing")).toBeLessThan(ids.indexOf("deck-line"));
    expect(ids.indexOf("deck-line")).toBeLessThan(ids.indexOf("trains-dots"));
    const line = layers.find((layer) => layer.id === "deck-line") as Layer;
    expect((line.props as { data: unknown[] }).data).toHaveLength(2);
    expect((line.props as { parameters?: Record<string, unknown> }).parameters).toMatchObject({
      depthWriteEnabled: false,
    });
  });

  it("hands the same data to the layers while the stretches stay, so they do not rebuild", () => {
    const dataOf = () =>
      buildTrainLayers(input)
        .filter((layer) => layer.id.startsWith("deck"))
        .map((layer) => (layer.props as { data: unknown }).data);
    const [first, second] = [dataOf(), dataOf()];
    expect(first).toHaveLength(2);
    expect(first[0]).toBe(deck);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("draws nothing without stretches or on a flat map", () => {
    expect(buildTrainLayers({ ...input, deck: [] }).some((l) => l.id.startsWith("deck"))).toBe(
      false,
    );
    expect(
      buildTrainLayers({ ...input, terrain: false }).some((l) => l.id.startsWith("deck")),
    ).toBe(false);
  });
});

describe("trains hidden by the relief or a building", () => {
  const input = {
    groups: [group(2), group(1, true)],
    selected: null,
    route: undefined,
    zoom: 15,
    theme: "light",
    iconAtlas: undefined,
  } as const;
  const parametersOf = (layer: Layer) =>
    (layer.props as { parameters?: Record<string, unknown> }).parameters ?? {};

  it("draws each chevron again where something stands in front of it, faint and not pickable", () => {
    const layers = buildTrainLayers({ ...input, terrain: true });
    const ghosts = layers.filter((layer) => layer.id.endsWith("-ghost"));

    expect(ghosts.map((layer) => layer.id)).toEqual([
      "trains-chevrons-ghost",
      "trains-chevrons-night-ghost",
    ]);
    for (const ghost of ghosts) {
      expect(parametersOf(ghost)).toMatchObject({
        depthCompare: "greater",
        depthWriteEnabled: false,
      });
      expect(ghost.props.pickable).toBe(false);
      expect(ghost.props.opacity).toBeCloseTo(chevronOpacity(15) * GHOST_OPACITY, 9);
    }
    const ids = layers.map((layer) => layer.id);
    expect(ids.indexOf("trains-chevrons-ghost")).toBeGreaterThan(ids.indexOf("trains-chevrons"));
  });

  it("keeps the chevrons out of the depth buffer so a chevron in front never hides a ghost behind it", () => {
    const chevrons = buildTrainLayers({ ...input, terrain: true }).filter(
      (layer) => layer.id.startsWith("trains-chevrons") && !layer.id.endsWith("-ghost"),
    );
    expect(chevrons).toHaveLength(2);
    for (const layer of chevrons) {
      expect(parametersOf(layer)).toEqual({ depthWriteEnabled: false });
    }
    const flat = buildTrainLayers({ ...input, terrain: false }).filter((layer) =>
      layer.id.startsWith("trains-chevrons"),
    );
    expect(flat).toHaveLength(2);
    for (const layer of flat) expect(parametersOf(layer)).toEqual({});
  });

  it("gives a chevron and its ghost the same data, so the frame is prepared once", () => {
    const layers = buildTrainLayers({ ...input, terrain: true });
    const dataOf = (id: string) =>
      (layers.find((layer) => layer.id === id) as Layer).props.data as unknown;
    expect(dataOf("trains-chevrons-ghost")).toBe(dataOf("trains-chevrons"));
    expect(dataOf("trains-chevrons-night-ghost")).toBe(dataOf("trains-chevrons-night"));
  });

  it("draws no ghosts on a flat map, where nothing hides a train", () => {
    expect(
      buildTrainLayers({ ...input, terrain: false }).some((layer) => layer.id.endsWith("-ghost")),
    ).toBe(false);
  });
});
