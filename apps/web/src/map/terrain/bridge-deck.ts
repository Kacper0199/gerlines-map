import type { DeckWindows } from "./deck-windows.ts";

/** Drawn metres the straight line between two shape vertices must run above the ground to count as a bridge. */
export const CHORD_CLEARANCE_M = 12;
const SAMPLES = [0.25, 0.5, 0.75] as const;
const MEMORY = 120_000;
const SHAPE_KEY_SPAN = 2 ** 22;
const LIFT_STEP_M = 0.5;
/**
 * Track metres over which the lift of the line grows by one metre from a joint with the rail: the
 * line leaves the rail at a 5 % grade instead of stepping up by the whole lift over one segment.
 */
export const LIFT_RAMP_M_PER_M = 20;
const METRES_PER_DEGREE = 111_320;

/**
 * The ground height at a position as drawn, from the DEM of the tile drawn there. Null or undefined
 * while that tile's own DEM has not loaded: a parent tile's DEM can be a few hundred metres off, so
 * nothing is measured against it.
 */
export type Ground = (lon: number, lat: number) => number | null | undefined;

/** The part of the world on screen, in degrees. Segments outside it are not measured. */
export interface ViewBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

interface Pass {
  readonly deck: DeckWindows;
  readonly view: ViewBounds | undefined;
  readonly found: DeckRun[];
  run: number;
  segment: number;
  start: number;
  at: number;
  lookups: number;
}

export interface DeckPath {
  readonly path: Float32Array;
}

interface DeckRun {
  /** Longitude, latitude and drawn height triples without the marker lift. */
  readonly path: Float32Array;
  /** The first (last) vertex is the neighbouring one brought down to the ground, so it takes no lift. */
  readonly groundStart: boolean;
  readonly groundEnd: boolean;
}

/**
 * Finds where trains would float: the shapes hold one height per vertex and a train follows the
 * straight line between two, so where that line runs high above the relief (a viaduct, a bridge
 * over a gorge) the style's rail, draped on the ground, is far below it. Each segment is measured
 * against the terrain once and remembered in two generations (the one in use and the one before),
 * so what the latest views needed stays and the oldest goes. Each stretch gets one more vertex at
 * each end, on the ground, so the line joins the rail instead of ending in the air.
 */
export class BridgeDeck {
  /** Segments that could not be measured in the last pass because their tile's own DEM had not loaded. */
  unmeasured = 0;
  private young = new Map<number, boolean>();
  private old = new Map<number, boolean>();
  private capacity: number;
  private readonly base: number;
  private readonly shapeIndex = new Map<string, number>();
  private runs: readonly DeckRun[] = [];
  private version = 0;
  private pass: Pass | undefined;
  private cached: { version: number; step: number; data: readonly DeckPath[] } | undefined;

  constructor(memory = MEMORY) {
    this.base = memory;
    this.capacity = memory;
  }

  /** Measures all segments of the windows at once. */
  measure(deck: DeckWindows, ground: Ground, view?: ViewBounds): void {
    this.begin(deck, view);
    this.step(ground, Number.POSITIVE_INFINITY);
  }

  /**
   * Starts measuring the windows, dropping a pass in progress. What the last finished pass found
   * stays in `data` until this one is done; what was measured is remembered across passes.
   */
  begin(deck: DeckWindows, view?: ViewBounds): void {
    this.unmeasured = 0;
    this.capacity = Math.max(this.base, 2 * segmentsOf(deck));
    this.pass = { deck, view, found: [], run: 0, segment: 0, start: -1, at: 0, lookups: 0 };
  }

  /** Changes whenever the published stretches do, so a caller knows when to draw them again. */
  get published(): number {
    return this.version;
  }

  /** Whether a pass is waiting for `step` calls. */
  get pending(): boolean {
    return this.pass !== undefined;
  }

  /**
   * Continues the pass for about `budget` terrain lookups and returns whether it is done. A
   * segment is not started once the budget is spent, so a call can go over it by one segment.
   */
  step(ground: Ground, budget: number): boolean {
    const pass = this.pass;
    if (!pass) return true;
    const counted: Ground = (lon, lat) => {
      pass.lookups++;
      return ground(lon, lat);
    };
    const limit = pass.lookups + budget;
    while (pass.run < pass.deck.counts.length) {
      if (!this.stepRun(pass, counted, limit)) return false;
      pass.at += 3 * (pass.deck.counts[pass.run] as number);
      pass.run++;
      pass.segment = 0;
      pass.start = -1;
    }
    this.pass = undefined;
    if (!sameRuns(this.runs, pass.found)) {
      this.runs = pass.found;
      this.version++;
    }
    return true;
  }

  /** Measures the segments of the current window; false when the budget ran out first. */
  private stepRun(pass: Pass, ground: Ground, limit: number): boolean {
    const { deck, view } = pass;
    const count = deck.counts[pass.run] as number;
    const shape = this.indexOf(deck.shapeIds[pass.run] as string);
    const first = deck.first[pass.run] as number;
    for (; pass.segment + 1 < count; pass.segment++) {
      if (pass.lookups >= limit) return false;
      const j = pass.segment;
      const high = this.segmentIsHigh(shape, first + j, deck.paths, pass.at + 3 * j, ground, view);
      if (high && pass.start < 0) pass.start = j;
      if (!high && pass.start >= 0) {
        pass.found.push(this.runOf(deck.paths, pass.at, count, pass.start, j, ground, view));
        pass.start = -1;
      }
    }
    if (pass.start >= 0) {
      pass.found.push(this.runOf(deck.paths, pass.at, count, pass.start, count - 1, ground, view));
    }
    return true;
  }

  /**
   * The stretches lifted by `liftM` as layer data. The same array comes back while the stretches
   * and the lift (to half a metre) are the same, so the layers built on it do not rebuild.
   */
  data(liftM: number): readonly DeckPath[] {
    const step = Math.round(liftM / LIFT_STEP_M);
    if (this.cached?.version === this.version && this.cached.step === step) {
      return this.cached.data;
    }
    const data = this.runs.map((run) => ({ path: lifted(run, step * LIFT_STEP_M) }));
    this.cached = { version: this.version, step, data };
    return data;
  }

  clear(): void {
    this.unmeasured = 0;
    this.pass = undefined;
    if (this.runs.length === 0) return;
    this.runs = [];
    this.version++;
  }

  private indexOf(id: string): number {
    let index = this.shapeIndex.get(id);
    if (index === undefined) {
      index = this.shapeIndex.size;
      this.shapeIndex.set(id, index);
    }
    return index;
  }

  private segmentIsHigh(
    shape: number,
    vertex: number,
    paths: Float32Array,
    a: number,
    ground: Ground,
    view: ViewBounds | undefined,
  ): boolean {
    if (view && !segmentInView(paths, a, view)) return false;
    const key = shape * SHAPE_KEY_SPAN + vertex;
    const known = this.recall(key);
    if (known !== undefined) return known;
    let clearance = Number.NEGATIVE_INFINITY;
    for (const t of SAMPLES) {
      const lon = lerp(paths[a] as number, paths[a + 3] as number, t);
      const lat = lerp(paths[a + 1] as number, paths[a + 4] as number, t);
      const here = ground(lon, lat);
      if (here === null || here === undefined) {
        this.unmeasured++;
        return false;
      }
      const height = lerp(paths[a + 2] as number, paths[a + 5] as number, t);
      clearance = Math.max(clearance, height - here);
    }
    const high = clearance > CHORD_CLEARANCE_M;
    this.remember(key, high);
    return high;
  }

  /** Vertices `from` to `to` of a window, with the neighbour on each side brought down to the ground. */
  private runOf(
    paths: Float32Array,
    at: number,
    count: number,
    from: number,
    to: number,
    ground: Ground,
    view: ViewBounds | undefined,
  ): DeckRun {
    const groundStart = from > 0;
    const groundEnd = to < count - 1;
    const first = groundStart ? from - 1 : from;
    const last = groundEnd ? to + 1 : to;
    const path = Float32Array.from(paths.subarray(at + 3 * first, at + 3 * (last + 1)));
    if (groundStart) this.onGround(path, 0, ground, view);
    if (groundEnd) this.onGround(path, path.length - 3, ground, view);
    return { path, groundStart, groundEnd };
  }

  /** Brings a vertex down to the ground; one without ground in the view stays in the air and is counted. */
  private onGround(
    path: Float32Array,
    at: number,
    ground: Ground,
    view: ViewBounds | undefined,
  ): void {
    const lon = path[at] as number;
    const lat = path[at + 1] as number;
    const here = ground(lon, lat);
    if (here !== null && here !== undefined) path[at + 2] = here;
    else if (!view || pointInView(lon, lat, view)) this.unmeasured++;
  }

  private recall(key: number): boolean | undefined {
    const fresh = this.young.get(key);
    if (fresh !== undefined) return fresh;
    const earlier = this.old.get(key);
    if (earlier !== undefined) this.remember(key, earlier);
    return earlier;
  }

  private remember(key: number, high: boolean): void {
    this.young.set(key, high);
    if (this.young.size >= this.capacity) {
      this.old = this.young;
      this.young = new Map();
    }
  }
}

function segmentsOf(deck: DeckWindows): number {
  let total = 0;
  for (let r = 0; r < deck.counts.length; r++) total += Math.max(0, (deck.counts[r] as number) - 1);
  return total;
}

function pointInView(lon: number, lat: number, view: ViewBounds): boolean {
  return lon >= view.west && lon <= view.east && lat >= view.south && lat <= view.north;
}

function segmentInView(paths: Float32Array, a: number, view: ViewBounds): boolean {
  const x0 = paths[a] as number;
  const y0 = paths[a + 1] as number;
  const x1 = paths[a + 3] as number;
  const y1 = paths[a + 4] as number;
  return (
    Math.max(x0, x1) >= view.west &&
    Math.min(x0, x1) <= view.east &&
    Math.max(y0, y1) >= view.south &&
    Math.min(y0, y1) <= view.north
  );
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function lifted(run: DeckRun, liftM: number): Float32Array {
  const path = Float32Array.from(run.path);
  const from = run.groundStart ? 3 : 0;
  const to = run.groundEnd ? path.length - 3 : path.length;
  const fromStart = run.groundStart ? distancesFrom(path, 0, 1) : undefined;
  const fromEnd = run.groundEnd ? distancesFrom(path, path.length / 3 - 1, -1) : undefined;
  for (let k = from; k < to; k += 3) {
    const vertex = k / 3;
    const along = Math.min(
      fromStart?.[vertex] ?? Number.POSITIVE_INFINITY,
      fromEnd?.[vertex] ?? Number.POSITIVE_INFINITY,
    );
    path[k + 2] = (path[k + 2] as number) + Math.min(liftM, along / LIFT_RAMP_M_PER_M);
  }
  return path;
}

/** Track metres from vertex `origin` to every vertex of the path, walking in direction `step` (1 or -1). */
function distancesFrom(path: Float32Array, origin: number, step: 1 | -1): number[] {
  const count = path.length / 3;
  const distances = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
  distances[origin] = 0;
  for (let v = origin + step; v >= 0 && v < count; v += step) {
    const a = 3 * (v - step);
    const b = 3 * v;
    const dx =
      ((path[b] as number) - (path[a] as number)) *
      METRES_PER_DEGREE *
      Math.cos((((path[a + 1] as number) + (path[b + 1] as number)) / 2) * (Math.PI / 180));
    const dy = ((path[b + 1] as number) - (path[a + 1] as number)) * METRES_PER_DEGREE;
    distances[v] = (distances[v - step] as number) + Math.hypot(dx, dy);
  }
  return distances;
}

function sameRuns(a: readonly DeckRun[], b: readonly DeckRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as DeckRun;
    const y = b[i] as DeckRun;
    if (x.groundStart !== y.groundStart || x.groundEnd !== y.groundEnd) return false;
    if (x.path.length !== y.path.length) return false;
    for (let k = 0; k < x.path.length; k++) if (x.path[k] !== y.path[k]) return false;
  }
  return true;
}
