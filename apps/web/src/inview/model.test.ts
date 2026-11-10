import { describe, expect, it } from "vitest";
import { bearingDegrees, compassPointOf, distanceParts } from "./model.ts";

describe("bearingDegrees", () => {
  it("is 0 to the north, 90 to the east, 180 to the south, 270 to the west", () => {
    const from = { lon: 8, lat: 50 };
    expect(bearingDegrees(from, { lon: 8, lat: 51 })).toBeCloseTo(0, 3);
    expect(bearingDegrees(from, { lon: 9, lat: 50 })).toBeCloseTo(90, 0);
    expect(bearingDegrees(from, { lon: 8, lat: 49 })).toBeCloseTo(180, 3);
    expect(bearingDegrees(from, { lon: 7, lat: 50 })).toBeCloseTo(270, 0);
  });

  it("points north-east for a point up and to the right", () => {
    const bearing = bearingDegrees({ lon: 8, lat: 50 }, { lon: 8.1, lat: 50.07 });
    expect(bearing).toBeGreaterThan(30);
    expect(bearing).toBeLessThan(60);
  });
});

describe("compassPointOf", () => {
  it("cuts the circle into eight sectors centred on the points", () => {
    expect(compassPointOf(0)).toBe("n");
    expect(compassPointOf(22)).toBe("n");
    expect(compassPointOf(23)).toBe("ne");
    expect(compassPointOf(90)).toBe("e");
    expect(compassPointOf(135)).toBe("se");
    expect(compassPointOf(180)).toBe("s");
    expect(compassPointOf(225)).toBe("sw");
    expect(compassPointOf(270)).toBe("w");
    expect(compassPointOf(315)).toBe("nw");
    expect(compassPointOf(337)).toBe("nw");
    expect(compassPointOf(338)).toBe("n");
    expect(compassPointOf(360)).toBe("n");
    expect(compassPointOf(-45)).toBe("nw");
  });
});

describe("distanceParts", () => {
  it("rounds metres to ten under a kilometre", () => {
    expect(distanceParts(54)).toEqual({ unit: "m", value: 50 });
    expect(distanceParts(453)).toEqual({ unit: "m", value: 450 });
    expect(distanceParts(996)).toEqual({ unit: "km", value: 1 });
  });

  it("shows one decimal under ten kilometres and whole kilometres above", () => {
    expect(distanceParts(2340)).toEqual({ unit: "km", value: 2.3 });
    expect(distanceParts(9949)).toEqual({ unit: "km", value: 9.9 });
    expect(distanceParts(12_600)).toEqual({ unit: "km", value: 13 });
  });

  it("says the middle for a train within fifty metres", () => {
    expect(distanceParts(0)).toBe("centre");
    expect(distanceParts(49)).toBe("centre");
    expect(distanceParts(50)).not.toBe("centre");
  });
});
