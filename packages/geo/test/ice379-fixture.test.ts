import { describe, expect, it } from "vitest";
import { loadIce379 } from "./ice379.ts";

describe("ICE 379 fixture", () => {
  const train = loadIce379();

  it("measures the route like GeographicLib geodesics over the same points", () => {
    const geographicLibTotal = 845_875.5814134143;
    expect(Math.abs(train.shape.length - geographicLibTotal)).toBeLessThan(1);
  });

  it("projects every stop onto the route in travel order, close to the track", () => {
    for (let k = 1; k < train.stops.length; k++) {
      expect(train.stops[k]?.s).toBeGreaterThan(train.stops[k - 1]?.s ?? 0);
    }
    for (const stop of train.stops) expect(stop.projectionDistance).toBeLessThan(500);
  });

  it("reads realtime clock times across midnight", () => {
    const basel = train.stops[train.stops.length - 1];
    expect(train.stops[0]?.departure).toBe(17 * 3600 + 22 * 60);
    expect(basel?.arrival).toBe(24 * 3600 + 45 * 60);
  });
});
