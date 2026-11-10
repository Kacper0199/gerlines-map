import type { LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";
import { EMPTY_POINTS, type PointCollection } from "../geo-base.ts";
import { layer, linearRamp } from "./layer-kit.ts";
import {
  focusOutlineLayers,
  landLabelLayers,
  maskLayers,
  neighbourLabelLayers,
  outlineLayers,
} from "./layers-geo.ts";
import {
  BUILDING_EXTRUSION_LAYER_ID,
  BUILDING_EXTRUSION_ZOOM,
  boundaryLayers,
  buildingExtrusionLayer,
  detailLayers,
  landLayers,
  lineLabelLayers,
  placeLayers,
  railwayLayers,
  roadLayers,
} from "./layers-vector.ts";
import { isLandCode, type LandCode, type MapStyleKind } from "./map-styles.ts";
import {
  hillshadePalette,
  type MapPalette,
  mapPalette,
  SATELLITE_TREATMENT,
  TERRAIN_EXAGGERATION,
} from "./palette.ts";

export { BUILDING_EXTRUSION_LAYER_ID, BUILDING_EXTRUSION_ZOOM };
export const TRAIN_ANCHOR_LAYER_ID = "trains-anchor";
export const TERRAIN_SOURCE_ID = "terrain-dem";

export const TILES_URL = "https://tiles.openfreemap.org/planet";
export const GLYPHS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
export const SATELLITE_TILES_URL = "https://tiles.versatiles.org/tiles/satellite/{z}/{x}/{y}";
export const SATELLITE_MAX_ZOOM = 17;
export const SATELLITE_BASE_MAX_ZOOM = 12;
export const SATELLITE_DETAIL_BOUNDS: [number, number, number, number] = [-1, 43, 15.1, 59];
export const DEM_TILES_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
export const DEM_MAX_ZOOM = 12;
const HILLSHADE_FULL_ZOOM = 6;
const HILLSHADE_CALM_ZOOM = 9;

export type GeoCollection = GeoJSON.FeatureCollection;

export interface GeoData {
  readonly mask?: GeoCollection;
  readonly outline?: GeoCollection;
  readonly neighbours?: GeoCollection;
  readonly laender?: GeoCollection;
  readonly landMasks?: Readonly<Partial<Record<LandCode, GeoCollection>>>;
}

export interface StyleOptions {
  readonly style: MapStyleKind;
  readonly assetBaseUrl: string;
  readonly labelLanguage: string;
  readonly focus?: LandCode | null;
  readonly terrain3d?: boolean;
  readonly buildings?: boolean;
  readonly landLabels?: PointCollection;
  readonly geo?: GeoData;
}

/**
 * MapLibre's default light (intensity 0.5) shades the walls to about 60 % of the building token,
 * darker than the labels and the rails; at 0.22 the shaded wall of #E3E0D8 stays above #B0ADA6
 * and the roof keeps the token.
 */
export const BUILDING_LIGHT_INTENSITY = 0.22;

/** Buildings stand up only on the relief: Dark and Light cannot tilt, so extruded walls would only recolour them. */
export function extrudesBuildings(
  options: Pick<StyleOptions, "style" | "terrain3d" | "buildings">,
): boolean {
  return options.style === "terrain" && options.terrain3d === true && options.buildings === true;
}

export function focusOf(options: Pick<StyleOptions, "focus">): LandCode | null {
  return isLandCode(options.focus) ? options.focus : null;
}

function demSource(): SourceSpecification {
  return {
    type: "raster-dem",
    tiles: [DEM_TILES_URL],
    tileSize: 512,
    maxzoom: DEM_MAX_ZOOM,
    encoding: "terrarium",
  };
}

function satelliteSource(maxzoom: number, detail: boolean): SourceSpecification {
  return {
    type: "raster",
    tiles: [SATELLITE_TILES_URL],
    tileSize: 512,
    maxzoom,
    ...(detail ? { minzoom: SATELLITE_BASE_MAX_ZOOM + 1, bounds: SATELLITE_DETAIL_BOUNDS } : {}),
  };
}

function sources(options: StyleOptions, origin: string): Record<string, SourceSpecification> {
  const focus = focusOf(options);
  const geo = options.geo ?? {};
  const url = (path: string) => `${origin}/geo/${path}`;
  const data = (held: GeoCollection | undefined, path: string) => held ?? url(path);
  const result: Record<string, SourceSpecification> = {
    openmaptiles: { type: "vector", url: TILES_URL },
    mask: {
      type: "geojson",
      data:
        focus === null
          ? data(geo.mask, "germany-mask.geojson")
          : data(geo.landMasks?.[focus], `laender-masks/${focus}.geojson`),
      ...(focus === null ? {} : { tolerance: 0 }),
    },
    outline: { type: "geojson", data: data(geo.outline, "germany-outline.geojson") },
    "laender-labels": {
      type: "geojson",
      data: (options.landLabels ?? EMPTY_POINTS) as unknown as GeoCollection,
    },
    neighbours: { type: "geojson", data: data(geo.neighbours, "neighbours.geojson") },
  };
  if (focus !== null) {
    result.laender = { type: "geojson", data: data(geo.laender, "laender.geojson"), tolerance: 0 };
  }
  if (options.style === "satellite") {
    result["satellite-base"] = satelliteSource(SATELLITE_BASE_MAX_ZOOM, false);
    result.satellite = satelliteSource(SATELLITE_MAX_ZOOM, true);
  }
  if (options.style === "terrain") {
    result.hillshade = demSource();
    result[TERRAIN_SOURCE_ID] = demSource();
  }
  return result;
}

function imageryLayer(id: string): LayerSpecification {
  return layer({
    id,
    type: "raster",
    source: id,
    paint: {
      "raster-brightness-max": SATELLITE_TREATMENT.brightnessMax,
      "raster-saturation": SATELLITE_TREATMENT.saturation,
      "raster-contrast": SATELLITE_TREATMENT.contrast,
      "raster-fade-duration": 0,
    },
  });
}

function groundLayers(
  style: MapStyleKind,
  p: MapPalette,
  extrudeBuildings: boolean,
): LayerSpecification[] {
  const background = layer({
    id: "background",
    type: "background",
    paint: { "background-color": p.land },
  });
  const extrusion = extrudeBuildings ? [buildingExtrusionLayer(p)] : [];
  if (style === "satellite") {
    return [background, imageryLayer("satellite-base"), imageryLayer("satellite")];
  }
  if (style === "terrain") {
    const shade = hillshadePalette(style);
    return [
      background,
      ...landLayers(p, true),
      layer({
        id: "hillshade",
        type: "hillshade",
        source: "hillshade",
        paint: {
          "hillshade-shadow-color": [
            "interpolate",
            ["linear"],
            ["zoom"],
            HILLSHADE_FULL_ZOOM,
            shade.shadowLowZoom,
            HILLSHADE_CALM_ZOOM,
            shade.shadow,
          ],
          "hillshade-highlight-color": shade.highlight,
          "hillshade-accent-color": shade.accent,
          "hillshade-exaggeration": linearRamp(
            HILLSHADE_FULL_ZOOM,
            shade.exaggerationLowZoom,
            HILLSHADE_CALM_ZOOM,
            shade.exaggeration,
          ),
        },
      }),
      ...detailLayers(p),
      ...roadLayers(p),
      ...extrusion,
    ];
  }
  return [background, ...landLayers(p, false), ...detailLayers(p), ...roadLayers(p), ...extrusion];
}

export function buildStyle(options: StyleOptions): StyleSpecification {
  const { style, labelLanguage } = options;
  const focus = focusOf(options);
  const palette = mapPalette(style);
  const origin = options.assetBaseUrl.replace(/\/+$/, "");
  const satellite = style === "satellite";
  const spec: StyleSpecification = {
    version: 8,
    name: `GerLines Fahrplan ${style}`,
    glyphs: GLYPHS_URL,
    sources: sources(options, origin),
    layers: [
      ...groundLayers(style, palette, extrudesBuildings(options)),
      ...maskLayers(palette, focus, style === "terrain" && options.terrain3d === true),
      ...railwayLayers(palette, !satellite, style === "terrain" && options.terrain3d === true),
      layer({ id: TRAIN_ANCHOR_LAYER_ID, type: "background", paint: { "background-opacity": 0 } }),
      ...boundaryLayers(palette).filter((entry) => !(focus && entry.id === "boundary_state")),
      ...outlineLayers(palette, focus),
      ...focusOutlineLayers(palette, focus),
      ...lineLabelLayers(palette, labelLanguage),
      ...landLabelLayers(palette, labelLanguage),
      ...placeLayers(palette, labelLanguage),
      ...neighbourLabelLayers(palette, labelLanguage),
    ],
  };
  if (extrudesBuildings(options)) spec.light = { intensity: BUILDING_LIGHT_INTENSITY };
  if (style === "terrain" && options.terrain3d) {
    spec.terrain = { source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION };
  }
  return spec;
}
