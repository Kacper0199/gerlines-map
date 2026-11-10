import {
  type Shape,
  segmentAt,
  vertexS,
  vertexX,
  vertexY,
  vertexZ,
  WEB_MERCATOR_RADIUS,
} from "@gerlines/geo";
import { drawnHeight, type Elevation } from "../map/terrain/elevation.ts";

const RADIANS_TO_DEGREES = 180 / Math.PI;

export function lonOf(x: number): number {
  return (x / WEB_MERCATOR_RADIUS) * RADIANS_TO_DEGREES;
}

export function latOf(y: number): number {
  return Math.atan(Math.sinh(y / WEB_MERCATOR_RADIUS)) * RADIANS_TO_DEGREES;
}

/** Compass bearing in degrees (clockwise from north) of a tangent in the map plane. */
export function bearingOf(tangentX: number, tangentY: number): number {
  return 90 - Math.atan2(tangentY, tangentX) * RADIANS_TO_DEGREES;
}

/** A shape as longitude and latitude pairs, for the route layers. */
export function shapeLonLat(shape: Shape): Float32Array {
  const path = new Float32Array(2 * shape.vertexCount);
  for (let i = 0; i < shape.vertexCount; i++) {
    path[2 * i] = lonOf(vertexX(shape, i));
    path[2 * i + 1] = latOf(vertexY(shape, i));
  }
  return path;
}

/** The height of each vertex of a shape on the relief, in the order of `shapeLonLat`. */
export function shapeHeights(shape: Shape, elevation: Elevation): Float32Array {
  const heights = new Float32Array(shape.vertexCount);
  for (let i = 0; i < shape.vertexCount; i++) {
    heights[i] = drawnHeight(vertexZ(shape, i), elevation);
  }
  return heights;
}

/**
 * Where arc lengths fall on a shape as fractional vertex indices, the unit the route layers and the
 * selected train's `vertex` use: the integer part is the segment, the fraction runs along it. Arcs outside the
 * shape sit on its ends.
 */
export function arcVertices(shape: Shape, arcs: ArrayLike<number>): Float32Array {
  const out = new Float32Array(arcs.length);
  let hint = 0;
  for (let i = 0; i < arcs.length; i++) {
    const s = Math.max(0, Math.min(shape.length, arcs[i] as number));
    hint = segmentAt(shape, s, hint);
    const start = vertexS(shape, hint);
    const end = vertexS(shape, hint + 1);
    out[i] = hint + (end > start ? Math.max(0, Math.min(1, (s - start) / (end - start))) : 0);
  }
  return out;
}
