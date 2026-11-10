import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  articulatedConsist,
  BOGIE_POINT_STRIDE,
  CAR_POSE_STRIDE,
  conventionalConsist,
  joinConsists,
  placeBogies,
  placeCars,
} from "../src/consist.ts";
import { createShape, type Shape } from "../src/shape.ts";
import { distanceToPolylineMercator, FRANKFURT_MERCATOR, PROPERTY_SEED } from "./arbitraries.ts";

const { x: X0, y: Y0 } = FRANKFURT_MERCATOR;

function eastShape(length: number, z?: [number, number]): Shape {
  return createShape(
    z
      ? { x: [X0, X0 + length], y: [Y0, Y0], z, s: [0, Math.hypot(length, z[1] - z[0])] }
      : { x: [X0, X0 + length], y: [Y0, Y0], s: [0, length] },
  );
}

function arcShape(radius: number, spacing: number, turns = 0.9): Shape {
  const count = Math.ceil((2 * Math.PI * radius * turns) / spacing) + 1;
  const x: number[] = [];
  const y: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i * spacing) / radius;
    x.push(X0 + radius * Math.sin(angle));
    y.push(Y0 + radius * (1 - Math.cos(angle)));
    s.push(
      i === 0
        ? 0
        : (s[i - 1] as number) +
            Math.hypot(
              (x[i] as number) - (x[i - 1] as number),
              (y[i] as number) - (y[i - 1] as number),
            ),
    );
  }
  return createShape({ x, y, s });
}

describe("consists", () => {
  it("places two bogies per conventional car, inset from the car ends", () => {
    const consist = conventionalConsist(
      [
        { length: 20, bogieInset: 2.5 },
        { length: 20, bogieInset: 2.5 },
      ],
      1,
    );
    expect(Array.from(consist.bogieOffsets)).toEqual([2.5, 17.5, 23.5, 38.5]);
    expect(consist.length).toBe(41);
    expect(Array.from(consist.carFront)).toEqual([0, 2]);
    expect(Array.from(consist.carRear)).toEqual([1, 3]);
    expect(Array.from(consist.carCentreFraction)).toEqual([0.5, 0.5]);
  });

  it("shares a Jacobs bogie between neighbouring bodies of an articulated unit", () => {
    const consist = articulatedConsist([15, 10, 15], 2);
    expect(Array.from(consist.bogieOffsets)).toEqual([2, 15, 25, 38]);
    expect(consist.length).toBe(40);
    expect(Array.from(consist.carFront)).toEqual([0, 1, 2]);
    expect(Array.from(consist.carRear)).toEqual([1, 2, 3]);
    expect(consist.carCentreFraction[0]).toBeCloseTo((7.5 - 2) / 13, 12);
    expect(consist.carCentreFraction[1]).toBeCloseTo(0.5, 12);
    expect(consist.carCentreFraction[2]).toBeCloseTo((32.5 - 25) / 13, 12);
  });

  it("joins units with a coupling gap", () => {
    const unit = articulatedConsist([15, 10, 15], 2);
    const pair = joinConsists([unit, unit], 1.5);
    expect(pair.length).toBe(81.5);
    expect(pair.carCount).toBe(6);
    expect(pair.bogieOffsets[4]).toBe(41.5 + 2);
    expect(pair.carFront[3]).toBe(4);
  });

  it("rejects bogies outside the car body", () => {
    expect(() => conventionalConsist([{ length: 10, bogieInset: 6 }])).toThrow(RangeError);
    expect(() => articulatedConsist([10], 11)).toThrow(RangeError);
  });
});

describe("placeCars", () => {
  it("puts car centres on a straight track at the midpoint of their bogies, heading east", () => {
    const shape = eastShape(1000);
    const consist = conventionalConsist(
      [
        { length: 20, bogieInset: 2.5 },
        { length: 20, bogieInset: 2.5 },
      ],
      1,
    );
    const poses = new Float64Array(consist.carCount * CAR_POSE_STRIDE);
    const beyond = placeCars(shape, 500, consist, poses);
    expect(beyond).toBe(0);
    expect(poses[0]).toBeCloseTo(X0 + 490, 9);
    expect(poses[CAR_POSE_STRIDE]).toBeCloseTo(X0 + 469, 9);
    expect(poses[3]).toBeCloseTo(0, 12);
    expect(poses[4]).toBeCloseTo(0, 12);
  });

  it("pitches cars on a grade", () => {
    const shape = eastShape(1000, [100, 140]);
    const consist = conventionalConsist([{ length: 20, bogieInset: 2.5 }]);
    const poses = new Float64Array(CAR_POSE_STRIDE);
    placeCars(shape, 500, consist, poses);
    expect(poses[4]).toBeCloseTo(Math.atan2(40, 1000), 9);
    expect(poses[2]).toBeGreaterThan(100);
  });

  it("places trains with more than 64 bogies", () => {
    const shape = eastShape(5000);
    const consist = conventionalConsist(
      Array.from({ length: 40 }, () => ({ length: 20, bogieInset: 2.5 })),
    );
    const poses = new Float64Array(consist.carCount * CAR_POSE_STRIDE);
    expect(placeCars(shape, 2000, consist, poses)).toBe(0);
    expect(poses[39 * CAR_POSE_STRIDE]).toBeCloseTo(X0 + 2000 - 39 * 20 - 10, 9);
  });

  it("reports how far the tail hangs beyond the start of the shape", () => {
    const shape = eastShape(1000);
    const consist = conventionalConsist([{ length: 20, bogieInset: 2.5 }]);
    const poses = new Float64Array(CAR_POSE_STRIDE);
    expect(placeCars(shape, 10, consist, poses)).toBeCloseTo(7.5, 9);
  });

  it("keeps bogies on the track and bodies within the sagitta on a 150 m radius curve", () => {
    const radius = 150;
    const shape = arcShape(radius, 2);
    const consist = articulatedConsist([20, 14, 14, 20], 2.5);
    const poses = new Float64Array(consist.carCount * CAR_POSE_STRIDE);
    placeCars(shape, 600, consist, poses);
    for (let c = 0; c < consist.carCount; c++) {
      const span =
        (consist.bogieOffsets[consist.carRear[c] as number] as number) -
        (consist.bogieOffsets[consist.carFront[c] as number] as number);
      const sagitta = (span * span + 2 * 2) / (8 * radius);
      const offTrack = distanceToPolylineMercator(
        shape,
        poses[c * CAR_POSE_STRIDE] as number,
        poses[c * CAR_POSE_STRIDE + 1] as number,
      );
      expect(offTrack).toBeLessThanOrEqual(sagitta + 1e-3);
    }
  });
});

describe("car placement properties", () => {
  it("bogie points stay on the polyline and car bodies within the sagitta of their bogie span plus the polyline chord error", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 120, max: 3000, noNaN: true }),
        fc.double({ min: 1, max: 25, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        (radius, spacing, fraction, articulated) => {
          const shape = arcShape(radius, spacing, 0.4);
          const consist = articulated
            ? articulatedConsist([18, 14, 14, 18], 2.5)
            : conventionalConsist(
                Array.from({ length: 4 }, () => ({ length: 26.4, bogieInset: 3.7 })),
                1,
              );
          const head = consist.length + fraction * (shape.length - consist.length);
          const poses = new Float64Array(consist.carCount * CAR_POSE_STRIDE);
          expect(placeCars(shape, head, consist, poses)).toBe(0);
          const points = new Float64Array(consist.bogieOffsets.length * BOGIE_POINT_STRIDE);
          placeBogies(shape, head, consist, points);
          for (let b = 0; b < consist.bogieOffsets.length; b++) {
            const o = b * BOGIE_POINT_STRIDE;
            const distance = distanceToPolylineMercator(
              shape,
              points[o] as number,
              points[o + 1] as number,
            );
            expect(distance).toBeLessThan(1e-3);
          }
          for (let c = 0; c < consist.carCount; c++) {
            const span =
              (consist.bogieOffsets[consist.carRear[c] as number] as number) -
              (consist.bogieOffsets[consist.carFront[c] as number] as number);
            const bound = (span * span + spacing * spacing) / (8 * radius);
            const offTrack = distanceToPolylineMercator(
              shape,
              poses[c * CAR_POSE_STRIDE] as number,
              poses[c * CAR_POSE_STRIDE + 1] as number,
            );
            expect(offTrack).toBeLessThanOrEqual(bound + 1e-3);
          }
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 1000 },
    );
  });
});
