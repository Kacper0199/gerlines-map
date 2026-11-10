export interface SplitRoute {
  readonly passed: Float32Array;
  readonly ahead: Float32Array;
}

export function splitRoute(
  path: Float32Array,
  vertex: number,
  lon: number,
  lat: number,
): SplitRoute {
  const vertexCount = path.length / 2;
  const lastSegment = Math.max(0, vertexCount - 2);
  const index = Math.max(0, Math.min(Math.floor(vertex), lastSegment));
  const passedEnd = 2 * (index + 1);
  const passed = new Float32Array(passedEnd + 2);
  passed.set(path.subarray(0, passedEnd));
  passed[passedEnd] = lon;
  passed[passedEnd + 1] = lat;
  const rest = path.subarray(passedEnd);
  const ahead = new Float32Array(rest.length + 2);
  ahead[0] = lon;
  ahead[1] = lat;
  ahead.set(rest, 2);
  return { passed, ahead };
}

/**
 * The same split with a height on every point, as XYZ triples for a 3D path: `heights` holds one

 * height per vertex of `path` (none means sea level), `z` the height of the train and `liftM` what
 * the vertices are raised by.
 */
export function splitRoute3d(
  path: Float32Array,
  heights: Float32Array | undefined,
  vertex: number,
  lon: number,
  lat: number,
  z: number,
  liftM = 0,
): SplitRoute {
  const vertexCount = path.length / 2;
  const index = segmentIndex(path, vertex);
  const passedCount = Math.min(index + 1, vertexCount);
  const passed = new Float32Array(3 * (passedCount + 1));
  writeVertices(passed, 0, path, heights, 0, passedCount, liftM);
  writePoint(passed, passedCount, lon, lat, z);
  const restCount = vertexCount - passedCount;
  const ahead = new Float32Array(3 * (restCount + 1));
  writePoint(ahead, 0, lon, lat, z);
  writeVertices(ahead, 1, path, heights, passedCount, vertexCount, liftM);
  return { passed, ahead };
}

/**
 * The same split as `splitRoute3d` for a train that moves every frame: the buffers are built when
 * the train passes a vertex, the lift changes or the route changes, and between those only the
 * train point at their join is rewritten.
 */
export class RouteSplitter {
  private cache:
    | {
        readonly path: Float32Array;
        readonly heights: Float32Array | undefined;
        readonly index: number;
        readonly liftM: number;
        readonly route: SplitRoute;
      }
    | undefined;

  split(
    path: Float32Array,
    heights: Float32Array | undefined,
    vertex: number,
    lon: number,
    lat: number,
    z: number,
    liftM = 0,
  ): SplitRoute {
    const index = segmentIndex(path, vertex);
    const cached = this.cache;
    if (
      cached &&
      cached.path === path &&
      cached.heights === heights &&
      cached.index === index &&
      cached.liftM === liftM
    ) {
      const { passed, ahead } = cached.route;
      writePoint(passed, passed.length / 3 - 1, lon, lat, z);
      writePoint(ahead, 0, lon, lat, z);
      return cached.route;
    }
    const route = splitRoute3d(path, heights, vertex, lon, lat, z, liftM);
    this.cache = { path, heights, index, liftM, route };
    return route;
  }
}

function segmentIndex(path: Float32Array, vertex: number): number {
  const lastSegment = Math.max(0, path.length / 2 - 2);
  return Math.max(0, Math.min(Math.floor(vertex), lastSegment));
}

function writePoint(target: Float32Array, at: number, lon: number, lat: number, z: number): void {
  target[3 * at] = lon;
  target[3 * at + 1] = lat;
  target[3 * at + 2] = z;
}

function writeVertices(
  target: Float32Array,
  at: number,
  path: Float32Array,
  heights: Float32Array | undefined,
  from: number,
  to: number,
  liftM: number,
): void {
  for (let i = from; i < to; i++) {
    writePoint(
      target,
      at + i - from,
      path[2 * i] as number,
      path[2 * i + 1] as number,
      (heights?.[i] ?? 0) + liftM,
    );
  }
}

/** The west, south, east and north corners around a path of longitude and latitude pairs. */
export function routeBounds(
  path: Float32Array,
): [[west: number, south: number], [east: number, north: number]] | null {
  if (path.length < 2) return null;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 1 < path.length; i += 2) {
    const lon = path[i] as number;
    const lat = path[i + 1] as number;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [
    [west, south],
    [east, north],
  ];
}
