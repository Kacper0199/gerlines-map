import { groundDistance, lonLatToMercator } from "./mercator.ts";

const MIN_SEGMENT_LENGTH = 1e-6;
const LINEAR_WALK_LIMIT = 8;

/**
 * Bytes per vertex record: s, x, y as Float64 (bytes 0 to 23), then z, tangentX, tangentY as
 * Float32 (bytes 24 to 35) and 4 bytes of padding. One record per vertex keeps a lookup (arc length
 * walk and interpolation between two vertices) to one or two cache lines.
 */
export const SHAPE_RECORD_BYTES = 40;
/** Float64 slots per record: s at 0, x at 1, y at 2. */
export const RECORD_DOUBLES = 5;
/** Float32 slots per record: z at 6, tangentX at 7, tangentY at 8. */
export const RECORD_FLOATS = 10;
const X = 1;
const Y = 2;
const Z = 6;
const TANGENT_X = 7;
const TANGENT_Y = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A track shape: an EPSG:3857 polyline with cumulative ground arc length, one record per vertex.
 *
 * `records` (Float64 view) holds per vertex the arc length s in ground metres on the WGS84
 * ellipsoid (0 at the first vertex, strictly increasing) and x, y in Web Mercator metres (the map
 * plane). `attributes` (Float32 view of the same buffer) holds z (elevation in metres, 0 without
 * elevation) and the unit vertex tangent in the map plane (bisector of the adjacent segments, for a
 * heading that turns smoothly through vertices). `buffer` can be transferred to a worker.
 */
export interface Shape {
  readonly buffer: ArrayBuffer;
  readonly records: Float64Array;
  readonly attributes: Float32Array;
  readonly vertexCount: number;
  readonly hasElevation: boolean;
  readonly length: number;
}

export interface MercatorPolyline {
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly z?: ArrayLike<number>;
  readonly s?: ArrayLike<number>;
}

/** Mutable output of sampleShape; reuse one instance per caller to avoid allocation per frame. */
export interface ShapeSample {
  x: number;
  y: number;
  z: number;
  tangentX: number;
  tangentY: number;
  segment: number;
  beyondEnd: number;
}

export interface ProjectionResult {
  readonly s: number;
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

export function createShapeSample(): ShapeSample {
  return { x: 0, y: 0, z: 0, tangentX: 1, tangentY: 0, segment: 0, beyondEnd: 0 };
}

export function vertexS(shape: Shape, index: number): number {
  return shape.records[index * RECORD_DOUBLES] as number;
}

export function vertexX(shape: Shape, index: number): number {
  return shape.records[index * RECORD_DOUBLES + X] as number;
}

export function vertexY(shape: Shape, index: number): number {
  return shape.records[index * RECORD_DOUBLES + Y] as number;
}

/** Elevation of a vertex in metres above sea level (0 for a shape built without elevation). */
export function vertexZ(shape: Shape, index: number): number {
  return shape.attributes[index * RECORD_FLOATS + Z] as number;
}

function assertFiniteArray(values: ArrayLike<number>, name: string, expectedLength: number): void {
  if (values.length !== expectedLength) {
    throw new RangeError(`${name} has ${values.length} values, expected ${expectedLength}`);
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new RangeError(`${name}[${i}] is not finite`);
  }
}

function assertArcLengthOrigin(s: ArrayLike<number>): void {
  if (s.length > 0 && s[0] !== 0) throw new RangeError(`s[0] must be 0, got ${s[0]}`);
  for (let i = 1; i < s.length; i++) {
    if ((s[i] as number) < (s[i - 1] as number)) throw new RangeError(`s decreases at ${i}`);
  }
}

function segmentGroundLength(input: MercatorPolyline, from: number, to: number): number {
  if (input.s) return (input.s[to] as number) - (input.s[from] as number);
  const horizontal = groundDistance(
    input.x[from] as number,
    input.y[from] as number,
    input.x[to] as number,
    input.y[to] as number,
  );
  if (!input.z) return horizontal;
  return Math.hypot(horizontal, (input.z[to] as number) - (input.z[from] as number));
}

function keptVertexIndices(input: MercatorPolyline): { indices: number[]; lengths: number[] } {
  const indices = [0];
  const lengths = [0];
  for (let i = 1; i < input.x.length; i++) {
    const last = indices[indices.length - 1] as number;
    const length = segmentGroundLength(input, last, i);
    if (length > MIN_SEGMENT_LENGTH) {
      indices.push(i);
      lengths.push(length);
    }
  }
  return { indices, lengths };
}

function writeVertexTangents(records: Float64Array, attributes: Float32Array, count: number): void {
  const segmentX = new Float64Array(count - 1);
  const segmentY = new Float64Array(count - 1);
  for (let i = 0; i + 1 < count; i++) {
    const a = i * RECORD_DOUBLES;
    const b = a + RECORD_DOUBLES;
    const dx = (records[b + X] as number) - (records[a + X] as number);
    const dy = (records[b + Y] as number) - (records[a + Y] as number);
    const norm = Math.hypot(dx, dy) || 1;
    segmentX[i] = dx / norm;
    segmentY[i] = dy / norm;
  }
  for (let i = 0; i < count; i++) {
    const before = Math.max(0, i - 1);
    const after = Math.min(count - 2, i);
    let tx = (segmentX[before] as number) + (segmentX[after] as number);
    let ty = (segmentY[before] as number) + (segmentY[after] as number);
    let norm = Math.hypot(tx, ty);
    if (norm < 1e-9) {
      tx = segmentX[after] as number;
      ty = segmentY[after] as number;
      norm = 1;
    }
    attributes[i * RECORD_FLOATS + TANGENT_X] = tx / norm;
    attributes[i * RECORD_FLOATS + TANGENT_Y] = ty / norm;
  }
}

/**
 * Builds a shape from Web Mercator coordinates. Without `s`, arc length is computed per segment on
 * the WGS84 ellipsoid (plus the elevation difference when `z` is given); with `s` (for example
 * geodesic metres from the shape pipeline) it is used as given and must start at 0 and never
 * decrease, a RangeError otherwise. Arc length 0 is the first vertex in both cases, and stop arc
 * lengths in a MotionPlan use the same origin. Repeated points are dropped.
 */
export function createShape(input: MercatorPolyline): Shape {
  const count = input.x.length;
  assertFiniteArray(input.x, "x", count);
  assertFiniteArray(input.y, "y", count);
  if (input.z) assertFiniteArray(input.z, "z", count);
  if (input.s) {
    assertFiniteArray(input.s, "s", count);
    assertArcLengthOrigin(input.s);
  }
  if (count === 0) throw new RangeError("a shape needs at least two distinct points");
  const { indices, lengths } = keptVertexIndices(input);
  if (indices.length < 2) throw new RangeError("a shape needs at least two distinct points");
  const kept = indices.length;
  const buffer = new ArrayBuffer(kept * SHAPE_RECORD_BYTES);
  const records = new Float64Array(buffer);
  const attributes = new Float32Array(buffer);
  let cumulative = 0;
  for (let k = 0; k < kept; k++) {
    const source = indices[k] as number;
    cumulative += lengths[k] as number;
    records[k * RECORD_DOUBLES] = cumulative;
    records[k * RECORD_DOUBLES + X] = input.x[source] as number;
    records[k * RECORD_DOUBLES + Y] = input.y[source] as number;
    attributes[k * RECORD_FLOATS + Z] = input.z ? (input.z[source] as number) : 0;
  }
  writeVertexTangents(records, attributes, kept);
  return {
    buffer,
    records,
    attributes,
    vertexCount: kept,
    hasElevation: input.z !== undefined,
    length: cumulative,
  };
}

/** Builds a shape from WGS84 [longitude, latitude] pairs in degrees. */
export function shapeFromLonLat(
  coordinates: ArrayLike<readonly [number, number]>,
  elevation?: ArrayLike<number>,
): Shape {
  const x = new Float64Array(coordinates.length);
  const y = new Float64Array(coordinates.length);
  for (let i = 0; i < coordinates.length; i++) {
    const [lon, lat] = coordinates[i] as readonly [number, number];
    const point = lonLatToMercator(lon, lat);
    x[i] = point.x;
    y[i] = point.y;
  }
  return createShape(elevation ? { x, y, z: elevation } : { x, y });
}

function binarySearchSegment(records: Float64Array, count: number, s: number): number {
  let low = 0;
  let high = count - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((records[middle * RECORD_DOUBLES] as number) <= s) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Index i of the segment with s[i] <= s <= s[i + 1], clamped to the end segments. Starts from
 * `hint` and walks, so a caller that keeps the last index gets amortised O(1) for monotone s; long
 * jumps fall back to binary search.
 */
export function segmentAt(shape: Shape, s: number, hint: number): number {
  return segmentIn(shape.records, shape.vertexCount, s, hint);
}

/** segmentAt on the records of a shape with `count` vertices. */
export function segmentIn(records: Float64Array, count: number, s: number, hint: number): number {
  const last = count - 2;
  let i = clamp(hint, 0, last);
  let steps = 0;
  while (i < last && s > (records[(i + 1) * RECORD_DOUBLES] as number)) {
    i++;
    if (++steps > LINEAR_WALK_LIMIT) return binarySearchSegment(records, count, s);
  }
  while (i > 0 && s < (records[i * RECORD_DOUBLES] as number)) {
    i--;
    if (++steps > LINEAR_WALK_LIMIT) return binarySearchSegment(records, count, s);
  }
  return i;
}

/**
 * Position, elevation and smooth heading at arc length s, written into `out`; returns the segment
 * index to pass back as the next hint. Outside [0, length] the end segment is extended in a
 * straight line and `out.beyondEnd` holds the distance beyond the shape in ground metres.
 */
export function sampleShape(shape: Shape, s: number, out: ShapeSample, hint = 0): number {
  return sampleShapeArrays(
    shape.records,
    shape.attributes,
    shape.vertexCount,
    shape.length,
    s,
    out,
    hint,
  );
}

/** sampleShape on the views of a shape, for callers that keep them in their own layout. */
export function sampleShapeArrays(
  records: Float64Array,
  attributes: Float32Array,
  count: number,
  length: number,
  s: number,
  out: ShapeSample,
  hint: number,
): number {
  const i = segmentIn(records, count, s, hint);
  const a = i * RECORD_DOUBLES;
  const b = a + RECORD_DOUBLES;
  const s0 = records[a] as number;
  const f = (s - s0) / ((records[b] as number) - s0);
  const ax = records[a + X] as number;
  const ay = records[a + Y] as number;
  out.x = ax + f * ((records[b + X] as number) - ax);
  out.y = ay + f * ((records[b + Y] as number) - ay);
  const fa = i * RECORD_FLOATS;
  const fb = fa + RECORD_FLOATS;
  const az = attributes[fa + Z] as number;
  out.z = az + f * ((attributes[fb + Z] as number) - az);
  const t = clamp(f, 0, 1);
  const t0x = attributes[fa + TANGENT_X] as number;
  const t0y = attributes[fa + TANGENT_Y] as number;
  const tx = t0x + t * ((attributes[fb + TANGENT_X] as number) - t0x);
  const ty = t0y + t * ((attributes[fb + TANGENT_Y] as number) - t0y);
  const norm = Math.sqrt(tx * tx + ty * ty) || 1;
  out.tangentX = tx / norm;
  out.tangentY = ty / norm;
  out.segment = i;
  out.beyondEnd = s < 0 ? -s : s > length ? s - length : 0;
  return i;
}

/**
 * Nearest point of the shape to (x, y) among arc lengths in [sMin, sMax]. The window keeps a fix
 * on its own track where the shape runs close to itself (parallel lines, loops, hairpins).
 * Distance is in ground metres; the search is linear in the number of segments in the window.
 */
export function projectOntoShape(
  shape: Shape,
  x: number,
  y: number,
  sMin: number,
  sMax: number,
): ProjectionResult {
  const lower = clamp(Math.min(sMin, sMax), 0, shape.length);
  const upper = clamp(Math.max(sMin, sMax), 0, shape.length);
  const first = segmentAt(shape, lower, 0);
  const lastSegment = segmentAt(shape, upper, first);
  const r = shape.records;
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestS = lower;
  let bestX = vertexX(shape, first);
  let bestY = vertexY(shape, first);
  for (let i = first; i <= lastSegment; i++) {
    const a = i * RECORD_DOUBLES;
    const b = a + RECORD_DOUBLES;
    const s0 = r[a] as number;
    const s1 = r[b] as number;
    const fMin = Math.max(0, (lower - s0) / (s1 - s0));
    const fMax = Math.min(1, (upper - s0) / (s1 - s0));
    const ax = r[a + X] as number;
    const ay = r[a + Y] as number;
    const dx = (r[b + X] as number) - ax;
    const dy = (r[b + Y] as number) - ay;
    const projected = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
    const f = clamp(projected, fMin, fMax);
    const px = ax + f * dx;
    const py = ay + f * dy;
    const distanceSquared = (px - x) * (px - x) + (py - y) * (py - y);
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestS = s0 + f * (s1 - s0);
      bestX = px;
      bestY = py;
    }
  }
  return { s: bestS, x: bestX, y: bestY, distance: groundDistance(bestX, bestY, x, y) };
}
