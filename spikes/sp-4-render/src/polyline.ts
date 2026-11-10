const PRECISION = 1e5;

export function decodePolyline(encoded: string): Float64Array {
  const out: number[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (let axis = 0; axis < 2; axis++) {
      let shift = 0;
      let result = 0;
      let byte = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    out.push(lon / PRECISION, lat / PRECISION);
  }
  return Float64Array.from(out);
}

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let chunk = "";
  while (v >= 0x20) {
    chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return chunk + String.fromCharCode(v + 63);
}

export function encodePolyline(lonLat: ArrayLike<number>): string {
  let prevLat = 0;
  let prevLon = 0;
  let out = "";
  for (let i = 0; i < lonLat.length; i += 2) {
    const lon = Math.round((lonLat[i] ?? 0) * PRECISION);
    const lat = Math.round((lonLat[i + 1] ?? 0) * PRECISION);
    out += encodeValue(lat - prevLat) + encodeValue(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

export function polylineLengthMetres(lonLat: ArrayLike<number>): number {
  let total = 0;
  for (let i = 2; i < lonLat.length; i += 2) {
    const lat = lonLat[i + 1] ?? 0;
    const previousLat = lonLat[i - 1] ?? 0;
    const dx =
      ((lonLat[i] ?? 0) - (lonLat[i - 2] ?? 0)) *
      111320 *
      Math.cos((((lat + previousLat) / 2) * Math.PI) / 180);
    const dy = (lat - previousLat) * 110574;
    total += Math.hypot(dx, dy);
  }
  return total;
}

function farthestVertex(
  lonLat: Float64Array,
  first: number,
  last: number,
  scale: { kx: number; ky: number },
  toleranceMetres: number,
): number {
  const ax = (lonLat[first * 2] ?? 0) * scale.kx;
  const ay = (lonLat[first * 2 + 1] ?? 0) * scale.ky;
  const dx = (lonLat[last * 2] ?? 0) * scale.kx - ax;
  const dy = (lonLat[last * 2 + 1] ?? 0) * scale.ky - ay;
  const lengthSquared = dx * dx + dy * dy;
  let farthest = -1;
  let farthestDistance = toleranceMetres;
  for (let i = first + 1; i < last; i++) {
    const px = (lonLat[i * 2] ?? 0) * scale.kx - ax;
    const py = (lonLat[i * 2 + 1] ?? 0) * scale.ky - ay;
    const t =
      lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
    const distance = Math.hypot(px - t * dx, py - t * dy);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = i;
    }
  }
  return farthest;
}

export function simplifyPolyline(lonLat: Float64Array, toleranceMetres: number): Float64Array {
  const count = lonLat.length / 2;
  if (count <= 2) return lonLat;
  const midLat = ((lonLat[1] ?? 0) + (lonLat[lonLat.length - 1] ?? 0)) / 2;
  const scale = { kx: 111320 * Math.cos((midLat * Math.PI) / 180), ky: 110574 };
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: number[] = [0, count - 1];
  while (stack.length > 0) {
    const last = stack.pop() as number;
    const first = stack.pop() as number;
    const farthest = farthestVertex(lonLat, first, last, scale, toleranceMetres);
    if (farthest === -1) continue;
    keep[farthest] = 1;
    stack.push(first, farthest, farthest, last);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (keep[i]) out.push(lonLat[i * 2] ?? 0, lonLat[i * 2 + 1] ?? 0);
  }
  return Float64Array.from(out);
}
