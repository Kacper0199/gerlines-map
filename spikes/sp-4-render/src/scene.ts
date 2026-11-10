import {
  advanceCursor,
  fractionAt,
  headingAt,
  metresPerDegreeLon,
  retreatCursor,
  type ShapeStore,
} from "./shapes.ts";

export interface FocusConfig {
  lon: number;
  lat: number;
  trains: number;
  startSeconds: number;
}

export interface SceneConfig {
  focus: FocusConfig | null;
  trainCount: number;
  seed: number;
  dwellSeconds: number;
  carsPerTrain: number;
  carLengthMetres: number;
  carGapMetres: number;
  bogieInsetMetres: number;
  baseHeightMetres: number;
}

export interface Allocator {
  f64(name: string, length: number): Float64Array;
  f32(name: string, length: number): Float32Array;
  u8(name: string, length: number): Uint8Array;
  u32(name: string, length: number): Uint32Array;
}

export interface Emission {
  count: number;
  vertexCount?: number;
  arrays: Record<string, Float64Array | Float32Array | Uint8Array | Uint32Array>;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const ACCELERATION = 0.6;
const CATCH_UP_SECONDS = 4;
const VISUAL_ACCELERATION_LIMIT = 1.2;
const METRES_PER_DEGREE_LAT = 110574;

const CAR_MATRIX_FLOATS = 12;
const CAR_HALF_LENGTH_METRES = 12;
const CAR_HALF_WIDTH_METRES = 1.5;
const CAR_HALF_HEIGHT_METRES = 1.8;
const FOCUS_RADIUS_METRES = 1200;
const FOCUS_SPREAD_METRES = 500;

export const DEFAULT_SCENE_CONFIG: SceneConfig = {
  focus: null,
  trainCount: 15000,
  seed: 4,
  dwellSeconds: 60,
  carsPerTrain: 10,
  carLengthMetres: 24,
  carGapMetres: 1,
  bogieInsetMetres: 3.5,
  baseHeightMetres: 0,
};

function writeCarMatrix(target: Float32Array, offset: number, yawRadians: number): void {
  const cosine = Math.cos(yawRadians);
  const sine = Math.sin(yawRadians);
  target[offset] = CAR_HALF_LENGTH_METRES * cosine;
  target[offset + 1] = CAR_HALF_LENGTH_METRES * sine;
  target[offset + 2] = 0;
  target[offset + 3] = -CAR_HALF_WIDTH_METRES * sine;
  target[offset + 4] = CAR_HALF_WIDTH_METRES * cosine;
  target[offset + 5] = 0;
  target[offset + 6] = 0;
  target[offset + 7] = 0;
  target[offset + 8] = CAR_HALF_HEIGHT_METRES;
  target[offset + 9] = 0;
  target[offset + 10] = 0;
  target[offset + 11] = CAR_HALF_HEIGHT_METRES;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Scene {
  readonly trainCount: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly visible: Uint32Array;
  visibleCount = 0;

  private readonly carPoints = { front: { lon: 0, lat: 0 }, rear: { lon: 0, lat: 0 } };
  private targetS = 0;
  private targetV = 0;
  private readonly store: ShapeStore;
  private readonly segmentDurations: Float64Array;
  private readonly segmentCategories: Uint8Array;
  private readonly config: SceneConfig;
  private readonly segment: Uint32Array;
  private readonly leg: Uint8Array;
  private readonly cursor: Uint32Array;
  private readonly s: Float64Array;
  private readonly v: Float64Array;
  private readonly phase: Float64Array;
  private readonly moveSeconds: Float64Array;
  private readonly length: Float64Array;
  private readonly cruise: Float64Array;
  private readonly accel: Float64Array;
  private readonly category: Uint8Array;
  private readonly rgba: Uint8Array;
  private readonly initialized: Uint8Array;
  private readonly sliceCounts: Uint32Array;

  constructor(
    store: ShapeStore,
    segmentDurations: Float64Array,
    segmentCategories: Uint8Array,
    categoryRgba: Uint8Array,
    config: SceneConfig,
  ) {
    const n = config.trainCount;
    this.store = store;
    this.segmentDurations = segmentDurations;
    this.segmentCategories = segmentCategories;
    this.config = config;
    this.trainCount = n;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.visible = new Uint32Array(n);
    this.segment = new Uint32Array(n);
    this.leg = new Uint8Array(n);
    this.cursor = new Uint32Array(n);
    this.s = new Float64Array(n);
    this.v = new Float64Array(n);
    this.phase = new Float64Array(n);
    this.moveSeconds = new Float64Array(n);
    this.length = new Float64Array(n);
    this.cruise = new Float64Array(n);
    this.accel = new Float64Array(n);
    this.category = new Uint8Array(n);
    this.rgba = new Uint8Array(n * 4);
    this.initialized = new Uint8Array(n);
    this.sliceCounts = new Uint32Array(n);

    const random = mulberry32(config.seed);
    const segmentCount = segmentDurations.length;
    for (let i = 0; i < n; i++) {
      const j = i % segmentCount;
      this.segment[i] = j;
      const moveSeconds = (segmentDurations[j] ?? 60) * (0.9 + 0.2 * random());
      const length = store.lengthMetres[j * 2] ?? 0;
      this.moveSeconds[i] = moveSeconds;
      this.length[i] = length;
      this.phase[i] = random() * 2 * (moveSeconds + config.dwellSeconds);
      this.fitProfile(i, length, moveSeconds);
      const category = segmentCategories[j] ?? 0;
      this.category[i] = category;
      for (let k = 0; k < 4; k++) this.rgba[i * 4 + k] = categoryRgba[category * 4 + k] ?? 255;
    }
    if (config.focus) this.concentrate(config.focus, random);
  }

  private nearestVertexDistance(
    shape: number,
    lon: number,
    lat: number,
  ): { s: number; metres: number } {
    const store = this.store;
    const first = store.vertexStart[shape] ?? 0;
    const last = store.vertexStart[shape + 1] ?? 0;
    let best = { s: 0, metres: Number.POSITIVE_INFINITY };
    for (let v = first; v < last; v++) {
      const dx = ((store.lonLat[v * 2] ?? 0) - lon) * metresPerDegreeLon(lat);
      const dy = ((store.lonLat[v * 2 + 1] ?? 0) - lat) * METRES_PER_DEGREE_LAT;
      const metres = Math.hypot(dx, dy);
      if (metres < best.metres) best = { s: store.cumulative[v] ?? 0, metres };
    }
    return best;
  }

  private secondsAtDistance(i: number, s: number): number {
    const T = this.moveSeconds[i] ?? 1;
    const L = this.length[i] ?? 0;
    const a = this.accel[i] ?? 1;
    const vc = this.cruise[i] ?? 1;
    const ta = vc / a;
    const accelerated = 0.5 * a * ta * ta;
    if (s < accelerated) return Math.sqrt((2 * s) / a);
    if (s <= L - accelerated) return ta + (s - accelerated) / vc;
    return T - Math.sqrt((2 * (L - s)) / a);
  }

  private concentrate(focus: FocusConfig, random: () => number): void {
    const hot: { segment: number; s: number }[] = [];
    const segmentCount = this.store.lengthMetres.length / 2;
    for (let j = 0; j < segmentCount; j++) {
      const nearest = this.nearestVertexDistance(j * 2, focus.lon, focus.lat);
      if (nearest.metres < FOCUS_RADIUS_METRES) hot.push({ segment: j, s: nearest.s });
    }
    if (hot.length === 0) return;
    for (let i = 0; i < Math.min(focus.trains, this.trainCount); i++) {
      const choice = hot[i % hot.length] as { segment: number; s: number };
      const length = this.store.lengthMetres[choice.segment * 2] ?? 0;
      this.segment[i] = choice.segment;
      this.length[i] = length;
      const moveSeconds = this.segmentDurations[choice.segment] ?? 60;
      this.moveSeconds[i] = moveSeconds;
      this.fitProfile(i, length, moveSeconds);
      const category = this.segmentCategories[choice.segment] ?? 0;
      this.category[i] = category;
      const s = Math.min(length, Math.max(0, choice.s + (random() * 2 - 1) * FOCUS_SPREAD_METRES));
      const tau = this.secondsAtDistance(i, s);
      const period = 2 * (moveSeconds + this.config.dwellSeconds);
      this.phase[i] = (((tau - focus.startSeconds) % period) + period) % period;
    }
  }

  private fitProfile(i: number, length: number, seconds: number): void {
    const discriminant = seconds * seconds - (4 * length) / ACCELERATION;
    if (discriminant >= 0) {
      this.accel[i] = ACCELERATION;
      this.cruise[i] = (ACCELERATION * (seconds - Math.sqrt(discriminant))) / 2;
    } else {
      const triangleAcceleration = (4 * length) / (seconds * seconds);
      this.accel[i] = triangleAcceleration;
      this.cruise[i] = (triangleAcceleration * seconds) / 2;
    }
  }

  private target(i: number, localSeconds: number): void {
    const T = this.moveSeconds[i] ?? 1;
    const L = this.length[i] ?? 0;
    if (localSeconds >= T) {
      this.targetS = L;
      this.targetV = 0;
      return;
    }
    const a = this.accel[i] ?? 1;
    const vc = this.cruise[i] ?? 0;
    const ta = vc / a;
    if (localSeconds < ta) {
      this.targetS = 0.5 * a * localSeconds * localSeconds;
      this.targetV = a * localSeconds;
    } else if (localSeconds < T - ta) {
      this.targetS = 0.5 * a * ta * ta + vc * (localSeconds - ta);
      this.targetV = vc;
    } else {
      const remaining = T - localSeconds;
      this.targetS = L - 0.5 * a * remaining * remaining;
      this.targetV = a * remaining;
    }
  }

  private flipLeg(i: number, leg: number): void {
    this.leg[i] = leg;
    this.s[i] = 0;
    this.v[i] = 0;
    this.cursor[i] = 0;
  }

  advance(nowSeconds: number, dtSeconds: number): void {
    const dt = Math.min(dtSeconds, 0.1);
    const dwell = this.config.dwellSeconds;
    for (let i = 0; i < this.trainCount; i++) {
      const legSeconds = (this.moveSeconds[i] ?? 1) + dwell;
      const tau = (nowSeconds + (this.phase[i] ?? 0)) % (2 * legSeconds);
      const leg = tau >= legSeconds ? 1 : 0;
      this.target(i, tau - leg * legSeconds);
      this.syncLeg(i, leg);
      this.follow(i, dt);
      this.place(i);
    }
  }

  private syncLeg(i: number, leg: number): void {
    if (leg !== this.leg[i]) this.flipLeg(i, leg);
    if (this.initialized[i]) return;
    this.initialized[i] = 1;
    this.s[i] = this.targetS;
    this.v[i] = this.targetV;
    this.cursor[i] = 0;
  }

  private follow(i: number, dt: number): void {
    const error = this.targetS - (this.s[i] ?? 0);
    const commanded = Math.min(
      Math.max(this.targetV + error / CATCH_UP_SECONDS, 0),
      1.5 * this.targetV + 8,
    );
    const limit = VISUAL_ACCELERATION_LIMIT * dt;
    const speed =
      (this.v[i] ?? 0) + Math.min(Math.max(commanded - (this.v[i] ?? 0), -limit), limit);
    this.v[i] = speed;
    this.s[i] = Math.min((this.s[i] ?? 0) + speed * dt, this.length[i] ?? 0);
  }

  private place(i: number): void {
    const store = this.store;
    const shape = this.shapeOf(i);
    const s = this.s[i] ?? 0;
    const cursor = advanceCursor(store, shape, this.cursor[i] ?? 0, s);
    this.cursor[i] = cursor;
    const start = ((store.vertexStart[shape] ?? 0) + cursor) * 2;
    const f = fractionAt(store, shape, cursor, s);
    const lon0 = store.lonLat[start] ?? 0;
    const lat0 = store.lonLat[start + 1] ?? 0;
    this.px[i] = lon0 + ((store.lonLat[start + 2] ?? lon0) - lon0) * f;
    this.py[i] = lat0 + ((store.lonLat[start + 3] ?? lat0) - lat0) * f;
  }

  select(bounds: Bounds, marginRatio: number): number {
    const padLon = (bounds.east - bounds.west) * marginRatio;
    const padLat = (bounds.north - bounds.south) * marginRatio;
    const west = bounds.west - padLon;
    const east = bounds.east + padLon;
    const south = bounds.south - padLat;
    const north = bounds.north + padLat;
    let count = 0;
    for (let i = 0; i < this.trainCount; i++) {
      const x = this.px[i] ?? 0;
      const y = this.py[i] ?? 0;
      if (x >= west && x <= east && y >= south && y <= north) this.visible[count++] = i;
    }
    this.visibleCount = count;
    return count;
  }

  private shapeOf(i: number): number {
    return (this.segment[i] ?? 0) * 2 + (this.leg[i] ?? 0);
  }

  private writeColor(target: Uint8Array, offset: number, i: number): void {
    const source = i * 4;
    target[offset] = this.rgba[source] ?? 0;
    target[offset + 1] = this.rgba[source + 1] ?? 0;
    target[offset + 2] = this.rgba[source + 2] ?? 0;
    target[offset + 3] = this.rgba[source + 3] ?? 255;
  }

  emitDots(alloc: Allocator): Emission {
    const count = this.visibleCount;
    const position = alloc.f64("position", count * 3);
    const color = alloc.u8("color", count * 4);
    const z = this.config.baseHeightMetres;
    for (let k = 0; k < count; k++) {
      const i = this.visible[k] ?? 0;
      position[k * 3] = this.px[i] ?? 0;
      position[k * 3 + 1] = this.py[i] ?? 0;
      position[k * 3 + 2] = z;
      this.writeColor(color, k * 4, i);
    }
    return { count, arrays: { position, color } };
  }

  emitIcons(alloc: Allocator): Emission {
    const count = this.visibleCount;
    const position = alloc.f64("position", count * 3);
    const angle = alloc.f32("angle", count);
    const color = alloc.u8("color", count * 4);
    const z = this.config.baseHeightMetres;
    for (let k = 0; k < count; k++) {
      const i = this.visible[k] ?? 0;
      position[k * 3] = this.px[i] ?? 0;
      position[k * 3 + 1] = this.py[i] ?? 0;
      position[k * 3 + 2] = z;
      angle[k] = headingAt(this.store, this.shapeOf(i), this.cursor[i] ?? 0);
      this.writeColor(color, k * 4, i);
    }
    return { count, arrays: { position, angle, color } };
  }

  private sliceVertexCount(i: number, lengthMetres: number): number {
    const cursor = this.cursor[i] ?? 0;
    const rearS = Math.max(0, (this.s[i] ?? 0) - lengthMetres);
    const rearCursor = retreatCursor(this.store, this.shapeOf(i), cursor, rearS);
    return 2 + cursor - rearCursor;
  }

  emitSlices(alloc: Allocator, trainLengthMetres: number): Emission {
    const count = this.visibleCount;
    const startIndices = alloc.u32("startIndices", count + 1);
    let vertices = 0;
    for (let k = 0; k < count; k++) {
      startIndices[k] = vertices;
      const i = this.visible[k] ?? 0;
      const n = this.sliceVertexCount(i, trainLengthMetres);
      this.sliceCounts[i] = n;
      vertices += n;
    }
    startIndices[count] = vertices;
    const position = alloc.f64("position", vertices * 3);
    const color = alloc.u8("color", vertices * 4);
    const z = this.config.baseHeightMetres;
    for (let k = 0; k < count; k++) {
      const i = this.visible[k] ?? 0;
      const first = startIndices[k] ?? 0;
      this.writeSlice(i, trainLengthMetres, position, first, z);
      const n = this.sliceCounts[i] ?? 0;
      for (let m = 0; m < n; m++) this.writeColor(color, (first + m) * 4, i);
    }
    return { count, vertexCount: vertices, arrays: { position, color, startIndices } };
  }

  private writeSlice(
    i: number,
    lengthMetres: number,
    position: Float64Array,
    firstVertex: number,
    z: number,
  ): void {
    const store = this.store;
    const shape = this.shapeOf(i);
    const start = store.vertexStart[shape] ?? 0;
    const cursor = this.cursor[i] ?? 0;
    const n = this.sliceCounts[i] ?? 0;
    let w = firstVertex * 3;
    position[w++] = this.px[i] ?? 0;
    position[w++] = this.py[i] ?? 0;
    position[w++] = z;
    const interior = n - 2;
    for (let m = 0; m < interior; m++) {
      const vertex = (start + cursor - m) * 2;
      position[w++] = store.lonLat[vertex] ?? 0;
      position[w++] = store.lonLat[vertex + 1] ?? 0;
      position[w++] = z;
    }
    const rearS = Math.max(0, (this.s[i] ?? 0) - lengthMetres);
    const rearCursor = retreatCursor(store, shape, cursor, rearS);
    const f = fractionAt(store, shape, rearCursor, rearS);
    const base = (start + rearCursor) * 2;
    const lon0 = store.lonLat[base] ?? 0;
    const lat0 = store.lonLat[base + 1] ?? 0;
    position[w++] = lon0 + ((store.lonLat[base + 2] ?? lon0) - lon0) * f;
    position[w++] = lat0 + ((store.lonLat[base + 3] ?? lat0) - lat0) * f;
    position[w] = z;
  }

  private bogie(shape: number, hint: number, s: number, out: { lon: number; lat: number }): void {
    const store = this.store;
    const clamped = Math.max(0, s);
    const cursor = retreatCursor(store, shape, hint, clamped);
    const base = ((store.vertexStart[shape] ?? 0) + cursor) * 2;
    const f = fractionAt(store, shape, cursor, clamped);
    const lon0 = store.lonLat[base] ?? 0;
    const lat0 = store.lonLat[base + 1] ?? 0;
    out.lon = lon0 + ((store.lonLat[base + 2] ?? lon0) - lon0) * f;
    out.lat = lat0 + ((store.lonLat[base + 3] ?? lat0) - lat0) * f;
  }

  emitCars(alloc: Allocator): Emission {
    const cars = this.config.carsPerTrain;
    const count = this.visibleCount * cars;
    const position = alloc.f64("position", count * 3);
    const matrix = alloc.f32("matrix", count * CAR_MATRIX_FLOATS);
    const color = alloc.u8("color", count * 4);
    const z = this.config.baseHeightMetres;
    const { front, rear } = this.carPoints;
    let w = 0;
    for (let k = 0; k < this.visibleCount; k++) {
      const i = this.visible[k] ?? 0;
      const shape = this.shapeOf(i);
      const s = this.s[i] ?? 0;
      const hint = this.cursor[i] ?? 0;
      for (let c = 0; c < cars; c++) {
        const carFront = s - c * (this.config.carLengthMetres + this.config.carGapMetres);
        this.bogie(shape, hint, carFront - this.config.bogieInsetMetres, front);
        this.bogie(
          shape,
          hint,
          carFront - this.config.carLengthMetres + this.config.bogieInsetMetres,
          rear,
        );
        const midLat = front.lat / 2 + rear.lat / 2;
        const dx = (front.lon - rear.lon) * metresPerDegreeLon(midLat);
        const dy = (front.lat - rear.lat) * METRES_PER_DEGREE_LAT;
        position[w * 3] = (front.lon + rear.lon) / 2;
        position[w * 3 + 1] = midLat;
        position[w * 3 + 2] = z;
        const yaw =
          dx === 0 && dy === 0
            ? (headingAt(this.store, shape, 0) * Math.PI) / 180
            : Math.atan2(dy, dx);
        writeCarMatrix(matrix, w * CAR_MATRIX_FLOATS, yaw);
        this.writeColor(color, w * 4, i);
        w++;
      }
    }
    return { count, arrays: { position, matrix, color } };
  }
}
