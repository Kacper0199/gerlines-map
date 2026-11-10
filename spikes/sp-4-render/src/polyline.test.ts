import { describe, expect, it } from "vitest";
import {
  decodePolyline,
  encodePolyline,
  polylineLengthMetres,
  simplifyPolyline,
} from "./polyline.ts";

describe("polyline", () => {
  it("decodes the Google reference example", () => {
    const decoded = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(Array.from(decoded)).toEqual([-120.2, 38.5, -120.95, 40.7, -126.453, 43.252]);
  });

  it("round-trips through encode and decode", () => {
    const original = Float64Array.from([13.37, 52.52, 13.4, 52.53, 13.45, 52.51]);
    expect(Array.from(decodePolyline(encodePolyline(original)))).toEqual(Array.from(original));
  });

  it("measures length in metres", () => {
    const oneDegreeNorth = Float64Array.from([10, 50, 10, 51]);
    expect(polylineLengthMetres(oneDegreeNorth)).toBeCloseTo(110574, -1);
  });

  it("drops vertices on a straight line and keeps corners", () => {
    const line = Float64Array.from([10, 50, 10.001, 50, 10.002, 50, 10.002, 50.002]);
    const simplified = simplifyPolyline(line, 2);
    expect(simplified.length / 2).toBe(3);
    expect(simplified[2]).toBe(10.002);
  });
});
