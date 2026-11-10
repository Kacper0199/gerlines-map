import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import basemap from "./basemap-style.json";

export const TERRAIN_SOURCE_ID = "terrain-dem";
export const HILLSHADE_LAYER_ID = "hillshade";
export const BUILDINGS_3D_LAYER_ID = "buildings-3d";

const DEM_TILEJSON = "https://tiles.mapterhorn.com/tilejson.json";
const BUILDING_EXTRUSION_MIN_ZOOM = 14.5;

function insertAfter(
  layers: LayerSpecification[],
  anchorId: string,
  layer: LayerSpecification,
): void {
  const index = layers.findIndex((candidate) => candidate.id === anchorId);
  layers.splice(index === -1 ? layers.length : index + 1, 0, layer);
}

export function buildStyle(): StyleSpecification {
  const style = structuredClone(basemap) as unknown as StyleSpecification;
  style.sources[TERRAIN_SOURCE_ID] = { type: "raster-dem", url: DEM_TILEJSON };
  style.sources["hillshade-dem"] = { type: "raster-dem", url: DEM_TILEJSON };

  insertAfter(style.layers, "landuse_park", {
    id: HILLSHADE_LAYER_ID,
    type: "hillshade",
    source: "hillshade-dem",
    layout: { visibility: "none" },
    paint: {
      "hillshade-exaggeration": 0.4,
      "hillshade-shadow-color": "#0C0C0D",
      "hillshade-highlight-color": "#2A2B2E",
      "hillshade-accent-color": "#151618",
    },
  });

  insertAfter(style.layers, "building", {
    id: BUILDINGS_3D_LAYER_ID,
    type: "fill-extrusion",
    source: "openmaptiles",
    "source-layer": "building",
    minzoom: BUILDING_EXTRUSION_MIN_ZOOM,
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": "#2B2C2F",
      "fill-extrusion-height": [
        "interpolate",
        ["linear"],
        ["zoom"],
        BUILDING_EXTRUSION_MIN_ZOOM,
        0,
        BUILDING_EXTRUSION_MIN_ZOOM + 1,
        ["coalesce", ["get", "render_height"], 6],
      ],
      "fill-extrusion-base": [
        "interpolate",
        ["linear"],
        ["zoom"],
        BUILDING_EXTRUSION_MIN_ZOOM,
        0,
        BUILDING_EXTRUSION_MIN_ZOOM + 1,
        ["coalesce", ["get", "render_min_height"], 0],
      ],
      "fill-extrusion-opacity": 0.9,
    },
  });
  return style;
}
