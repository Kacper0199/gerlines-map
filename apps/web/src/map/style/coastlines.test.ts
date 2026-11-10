import { expression, featureFilter, latest } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { colorValue } from "../../theme/tokens.ts";
import { buildStyle } from "./build-style.ts";
import { MAP_STYLES, type MapStyleKind } from "./map-styles.ts";
import { mapPalette } from "./palette.ts";

const BASE = { assetBaseUrl: "http://127.0.0.1:5173/", labelLanguage: "en" } as const;
const SEA_STYLES = ["dark", "light", "terrain"] as const;
const GROUND_ABOVE_SEA = [
  "building",
  "waterway",
  "highway_minor",
  "highway_major_inner",
  "highway_motorway_inner",
] as const;
const COUNTRY_LAYERS = ["boundary_country_z0-4", "boundary_country_z5-"] as const;

function build(style: MapStyleKind, focus?: "DE-BY"): StyleSpecification {
  return buildStyle({ ...BASE, style, ...(focus ? { focus } : {}) });
}

function layerOf(style: StyleSpecification, id: string): LayerSpecification {
  const found = style.layers.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`Layer ${id} is missing`);
  }
  return found;
}

function indexOf(style: StyleSpecification, id: string): number {
  return style.layers.findIndex((entry) => entry.id === id);
}

type Properties = Record<string, string | number>;

// Property sets copied from the live OpenFreeMap tiles (planet 20261101), boundary layer, admin_level 2.
const GOERLITZ_BORDER: Properties = { adm0_l: "POL", disputed: 0, maritime: 0, admin_level: 2 };
const DOLLART_BORDER: Properties = { adm0_r: "NLD", disputed: 0, maritime: 0, admin_level: 2 };
const CONSTANCE_BORDER: Properties = { adm0_r: "CHE", disputed: 0, maritime: 0, admin_level: 2 };
const LOW_ZOOM_BORDER: Properties = { disputed: 0, maritime: 0, admin_level: 2 };
const POLAND_CZECHIA_BORDER: Properties = {
  adm0_r: "CZE",
  adm0_l: "POL",
  disputed: 0,
  maritime: 0,
  admin_level: 2,
};
const NORTH_SEA_LINE: Properties = { adm0_r: "NLD", disputed: 0, maritime: 1, admin_level: 2 };
const GERMAN_BORDERS = [GOERLITZ_BORDER, DOLLART_BORDER, CONSTANCE_BORDER, LOW_ZOOM_BORDER];

const LINE = 2;
const POLYGON = 3;

function drawsAt(entry: LayerSpecification, zoom: number): boolean {
  const { minzoom = 0, maxzoom = 24 } = entry;
  return zoom >= minzoom && zoom < maxzoom;
}

function matches(
  entry: LayerSpecification,
  properties: Properties,
  type: number,
  zoom: number,
): boolean {
  const filter = (entry as { filter?: unknown }).filter;
  if (!drawsAt(entry, zoom)) {
    return false;
  }
  return (
    filter === undefined ||
    featureFilter(filter as never, `layers.${entry.id}.filter`).filter({ zoom }, {
      type,
      properties,
    } as never)
  );
}

function paintAt(
  entry: LayerSpecification,
  property: string,
  spec: unknown,
  zoom: number,
  properties: Properties = {},
  type = POLYGON,
): unknown {
  const value = (entry.paint as Record<string, unknown>)[property];
  const parsed = expression.createExpression(value, spec as never);
  if (parsed.result !== "success") {
    throw new Error(JSON.stringify(parsed.value));
  }
  const result = parsed.value.evaluate({ zoom }, { type, properties } as never) as unknown;
  if (result && typeof result === "object" && "r" in result) {
    const { r, g, b } = result as { r: number; g: number; b: number };
    return `#${[r, g, b]
      .map((part) =>
        Math.round(part * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()}`;
  }
  return result;
}

function opacityAt(entry: LayerSpecification, zoom: number): number {
  if (!drawsAt(entry, zoom)) {
    return 0;
  }
  const value = (entry.paint as Record<string, unknown>)["line-opacity"];
  return value === undefined
    ? 1
    : (paintAt(entry, "line-opacity", latest.paint_line["line-opacity"], zoom, {}, LINE) as number);
}

function tileLinesAt(
  style: StyleSpecification,
  properties: Properties,
  zoom: number,
): LayerSpecification[] {
  return style.layers.filter(
    (entry) => entry.id.startsWith("boundary_country") && matches(entry, properties, LINE, zoom),
  );
}

function groundWater(style: StyleSpecification): LayerSpecification[] {
  return style.layers.filter(
    (entry) =>
      entry.type === "fill" && (entry as { "source-layer"?: string })["source-layer"] === "water",
  );
}

function widthAt(entry: LayerSpecification, zoom: number): number {
  const width = (entry.paint as Record<string, unknown>)["line-width"];
  const parsed = expression.createExpression(width, latest.paint_line["line-width"] as never);
  if (parsed.result !== "success") {
    throw new Error(JSON.stringify(parsed.value));
  }
  return parsed.value.evaluate({ zoom }) as number;
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function parts(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [red, green, blue] = parts(hex);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

function masked(base: string, mask: string, opacity: number): string {
  const [b, m] = [parts(base), parts(mask)];
  return `#${b
    .map((value, at) =>
      Math.round(value * (1 - opacity) + (m[at] as number) * opacity)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

describe("coastlines and border hierarchy", () => {
  it.each(MAP_STYLES)("draws only the ocean coast, above the mask, in %s", (name) => {
    const style = build(name);
    const coast = layerOf(style, "coastline");

    expect(coast).toMatchObject({
      type: "line",
      "source-layer": "water",
      paint: { "line-color": mapPalette(name).boundaryCountry },
    });
    expect(matches(coast, { class: "ocean" }, POLYGON, 6)).toBe(true);
    for (const other of ["lake", "river", "pond"]) {
      expect(matches(coast, { class: other }, POLYGON, 6)).toBe(false);
    }
    expect(indexOf(style, "germany-mask")).toBeLessThan(indexOf(style, "coastline"));
  });

  it.each(MAP_STYLES)(
    "puts no water fill above the mask, so nothing drawn on the ground is hidden in %s",
    (name) => {
      const style = build(name);
      const mask = indexOf(style, "germany-mask");

      for (const entry of groundWater(style)) {
        expect(indexOf(style, entry.id)).toBeLessThan(mask);
      }
      expect(style.layers.slice(mask + 1).some((entry) => entry.type === "fill")).toBe(false);
    },
  );

  it.each(SEA_STYLES)(
    "colours the ocean in the ground water layer, below every road, building and waterway, in %s",
    (name) => {
      const style = build(name);
      const palette = mapPalette(name);
      const ocean = groundWater(style).filter(
        (entry) =>
          paintAt(entry, "fill-color", latest.paint_fill["fill-color"], 8, { class: "ocean" }) ===
          palette.seaGround,
      );

      expect(ocean.length).toBeGreaterThan(0);
      for (const entry of ocean) {
        for (const above of GROUND_ABOVE_SEA) {
          expect(indexOf(style, entry.id)).toBeLessThan(indexOf(style, above));
        }
        expect(
          paintAt(entry, "fill-color", latest.paint_fill["fill-color"], 8, { class: "lake" }),
        ).toBe(palette.water);
      }
    },
  );

  it("leaves the satellite imagery sea as the photograph shows it", () => {
    const style = build("satellite");

    expect(groundWater(style)).toEqual([]);
    expect(mapPalette("satellite").seaGround).toBeNull();
  });

  describe.each(
    GERMAN_BORDERS.map((properties) => [JSON.stringify(properties), properties] as const),
  )("the German border tagged %s", (_label, properties) => {
    it.each(MAP_STYLES)(
      "is drawn once: the outline over the tile line up to zoom 11 in %s",
      (name) => {
        const style = build(name);
        for (let zoom = 3; zoom <= 10.5; zoom += 0.5) {
          const lines = tileLinesAt(style, properties, zoom);
          expect(lines.length).toBeLessThanOrEqual(1);
          expect(opacityAt(layerOf(style, "germany-outline"), zoom)).toBe(1);
          for (const line of lines) {
            expect(indexOf(style, line.id)).toBeLessThan(indexOf(style, "germany-outline"));
          }
        }
      },
    );

    it.each(MAP_STYLES)("is drawn once: the tile line alone from zoom 12 in %s", (name) => {
      const style = build(name);
      for (let zoom = 12; zoom <= 17; zoom += 1) {
        expect(opacityAt(layerOf(style, "germany-outline"), zoom)).toBe(0);
        expect(tileLinesAt(style, properties, zoom)).toHaveLength(1);
      }
    });
  });

  it("fades the outline out between zoom 11 and 12, where the exact tile line takes over", () => {
    const outline = layerOf(build("dark"), "germany-outline");

    expect(opacityAt(outline, 10.9)).toBe(1);
    expect(opacityAt(outline, 11.5)).toBeGreaterThan(0);
    expect(opacityAt(outline, 11.5)).toBeLessThan(1);
    expect(opacityAt(outline, 12)).toBe(0);
  });

  it("draws neighbour borders and no sea line from the country layers", () => {
    const style = build("dark");

    for (const zoom of [3, 6, 10]) {
      const drawn = (properties: Properties) =>
        style.layers.filter(
          (entry) =>
            entry.id.startsWith("boundary_country") && matches(entry, properties, LINE, zoom),
        );
      expect(drawn(POLAND_CZECHIA_BORDER)).toHaveLength(1);
      expect(drawn(NORTH_SEA_LINE)).toHaveLength(0);
    }
  });

  it.each(MAP_STYLES)(
    "draws Germany thicker than before and above every other line in %s",
    (name) => {
      const style = build(name);
      const outline = layerOf(style, "germany-outline");

      expect(widthAt(outline, 4)).toBeGreaterThan(0.8);
      expect(widthAt(outline, 10)).toBeGreaterThan(1.4);
      for (const zoom of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16]) {
        expect(widthAt(outline, Math.max(zoom, 4))).toBeGreaterThan(
          widthAt(layerOf(style, "coastline"), zoom),
        );
        for (const id of COUNTRY_LAYERS) {
          expect(widthAt(outline, Math.max(zoom, 4))).toBeGreaterThan(
            widthAt(layerOf(style, id), zoom),
          );
        }
      }
    },
  );

  it("keeps Germany's line the strongest in colour too, also over the satellite imagery", () => {
    for (const name of MAP_STYLES) {
      const palette = mapPalette(name);
      const style = build(name);
      const outline = (layerOf(style, "germany-outline").paint as Record<string, string>)[
        "line-color"
      ] as string;
      const land = masked(palette.land, palette.mask, palette.maskOpacity);

      if (name === "satellite") {
        expect(outline).toBe(colorValue("map-rail-satellite", "light"));
        expect(luminance(outline)).toBeGreaterThan(luminance(palette.boundaryCountry));
        for (const id of ["coastline", ...COUNTRY_LAYERS]) {
          expect((layerOf(style, id).paint as Record<string, number>)["line-opacity"]).toBeLessThan(
            1,
          );
        }
      } else {
        expect(ratio(outline, land)).toBeGreaterThan(ratio(palette.boundaryCountry, land));
      }
    }
  });

  it("keeps neighbour borders and coasts thin but visible, and no wider than 1.4 px past zoom 12", () => {
    const style = build("dark");

    for (const id of ["coastline", ...COUNTRY_LAYERS]) {
      for (const zoom of [3, 5, 8, 12, 16]) {
        const width = widthAt(layerOf(style, id), zoom);
        expect(width).toBeGreaterThanOrEqual(0.6);
        expect(width).toBeLessThanOrEqual(1.6);
      }
    }
    for (const id of COUNTRY_LAYERS) {
      expect(widthAt(layerOf(style, id), 16)).toBeLessThanOrEqual(1.4);
    }
  });

  it("keeps the Land focus widths: the national outline as before at every zoom, the focused Land on top", () => {
    const style = build("dark", "DE-BY");
    const outline = layerOf(style, "germany-outline");
    const focus = layerOf(style, "land-focus-outline");

    expect(widthAt(outline, 4)).toBe(0.8);
    expect(widthAt(outline, 10)).toBe(1.4);
    expect(opacityAt(outline, 14)).toBe(1);
    expect((focus.paint as Record<string, unknown>)["line-width"]).toBe(1.6);
    expect(indexOf(style, "germany-outline")).toBeLessThan(indexOf(style, "land-focus-outline"));
  });

  describe("contrast under the mask", () => {
    const THEME = { dark: "dark", light: "light", terrain: "light" } as const;
    const seen = (name: (typeof SEA_STYLES)[number]) => {
      const palette = mapPalette(name);
      return {
        palette,
        land: masked(palette.land, palette.mask, palette.maskOpacity),
        sea: masked(palette.seaGround as string, palette.mask, palette.maskOpacity),
      };
    };

    it.each(SEA_STYLES)(
      "paints the sea so that, under the mask, it shows the sea token in %s",
      (name) => {
        const { sea } = seen(name);
        const token = parts(colorValue("map-sea", THEME[name]));

        parts(sea).forEach((channelValue, at) => {
          expect(Math.abs(channelValue - (token[at] as number))).toBeLessThanOrEqual(2);
        });
      },
    );

    it.each(SEA_STYLES)("tells the sea from the masked land in %s", (name) => {
      const { land, sea } = seen(name);

      expect(ratio(sea, land)).toBeGreaterThanOrEqual(name === "dark" ? 1.05 : 1.2);
      expect(luminance(sea)).toBeLessThan(luminance(land));
    });

    it.each(SEA_STYLES)(
      "reads neighbour lines and the coast against sea and land in %s",
      (name) => {
        const { palette, land, sea } = seen(name);

        expect(ratio(palette.boundaryCountry, land)).toBeGreaterThanOrEqual(1.9);
        expect(ratio(palette.boundaryCountry, sea)).toBeGreaterThanOrEqual(1.9);
        expect(ratio(palette.outline, land)).toBeGreaterThanOrEqual(2.4);
        expect(ratio(palette.outline, sea)).toBeGreaterThanOrEqual(2);
      },
    );
  });
});
