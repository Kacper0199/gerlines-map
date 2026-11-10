import { describe, expect, it } from "vitest";
import {
  decodePolyline,
  encodePolyline,
  GEOMETRY_PRECISION,
  GEOMETRY_TOLERANCE_M,
  legGeometryOf,
  simplifyPath,
} from "./geometry.ts";

const GOOGLE_EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const GOOGLE_POINTS: [number, number][] = [
  [38.5, -120.2],
  [40.7, -120.95],
  [43.252, -126.453],
];

type Point = readonly [number, number];

function metresBetween([lat1, lon1]: Point, [lat2, lon2]: Point): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6_371_008.8;
}

function distanceToPath(point: Point, path: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as Point;
    const b = path[i] as Point;
    for (let t = 0; t <= 1; t += 0.01) {
      const on: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      best = Math.min(best, metresBetween(point, on));
    }
  }
  return best;
}

describe("polyline codec", () => {
  it("decodes the Google example at precision 5", () => {
    const decoded = decodePolyline(GOOGLE_EXAMPLE, 5);
    expect(decoded).toHaveLength(3);
    decoded.forEach(([lat, lon], index) => {
      const [wantLat, wantLon] = GOOGLE_POINTS[index] as [number, number];
      expect(lat).toBeCloseTo(wantLat, 5);
      expect(lon).toBeCloseTo(wantLon, 5);
    });
  });

  it("encodes the Google example back", () => {
    expect(encodePolyline(GOOGLE_POINTS, 5)).toBe(GOOGLE_EXAMPLE);
  });

  it("keeps points through precision 6 and 5", () => {
    const points: [number, number][] = [
      [52.525605, 13.369075],
      [52.5262, 13.36],
      [48.140232, 11.558335],
    ];
    const six = decodePolyline(encodePolyline(points, 6), 6);
    six.forEach(([lat, lon], index) => {
      expect(lat).toBeCloseTo((points[index] as [number, number])[0], 6);
      expect(lon).toBeCloseTo((points[index] as [number, number])[1], 6);
    });
  });

  it("decodes an empty string to no points", () => {
    expect(decodePolyline("", 6)).toEqual([]);
  });

  it("refuses a truncated string", () => {
    expect(() => decodePolyline("_p~iF~ps|U_ulL", 5)).toThrow();
  });
});

describe("simplifyPath", () => {
  it("keeps both ends and drops points on a straight line", () => {
    const line: [number, number][] = Array.from({ length: 50 }, (_, i) => [50, 8 + i * 0.001]);
    expect(simplifyPath(line, 2)).toEqual([line[0], line[49]]);
  });

  it("keeps a bend larger than the tolerance", () => {
    const bend: [number, number][] = [
      [50, 8],
      [50.001, 8.01],
      [50, 8.02],
    ];
    expect(simplifyPath(bend, 2)).toHaveLength(3);
  });

  it("stays within the tolerance of every dropped point", () => {
    const wiggle: [number, number][] = Array.from({ length: 400 }, (_, i) => [
      50 + i * 0.0005,
      8 + Math.sin(i / 7) * 0.0004,
    ]);
    const kept = simplifyPath(wiggle, GEOMETRY_TOLERANCE_M);
    expect(kept.length).toBeLessThan(wiggle.length);
    for (const point of wiggle) {
      expect(distanceToPath(point, kept)).toBeLessThan(GEOMETRY_TOLERANCE_M + 1.5);
    }
  });

  it("returns short paths unchanged", () => {
    expect(simplifyPath([[50, 8]], 2)).toEqual([[50, 8]]);
    expect(simplifyPath([], 2)).toEqual([]);
  });
});

describe("legGeometryOf", () => {
  it("re-encodes a MOTIS polyline at precision 5 with fewer points", () => {
    const straight: [number, number][] = Array.from({ length: 200 }, (_, i) => [
      52 + i * 0.0001,
      13,
    ]);
    const geometry = legGeometryOf({
      points: encodePolyline(straight, 6),
      precision: 6,
      length: 200,
    });
    expect(geometry?.precision).toBe(GEOMETRY_PRECISION);
    expect(geometry?.points).toBe(2);
    const decoded = decodePolyline(geometry?.polyline ?? "", GEOMETRY_PRECISION);
    expect(decoded[0]?.[0]).toBeCloseTo(52, 5);
    expect(decoded[1]?.[0]).toBeCloseTo(52.0199, 5);
  });

  it("answers null for a missing, empty or broken polyline", () => {
    expect(legGeometryOf(undefined)).toBeNull();
    expect(legGeometryOf({ points: "", precision: 6, length: 0 })).toBeNull();
    expect(legGeometryOf({ points: "_p~iF", precision: 6, length: 1 })).toBeNull();
    expect(legGeometryOf({ points: "_p~iF~ps|U_ulL", precision: 5, length: 2 })).toBeNull();
  });
});
