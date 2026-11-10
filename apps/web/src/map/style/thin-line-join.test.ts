import { expression } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { buildStyle } from "./build-style.ts";
import { THIN_LINE_JOIN } from "./layer-kit.ts";

const BASE = { assetBaseUrl: "http://127.0.0.1:5173/", labelLanguage: "en" } as const;
const THIN = [
  "boundary_state",
  "boundary_country_z0-4",
  "boundary_country_z5-",
  "coastline",
  "germany-outline",
  "highway_motorway_subtle",
  "highway_path",
  "highway_minor",
  "highway_major_subtle",
  "highway_motorway_inner",
  "railway",
];

function joinAt(zoom: number): unknown {
  const compiled = expression.createExpression(THIN_LINE_JOIN, {
    type: "enum",
    values: { bevel: {}, round: {}, miter: {} },
    expression: { interpolated: false, parameters: ["zoom"] },
  } as never);
  if (compiled.result !== "success") throw new Error("the join expression does not compile");
  return compiled.value.evaluate({ zoom });
}

describe("the join of thin lines", () => {
  it("is mitred below zoom 10, where lines are under two pixels wide with several vertices per pixel, and round from there", () => {
    expect(joinAt(4)).toBe("miter");
    expect(joinAt(9.99)).toBe("miter");
    expect(joinAt(10)).toBe("round");
    expect(joinAt(16)).toBe("round");
  });

  it("is the one of every long tile line and of the national outline", () => {
    const layers = buildStyle({ ...BASE, style: "dark" }).layers as LayerSpecification[];
    for (const id of THIN) {
      const found = layers.find((entry) => entry.id === id);
      expect(found, id).toBeDefined();
      expect((found as { layout?: Record<string, unknown> }).layout?.["line-join"], id).toEqual(
        THIN_LINE_JOIN,
      );
    }
  });

  it("keeps the casings of roads, which are drawn with butt caps and mitred joins at every zoom", () => {
    const layers = buildStyle({ ...BASE, style: "dark" }).layers as LayerSpecification[];
    const casing = layers.find((entry) => entry.id === "highway_motorway_casing") as {
      layout?: Record<string, unknown>;
    };
    expect(casing.layout).toMatchObject({ "line-cap": "butt", "line-join": "miter" });
  });
});
