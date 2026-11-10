const M_PER_DEGREE = 111_195;
const STRIDE = 3;

function segmentMetres(path: Float32Array, from: number): number {
  const a = STRIDE * from;
  const b = a + STRIDE;
  const midLat = (((path[a + 1] as number) + (path[b + 1] as number)) / 2) * (Math.PI / 180);
  const dx = ((path[b] as number) - (path[a] as number)) * Math.cos(midLat);
  const dy = (path[b + 1] as number) - (path[a + 1] as number);
  return Math.hypot(dx, dy) * M_PER_DEGREE;
}

function tailTotal(tail: Float64Array): number {
  return tail.length > 0 ? (tail[tail.length - 1] as number) : 0;
}

interface Measured {
  readonly path: Float32Array;
  /** Metres from vertex 1 to vertex i + 1 (the first segment moves with the train and is measured live). */
  readonly tail: Float64Array;
}

/**
 * The length of the route ahead measured along its own vertices (arc length on the matched shape, ADR-0001),
 * and the part of it that has been drawn so far. The route ahead is an XYZ path whose first point is the train
 * and moves every frame, so the first segment is measured again on each call and the rest is measured once.
 */
export class RouteReveal {
  private measured: Measured | undefined;
  private scratch = new Float32Array(0);

  totalMetres(path: Float32Array): number {
    const count = path.length / STRIDE;
    if (count < 2) return 0;
    return segmentMetres(path, 0) + tailTotal(this.tailOf(path));
  }

  /** The route from the train to `metres` along it; the whole array once the length reaches the end. */
  prefix(path: Float32Array, metres: number): Float32Array {
    const count = path.length / STRIDE;
    if (count < 2) return path;
    const tail = this.tailOf(path);
    const head = segmentMetres(path, 0);
    if (metres >= head + tailTotal(tail)) return path;
    if (this.scratch.length < path.length) this.scratch = new Float32Array(path.length);
    const out = this.scratch;
    if (metres <= 0) {
      out.set(path.subarray(0, STRIDE));
      out.set(path.subarray(0, STRIDE), STRIDE);
      return out.subarray(0, 2 * STRIDE);
    }
    const metresTo = (vertex: number) => (vertex === 0 ? 0 : head + (tail[vertex - 2] ?? 0));
    let low = 1;
    let high = count - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (metresTo(mid) > metres) high = mid;
      else low = mid + 1;
    }
    const segment = low - 1;
    const start = metresTo(segment);
    const length = metresTo(segment + 1) - start;
    const along = length > 0 ? Math.min(1, Math.max(0, (metres - start) / length)) : 0;
    const keep = STRIDE * (segment + 1);
    out.set(path.subarray(0, keep));
    const a = STRIDE * segment;
    for (let k = 0; k < STRIDE; k += 1) {
      const from = path[a + k] as number;
      const to = path[a + STRIDE + k] as number;
      out[keep + k] = from + (to - from) * along;
    }
    return out.subarray(0, keep + STRIDE);
  }

  private tailOf(path: Float32Array): Float64Array {
    const cached = this.measured;
    if (cached && cached.path === path) return cached.tail;
    const count = path.length / STRIDE;
    const tail = new Float64Array(Math.max(0, count - 2));
    let sum = 0;
    for (let i = 1; i < count - 1; i += 1) {
      sum += segmentMetres(path, i);
      tail[i - 1] = sum;
    }
    const measured = { path, tail };
    this.measured = measured;
    return tail;
  }
}
