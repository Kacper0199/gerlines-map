import type { LayerSpecification } from "maplibre-gl";
import { geoText, type Json, layer, linearRamp, symbolLayer, THIN_LINE_JOIN } from "./layer-kit.ts";
import type { LandCode } from "./map-styles.ts";
import type { MapPalette } from "./palette.ts";

const OCEAN: Json = ["==", ["get", "class"], "ocean"];
const OUTLINE_WIDTH = linearRamp(4, 1.2, 10, 2.1);
const OUTLINE_WIDTH_FOCUSED = linearRamp(4, 0.8, 10, 1.4);
const OUTLINE_FADE = linearRamp(11, 1, 12, 0);
const COAST_WIDTH = linearRamp(3, 0.6, 8, 0.9, 12, 1.2, 16, 1.6);

/**
 * The fill outline pass of a fill costs a line per polygon edge. The national outline (to zoom 11, fading to 12) and
 * the multisampled canvas cover the mask's edge below zoom 11; beyond it, and on the relief, where MapLibre draws fills
 * into targets without multisampling, the pass stays.
 */
const MASK_EDGE_PASS: Json = ["step", ["zoom"], false, 11, true];

export function maskLayers(
  p: MapPalette,
  focus: LandCode | null,
  relief = false,
): LayerSpecification[] {
  const layers = [
    layer({
      id: "germany-mask",
      type: "fill",
      source: "mask",
      paint: {
        "fill-color": p.mask,
        "fill-opacity": p.maskOpacity,
        "fill-antialias": relief ? true : MASK_EDGE_PASS,
      },
    }),
    layer({
      id: "coastline",
      type: "line",
      source: "openmaptiles",
      "source-layer": "water",
      filter: OCEAN,
      layout: { "line-join": THIN_LINE_JOIN },
      paint: {
        "line-color": p.boundaryCountry,
        "line-width": COAST_WIDTH,
        "line-opacity": p.neighbourLineOpacity,
      },
    }),
  ];
  if (focus !== null) {
    layers.push(
      layer({
        id: "laender-borders",
        type: "line",
        source: "laender",
        filter: ["!=", ["get", "code"], focus],
        layout: { "line-join": "round" },
        paint: { "line-color": p.outline, "line-width": 0.8 },
      }),
    );
  }
  return layers;
}

export function outlineLayers(p: MapPalette, focus: LandCode | null): LayerSpecification[] {
  const national = focus === null;
  return [
    layer({
      id: "germany-outline",
      type: "line",
      source: "outline",
      layout: { "line-join": THIN_LINE_JOIN },
      ...(national ? { maxzoom: 12 } : {}),
      paint: {
        "line-color": p.germanyOutline,
        "line-width": national ? OUTLINE_WIDTH : OUTLINE_WIDTH_FOCUSED,
        ...(national ? { "line-opacity": OUTLINE_FADE } : {}),
      },
    }),
  ];
}

export function focusOutlineLayers(p: MapPalette, focus: LandCode | null): LayerSpecification[] {
  if (focus === null) {
    return [];
  }
  return [
    layer({
      id: "land-focus-outline",
      type: "line",
      source: "laender",
      filter: ["==", ["get", "code"], focus],
      layout: { "line-join": "round" },
      paint: { "line-color": p.focusOutline, "line-width": 1.6 },
    }),
  ];
}

function labelHalo(p: MapPalette) {
  return { "text-halo-color": p.halo, "text-halo-width": 1.6, "text-halo-blur": 0 };
}

export function landLabelLayers(p: MapPalette, language: string): LayerSpecification[] {
  return [
    symbolLayer(
      "geo_land_label",
      { source: "laender-labels" },
      "geo",
      undefined,
      {
        "text-field": geoText(language),
        "text-size": linearRamp(5, 10.5, 8, 12),
        "text-max-width": 7,
        "text-anchor": "center",
      },
      { "text-color": p.label, ...labelHalo(p) },
      { minzoom: 5, maxzoom: 8.5 },
    ),
  ];
}

export function neighbourLabelLayers(p: MapPalette, language: string): LayerSpecification[] {
  const neighbour = (id: string, filter: Json, minzoom: number) =>
    symbolLayer(
      id,
      { source: "neighbours" },
      "geo",
      filter,
      {
        "text-field": geoText(language),
        "text-size": 12.5,
        "text-max-width": 8,
        "text-anchor": "center",
      },
      { "text-color": p.labelCity, ...labelHalo(p) },
      { minzoom, maxzoom: 8 },
    );
  return [
    neighbour("geo_neighbour_label", ["==", ["get", "shares_border"], true], 0),
    neighbour("geo_neighbour_label_far", ["!=", ["get", "shares_border"], true], 6.5),
  ];
}
