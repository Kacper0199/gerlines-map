import type { LegGeometry } from "@gerlines/schema/journeys";

export type LatLon = readonly [number, number];

/** Precision of the polylines this API answers: 1e-5 degrees, about a metre. */
export const GEOMETRY_PRECISION = 5;
/** Largest distance a dropped point may lie from the simplified line, in metres. */
export const GEOMETRY_TOLERANCE_M = 4;

const EARTH_RADIUS_M = 6_371_008.8;
const RADIANS = Math.PI / 180;

/** Google polyline decoding into [lat, lon] pairs; throws on a truncated string. */
export function decodePolyline(encoded: string, precision: number): LatLon[] {
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new RangeError("polyline ends inside a value");
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push([lat / factor, lon / factor]);
  }
  return points;
}

function encodeValue(value: number): string {
  let rest = value < 0 ? ~(value << 1) : value << 1;
  let text = "";
  while (rest >= 0x20) {
    text += String.fromCharCode((0x20 | (rest & 0x1f)) + 63);
    rest >>= 5;
  }
  return text + String.fromCharCode(rest + 63);
}

export function encodePolyline(points: readonly LatLon[], precision: number): string {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLon = 0;
  let text = "";
  for (const [lat, lon] of points) {
    const scaledLat = Math.round(lat * factor);
    const scaledLon = Math.round(lon * factor);
    text += encodeValue(scaledLat - lastLat) + encodeValue(scaledLon - lastLon);
    lastLat = scaledLat;
    lastLon = scaledLon;
  }
  return text;
}

function segmentDistanceM(point: LatLon, start: LatLon, end: LatLon): number {
  const cosLat = Math.cos(start[0] * RADIANS);
  const toXY = ([lat, lon]: LatLon) => [
    (lon - start[1]) * RADIANS * cosLat * EARTH_RADIUS_M,
    (lat - start[0]) * RADIANS * EARTH_RADIUS_M,
  ];
  const [px, py] = toXY(point) as [number, number];
  const [ex, ey] = toXY(end) as [number, number];
  const lengthSquared = ex * ex + ey * ey;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * ex + py * ey) / lengthSquared));
  return Math.hypot(px - t * ex, py - t * ey);
}

/** Douglas–Peucker over local metres: keeps both ends and every point needed within the tolerance. */
export function simplifyPath(points: readonly LatLon[], toleranceM: number): LatLon[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let farthest = -1;
    let farthestM = toleranceM;
    for (let i = first + 1; i < last; i += 1) {
      const distance = segmentDistanceM(
        points[i] as LatLon,
        points[first] as LatLon,
        points[last] as LatLon,
      );
      if (distance > farthestM) {
        farthest = i;
        farthestM = distance;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

export interface MotisPolyline {
  readonly points: string;
  readonly precision: number;
  readonly length: number;
}

/**
 * The route line of a leg as MOTIS drew it on the track, simplified to a few metres and encoded at
 * precision 5; null when MOTIS sent no usable line.
 */
export function legGeometryOf(polyline: MotisPolyline | undefined): LegGeometry | null {
  if (!polyline || polyline.points === "") return null;
  let points: LatLon[];
  try {
    points = decodePolyline(polyline.points, polyline.precision);
  } catch {
    return null;
  }
  if (points.length < 2) return null;
  const simplified = simplifyPath(points, GEOMETRY_TOLERANCE_M);
  return {
    polyline: encodePolyline(simplified, GEOMETRY_PRECISION),
    precision: GEOMETRY_PRECISION,
    points: simplified.length,
  };
}
