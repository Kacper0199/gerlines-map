import type { Journey } from "@gerlines/schema/journeys";
import { describe, expect, it } from "vitest";
import { categoryColor, colorValue } from "../theme/tokens.ts";
import { FIXTURES } from "./fixtures.ts";
import { journeyFeatures, linePointsOf } from "./journey-layer.ts";
import { transitLegs } from "./journey-view.ts";

const ice = FIXTURES.bremenHamburg.journeys[0] as Journey;

describe("journeyFeatures", () => {
  it("draws a train leg as its MOTIS route line in the category colour", () => {
    const leg = transitLegs(ice)[0];
    if (!leg) throw new Error("no leg");
    const { features } = journeyFeatures(ice, "dark");
    const line = features.find((feature) => feature.geometry.type === "LineString");
    expect(line?.properties).toEqual({ kind: "transit", colour: categoryColor("dark", "hsr") });
    const coordinates = line?.geometry.coordinates as [number, number][];
    expect(coordinates).toHaveLength(leg.geometry?.points ?? 0);
    expect(coordinates.length).toBeGreaterThan(2);
    const [lon, lat] = coordinates[0] as [number, number];
    expect(Math.abs(lon - leg.from.lon)).toBeLessThan(0.01);
    expect(Math.abs(lat - leg.from.lat)).toBeLessThan(0.01);
  });

  it("marks both ends and each change", () => {
    const [first, second] = [
      transitLegs(ice)[0],
      transitLegs(FIXTURES.bremenHamburg.journeys[1] as Journey)[0],
    ];
    const twoLegs = { ...ice, legs: [first, second] } as Journey;
    const points = journeyFeatures(twoLegs, "light").features.filter(
      (feature) => feature.geometry.type === "Point",
    );
    expect(points.map((point) => point.properties.kind).sort()).toEqual(["change", "end", "end"]);
  });

  it("leaves out a train leg without a line instead of drawing it straight", () => {
    const withoutLine = {
      ...ice,
      legs: ice.legs.map((leg) => (leg.kind === "transit" ? { ...leg, geometry: null } : leg)),
    };
    const lines = journeyFeatures(withoutLine, "dark").features.filter(
      (feature) => feature.geometry.type === "LineString",
    );
    expect(lines).toEqual([]);
  });

  it("draws a walk between two stops as a dashed line in muted ink", () => {
    const leg = transitLegs(ice)[0];
    if (!leg) throw new Error("no leg");
    const walk = {
      kind: "walk" as const,
      from: leg.to,
      to: { ...leg.to, lon: leg.to.lon + 0.002 },
      departure: leg.arrival,
      arrival: leg.arrival,
      durationS: 240,
    };
    const { features } = journeyFeatures({ ...ice, legs: [leg, walk] }, "dark");
    expect(features.find((feature) => feature.properties.kind === "walk")?.properties).toEqual({
      kind: "walk",
      colour: colorValue("ink-muted", "dark"),
    });
  });

  it("is empty without a journey", () => {
    expect(journeyFeatures(null, "dark").features).toEqual([]);
    const leg = transitLegs(ice)[0];
    if (!leg) throw new Error("no leg");
    expect(linePointsOf({ ...leg, geometry: null })).toBeNull();
  });
});
