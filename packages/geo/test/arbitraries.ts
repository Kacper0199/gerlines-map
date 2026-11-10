import fc from "fast-check";
import { createShape, type Shape, vertexX, vertexY } from "../src/shape.ts";

export const PROPERTY_SEED = 20261024;

export const FRANKFURT_MERCATOR = { x: 964_000, y: 6_465_000 };

export interface PolylineSpec {
  readonly steps: readonly { readonly length: number; readonly turn: number }[];
  readonly startHeading: number;
}

export const polylineSpec: fc.Arbitrary<PolylineSpec> = fc.record({
  steps: fc.array(
    fc.record({
      length: fc.oneof(
        fc.double({ min: 0.5, max: 50, noNaN: true }),
        fc.double({ min: 50, max: 3000, noNaN: true }),
      ),
      turn: fc.oneof(
        fc.double({ min: -0.05, max: 0.05, noNaN: true }),
        fc.double({ min: -Math.PI * 0.95, max: Math.PI * 0.95, noNaN: true }),
      ),
    }),
    { minLength: 1, maxLength: 60 },
  ),
  startHeading: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
});

export function polylineFromSpec(spec: PolylineSpec): { x: number[]; y: number[] } {
  const x = [FRANKFURT_MERCATOR.x];
  const y = [FRANKFURT_MERCATOR.y];
  let heading = spec.startHeading;
  let px = FRANKFURT_MERCATOR.x;
  let py = FRANKFURT_MERCATOR.y;
  for (const step of spec.steps) {
    heading += step.turn;
    const mercatorLength = step.length * 1.55;
    px += mercatorLength * Math.cos(heading);
    py += mercatorLength * Math.sin(heading);
    x.push(px);
    y.push(py);
  }
  return { x, y };
}

export const shapeArbitrary: fc.Arbitrary<Shape> = polylineSpec.map((spec) =>
  createShape(polylineFromSpec(spec)),
);

export function distanceToPolylineMercator(shape: Shape, px: number, py: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < shape.vertexCount; i++) {
    const ax = vertexX(shape, i);
    const ay = vertexY(shape, i);
    const dx = vertexX(shape, i + 1) - ax;
    const dy = vertexY(shape, i + 1) - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
        : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return best;
}
