import type { Layer } from "@deck.gl/core";
import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { type FrameGroup, POSITION_STRIDE, type SelectedFrame } from "../motion/frame.ts";
import { colorValue, hexToRgb, type ThemeName } from "../theme/tokens.ts";
import { CHEVRON_ICONS } from "./chevron-atlas.ts";
import type { SplitRoute } from "./route-split.ts";
import { TRAIN_ANCHOR_LAYER_ID } from "./style/build-style.ts";
import type { DeckPath } from "./terrain/bridge-deck.ts";

const CROSSFADE_FROM_ZOOM = 9.5;
const CROSSFADE_SPAN = 1;
const SEPARATION_STROKE_PX = 0.8;
const HOLLOW_STROKE_PX = 2;

export interface TrainLayerInput {
  readonly groups: readonly FrameGroup[];
  readonly selected: SelectedFrame | null;
  readonly route: SplitRoute | undefined;
  readonly zoom: number;
  readonly theme: ThemeName;
  readonly iconAtlas: HTMLCanvasElement | undefined;
  /** How far the selected train's chevron marker gives way to its cars (0 when it is not drawn as cars). */
  readonly carFade?: number;
  /** 3D terrain is on: the selection is drawn over the relief, never hidden by a ridge or a coarse mesh. */
  readonly terrain?: boolean;
  /**
   * The map is tilted: paths and markers drawn at the same height would fight over the depth buffer
   * (the route shows as dashes), so the selection ignores depth and the chevrons write none, as on the relief.
   */
  readonly pitched?: boolean;
  /**
   * Stretches of track that run high above the relief (viaducts), as longitude, latitude and height
   * triples. The same array is passed again while the stretches do not change, so nothing rebuilds.
   */
  readonly deck?: readonly DeckPath[];
  /** Layers drawn over the selected route and under the trains, such as the segment profile. */
  readonly routeExtras?: readonly Layer[];
}

/** Share of a chevron's opacity left where a ridge, a tunnel mountain or a building stands in front of it. */
export const GHOST_OPACITY = 0.4;
const BEHIND = { depthCompare: "greater", depthWriteEnabled: false } as const;
/**
 * Chevrons test against the relief and the buildings but leave their own depth out of the buffer,
 * so a ghost is judged against what really stands in front of a train, not against another chevron.
 */
const NO_DEPTH_WRITE = { depthWriteEnabled: false } as const;
const OVER_RELIEF = { depthCompare: "always", depthWriteEnabled: false } as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolate(zoom: number, stops: readonly (readonly [number, number])[]): number {
  const first = stops[0] as readonly [number, number];
  const last = stops[stops.length - 1] as readonly [number, number];
  if (zoom <= first[0]) {
    return first[1];
  }
  if (zoom >= last[0]) {
    return last[1];
  }
  for (let i = 1; i < stops.length; i++) {
    const [z1, v1] = stops[i] as readonly [number, number];
    const [z0, v0] = stops[i - 1] as readonly [number, number];
    if (zoom <= z1) {
      return v0 + ((zoom - z0) / (z1 - z0)) * (v1 - v0);
    }
  }
  return last[1];
}

export function chevronOpacity(zoom: number): number {
  return clamp01((zoom - CROSSFADE_FROM_ZOOM) / CROSSFADE_SPAN);
}

export function dotOpacity(zoom: number): number {
  return 1 - chevronOpacity(zoom);
}

export function dotRadiusPixels(zoom: number): number {
  return interpolate(zoom, [
    [4, 2.5],
    [8, 3.6],
    [11, 5],
  ]);
}

export function chevronPixels(zoom: number): number {
  return interpolate(zoom, [
    [9.5, 13],
    [13, 24],
    [17, 34],
  ]);
}

function rgba(hex: string, alpha = 255): [number, number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r, g, b, alpha];
}

function binary(group: FrameGroup, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    length: group.count,
    attributes: {
      getPosition: { value: group.positions, size: POSITION_STRIDE },
      ...extra,
    },
  };
}

function dotLayer(group: FrameGroup, zoom: number): Layer {
  const opacity = dotOpacity(zoom);
  return new ScatterplotLayer({
    id: group.hollow ? "trains-dots-night" : "trains-dots",
    data: binary(group, {
      getRadius: { value: group.sizes, size: 1 },
      getFillColor: { value: group.fillColors, size: 4, normalized: true },
      getLineColor: { value: group.lineColors, size: 4, normalized: true },
    }) as never,
    radiusUnits: "pixels",
    radiusScale: dotRadiusPixels(zoom),
    stroked: true,
    lineWidthUnits: "pixels",
    getLineWidth: group.hollow ? HOLLOW_STROKE_PX : SEPARATION_STROKE_PX,
    opacity,
    visible: opacity > 0 && group.count > 0,
    pickable: true,
    beforeId: TRAIN_ANCHOR_LAYER_ID,
  });
}

function chevronData(group: FrameGroup): never {
  return binary(group, {
    getAngle: { value: group.iconAngles, size: 1 },
    getSize: { value: group.sizes, size: 1 },
    getColor: {
      value: group.hollow ? group.lineColors : group.fillColors,
      size: 4,
      normalized: true,
    },
  }) as never;
}

interface ChevronOptions {
  readonly ghost?: boolean;
  readonly terrain?: boolean;
}

function chevronLayer(
  group: FrameGroup,
  data: never,
  zoom: number,
  atlas: HTMLCanvasElement | undefined,
  { ghost = false, terrain = false }: ChevronOptions = {},
): Layer {
  const opacity = chevronOpacity(zoom) * (ghost ? GHOST_OPACITY : 1);
  const base = group.hollow ? "trains-chevrons-night" : "trains-chevrons";
  const parameters = ghost ? BEHIND : terrain ? NO_DEPTH_WRITE : undefined;
  return new IconLayer({
    id: ghost ? `${base}-ghost` : base,
    data,
    iconAtlas: atlas as never,
    iconMapping: CHEVRON_ICONS,
    getIcon: (group.hollow ? "chevron-hollow" : "chevron") as never,
    sizeUnits: "pixels",
    sizeScale: chevronPixels(zoom),
    opacity,
    visible: opacity > 0 && group.count > 0,
    pickable: !ghost,
    ...(parameters ? { parameters } : {}),
    beforeId: TRAIN_ANCHOR_LAYER_ID,
  });
}

function routeLayers(route: SplitRoute, theme: ThemeName, depthFree: boolean): Layer[] {
  const path = (
    id: string,
    points: Float32Array,
    color: [number, number, number, number],
    width: number,
  ) =>
    new PathLayer({
      id,
      data: [{ path: points }],
      positionFormat: "XYZ",
      getPath: (d: { path: Float32Array }) => d.path as never,
      getColor: color,
      getWidth: width,
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      ...(depthFree ? { parameters: OVER_RELIEF } : {}),
      beforeId: TRAIN_ANCHOR_LAYER_ID,
    });
  return [
    path("selected-route-casing", route.ahead, rgba(colorValue("on-primary", theme), 217), 8),
    path("selected-route-past", route.passed, rgba(colorValue("ink", theme), 115), 3),
    path("selected-route-ahead", route.ahead, rgba(colorValue("primary", theme)), 4),
  ];
}

const DECK_WIDTH_STOPS = [
  [12, 1.8],
  [16, 3.2],
] as const;
const DECK_CASING_EXTRA_PX = 2.5;

function deckLayers(data: readonly DeckPath[], zoom: number, theme: ThemeName): Layer[] {
  const width = interpolate(zoom, DECK_WIDTH_STOPS);
  const path = (id: string, color: [number, number, number, number], pixels: number) =>
    new PathLayer({
      id,
      data,
      positionFormat: "XYZ",
      getPath: (d: { path: Float32Array }) => d.path as never,
      getColor: color,
      getWidth: pixels,
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      pickable: false,
      parameters: { depthWriteEnabled: false },
      beforeId: TRAIN_ANCHOR_LAYER_ID,
    });
  return [
    path("deck-casing", rgba(colorValue("map-land", theme), 217), width + DECK_CASING_EXTRA_PX),
    path("deck-line", rgba(colorValue("map-label", theme)), width),
  ];
}

/**
 * The marker of the selected train has no `beforeId`, so it draws on top of the map's own layers,
 * place labels included: a label never hides the one train the user chose. Every other train layer
 * stays under the labels.
 */
function selectedMarkers(
  selected: SelectedFrame,
  zoom: number,
  theme: ThemeName,
  atlas: HTMLCanvasElement | undefined,
  carFade: number,
  depthFree: boolean,
): Layer[] {
  const overRelief = depthFree ? { parameters: OVER_RELIEF } : {};
  const ring = rgba(colorValue("on-primary", theme));
  const amber = rgba(colorValue("primary", theme));
  const datum = [{ position: [selected.lon, selected.lat, selected.z], angle: -selected.bearing }];
  const dotVisible = dotOpacity(zoom) > 0;
  const chevronVisible = chevronOpacity(zoom) > 0;
  const marker = (id: string, color: [number, number, number, number], pixels: number) =>
    new IconLayer({
      id,
      data: datum,
      iconAtlas: atlas as never,
      iconMapping: CHEVRON_ICONS,
      getIcon: "chevron" as never,
      getPosition: (d: (typeof datum)[number]) => d.position as [number, number, number],
      getAngle: (d: (typeof datum)[number]) => d.angle,
      getColor: color,
      sizeUnits: "pixels",
      sizeScale: pixels,
      opacity: 1 - carFade,
      visible: chevronVisible && carFade < 1,
      ...overRelief,
    });
  const chevron = chevronPixels(zoom) * 1.3;
  return [
    new ScatterplotLayer({
      id: "selected-halo",
      data: datum,
      getPosition: (d: (typeof datum)[number]) => d.position as [number, number, number],
      stroked: true,
      filled: false,
      getLineColor: amber,
      lineWidthUnits: "pixels",
      getLineWidth: 2.5,
      radiusUnits: "pixels",
      getRadius: interpolate(zoom, [
        [4, 9],
        [13, 17],
      ]),
      visible: dotVisible,
      ...overRelief,
    }),
    new ScatterplotLayer({
      id: "selected-dot",
      data: datum,
      getPosition: (d: (typeof datum)[number]) => d.position as [number, number, number],
      getFillColor: amber,
      getLineColor: ring,
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 1.5,
      radiusUnits: "pixels",
      getRadius: interpolate(zoom, [
        [4, 4.5],
        [11, 7],
      ]),
      visible: dotVisible,
      ...overRelief,
    }),
    marker("selected-chevron-ring", ring, chevron + 6),
    marker("selected-chevron", amber, chevron),
  ];
}

export function buildTrainLayers(input: TrainLayerInput): Layer[] {
  const { groups, selected, route, zoom, theme, iconAtlas, carFade = 0, terrain = false } = input;
  const depthFree = terrain || input.pitched === true;
  const layers: Layer[] = [];
  if (terrain && input.deck && input.deck.length > 0) {
    layers.push(...deckLayers(input.deck, zoom, theme));
  }
  if (selected && route) {
    layers.push(...routeLayers(route, theme, depthFree));
    if (input.routeExtras) layers.push(...input.routeExtras);
  }
  for (const group of groups) {
    layers.push(dotLayer(group, zoom));
  }
  const data = groups.map(chevronData);
  groups.forEach((group, i) => {
    layers.push(chevronLayer(group, data[i] as never, zoom, iconAtlas, { terrain: depthFree }));
  });
  if (terrain) {
    groups.forEach((group, i) => {
      layers.push(chevronLayer(group, data[i] as never, zoom, iconAtlas, { ghost: true }));
    });
  }
  if (selected) {
    layers.push(...selectedMarkers(selected, zoom, theme, iconAtlas, carFade, depthFree));
  }
  return layers;
}
