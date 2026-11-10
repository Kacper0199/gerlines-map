import { describe, expect, it } from "vitest";
import {
  groundDistance,
  latitudeFromMercatorY,
  lonLatToMercator,
  mercatorToLonLat,
  WEB_MERCATOR_RADIUS,
} from "../src/mercator.ts";

describe("Web Mercator conversion", () => {
  it("maps the origin and round-trips Frankfurt Hbf", () => {
    expect(lonLatToMercator(0, 0)).toEqual({ x: 0, y: 0 });
    const frankfurt = lonLatToMercator(8.662206, 50.105976);
    const back = mercatorToLonLat(frankfurt.x, frankfurt.y);
    expect(back.lon).toBeCloseTo(8.662206, 12);
    expect(back.lat).toBeCloseTo(50.105976, 12);
  });

  it("matches the EPSG:3857 easting of 180 degrees", () => {
    expect(lonLatToMercator(180, 0).x).toBeCloseTo(Math.PI * WEB_MERCATOR_RADIUS, 6);
  });

  it("recovers the geodetic latitude from a Mercator northing", () => {
    const { y } = lonLatToMercator(10, 52.52);
    expect(latitudeFromMercatorY(y)).toBeCloseTo((52.52 * Math.PI) / 180, 12);
  });
});

describe("groundDistance on the WGS84 ellipsoid (references from GeographicLib 2.1 Geodesic.WGS84)", () => {
  it("returns the length of one minute of latitude at 50 degrees north", () => {
    const a = lonLatToMercator(8, 50);
    const b = lonLatToMercator(8, 50 + 1 / 60);
    expect(Math.abs(groundDistance(a.x, a.y, b.x, b.y) - 1853.8204099149266)).toBeLessThan(0.01);
  });

  it("returns the length of one minute of longitude at 50 degrees north", () => {
    const a = lonLatToMercator(8, 50);
    const b = lonLatToMercator(8 + 1 / 60, 50);
    expect(Math.abs(groundDistance(a.x, a.y, b.x, b.y) - 1194.9292244611997)).toBeLessThan(0.01);
  });

  it("is far smaller than the Mercator distance in Germany", () => {
    const a = lonLatToMercator(8, 50);
    const b = lonLatToMercator(8.01, 50.01);
    const mercator = Math.hypot(b.x - a.x, b.y - a.y);
    const ratio = mercator / groundDistance(a.x, a.y, b.x, b.y);
    expect(ratio).toBeGreaterThan(1.54);
    expect(ratio).toBeLessThan(1.57);
  });
});
