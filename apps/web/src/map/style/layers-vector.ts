import type { LayerSpecification } from "maplibre-gl";
import { DECK_MIN_ZOOM } from "../terrain/deck-windows.ts";
import {
  classIs,
  fillLayer,
  isLine,
  isPoint,
  isPolygon,
  type Json,
  layer,
  linearRamp,
  lineLayer,
  nameText,
  routeRefText,
  symbolLayer,
  THIN_LINE_JOIN,
  zoomRamp,
} from "./layer-kit.ts";
import type { MapPalette } from "./palette.ts";

const OMT = { source: "openmaptiles" } as const;

export const BUILDING_EXTRUSION_LAYER_ID = "building_3d";
/** Zoom from which buildings are extruded; walls and opacity grow in over the next zoom level. */
export const BUILDING_EXTRUSION_ZOOM = 14.5;
const BUILDING_EXTRUSION_FULL_ZOOM = BUILDING_EXTRUSION_ZOOM + 1;
const BUILDING_EXTRUSION_OPACITY = 0.9;
const BUILDING_FALLBACK_HEIGHT_M = 6;

function growingWith(attribute: string, fallback: number): Json {
  return linearRamp(BUILDING_EXTRUSION_ZOOM, 0, BUILDING_EXTRUSION_FULL_ZOOM, [
    "coalesce",
    ["get", attribute],
    fallback,
  ] as unknown as number);
}

export function buildingExtrusionLayer(p: MapPalette): LayerSpecification {
  return layer({
    id: BUILDING_EXTRUSION_LAYER_ID,
    type: "fill-extrusion",
    ...OMT,
    "source-layer": "building",
    minzoom: BUILDING_EXTRUSION_ZOOM,
    filter: ["all", isPolygon, ["!=", ["get", "hide_3d"], true]],
    paint: {
      "fill-extrusion-color": p.building,
      "fill-extrusion-height": growingWith("render_height", BUILDING_FALLBACK_HEIGHT_M),
      "fill-extrusion-base": growingWith("render_min_height", 0),
      "fill-extrusion-opacity": linearRamp(
        BUILDING_EXTRUSION_ZOOM,
        0,
        BUILDING_EXTRUSION_FULL_ZOOM,
        BUILDING_EXTRUSION_OPACITY,
      ),
      "fill-extrusion-vertical-gradient": true,
    },
  });
}

export function landLayers(p: MapPalette, relief: boolean): LayerSpecification[] {
  const wood = relief
    ? { minzoom: 5, opacity: linearRamp(5, 0.5, 9, 0.85, 13, 0.6) }
    : { minzoom: 10, opacity: zoomRamp(0.3, 8, 0, 10, 0.8, 13, 0.4) };
  return [
    fillLayer(
      "water",
      "water",
      p.seaGround === null ? p.water : ["match", ["get", "class"], "ocean", p.seaGround, p.water],
      { filter: ["all", isPolygon, ["!=", ["get", "brunnel"], "tunnel"]] },
      { "fill-antialias": false },
    ),
    fillLayer(
      "landuse_residential",
      "landuse",
      p.landTint,
      { maxzoom: 9, filter: ["all", isPolygon, ["==", ["get", "class"], "residential"]] },
      { "fill-opacity": 0.7 },
    ),
    fillLayer(
      "landcover_wood",
      "landcover",
      p.greenTint,
      { minzoom: wood.minzoom, filter: ["all", isPolygon, ["==", ["get", "class"], "wood"]] },
      { "fill-opacity": wood.opacity },
    ),
    fillLayer("landuse_park", "landuse", p.greenTint, {
      filter: ["all", isPolygon, ["==", ["get", "class"], "park"]],
    }),
  ];
}

export function detailLayers(p: MapPalette): LayerSpecification[] {
  return [
    layer({
      id: "waterway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      filter: isLine,
      paint: { "line-color": p.water },
    }),
    fillLayer(
      "building",
      "building",
      p.building,
      { minzoom: 12, filter: isPolygon },
      { "fill-antialias": true, "fill-outline-color": p.buildingOutline },
    ),
  ];
}

export function roadLayers(p: MapPalette): LayerSpecification[] {
  const major = ["all", isLine, classIs("primary", "secondary", "tertiary", "trunk")];
  const motorway = ["all", isLine, ["==", ["get", "class"], "motorway"]];
  const butt = { "line-cap": "butt", "line-join": "miter" };
  return [
    lineLayer(
      "highway_path",
      p.roadMinor,
      zoomRamp(1.2, 13, 1, 20, 10),
      { filter: ["all", isLine, ["==", ["get", "class"], "path"]] },
      undefined,
      { "line-dasharray": [1.5, 1.5], "line-opacity": 0.9 },
    ),
    lineLayer("highway_minor", p.roadMinor, zoomRamp(1.55, 13, 1.8, 20, 20), {
      minzoom: 8,
      filter: ["all", isLine, classIs("minor", "service", "track")],
    }),
    lineLayer(
      "highway_major_casing",
      p.roadMajorCasing,
      zoomRamp(1.3, 10, 3, 20, 23),
      { minzoom: 11, filter: major },
      butt,
    ),
    lineLayer("highway_major_inner", p.roadMajor, zoomRamp(1.3, 10, 2, 20, 20), {
      minzoom: 11,
      filter: major,
    }),
    lineLayer("highway_major_subtle", p.roadMinor, linearRamp(6, 0, 8, 2), {
      minzoom: 6,
      maxzoom: 11,
      filter: major,
    }),
    lineLayer(
      "highway_motorway_casing",
      p.roadMotorwayCasing,
      zoomRamp(1.4, 5.8, 0, 6, 3, 20, 40),
      { minzoom: 6, filter: motorway },
      butt,
    ),
    lineLayer("highway_motorway_inner", p.roadMotorway, zoomRamp(1.4, 4, 2, 6, 1.3, 20, 30), {
      minzoom: 6,
      filter: motorway,
    }),
    lineLayer("highway_motorway_subtle", p.roadMinor, zoomRamp(1.4, 4, 2, 6, 1.3), {
      maxzoom: 6,
      filter: motorway,
    }),
  ];
}

const RELIEF_DASH_OPACITY = 0.4;
const RELIEF_BRIDGE_OPACITY = 0.5;
const RELIEF_TUNNEL_OPACITY = 0.4;
const RELIEF_TUNNEL_DASH = [2, 2];

/**
 * Rails on the relief are darker and wider from zoom 11: the light rail token almost vanishes on
 * hillshade at pitch 50 and more, where a line is foreshortened. From the zoom where the deck line
 * exists a rail on a bridge is dimmed to half (the line under the trains runs above it, and a full
 * strength rail draped into the gorge reads as a second track; a short overpass has no deck line, and
 * at 30 % its rail read as a break); below it the bridge stays at full strength,
 * since nothing runs above it and a dim gap would show. A rail in a tunnel is faint and dashed (drawn over the ridge it would read as
 * a track climbing the mountain).
 */
export function railwayLayers(
  p: MapPalette,
  dashed: boolean,
  relief = false,
): LayerSpecification[] {
  const color = relief ? p.label : p.rail;
  const width = relief
    ? zoomRamp(1.3, 8, 0.8, 11, 1.4, 12, 1.8, 16, 3.2, 20, 7)
    : zoomRamp(1.3, 8, 0.6, 12, 1, 16, 3, 20, 7);
  const rail = ["all", isLine, ["==", ["get", "class"], "rail"]];
  const mainline = [...rail, ["!", ["has", "service"]]];
  const openTrack = [...mainline, ["match", ["get", "brunnel"], ["bridge", "tunnel"], false, true]];
  const onBridge = [...mainline, ["==", ["get", "brunnel"], "bridge"]];
  const inTunnel = [...mainline, ["==", ["get", "brunnel"], "tunnel"]];
  const service = ["all", isLine, ["all", ["==", ["get", "class"], "rail"], ["has", "service"]]];
  const transit = [
    "all",
    isLine,
    [
      "all",
      ["==", ["get", "class"], "transit"],
      ["match", ["get", "brunnel"], ["tunnel"], false, true],
    ],
  ];
  const joinOnly = { "line-join": THIN_LINE_JOIN };
  const layers = [
    lineLayer("railway_transit", p.rail, 3, { minzoom: 16, filter: transit }, joinOnly),
    lineLayer("railway_minor", p.rail, 3, { minzoom: 16, filter: service }, joinOnly),
    lineLayer(
      "railway",
      color,
      width,
      { minzoom: 8, filter: relief ? openTrack : mainline },
      joinOnly,
    ),
  ];
  if (relief) {
    layers.push(
      lineLayer(
        "railway_bridge_overview",
        color,
        width,
        { minzoom: 8, maxzoom: DECK_MIN_ZOOM, filter: onBridge },
        joinOnly,
      ),
      lineLayer(
        "railway_bridge",
        color,
        width,
        { minzoom: DECK_MIN_ZOOM, filter: onBridge },
        joinOnly,
        { "line-opacity": RELIEF_BRIDGE_OPACITY },
      ),
      lineLayer("railway_tunnel", color, width, { minzoom: 8, filter: inTunnel }, joinOnly, {
        "line-opacity": RELIEF_TUNNEL_OPACITY,
        "line-dasharray": RELIEF_TUNNEL_DASH,
      }),
    );
  }
  if (dashed) {
    layers.push(
      lineLayer(
        "railway_dashline",
        p.land,
        1,
        { minzoom: 14, filter: relief ? openTrack : mainline },
        joinOnly,
        {
          "line-dasharray": [3, 3],
          "line-width": zoomRamp(1.3, 16, 2, 20, 6),
          ...(relief ? { "line-opacity": RELIEF_DASH_OPACITY } : {}),
        },
      ),
    );
  }
  return layers;
}

const NEIGHBOUR_LINE_WIDTH = linearRamp(3, 0.7, 8, 1, 12, 1.4);

export function boundaryLayers(p: MapPalette): LayerSpecification[] {
  const onLand: Json = ["!=", ["get", "maritime"], 1];
  const boundary = (
    id: string,
    color: string,
    filter: Json,
    width: Json,
    extra: Record<string, unknown>,
    dashed = false,
    opacity = 1,
  ) =>
    layer({
      id,
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter,
      layout: { "line-cap": "round", "line-join": THIN_LINE_JOIN },
      paint: {
        "line-color": color,
        "line-width": width,
        "line-opacity": opacity,
        ...(dashed ? { "line-dasharray": [2, 2] } : {}),
      },
      ...extra,
    });
  return [
    boundary(
      "boundary_state",
      p.boundaryState,
      ["==", ["get", "admin_level"], 4],
      zoomRamp(1.3, 3, 1, 22, 15),
      {},
      true,
    ),
    boundary(
      "boundary_country_z0-4",
      p.boundaryCountry,
      ["all", ["==", ["get", "admin_level"], 2], ["!", ["has", "claimed_by"]], onLand],
      NEIGHBOUR_LINE_WIDTH,
      { maxzoom: 5 },
      false,
      p.neighbourLineOpacity,
    ),
    boundary(
      "boundary_country_z5-",
      p.boundaryCountry,
      ["all", ["==", ["get", "admin_level"], 2], onLand],
      NEIGHBOUR_LINE_WIDTH,
      { minzoom: 5 },
      false,
      p.neighbourLineOpacity,
    ),
  ];
}

export function lineLabelLayers(p: MapPalette, language: string): LayerSpecification[] {
  const halo = { "text-halo-color": p.halo, "text-halo-width": 1.2, "text-halo-blur": 0 };
  return [
    symbolLayer(
      "water_name",
      { ...OMT, sourceLayer: "water_name" },
      "name",
      isLine,
      {
        "symbol-placement": "line",
        "symbol-spacing": 500,
        "text-field": nameText(language),
        "text-rotation-alignment": "map",
        "text-size": 12,
      },
      { "text-color": p.labelWater, ...halo },
    ),
    symbolLayer(
      "highway_name_other",
      { ...OMT, sourceLayer: "transportation_name" },
      "name",
      ["all", ["!=", ["get", "class"], "motorway"], isLine],
      {
        "symbol-placement": "line",
        "symbol-spacing": 350,
        "text-field": nameText(language),
        "text-max-angle": 30,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "map",
        "text-size": 10,
      },
      { "text-color": p.label, ...halo },
    ),
    symbolLayer(
      "highway_name_motorway",
      { ...OMT, sourceLayer: "transportation_name" },
      undefined,
      ["all", isLine, ["==", ["get", "class"], "motorway"]],
      {
        "symbol-placement": "line",
        "symbol-spacing": 350,
        "text-field": routeRefText(),
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "viewport",
        "text-size": 10,
      },
      { "text-color": p.label, "text-translate": [0, 2], ...halo },
    ),
  ];
}

export function placeLayers(p: MapPalette, language: string): LayerSpecification[] {
  const halo = { "text-halo-color": p.halo, "text-halo-width": 1.6, "text-halo-blur": 0 };
  const isClass = (name: string): Json => ["==", ["get", "class"], name];
  const place = (
    id: string,
    classes: Json,
    size: number,
    maxzoom: number,
    color: string,
    extraFilter: Json[] = [],
  ) =>
    symbolLayer(
      id,
      { ...OMT, sourceLayer: "place" },
      "name",
      ["all", isPoint, classes, ...extraFilter],
      { "text-field": nameText(language), "text-size": size, "text-anchor": "center" },
      { "text-color": color, ...halo },
      { maxzoom },
    );
  return [
    place("place_other", classIs("hamlet", "isolated_dwelling", "neighbourhood"), 11, 14, p.label),
    place("place_suburb", isClass("suburb"), 11, 15, p.label),
    place("place_village", isClass("village"), 11, 14, p.label),
    place("place_town", isClass("town"), 11.5, 15, p.label),
    place("place_city", isClass("city"), 13, 14, p.labelCity, [[">", ["get", "rank"], 3]]),
    place("place_city_large", isClass("city"), 15, 12, p.labelCity, [["<=", ["get", "rank"], 3]]),
  ];
}
