import type { Journey, TransitLeg } from "@gerlines/schema/journeys";
import type { CategoryKey } from "@gerlines/ui/tokens";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { TRAIN_ANCHOR_LAYER_ID } from "../map/style/build-style.ts";
import { decodePolyline } from "../motion/polyline.ts";
import { categoryColor, colorValue, type ThemeName } from "../theme/tokens.ts";

export const JOURNEY_SOURCE_ID = "gl-journey";
export const JOURNEY_LAYER_IDS = {
  casing: "gl-journey-casing",
  line: "gl-journey-line",
  walk: "gl-journey-walk",
  stops: "gl-journey-stops",
} as const;

const COLOURED: ReadonlySet<string> = new Set(["hsr", "ld", "night", "rfast", "reg", "sbahn"]);

type Position = [number, number];

interface LegFeature {
  readonly type: "Feature";
  readonly geometry: { readonly type: "LineString"; readonly coordinates: Position[] };
  readonly properties: { readonly kind: "transit" | "walk"; readonly colour: string };
}

interface StopFeature {
  readonly type: "Feature";
  readonly geometry: { readonly type: "Point"; readonly coordinates: Position };
  readonly properties: { readonly kind: "end" | "change" };
}

export interface JourneyCollection {
  readonly type: "FeatureCollection";
  readonly features: (LegFeature | StopFeature)[];
}

const EMPTY: JourneyCollection = { type: "FeatureCollection", features: [] };

/** The leg's route line as [lon, lat] points, or null when the router sent no line. */
export function linePointsOf(leg: TransitLeg): Position[] | null {
  if (!leg.geometry) return null;
  const flat = decodePolyline(leg.geometry.polyline, leg.geometry.precision);
  const points: Position[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2)
    points.push([flat[i] as number, flat[i + 1] as number]);
  return points.length >= 2 ? points : null;
}

function legColour(leg: TransitLeg, theme: ThemeName): string {
  return COLOURED.has(leg.category)
    ? categoryColor(theme, leg.category as CategoryKey)
    : colorValue("ink-muted", theme);
}

/**
 * The journey as map features: each train leg as its route line from MOTIS in its category colour
 * (never a train position, never a straight line between stops), each walk between two stops as a
 * dashed line, and the first stop, the last stop and every change as rings. A train leg without a
 * line is left out rather than drawn straight.
 */
export function journeyFeatures(journey: Journey | null, theme: ThemeName): JourneyCollection {
  if (!journey) return EMPTY;
  const features: (LegFeature | StopFeature)[] = [];
  journey.legs.forEach((leg, index) => {
    if (leg.kind === "transit") {
      const coordinates = linePointsOf(leg);
      if (coordinates) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates },
          properties: { kind: "transit", colour: legColour(leg, theme) },
        });
      }
    } else {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [leg.from.lon, leg.from.lat],
            [leg.to.lon, leg.to.lat],
          ],
        },
        properties: { kind: "walk", colour: colorValue("ink-muted", theme) },
      });
    }
    if (index > 0) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [leg.from.lon, leg.from.lat] },
        properties: { kind: "change" },
      });
    }
  });
  const first = journey.legs[0];
  const last = journey.legs.at(-1);
  for (const stop of [first?.from, last?.to]) {
    if (stop) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [stop.lon, stop.lat] },
        properties: { kind: "end" },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function addLayers(map: MapLibreMap, theme: ThemeName, data: JourneyCollection): void {
  const before = map.getLayer(TRAIN_ANCHOR_LAYER_ID) ? TRAIN_ANCHOR_LAYER_ID : undefined;
  const surface = colorValue("surface", theme);
  const ink = colorValue("ink", theme);
  map.addSource(JOURNEY_SOURCE_ID, { type: "geojson", data: data as never });
  map.addLayer(
    {
      id: JOURNEY_LAYER_IDS.casing,
      type: "line",
      source: JOURNEY_SOURCE_ID,
      filter: ["==", ["get", "kind"], "transit"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": surface,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 5, 10, 8, 14, 11],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: JOURNEY_LAYER_IDS.line,
      type: "line",
      source: JOURNEY_SOURCE_ID,
      filter: ["==", ["get", "kind"], "transit"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": ["get", "colour"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 5, 14, 7],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: JOURNEY_LAYER_IDS.walk,
      type: "line",
      source: JOURNEY_SOURCE_ID,
      filter: ["==", ["get", "kind"], "walk"],
      paint: { "line-color": ["get", "colour"], "line-width": 2, "line-dasharray": [1, 2] },
    },
    before,
  );
  map.addLayer(
    {
      id: JOURNEY_LAYER_IDS.stops,
      type: "circle",
      source: JOURNEY_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": ["match", ["get", "kind"], "end", 6, 4.5],
        "circle-color": ["match", ["get", "kind"], "end", ink, surface],
        "circle-stroke-color": ["match", ["get", "kind"], "end", surface, ink],
        "circle-stroke-width": 2,
      },
    },
    before,
  );
}

function removeLayers(map: MapLibreMap): void {
  for (const id of Object.values(JOURNEY_LAYER_IDS)) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(JOURNEY_SOURCE_ID)) map.removeSource(JOURNEY_SOURCE_ID);
}

/**
 * Keeps the shown journey on the map: below the trains and the labels, above the rails, and put
 * back after a style change (a theme or map style switch replaces every layer).
 */
export class JourneyLayer {
  private readonly map: MapLibreMap;
  private journey: Journey | null = null;
  private theme: ThemeName;
  private drawnTheme: ThemeName | null = null;
  private readonly onStyle = () => this.sync();
  private waiting = false;

  constructor(map: MapLibreMap, theme: ThemeName) {
    this.map = map;
    this.theme = theme;
    map.on("styledata", this.onStyle);
  }

  show(journey: Journey | null, theme: ThemeName): void {
    this.journey = journey;
    this.theme = theme;
    this.sync();
  }

  private sync(): void {
    if (!this.map.isStyleLoaded()) {
      if (!this.waiting) {
        this.waiting = true;
        this.map.once("idle", () => {
          this.waiting = false;
          this.sync();
        });
      }
      return;
    }
    const data = journeyFeatures(this.journey, this.theme);
    const source = this.map.getSource(JOURNEY_SOURCE_ID) as GeoJSONSource | undefined;
    if (data.features.length === 0) {
      if (source) removeLayers(this.map);
      this.drawnTheme = null;
      return;
    }
    if (source && this.drawnTheme === this.theme) {
      source.setData(data as never);
      return;
    }
    if (source) removeLayers(this.map);
    addLayers(this.map, this.theme, data);
    this.drawnTheme = this.theme;
  }

  dispose(): void {
    this.map.off("styledata", this.onStyle);
    this.journey = null;
    if (this.map.getStyle()) removeLayers(this.map);
  }
}
