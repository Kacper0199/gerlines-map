const METRES_PER_DEGREE = 111_320;
const DEGREES = Math.PI / 180;

/** Ground distance in metres between two longitude and latitude points, flat earth around their mean latitude. */
export function groundMetres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * DEGREES) * METRES_PER_DEGREE;
  const dy = (lat2 - lat1) * METRES_PER_DEGREE;
  return Math.hypot(dx, dy);
}

function pushPoint(
  out: number[],
  path: Float32Array,
  heights: Float32Array | undefined,
  at: number,
  fraction: number,
  lift: number,
): void {
  const next = Math.min(at + 1, path.length / 2 - 1);
  const lon =
    (path[2 * at] as number) + ((path[2 * next] as number) - (path[2 * at] as number)) * fraction;
  const lat =
    (path[2 * at + 1] as number) +
    ((path[2 * next + 1] as number) - (path[2 * at + 1] as number)) * fraction;
  const h0 = heights?.[at] ?? 0;
  const h1 = heights?.[next] ?? 0;
  out.push(lon, lat, h0 + (h1 - h0) * fraction + lift);
}

/**
 * The part of a route between two fractional vertex indices as longitude, latitude and height triples:
 * the vertices strictly between them plus the two end points on their segments. Vertices closer than
 * `minSpacingM` to the last kept point are dropped, which keeps long legs cheap when the map is zoomed out.
 */
export function legPath(
  path: Float32Array,
  heights: Float32Array | undefined,
  fromVertex: number,
  toVertex: number,
  lift: number,
  minSpacingM = 0,
): Float32Array {
  const last = path.length / 2 - 1;
  if (!(toVertex > fromVertex) || last < 1) return new Float32Array(0);
  const start = Math.max(0, Math.min(last, fromVertex));
  const end = Math.max(0, Math.min(last, toVertex));
  const out: number[] = [];
  const startIndex = Math.floor(start);
  pushPoint(out, path, heights, startIndex, start - startIndex, lift);
  const endIndex = Math.floor(end);
  for (let i = startIndex + 1; i <= endIndex; i++) {
    if (i === end) continue;
    pushPoint(out, path, heights, i, 0, lift);
    if (minSpacingM > 0) {
      const n = out.length;
      const lon = out[n - 3] as number;
      const lat = out[n - 2] as number;
      const prevLon = out[n - 6] as number;
      const prevLat = out[n - 5] as number;
      if (groundMetres(prevLon, prevLat, lon, lat) < minSpacingM) out.length = n - 3;
    }
  }
  pushPoint(out, path, heights, endIndex, end - endIndex, lift);
  return Float32Array.from(out);
}

/** The path cut into dashes of `dashM` with `gapM` between, measured on the ground along it. */
export function dashPieces(xyz: Float32Array, dashM: number, gapM: number): Float32Array[] {
  const count = xyz.length / 3;
  if (count < 2) return [];
  const pieces: Float32Array[] = [];
  let current: number[] = [];
  let drawing = true;
  let left = dashM;
  const at = (i: number) =>
    [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]] as [number, number, number];
  let [px, py, pz] = at(0);
  current.push(px, py, pz);
  for (let i = 1; i < count; i++) {
    const [x, y, z] = at(i);
    let remaining = groundMetres(px, py, x, y);
    while (remaining > left) {
      const t = left / remaining;
      const cx = px + (x - px) * t;
      const cy = py + (y - py) * t;
      const cz = pz + (z - pz) * t;
      if (drawing) {
        current.push(cx, cy, cz);
        pieces.push(Float32Array.from(current));
        current = [];
        left = gapM;
      } else {
        current = [cx, cy, cz];
        left = dashM;
      }
      drawing = !drawing;
      px = cx;
      py = cy;
      pz = cz;
      remaining = groundMetres(px, py, x, y);
    }
    left -= remaining;
    if (drawing) current.push(x, y, z);
    px = x;
    py = y;
    pz = z;
  }
  if (drawing && current.length >= 6) pieces.push(Float32Array.from(current));
  return pieces;
}

/**
 * The half width the strip may have at path point `i`: on a bend tighter than the strip is wide, the inner edge
 * would run backwards past its neighbours and fold the polygon over itself, which an extruded polygon cannot draw.
 * On an arc the limit is half its radius, so the inner edge stays clear of the centre of the curve.
 */
function allowedHalfWidth(xyz: Float32Array, i: number, count: number, halfWidthM: number): number {
  if (i === 0 || i === count - 1) return halfWidthM;
  const scale = Math.cos((xyz[3 * i + 1] as number) * DEGREES);
  const inX = ((xyz[3 * i] as number) - (xyz[3 * (i - 1)] as number)) * scale * METRES_PER_DEGREE;
  const inY = ((xyz[3 * i + 1] as number) - (xyz[3 * (i - 1) + 1] as number)) * METRES_PER_DEGREE;
  const outX = ((xyz[3 * (i + 1)] as number) - (xyz[3 * i] as number)) * scale * METRES_PER_DEGREE;
  const outY = ((xyz[3 * (i + 1) + 1] as number) - (xyz[3 * i + 1] as number)) * METRES_PER_DEGREE;
  const inLength = Math.hypot(inX, inY);
  const outLength = Math.hypot(outX, outY);
  if (inLength === 0 || outLength === 0) return halfWidthM;
  const turn = Math.abs(Math.atan2(inX * outY - inY * outX, inX * outX + inY * outY));
  if (turn < 1e-3) return halfWidthM;
  return Math.min(halfWidthM, (0.25 * Math.min(inLength, outLength)) / Math.tan(turn / 2));
}

/** The allowed half width at each point, none growing faster than the path runs, so the strip narrows gradually before a bend. */
function taperedHalfWidths(xyz: Float32Array, count: number, halfWidthM: number): number[] {
  const widths = Array.from({ length: count }, (_, i) =>
    allowedHalfWidth(xyz, i, count, halfWidthM),
  );
  const gap = (i: number) =>
    groundMetres(
      xyz[3 * i] as number,
      xyz[3 * i + 1] as number,
      xyz[3 * (i + 1)] as number,
      xyz[3 * (i + 1) + 1] as number,
    );
  for (let i = 1; i < count; i++) {
    widths[i] = Math.min(widths[i] as number, (widths[i - 1] as number) + gap(i - 1));
  }
  for (let i = count - 2; i >= 0; i--) {
    widths[i] = Math.min(widths[i] as number, (widths[i + 1] as number) + gap(i));
  }
  return widths;
}

/**
 * A strip of half width `halfWidthM` around the path as a ring of [lon, lat, height]: the left edge forward,
 * the right edge back, every point at the height of its path point. Used to extrude the curtain. The strip
 * narrows on bends tighter than its width, so the edges of a curve do not cross; a path that doubles back on itself
 * within the strip's width (a hairpin) can still overlap itself.
 */
export function ribbonRing(xyz: Float32Array, halfWidthM: number): number[][] {
  const count = xyz.length / 3;
  if (count < 2) return [];
  const left: number[][] = [];
  const right: number[][] = [];
  const widths = taperedHalfWidths(xyz, count, halfWidthM);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    const lat = xyz[3 * i + 1] as number;
    const scale = Math.cos(lat * DEGREES);
    const dx = ((xyz[3 * b] as number) - (xyz[3 * a] as number)) * scale;
    const dy = (xyz[3 * b + 1] as number) - (xyz[3 * a + 1] as number);
    const length = Math.hypot(dx, dy) || 1;
    const width = widths[i] as number;
    const offsetLon = ((-dy / length) * width) / METRES_PER_DEGREE / scale;
    const offsetLat = ((dx / length) * width) / METRES_PER_DEGREE;
    const lon = xyz[3 * i] as number;
    const z = xyz[3 * i + 2] as number;
    left.push([lon + offsetLon, lat + offsetLat, z]);
    right.push([lon - offsetLon, lat - offsetLat, z]);
  }
  return [...left, ...right.reverse()];
}
