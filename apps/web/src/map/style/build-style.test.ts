import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { colorValue } from "../../theme/tokens.ts";
import { DECK_MIN_ZOOM } from "../terrain/deck-windows.ts";
import {
  BUILDING_EXTRUSION_LAYER_ID,
  BUILDING_EXTRUSION_ZOOM,
  BUILDING_LIGHT_INTENSITY,
  buildStyle,
  type StyleOptions,
  TERRAIN_SOURCE_ID,
  TRAIN_ANCHOR_LAYER_ID,
} from "./build-style.ts";
import { LABEL_KIND, nameText } from "./layer-kit.ts";
import { MAP_STYLES, type MapStyleKind } from "./map-styles.ts";
import { mapPalette } from "./palette.ts";

const BASE = { assetBaseUrl: "http://127.0.0.1:5173/", labelLanguage: "en" } as const;

function build(style: MapStyleKind, extra: Partial<StyleOptions> = {}): StyleSpecification {
  return buildStyle({ ...BASE, style, ...extra });
}

function ids(style: StyleSpecification): string[] {
  return style.layers.map((entry) => entry.id);
}

function byId(style: StyleSpecification, id: string): LayerSpecification | undefined {
  return style.layers.find((entry) => entry.id === id);
}

function textField(entry: LayerSpecification | undefined): string {
  return JSON.stringify(
    (entry as { layout?: Record<string, unknown> } | undefined)?.layout?.["text-field"],
  );
}

function source(style: StyleSpecification, id: string): Record<string, unknown> {
  return style.sources[id] as unknown as Record<string, unknown>;
}

describe("buildStyle", () => {
  it.each(MAP_STYLES)("produces a valid MapLibre style for %s", (style) => {
    expect(validateStyleMin(build(style))).toEqual([]);
    expect(validateStyleMin(build(style, { focus: "DE-BY", terrain3d: true }))).toEqual([]);
  });

  it.each(MAP_STYLES)("has unique layer ids in %s", (style) => {
    const list = ids(build(style, { focus: "DE-HB" }));

    expect(new Set(list).size).toBe(list.length);
  });

  it("paints dark and light with the map tokens of their theme", () => {
    for (const theme of ["dark", "light"] as const) {
      const style = build(theme);

      expect(byId(style, "background")?.paint).toMatchObject({
        "background-color": colorValue("map-land", theme),
      });
      expect(byId(style, "water")?.paint).toMatchObject({
        "fill-color": [
          "match",
          ["get", "class"],
          "ocean",
          expect.any(String),
          colorValue("map-water", theme),
        ],
      });
      expect(byId(style, "railway")?.paint).toMatchObject({
        "line-color": colorValue("map-rail", theme),
      });
    }
  });

  it("shows railways from zoom 8 in every style", () => {
    for (const style of MAP_STYLES) {
      expect(byId(build(style), "railway")?.minzoom).toBe(8);
    }
  });

  it("keeps the national mask colours and opacities of the design", () => {
    expect(byId(build("dark"), "germany-mask")?.paint).toMatchObject({
      "fill-color": "#0C0C0D",
      "fill-opacity": 0.55,
    });
    expect(byId(build("light"), "germany-mask")?.paint).toMatchObject({
      "fill-color": "#6E6C66",
      "fill-opacity": 0.34,
    });
  });

  it("reads the national mask at the default tolerance and each Land mask without simplification", () => {
    const national = build("dark");
    const focused = build("dark", { focus: "DE-BE" });

    expect(source(national, "mask")).toMatchObject({
      data: "http://127.0.0.1:5173/geo/germany-mask.geojson",
    });
    expect(source(national, "mask")).not.toHaveProperty("tolerance");
    expect(source(focused, "mask")).toMatchObject({
      data: "http://127.0.0.1:5173/geo/laender-masks/DE-BE.geojson",
      tolerance: 0,
    });
    expect(source(focused, "laender")).toMatchObject({ tolerance: 0 });
  });

  it("draws the mask without the fill outline pass only below zoom 11, where the national outline and the multisampled canvas cover its edge", () => {
    for (const style of ["dark", "light", "satellite"] as const) {
      expect(byId(build(style), "germany-mask")?.paint).toMatchObject({
        "fill-antialias": ["step", ["zoom"], false, 11, true],
      });
    }
  });

  it("keeps the fill outline pass on the relief, which draws fills into targets without multisampling", () => {
    const relief = buildStyle({ ...BASE, style: "terrain", terrain3d: true });
    expect(byId(relief, "germany-mask")?.paint).toMatchObject({ "fill-antialias": true });
    const flatTerrain = buildStyle({ ...BASE, style: "terrain", terrain3d: false });
    expect(byId(flatTerrain, "germany-mask")?.paint).toMatchObject({
      "fill-antialias": ["step", ["zoom"], false, 11, true],
    });
  });

  it.each(MAP_STYLES)(
    "puts the mask above the ground and below rails, trains, borders and labels in %s",
    (name) => {
      const style = build(name);
      const list = ids(style);
      const mask = list.indexOf("germany-mask");
      const anchor = list.indexOf(TRAIN_ANCHOR_LAYER_ID);
      for (const below of [
        "landuse_residential",
        "building",
        "highway_motorway_inner",
        "satellite",
      ]) {
        if (list.includes(below)) {
          expect(list.indexOf(below)).toBeLessThan(mask);
        }
      }
      expect(mask).toBeLessThan(list.indexOf("railway"));
      expect(list.indexOf("railway")).toBeLessThan(anchor);
      expect(anchor).toBeLessThan(list.indexOf("boundary_state"));
      expect(anchor).toBeLessThan(list.indexOf("boundary_country_z5-"));
      style.layers.forEach((entry, index) => {
        if (entry.type === "symbol") {
          expect(index).toBeGreaterThan(anchor);
        }
      });
    },
  );

  it("passes geo files it already holds as data, so a style switch fetches nothing", () => {
    const collection = (name: string) => ({
      type: "FeatureCollection" as const,
      features: [],
      name,
    });
    const geo = {
      mask: collection("mask"),
      outline: collection("outline"),
      neighbours: collection("neighbours"),
      laender: collection("laender"),
      landMasks: { "DE-BY": collection("by") },
    };
    const national = build("dark", { geo });
    const focused = build("light", { focus: "DE-BY", geo });

    expect(source(national, "mask").data).toBe(geo.mask);
    expect(source(national, "outline").data).toBe(geo.outline);
    expect(source(national, "neighbours").data).toBe(geo.neighbours);
    expect(source(focused, "mask").data).toBe(geo.landMasks["DE-BY"]);
    expect(source(focused, "laender").data).toBe(geo.laender);
  });

  it("builds no geo URL from a focus value that is not a Land code", () => {
    const style = build("dark", { focus: "../../x" as never });

    expect(JSON.stringify(style.sources)).not.toContain("../../x");
    expect(style.sources.laender).toBeUndefined();
    expect(byId(style, "land-focus-outline")).toBeUndefined();
  });

  it.each(MAP_STYLES)(
    "draws the focus outline above the national outline and the tile country borders in %s",
    (name) => {
      const list = ids(build(name, { focus: "DE-SL" }));
      const focus = list.indexOf("land-focus-outline");

      for (const below of ["germany-outline", "boundary_country_z0-4", "boundary_country_z5-"]) {
        expect(list.indexOf(below)).toBeLessThan(focus);
      }
      expect(focus).toBeLessThan(list.indexOf("place_city"));
    },
  );

  it("draws a Land focus with the focus outline in ink and the other Länder in the outline colour", () => {
    const style = build("light", { focus: "DE-BY" });

    expect(byId(style, "land-focus-outline")).toMatchObject({
      filter: ["==", ["get", "code"], "DE-BY"],
      paint: { "line-color": colorValue("ink", "light"), "line-width": 1.6 },
    });
    expect(byId(style, "laender-borders")).toMatchObject({
      filter: ["!=", ["get", "code"], "DE-BY"],
      paint: { "line-color": colorValue("map-outline", "light"), "line-width": 0.8 },
    });
    expect(byId(style, "boundary_state")).toBeUndefined();
    expect(byId(build("light"), "boundary_state")).toBeDefined();
    expect(byId(build("light"), "land-focus-outline")).toBeUndefined();
    expect(build("light").sources.laender).toBeUndefined();
  });

  describe("satellite", () => {
    it("reads VersaTiles imagery as 512 pixel tiles up to zoom 17 and darkens it", () => {
      const style = build("satellite");

      expect(source(style, "satellite")).toMatchObject({
        type: "raster",
        tiles: ["https://tiles.versatiles.org/tiles/satellite/{z}/{x}/{y}"],
        tileSize: 512,
        minzoom: 13,
        maxzoom: 17,
      });
      for (const id of ["satellite-base", "satellite"]) {
        const raster = byId(style, id)?.paint as Record<string, number>;
        expect(raster["raster-brightness-max"]).toBeLessThan(1);
        expect(raster["raster-saturation"]).toBeLessThan(0);
      }
    });

    it("keeps the zoom 12 imagery under the detail, so places without detail tiles show no holes", () => {
      const style = build("satellite");
      const list = ids(style);

      expect(source(style, "satellite-base")).toMatchObject({
        type: "raster",
        tiles: ["https://tiles.versatiles.org/tiles/satellite/{z}/{x}/{y}"],
        tileSize: 512,
        maxzoom: 12,
      });
      expect(source(style, "satellite-base").bounds).toBeUndefined();
      expect(list.indexOf("satellite-base")).toBeLessThan(list.indexOf("satellite"));
      const [west, , east] = source(style, "satellite").bounds as number[];
      expect(east).toBeLessThan(15.2);
      expect(west).toBeLessThan(0);
    });

    it("paints rails and country borders with the satellite map tokens", () => {
      const style = build("satellite");

      expect(byId(style, "railway")?.paint).toMatchObject({ "line-color": "#A7A39B" });
      expect(byId(style, "boundary_country_z5-")?.paint).toMatchObject({
        "line-color": "#8D8A84",
      });
    });

    it("draws no vector ground, water or roads over the imagery", () => {
      const list = ids(build("satellite"));

      for (const absent of [
        "water",
        "landcover_wood",
        "building",
        "highway_minor",
        "railway_dashline",
      ]) {
        expect(list).not.toContain(absent);
      }
    });

    it("uses the dark theme for labels and the mask", () => {
      const style = build("satellite");

      expect(byId(style, "germany-mask")?.paint).toMatchObject({ "fill-color": "#0C0C0D" });
      expect(byId(style, "place_city")?.paint).toMatchObject({
        "text-halo-color": colorValue("map-land", "dark"),
      });
    });
  });

  describe("terrain", () => {
    it("shades the relief from the Mapterhorn terrarium tiles up to zoom 12", () => {
      const style = build("terrain");
      const expected = {
        type: "raster-dem",
        tiles: ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"],
        encoding: "terrarium",
        tileSize: 512,
        maxzoom: 12,
      };

      expect(source(style, "hillshade")).toMatchObject(expected);
      expect(source(style, TERRAIN_SOURCE_ID)).toMatchObject(expected);
      const list = ids(style);
      expect(list.indexOf("hillshade")).toBeGreaterThan(list.indexOf("landcover_wood"));
      expect(list.indexOf("hillshade")).toBeLessThan(list.indexOf("highway_minor"));
      expect(byId(style, "background")?.paint).toMatchObject({
        "background-color": colorValue("map-land", "light"),
      });
    });

    it("shades the relief at full strength at national zoom and calmer when zoomed in", () => {
      const paint = byId(build("terrain"), "hillshade")?.paint as Record<string, unknown>;

      expect(paint["hillshade-exaggeration"]).toEqual([
        "interpolate",
        ["linear"],
        ["zoom"],
        6,
        1,
        9,
        0.6,
      ]);
      expect(JSON.stringify(paint["hillshade-shadow-color"])).toContain(colorValue("ink", "light"));
    });

    it("adds 3D terrain only when it is switched on", () => {
      expect(build("terrain").terrain).toBeUndefined();
      expect(build("terrain", { terrain3d: true }).terrain).toEqual({
        source: TERRAIN_SOURCE_ID,
        exaggeration: 1.5,
      });
      expect(build("dark", { terrain3d: true }).terrain).toBeUndefined();
    });

    it("loads no elevation in the other styles", () => {
      for (const style of ["dark", "light", "satellite"] as const) {
        expect(build(style).sources.hillshade).toBeUndefined();
      }
    });
  });

  describe("labels", () => {
    it.each(["en", "pl"])(
      "labels places with name:%s, then the local Latin name, never an English fallback",
      (language) => {
        const style = build("dark", { labelLanguage: language });
        const nameLayers = style.layers.filter(
          (entry) =>
            (entry as { metadata?: Record<string, unknown> }).metadata?.[LABEL_KIND] === "name",
        );

        expect(nameLayers.length).toBeGreaterThan(5);
        const translated = JSON.stringify([
          "coalesce",
          ["get", `name:${language}`],
          ["get", "name:latin"],
          ["get", "name"],
        ]);
        for (const entry of nameLayers) {
          expect(textField(entry)).toBe(JSON.stringify(nameText(language)));
          expect(textField(entry)).toContain(translated);
        }
        const tileLabels = style.layers.filter(
          (entry) => (entry as { source?: string }).source === "openmaptiles",
        );
        expect(JSON.stringify(tileLabels)).not.toMatch(/name_(en|de)/);
      },
    );

    it("labels places in German by their local name, every name layer alike", () => {
      const style = build("dark", { labelLanguage: "de" });
      const nameLayers = style.layers.filter(
        (entry) =>
          (entry as { metadata?: Record<string, unknown> }).metadata?.[LABEL_KIND] === "name",
      );

      expect(new Set(nameLayers.map((entry) => textField(entry))).size).toBe(1);
      expect(textField(nameLayers[0])).toContain("name:de");
      expect(textField(nameLayers[0])).toContain("name:latin");
    });

    it("labels Länder and neighbours from the geo base in the active language", () => {
      const style = build("light", { labelLanguage: "pl" });

      for (const id of ["geo_land_label", "geo_neighbour_label", "geo_neighbour_label_far"]) {
        expect(textField(byId(style, id))).toBe(JSON.stringify(["get", "name_pl"]));
      }
      expect(source(style, "neighbours")).toMatchObject({
        data: "http://127.0.0.1:5173/geo/neighbours.geojson",
      });
    });

    it("leaves the state and country labels of the tiles out", () => {
      const list = ids(build("dark"));

      expect(list.some((id) => id.startsWith("place_country") || id === "place_state")).toBe(false);
    });

    it("draws the Land labels below the city labels and the neighbour labels on top", () => {
      const list = ids(build("dark"));

      expect(list.indexOf("geo_land_label")).toBeLessThan(list.indexOf("place_city_large"));
      expect(list.indexOf("geo_neighbour_label")).toBe(list.length - 2);
    });

    it("carries the Land label points it is given", () => {
      const points = {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [8.79, 53.11] as const },
            properties: { code: "DE-HB", name_en: "Bremen", name_de: "Bremen", name_pl: "Brema" },
          },
        ],
      };

      expect(source(build("dark", { landLabels: points }), "laender-labels")).toMatchObject({
        data: points,
      });
    });
  });

  it("draws country borders on land only, without the maritime lines", () => {
    for (const id of ["boundary_country_z0-4", "boundary_country_z5-"]) {
      expect(
        JSON.stringify((byId(build("satellite"), id) as { filter?: unknown }).filter),
      ).toContain(JSON.stringify(["!=", ["get", "maritime"], 1]));
    }
  });

  it("reads vector tiles from OpenFreeMap and glyphs from the same host", () => {
    const style = build("dark");

    expect(style.sources.openmaptiles).toMatchObject({
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
    });
    expect(style.glyphs).toBe("https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf");
  });

  describe("rails on the relief", () => {
    const rail = (style: StyleSpecification) =>
      byId(style, "railway") as { paint: Record<string, unknown> };

    it("draws the mainline rail darker and wider from zoom 11 while the relief is on", () => {
      const flat = rail(build("terrain")).paint;
      const tilted = rail(build("terrain", { terrain3d: true })).paint;

      expect(flat["line-color"]).toBe(mapPalette("terrain").rail);
      expect(tilted["line-color"]).toBe(mapPalette("terrain").label);
      expect(JSON.stringify(tilted["line-width"])).toContain("11,1.4");
      expect(JSON.stringify(flat["line-width"])).not.toContain("11,1.4");
    });

    it("softens the sleeper dashes over the darker rail", () => {
      const dash = (style: StyleSpecification) =>
        byId(style, "railway_dashline") as { paint: Record<string, unknown> };
      expect(dash(build("terrain", { terrain3d: true })).paint["line-opacity"]).toBe(0.4);
      expect(dash(build("terrain")).paint["line-opacity"]).toBeUndefined();
    });

    it("dims the rail on a bridge under the deck line and shows a tunnel faint and dashed", () => {
      const style = build("terrain", { terrain3d: true });
      const layer = (id: string) =>
        byId(style, id) as { filter: unknown; paint: Record<string, unknown> };

      expect(layer("railway_bridge").paint["line-opacity"]).toBe(0.5);
      expect(layer("railway_bridge").paint["line-color"]).toBe(mapPalette("terrain").label);
      expect(JSON.stringify(layer("railway_bridge").filter)).toContain('"bridge"');
      expect(layer("railway_tunnel").paint["line-opacity"]).toBe(0.4);
      expect(layer("railway_tunnel").paint["line-dasharray"]).toEqual([2, 2]);
      expect(JSON.stringify(layer("railway_tunnel").filter)).toContain('"tunnel"');
    });

    it("dims a bridge only from the zoom where the deck line exists, below it the bridge stays full strength", () => {
      const style = build("terrain", { terrain3d: true });
      type Spec = {
        id: string;
        minzoom?: number;
        maxzoom?: number;
        filter?: unknown;
        paint: Record<string, unknown>;
      };
      const layers = (style.layers as unknown as Spec[]).filter((layer) =>
        layer.id.startsWith("railway"),
      );
      const bridgeOpacities = (zoom: number) =>
        layers
          .filter((layer) => (layer.minzoom ?? 0) <= zoom && zoom < (layer.maxzoom ?? 24))
          .filter((layer) => {
            const filter = JSON.stringify(layer.filter);
            return filter.includes('"bridge"') && !filter.includes('"bridge","tunnel"');
          })
          .map((layer) => layer.paint["line-opacity"] ?? 1);

      expect((byId(style, "railway_bridge") as Spec).minzoom).toBe(DECK_MIN_ZOOM);
      for (let zoom = 8; zoom < DECK_MIN_ZOOM; zoom++) expect(bridgeOpacities(zoom)).toEqual([1]);
      for (let zoom = DECK_MIN_ZOOM; zoom <= 20; zoom++)
        expect(bridgeOpacities(zoom)).toEqual([0.5]);
    });

    it("keeps bridges and tunnels out of the full strength rail", () => {
      const filter = JSON.stringify(
        (byId(build("terrain", { terrain3d: true }), "railway") as { filter: unknown }).filter,
      );
      expect(filter).toContain('"brunnel"');
      expect(filter).toContain('"bridge","tunnel"');
    });

    it("draws bridges and tunnels like any rail while the relief is off", () => {
      for (const name of ["dark", "light", "satellite", "terrain"] as const) {
        const style = build(name);
        expect(byId(style, "railway_bridge")).toBeUndefined();
        expect(byId(style, "railway_tunnel")).toBeUndefined();
        expect(
          JSON.stringify((byId(style, "railway") as { filter: unknown }).filter),
        ).not.toContain("brunnel");
      }
    });

    it("puts the bridge and tunnel rails below the train anchor and keeps the style valid", () => {
      const style = build("terrain", { terrain3d: true });
      const list = ids(style);
      expect(list.indexOf("railway_bridge")).toBeLessThan(list.indexOf(TRAIN_ANCHOR_LAYER_ID));
      expect(list.indexOf("railway_tunnel")).toBeLessThan(list.indexOf(TRAIN_ANCHOR_LAYER_ID));
      expect(validateStyleMin(style)).toEqual([]);
    });

    it("keeps the rail of the other styles", () => {
      for (const name of ["dark", "light", "satellite"] as const) {
        expect(rail(build(name, { terrain3d: true })).paint["line-color"]).toBe(
          mapPalette(name).rail,
        );
      }
    });
  });

  describe("3D buildings", () => {
    const extrusion = (style: StyleSpecification) => byId(style, BUILDING_EXTRUSION_LAYER_ID);

    const relief = { buildings: true, terrain3d: true } as const;

    it("extrudes the building layer from zoom 14.5 in Terrain 3D", () => {
      const style = build("terrain", relief);
      expect(extrusion(style)).toMatchObject({
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: BUILDING_EXTRUSION_ZOOM,
      });
      expect(BUILDING_EXTRUSION_ZOOM).toBe(14.5);
      expect(validateStyleMin(style)).toEqual([]);
    });

    it("has no extrusion in the styles that cannot tilt, whatever the switches say", () => {
      for (const name of ["dark", "light", "satellite"] as const) {
        expect(extrusion(build(name, relief))).toBeUndefined();
      }
    });

    it("has no extrusion when buildings or the relief are off", () => {
      expect(extrusion(build("terrain"))).toBeUndefined();
      expect(extrusion(build("terrain", { buildings: false, terrain3d: true }))).toBeUndefined();
      expect(extrusion(build("terrain", { buildings: true, terrain3d: false }))).toBeUndefined();
    });

    it("leaves out the outline of a building that has parts, so the parts do not fight it", () => {
      const filter = JSON.stringify(
        (extrusion(build("terrain", relief)) as { filter: unknown }).filter,
      );
      expect(filter).toContain(JSON.stringify(["!=", ["get", "hide_3d"], true]));
    });

    it("grows the walls and the opacity in over one zoom level from 14.5", () => {
      const paint = (extrusion(build("terrain", relief)) as { paint: Record<string, unknown> })
        .paint;
      const height = JSON.stringify(paint["fill-extrusion-height"]);
      expect(height).toContain("14.5,0,15.5");
      expect(height).toContain("render_height");
      expect(JSON.stringify(paint["fill-extrusion-opacity"])).toContain("14.5,0,15.5");
    });

    it("draws the extrusion above the roads and below the mask, so abroad stays muted", () => {
      const list = ids(build("terrain", relief));
      const at = list.indexOf(BUILDING_EXTRUSION_LAYER_ID);
      expect(at).toBeGreaterThan(list.indexOf("building"));
      expect(at).toBeGreaterThan(list.indexOf("highway_motorway_inner"));
      expect(at).toBeLessThan(list.indexOf("germany-mask"));
    });

    it("softens the light so the shaded walls stay a light grey", () => {
      expect(build("terrain", relief).light).toEqual({ intensity: BUILDING_LIGHT_INTENSITY });
      expect(BUILDING_LIGHT_INTENSITY).toBeLessThanOrEqual(0.25);
      expect(build("terrain", { terrain3d: true }).light).toBeUndefined();
      expect(build("dark", relief).light).toBeUndefined();
    });

    it("keeps the extrusion in the colour of the building token", () => {
      const paint = (extrusion(build("terrain", relief)) as { paint: Record<string, unknown> })
        .paint;
      expect(paint["fill-extrusion-color"]).toBe(mapPalette("terrain").building);
    });
  });
});
