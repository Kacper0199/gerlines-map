import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { groundDistance, lonLatToMercator } from "../src/mercator.ts";
import {
  createShape,
  createShapeSample,
  type ProjectionResult,
  projectOntoShape,
  sampleShape,
  segmentAt,
  shapeFromLonLat,
  vertexS,
  vertexX,
  vertexY,
  vertexZ,
} from "../src/shape.ts";
import {
  distanceToPolylineMercator,
  FRANKFURT_MERCATOR,
  PROPERTY_SEED,
  shapeArbitrary,
} from "./arbitraries.ts";

const { x: X0, y: Y0 } = FRANKFURT_MERCATOR;

function straightEastShape(groundMetres: number) {
  const start = { x: X0, y: Y0 };
  const scale = Math.hypot(1, 0) / groundDistance(X0, Y0, X0 + 1, Y0);
  return createShape({ x: [start.x, start.x + groundMetres * scale], y: [start.y, start.y] });
}

describe("createShape", () => {
  it("stores cumulative ground arc length in metres, not Mercator metres", () => {
    const shape = straightEastShape(1000);
    expect(shape.length).toBeCloseTo(1000, 6);
    expect(vertexX(shape, 1)).toBeGreaterThan(X0 + 1500);
  });

  it("adds the vertical component to arc length when elevation is given", () => {
    const flat = straightEastShape(300);
    const climbing = createShape({
      x: [vertexX(flat, 0), vertexX(flat, 1)],
      y: [vertexY(flat, 0), vertexY(flat, 1)],
      z: [100, 140],
    });
    expect(climbing.length).toBeCloseTo(Math.hypot(300, 40), 6);
  });

  it("uses arc lengths supplied by the pipeline as they are", () => {
    const shape = createShape({ x: [X0, X0 + 100, X0 + 300], y: [Y0, Y0, Y0], s: [0, 70, 200] });
    expect([0, 1, 2].map((i) => vertexS(shape, i))).toEqual([0, 70, 200]);
  });

  it("rejects supplied arc lengths that do not start at 0 or that decrease", () => {
    expect(() =>
      createShape({ x: [X0, X0 + 100, X0 + 300], y: [Y0, Y0, Y0], s: [5, 75, 205] }),
    ).toThrow(RangeError);
    expect(() =>
      createShape({ x: [X0, X0 + 100, X0 + 300], y: [Y0, Y0, Y0], s: [0, 70, 60] }),
    ).toThrow(RangeError);
  });

  it("drops repeated points so arc length strictly increases", () => {
    const shape = createShape({ x: [X0, X0, X0 + 10, X0 + 10, X0 + 20], y: [Y0, Y0, Y0, Y0, Y0] });
    expect(shape.vertexCount).toBe(3);
    for (let i = 1; i < shape.vertexCount; i++) {
      expect(vertexS(shape, i)).toBeGreaterThan(vertexS(shape, i - 1));
    }
  });

  it("rejects shapes with fewer than two distinct points", () => {
    expect(() => createShape({ x: [X0, X0], y: [Y0, Y0] })).toThrow(RangeError);
  });

  it("rejects non-finite coordinates and mismatched lengths", () => {
    expect(() => createShape({ x: [X0, Number.NaN], y: [Y0, Y0] })).toThrow(RangeError);
    expect(() => createShape({ x: [X0, X0 + 1], y: [Y0] })).toThrow(RangeError);
  });

  it("builds from WGS84 longitude and latitude", () => {
    const shape = shapeFromLonLat([
      [8, 50],
      [8, 50 + 1 / 60],
    ]);
    expect(shape.length).toBeCloseTo(1853.82, 1);
    expect(vertexY(shape, 0)).toBeCloseTo(lonLatToMercator(8, 50).y, 6);
  });
});

describe("sampleShape", () => {
  const corner = createShape({ x: [X0, X0 + 1000, X0 + 1000], y: [Y0, Y0, Y0 + 1000] });

  it("interpolates linearly inside a segment", () => {
    const sample = createShapeSample();
    sampleShape(corner, vertexS(corner, 1) / 2, sample);
    expect(sample.x).toBeCloseTo(X0 + 500, 6);
    expect(sample.y).toBeCloseTo(Y0, 6);
    expect(sample.beyondEnd).toBe(0);
  });

  it("turns the heading smoothly through a vertex", () => {
    const sample = createShapeSample();
    sampleShape(corner, vertexS(corner, 1), sample);
    expect(sample.tangentX).toBeCloseTo(Math.SQRT1_2, 9);
    expect(sample.tangentY).toBeCloseTo(Math.SQRT1_2, 9);
    expect(Math.hypot(sample.tangentX, sample.tangentY)).toBeCloseTo(1, 12);
  });

  it("extrapolates along the end tangent and reports the distance beyond the shape", () => {
    const sample = createShapeSample();
    sampleShape(corner, -25, sample);
    expect(sample.beyondEnd).toBe(25);
    expect(sample.x).toBeLessThan(X0);
    sampleShape(corner, corner.length + 10, sample);
    expect(sample.beyondEnd).toBe(10);
    expect(sample.y).toBeGreaterThan(Y0 + 1000);
  });

  it("keeps a unit heading where the polyline reverses on itself", () => {
    const reversal = createShape({ x: [X0, X0 + 100, X0], y: [Y0, Y0, Y0 + 1e-9] });
    const sample = createShapeSample();
    sampleShape(reversal, vertexS(reversal, 1), sample);
    expect(Math.hypot(sample.tangentX, sample.tangentY)).toBeCloseTo(1, 6);
  });

  it("interpolates elevation", () => {
    const hill = createShape({ x: [X0, X0 + 1000], y: [Y0, Y0], z: [100, 200] });
    const sample = createShapeSample();
    sampleShape(hill, hill.length / 4, sample);
    expect(sample.z).toBeCloseTo(125, 9);
  });

  it("reads the elevation of a vertex, zero for a shape without elevation", () => {
    const hill = createShape({ x: [X0, X0 + 1000], y: [Y0, Y0], z: [100, 200] });
    const flat = createShape({ x: [X0, X0 + 1000], y: [Y0, Y0] });
    expect([vertexZ(hill, 0), vertexZ(hill, 1)]).toEqual([100, 200]);
    expect([vertexZ(flat, 0), vertexZ(flat, 1)]).toEqual([0, 0]);
  });
});

describe("segmentAt", () => {
  const shape = createShape({
    x: Array.from({ length: 101 }, (_, i) => X0 + i * 10),
    y: Array.from({ length: 101 }, () => Y0),
  });

  it("finds the segment from any hint, forwards and backwards", () => {
    const target = vertexS(shape, 73);
    expect(segmentAt(shape, target + 0.1, 0)).toBe(73);
    expect(segmentAt(shape, target + 0.1, 99)).toBe(73);
    expect(segmentAt(shape, target + 0.1, 72)).toBe(73);
  });

  it("clamps out-of-range arc lengths to the end segments", () => {
    expect(segmentAt(shape, -5, 50)).toBe(0);
    expect(segmentAt(shape, shape.length + 5, 3)).toBe(99);
  });
});

describe("projectOntoShape", () => {
  const hairpin = createShape({
    x: [X0, X0 + 2000, X0 + 2000, X0],
    y: [Y0, Y0, Y0 + 100, Y0 + 100],
  });

  it("returns the arc length and ground distance of the nearest point", () => {
    const result: ProjectionResult = projectOntoShape(hairpin, X0 + 500, Y0 + 20, 0, 1000);
    expect(result.x).toBeCloseTo(X0 + 500, 6);
    expect(result.y).toBeCloseTo(Y0, 6);
    expect(result.distance).toBeCloseTo(groundDistance(X0 + 500, Y0, X0 + 500, Y0 + 20), 6);
  });

  it("stays inside the window and ignores the closer parallel track outside it", () => {
    const sReturnLeg = vertexS(hairpin, 2) + 1000;
    const result = projectOntoShape(hairpin, X0 + 500, Y0 + 20, sReturnLeg - 500, sReturnLeg + 500);
    expect(result.y).toBeCloseTo(Y0 + 100, 6);
    expect(result.s).toBeGreaterThan(vertexS(hairpin, 2));
  });

  it("clips the result to the window boundaries", () => {
    const result = projectOntoShape(hairpin, X0 + 1500, Y0, 0, 300);
    expect(result.s).toBeCloseTo(300, 6);
  });
});

describe("shape properties", () => {
  it("every sampled point lies on the polyline within 1 mm", () => {
    fc.assert(
      fc.property(shapeArbitrary, fc.double({ min: 0, max: 1, noNaN: true }), (shape, f) => {
        const sample = createShapeSample();
        sampleShape(shape, f * shape.length, sample);
        const mercatorPerGround = 1.7;
        expect(distanceToPolylineMercator(shape, sample.x, sample.y)).toBeLessThan(
          0.001 * mercatorPerGround,
        );
      }),
      { seed: PROPERTY_SEED, numRuns: 2000 },
    );
  });

  it("cursor walking over increasing arc lengths agrees with a fresh search", () => {
    fc.assert(
      fc.property(
        shapeArbitrary,
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 40 }),
        (shape, fractions) => {
          const sorted = [...fractions].sort((a, b) => a - b);
          let hint = 0;
          for (const f of sorted) {
            const s = f * shape.length;
            hint = segmentAt(shape, s, hint);
            expect(vertexS(shape, hint)).toBeLessThanOrEqual(s);
            expect(vertexS(shape, hint + 1)).toBeGreaterThanOrEqual(s);
            expect(hint).toBe(segmentAt(shape, s, 0));
          }
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 1000 },
    );
  });

  it("projecting a sampled point over the whole shape returns a point within 1 mm of it", () => {
    fc.assert(
      fc.property(shapeArbitrary, fc.double({ min: 0, max: 1, noNaN: true }), (shape, f) => {
        const sample = createShapeSample();
        sampleShape(shape, f * shape.length, sample);
        const result = projectOntoShape(shape, sample.x, sample.y, 0, shape.length);
        expect(result.distance).toBeLessThan(0.001);
      }),
      { seed: PROPERTY_SEED, numRuns: 1000 },
    );
  });

  it("arc length is non-decreasing in the sampled position along a monotone walk", () => {
    fc.assert(
      fc.property(shapeArbitrary, (shape) => {
        const sample = createShapeSample();
        let previousX = Number.NaN;
        let previousY = Number.NaN;
        let walked = 0;
        const steps = 200;
        for (let k = 0; k <= steps; k++) {
          sampleShape(shape, (k / steps) * shape.length, sample);
          if (k > 0) walked += groundDistance(previousX, previousY, sample.x, sample.y);
          previousX = sample.x;
          previousY = sample.y;
        }
        expect(walked).toBeLessThanOrEqual(shape.length * (1 + 1e-9) + 1e-6);
      }),
      { seed: PROPERTY_SEED, numRuns: 500 },
    );
  });
});
