import { describe, expect, it } from "vitest";
import { encodePolyline } from "../../test/helpers/encode-polyline.ts";
import { decodePolyline, POLYLINE_PRECISION } from "./polyline.ts";

describe("decodePolyline", () => {
  it("decodes the reference example into longitude and latitude pairs", () => {
    const decoded = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");

    expect(Array.from(decoded)).toEqual([-120.2, 38.5, -120.95, 40.7, -126.453, 43.252]);
  });

  it("returns an empty array for an empty string", () => {
    expect(decodePolyline("")).toHaveLength(0);
  });

  it("decodes a two point line from a real MOTIS segment", () => {
    const [lon0, lat0, lon1, lat1] = decodePolyline("gxt{Hw{l@fz_bAinsw@");

    expect(lon0).toBeCloseTo(0.235, 5);
    expect(lat0).toBeCloseTo(51.885, 5);
    expect(lon1).toBeCloseTo(9.51489, 5);
    expect(lat1).toBeCloseTo(40.90336, 5);
  });

  it("round trips points at precision 6", () => {
    const points = [
      [8.662206, 50.105976],
      [8.663118, 50.106533],
      [8.69, 50.12],
    ] as const;

    const decoded = decodePolyline(encodePolyline(points, 6), 6);

    expect(Array.from(decoded)).toEqual(points.flat());
  });

  it("stops at a truncated trailing coordinate instead of reading past the end", () => {
    const decoded = decodePolyline("_p~iF~ps|U_ulL");

    expect(Array.from(decoded)).toEqual([-120.2, 38.5]);
  });
});

describe("POLYLINE_PRECISION", () => {
  it("is the precision MOTIS answers in by default and the decoder assumes", () => {
    expect(POLYLINE_PRECISION).toBe(5);
    const points = [[13.40495, 52.52001]] as const;

    expect(Array.from(decodePolyline(encodePolyline(points), POLYLINE_PRECISION))).toEqual(
      Array.from(decodePolyline(encodePolyline(points))),
    );
  });
});
