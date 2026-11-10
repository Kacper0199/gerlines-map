import { describe, expect, it } from "vitest";
import { dashPieces, groundMetres, legPath, ribbonRing } from "./geometry.ts";

const LON = Float32Array.from([10, 10.01, 10.02, 10.03, 10.04]);
const PATH = Float32Array.from(Array.from(LON).flatMap((lon) => [lon, 50]));
const HEIGHTS = Float32Array.from([100, 110, 120, 130, 140]);

const points = (xyz: Float32Array) =>
  Array.from({ length: xyz.length / 3 }, (_, i) => [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]);

describe("groundMetres", () => {
  it("measures a degree of longitude at 50 degrees north near 71.5 km", () => {
    expect(groundMetres(10, 50, 11, 50)).toBeGreaterThan(71_000);
    expect(groundMetres(10, 50, 11, 50)).toBeLessThan(72_000);
  });
});

describe("legPath", () => {
  it("starts and ends at the fractional vertices with heights interpolated on the segment", () => {
    const xyz = legPath(PATH, HEIGHTS, 0.5, 2.25, 0);
    const p = points(xyz);
    expect(p[0]?.[0]).toBeCloseTo(10.005, 5);
    expect(p[0]?.[2]).toBeCloseTo(105, 3);
    expect(p.at(-1)?.[0]).toBeCloseTo(10.0225, 5);
    expect(p.at(-1)?.[2]).toBeCloseTo(122.5, 3);
  });

  it("keeps the vertices between the two ends", () => {
    const p = points(legPath(PATH, HEIGHTS, 0.5, 2.25, 0));
    expect(p.map((point) => point[0]?.toFixed(3))).toEqual([
      "10.005",
      "10.010",
      "10.020",
      "10.023",
    ]);
  });

  it("lifts every point and takes height zero where the map is flat", () => {
    const flat = points(legPath(PATH, undefined, 1, 2, 7));
    expect(flat.map((point) => point[2])).toEqual([7, 7]);
    const lifted = points(legPath(PATH, HEIGHTS, 1, 2, 7));
    expect(lifted.map((point) => point[2])).toEqual([117, 127]);
  });

  it("drops vertices closer than the spacing but keeps both ends", () => {
    const xyz = legPath(PATH, HEIGHTS, 0, 4, 0, 1500);
    const p = points(xyz);
    expect(p.length).toBeLessThan(5);
    expect(p[0]?.[0]).toBeCloseTo(10, 5);
    expect(p.at(-1)?.[0]).toBeCloseTo(10.04, 5);
  });

  it("is empty for a leg that ends before it starts", () => {
    expect(legPath(PATH, HEIGHTS, 3, 2, 0)).toHaveLength(0);
  });
});

describe("dashPieces", () => {
  it("cuts a path into dashes of the given length with gaps between", () => {
    const xyz = legPath(PATH, HEIGHTS, 0, 4, 0);
    const total = groundMetres(10, 50, 10.04, 50);
    const pieces = dashPieces(xyz, total / 8, total / 8);
    expect(pieces).toHaveLength(4);
    for (const piece of pieces) {
      const p = points(piece);
      expect(groundMetres(p[0]?.[0] as number, 50, p.at(-1)?.[0] as number, 50)).toBeCloseTo(
        total / 8,
        -1,
      );
    }
  });

  it("returns the path whole when it is shorter than one dash", () => {
    const xyz = legPath(PATH, HEIGHTS, 0, 0.001, 0);
    expect(dashPieces(xyz, 5000, 5000)).toHaveLength(1);
  });
});

describe("ribbonRing", () => {
  it("is a closed strip of the given half width around the path, forward on one side and back on the other", () => {
    const xyz = legPath(PATH, HEIGHTS, 0, 4, 0);
    const ring = ribbonRing(xyz, 20);
    expect(ring).toHaveLength(10);
    const [first, last] = [ring[0], ring[9]] as number[][];
    expect(
      groundMetres(
        first?.[0] as number,
        first?.[1] as number,
        last?.[0] as number,
        last?.[1] as number,
      ),
    ).toBeCloseTo(40, -1);
    expect(ring[0]?.[2]).toBe(100);
    expect(ring[4]?.[2]).toBe(140);
    expect(ring[5]?.[2]).toBe(140);
  });

  it("narrows on a tight arc so the edges of the ring do not cross", () => {
    const radius = 30;
    const arc = Array.from({ length: 31 }, (_, i) => {
      const angle = (i / 30) * (Math.PI / 2);
      return [
        10 + (radius * Math.sin(angle)) / (Math.cos(50 * (Math.PI / 180)) * 111_320),
        50 + (radius * (1 - Math.cos(angle))) / 111_320,
      ];
    });
    const xyz = Float32Array.from(arc.flatMap(([lon, lat]) => [lon as number, lat as number, 0]));
    const flat = (ring: number[][]) =>
      ring.map(([lon, lat]) => [
        ((lon as number) - 10) * Math.cos(50 * (Math.PI / 180)) * 111_320,
        ((lat as number) - 50) * 111_320,
      ]) as [number, number][];
    expect(crossings(flat(ribbonRing(xyz, 8)))).toBe(0);
    expect(crossings(flat(ribbonRing(xyz, 40)))).toBe(0);
  });

  it("keeps every point on a gentle curve", () => {
    const xyz = legPath(PATH, HEIGHTS, 0, 4, 0);
    expect(ribbonRing(xyz, 20)).toHaveLength(10);
  });

  it("is empty for fewer than two points", () => {
    expect(ribbonRing(Float32Array.from([10, 50, 0]), 20)).toEqual([]);
  });
});

function crossings(ring: readonly [number, number][]): number {
  const edges = ring.map(
    (point, i) => [point, ring[(i + 1) % ring.length] as [number, number]] as const,
  );
  const turn = (a: [number, number], b: [number, number], c: [number, number]) =>
    Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  let count = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 2; j < edges.length; j++) {
      if (i === 0 && j === edges.length - 1) continue;
      const [a, b] = edges[i] as readonly [[number, number], [number, number]];
      const [c, d] = edges[j] as readonly [[number, number], [number, number]];
      if (turn(a, b, c) !== turn(a, b, d) && turn(c, d, a) !== turn(c, d, b)) count++;
    }
  }
  return count;
}
