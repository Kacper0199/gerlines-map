const METRES_PER_DEGREE_LAT = 110574;
const METRES_PER_DEGREE_LON_AT_EQUATOR = 111320;

export interface ShapeStore {
  lonLat: Float64Array;
  cumulative: Float64Array;
  vertexStart: Uint32Array;
  lengthMetres: Float64Array;
}

export function metresPerDegreeLon(latitudeDegrees: number): number {
  return METRES_PER_DEGREE_LON_AT_EQUATOR * Math.cos((latitudeDegrees * Math.PI) / 180);
}

export function degreesToMetres(
  dLon: number,
  dLat: number,
  latitudeDegrees: number,
): [number, number] {
  return [dLon * metresPerDegreeLon(latitudeDegrees), dLat * METRES_PER_DEGREE_LAT];
}

function reversed(lonLat: Float64Array): Float64Array {
  const count = lonLat.length / 2;
  const out = new Float64Array(lonLat.length);
  for (let i = 0; i < count; i++) {
    out[i * 2] = lonLat[(count - 1 - i) * 2] ?? 0;
    out[i * 2 + 1] = lonLat[(count - 1 - i) * 2 + 1] ?? 0;
  }
  return out;
}

export function buildShapeStore(polylines: readonly Float64Array[]): ShapeStore {
  const shapes: Float64Array[] = [];
  for (const polyline of polylines) {
    shapes.push(polyline, reversed(polyline));
  }
  let totalVertices = 0;
  for (const shape of shapes) totalVertices += shape.length / 2;

  const lonLat = new Float64Array(totalVertices * 2);
  const cumulative = new Float64Array(totalVertices);
  const vertexStart = new Uint32Array(shapes.length + 1);
  const lengthMetres = new Float64Array(shapes.length);

  let cursor = 0;
  shapes.forEach((shape, shapeIndex) => {
    vertexStart[shapeIndex] = cursor;
    const count = shape.length / 2;
    let distance = 0;
    for (let i = 0; i < count; i++) {
      const lon = shape[i * 2] ?? 0;
      const lat = shape[i * 2 + 1] ?? 0;
      if (i > 0) {
        const previousLon = shape[(i - 1) * 2] ?? 0;
        const previousLat = shape[(i - 1) * 2 + 1] ?? 0;
        const [dx, dy] = degreesToMetres(
          lon - previousLon,
          lat - previousLat,
          (lat + previousLat) / 2,
        );
        distance += Math.hypot(dx, dy);
      }
      lonLat[(cursor + i) * 2] = lon;
      lonLat[(cursor + i) * 2 + 1] = lat;
      cumulative[cursor + i] = distance;
    }
    lengthMetres[shapeIndex] = distance;
    cursor += count;
  });
  vertexStart[shapes.length] = cursor;
  return { lonLat, cumulative, vertexStart, lengthMetres };
}

export interface ShapePoint {
  lon: number;
  lat: number;
  headingDegrees: number;
}

export function advanceCursor(store: ShapeStore, shape: number, cursor: number, s: number): number {
  const start = store.vertexStart[shape] ?? 0;
  const last = (store.vertexStart[shape + 1] ?? 0) - start - 2;
  let c = cursor;
  while (c < last && (store.cumulative[start + c + 1] ?? 0) <= s) c++;
  return c;
}

export function retreatCursor(store: ShapeStore, shape: number, cursor: number, s: number): number {
  const start = store.vertexStart[shape] ?? 0;
  let c = cursor;
  while (c > 0 && (store.cumulative[start + c] ?? 0) > s) c--;
  return c;
}

export function fractionAt(store: ShapeStore, shape: number, cursor: number, s: number): number {
  const start = store.vertexStart[shape] ?? 0;
  const a = store.cumulative[start + cursor] ?? 0;
  const b = store.cumulative[start + cursor + 1] ?? a;
  const span = b - a;
  if (span <= 0) return 0;
  const f = (s - a) / span;
  return Math.min(1, Math.max(0, f));
}

export function headingAt(store: ShapeStore, shape: number, cursor: number): number {
  const start = store.vertexStart[shape] ?? 0;
  const i = (start + cursor) * 2;
  const lat = store.lonLat[i + 1] ?? 0;
  const [dx, dy] = degreesToMetres(
    (store.lonLat[i + 2] ?? 0) - (store.lonLat[i] ?? 0),
    (store.lonLat[i + 3] ?? 0) - lat,
    lat,
  );
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}
