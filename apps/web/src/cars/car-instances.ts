import { createShapeSample, groundDistance, type Shape, sampleShape } from "@gerlines/geo";
import { latOf, lonOf } from "../live/geometry.ts";
import {
  carElevation,
  drawnHeight,
  type Elevation,
  FLAT,
  gradeAngleDeg,
} from "../map/terrain/elevation.ts";
import type { Rgb } from "../motion/frame.ts";
import { type CarModel, LOD_LEVELS } from "./catalog.ts";
import type { Fleet } from "./fleet.ts";

/** Body width of a car, metres: what the car tier is sized by (DB and S-Bahn bodies are 2.8 to 3.1 m). */
export const CAR_WIDTH_M = 2.9;
/** Screen width of a car, pixels, at which the crossfade from the chevron to the cars starts and ends. */
export const CAR_FADE_FROM_PX = 3.5;
export const CAR_FADE_TO_PX = 5.5;
/** The selected train's marker stays until its cars are this wide (R-14), fading between the two. */
export const MARKER_FADE_FROM_PX = 5.5;
export const MARKER_FADE_TO_PX = 7;
/** Seconds a train takes to change between its chevron and its cars. */
export const CAR_BLEND_S = 0.3;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const TILE_PX = 512;

/** Slack around the visible box, ground metres, on top of a train's own length. */
const VISIBLE_PAD_M = 20;

/** Trains drawn as cars after culling (SP-4, D-018), nearest to the view centre first. */
export const CAR_TRAIN_CAP = 300;

const DEGREES = 180 / Math.PI;
/** Model end states for the lamps (D-053): 0 no lamp state, 1 head (white lit), 2 tail (red lit). */
export const LAMP_NONE = 0;
export const LAMP_HEAD = 1;
export const LAMP_TAIL = 2;

export interface CarView {
  readonly zoom: number;
  /** View centre in Web Mercator metres. */
  readonly centerX: number;
  readonly centerY: number;
  /** Ground metres from the centre within which a train is drawn as cars. */
  readonly radiusM: number;
  /** Ground metres from the centre beyond which a car takes one coarser level of detail. */
  readonly fineRadiusM: number;
  /** Web Mercator box of the ground the screen shows; a train wholly outside it is not placed. */
  readonly visible?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Meshes the page has loaded, as `mesh@lod`; a train gives up its chevron only when all of its are. */
  readonly ready?: ReadonlySet<string>;
  /** How the baked shape heights are lifted onto the 3D terrain; flat (cars at sea level) when absent. */
  readonly elevation?: Elevation;
}

export interface CarTrain {
  readonly key: number;
  readonly model: CarModel;
  /** Palette row of the train's livery, the model's own when absent. */
  readonly liveryRow?: number;
  readonly shape: Shape;
  /** Arc length of the train's front on its shape, metres. */
  readonly headS: number;
  /** Map position of the front, Web Mercator metres. */
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
  readonly color: Rgb;
  /** The selected train: its mode band is drawn unlit so it reads as the route's amber. */
  readonly selected?: boolean;
}

/** Instances of one mesh at one level of detail, as typed arrays for an instanced mesh layer. */
export interface MeshInstances {
  readonly mesh: string;
  readonly lod: number;
  readonly count: number;
  /** Longitude, latitude (degrees, Float64 so a car keeps its centimetres) and height (m). */
  readonly positions: Float64Array;
  /**
   * deck.gl's instance model matrix (12 floats: the 3 x 3 rotation by columns, then a zero
   * translation) from yaw (counterclockwise from east) and pitch (positive nose down), as its
   * SimpleMeshLayer computes from getOrientation; binary data cannot feed that transform.
   */
  readonly matrices: Float32Array;
  /** Colour mode band (D-039) and the instance's opacity. */
  readonly colors: Uint8Array;
  readonly liveryRows: Float32Array;
  /** Lamp state of the model's +x end and of its -x end. */
  readonly lamps: Float32Array;
  /** 1 for the instances of the selected train, else 0. */
  readonly selected: Float32Array;
  readonly trainKeys: Int32Array;
}

export interface CarFrame {
  /** The instances by mesh; empty in a frame the worker has sent, which carries `fleet` instead. */
  readonly meshes: readonly MeshInstances[];
  /** All meshes merged into one set of arrays, made in the worker. */
  readonly fleet?: Fleet;
  /** Keys of the trains placed as cars (their whole consist lies on the shape). */
  readonly trainKeys: Int32Array;
  /** Keys of the placed trains whose meshes are all loaded, so their chevrons may fade out. */
  readonly drawnKeys: Int32Array;
  /** Chevron to cars blend of each drawn train (0 to 1), aligned with `drawnKeys`. */
  readonly blends: Float32Array;
  /** `mesh@lod` ids of meshes the frame wants and the page has not loaded, so the page fetches them. */
  readonly wanted: readonly string[];
  readonly fade: number;
}

/** On-screen width of a car in pixels, top-down, at a zoom and latitude (degrees). */
export function carWidthPx(zoom: number, latDeg: number): number {
  const metresPerPixel =
    (EARTH_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (TILE_PX * 2 ** zoom);
  return CAR_WIDTH_M / metresPerPixel;
}

function fadeByWidth(zoom: number, latDeg: number, fromPx: number, toPx: number): number {
  return Math.max(0, Math.min(1, (carWidthPx(zoom, latDeg) - fromPx) / (toPx - fromPx)));
}

/**
 * Opacity of the car tier: 0 while a car is narrower than a chevron's worth of pixels, 1 once it is
 * wide enough to read its roof band. A continuous function of the view, so it cannot flicker.
 */
export function carFade(zoom: number, latDeg: number): number {
  return fadeByWidth(zoom, latDeg, CAR_FADE_FROM_PX, CAR_FADE_TO_PX);
}

/** How far the selected train's chevron marker gives way to its cars (0 while they are narrow). */
export function markerFade(zoom: number, latDeg: number): number {
  return fadeByWidth(zoom, latDeg, MARKER_FADE_FROM_PX, MARKER_FADE_TO_PX);
}

/**
 * Per-train blend between chevron (0) and cars (1), stepped by the frame clock: the caller runs
 * `begin(now)` before `writeCars`, which steps every train it places and then calls `end`.
 */
export class CarBlend {
  private values = new Map<number, number>();
  private touched = new Set<number>();
  private lastS = Number.NaN;
  private stepS = 0;

  begin(nowS: number): void {
    this.stepS = Number.isNaN(this.lastS) ? 1 : Math.max(0, Math.min(nowS - this.lastS, 1));
    this.lastS = nowS;
    this.touched = new Set();
  }

  /** Moves a train's blend towards `target` (0 or 1) and returns it. */
  step(key: number, target: 0 | 1): number {
    const previous = this.values.get(key) ?? 0;
    const delta = this.stepS / CAR_BLEND_S;
    const next = target === 1 ? Math.min(1, previous + delta) : Math.max(0, previous - delta);
    this.values.set(key, next);
    this.touched.add(key);
    return next;
  }

  clear(): void {
    this.values.clear();
    this.lastS = Number.NaN;
  }

  /** Forgets trains that were not stepped since `begin`. */
  end(): void {
    for (const key of this.values.keys()) if (!this.touched.has(key)) this.values.delete(key);
  }
}

/** Level of detail by zoom (LOD2 14.5 to 15.5, LOD1 15.5 to 17, LOD0 from 17), coarser far out. */
export function lodFor(zoom: number, distanceM: number, fineRadiusM: number): number {
  const base = zoom >= 17 ? 0 : zoom >= 15.5 ? 1 : 2;
  return Math.min(2, base + (distanceM > fineRadiusM ? 1 : 0));
}

/** Whether a train's consist, trailing its head by at most its length, can reach the visible box. */
function reachesBox(train: CarTrain, box: NonNullable<CarView["visible"]>, mercatorPerM: number) {
  const reach = (train.model.consist.length + VISIBLE_PAD_M) * mercatorPerM;
  return (
    train.x >= box.minX - reach &&
    train.x <= box.maxX + reach &&
    train.y >= box.minY - reach &&
    train.y <= box.maxY + reach
  );
}

/** The trains within the view radius and the visible box, nearest first, at most `cap`. */
export function chooseCarTrains(
  trains: readonly CarTrain[],
  view: CarView,
  cap = CAR_TRAIN_CAP,
): { train: CarTrain; distance: number }[] {
  const chosen: { train: CarTrain; distance: number }[] = [];
  const mercatorPerM = 1 / Math.cos((latOf(view.centerY) * Math.PI) / 180);
  for (const train of trains) {
    if (view.visible && !reachesBox(train, view.visible, mercatorPerM)) continue;
    const distance = groundDistance(view.centerX, view.centerY, train.x, train.y);
    if (distance <= view.radiusM + train.model.consist.length) chosen.push({ train, distance });
  }
  chosen.sort((a, b) => a.distance - b.distance || a.train.key - b.train.key);
  return chosen.slice(0, cap);
}

/** Lamp states of the +x and -x ends of car `index` (the train runs towards +s, car 0 leads). */
export function lampStates(model: CarModel, index: number): [number, number] {
  const last = model.cars.length - 1;
  const reversed = model.cars[index]?.reversed ?? false;
  let front = LAMP_NONE;
  let rear = LAMP_NONE;
  if (index === 0) front = LAMP_HEAD;
  if (index === last) rear = LAMP_TAIL;
  return reversed ? [rear, front] : [front, rear];
}

export class MeshBuilder {
  readonly positions: number[] = [];
  readonly matrices: number[] = [];
  readonly colors: number[] = [];
  readonly liveryRows: number[] = [];
  readonly lamps: number[] = [];
  readonly selected: number[] = [];
  readonly trainKeys: number[] = [];

  readonly mesh: string;
  readonly lod: number;

  constructor(mesh: string, lod: number) {
    this.mesh = mesh;
    this.lod = lod;
  }

  push(
    x: number,
    y: number,
    z: number,
    pitch: number,
    yaw: number,
    train: CarTrain,
    lamps: readonly [number, number],
  ): void {
    this.positions.push(lonOf(x), latOf(y), z);
    const p = pitch / DEGREES;
    const w = yaw / DEGREES;
    const cp = Math.cos(p);
    const sp = Math.sin(p);
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    this.matrices.push(cw * cp, sw * cp, -sp, -sw, cw, 0, cw * sp, sw * sp, cp, 0, 0, 0);
    this.colors.push(train.color[0], train.color[1], train.color[2], Math.round(255 * train.alpha));
    this.liveryRows.push(train.liveryRow ?? train.model.liveryRow);
    this.lamps.push(lamps[0], lamps[1]);
    this.selected.push(train.selected ? 1 : 0);
    this.trainKeys.push(train.key);
  }

  finish(): MeshInstances {
    return {
      mesh: this.mesh,
      lod: this.lod,
      count: this.trainKeys.length,
      positions: Float64Array.from(this.positions),
      matrices: Float32Array.from(this.matrices),
      colors: Uint8Array.from(this.colors),
      liveryRows: Float32Array.from(this.liveryRows),
      lamps: Float32Array.from(this.lamps),
      selected: Float32Array.from(this.selected),
      trainKeys: Int32Array.from(this.trainKeys),
    };
  }
}

const sample = createShapeSample();
let pivots = new Float64Array(64 * 3);
let pivotYaws = new Float64Array(64);
const NO_LAMPS: readonly [number, number] = [LAMP_NONE, LAMP_NONE];
/** Overhang past an end of the shape, ground metres, that still counts as on the shape. */
const END_TOLERANCE_M = 1e-6;

/** Samples every bogie pivot of a train into the scratch arrays; true when all are on the shape. */
function samplePivots(train: CarTrain): boolean {
  const { model, shape, headS } = train;
  const offsets = model.consist.bogieOffsets;
  const count = offsets.length;
  if (pivots.length < 3 * count) {
    pivots = new Float64Array(3 * count);
    pivotYaws = new Float64Array(count);
  }
  let hint = 0;
  let allOn = true;
  for (let b = 0; b < count; b++) {
    hint = sampleShape(shape, headS - (offsets[b] as number), sample, hint);
    pivots[3 * b] = sample.x;
    pivots[3 * b + 1] = sample.y;
    pivots[3 * b + 2] = sample.z;
    pivotYaws[b] = Math.atan2(sample.tangentY, sample.tangentX) * DEGREES;
    if (sample.beyondEnd > END_TOLERANCE_M) allOn = false;
  }
  return allOn;
}

function placeCarBody(
  train: CarTrain,
  c: number,
  builder: (mesh: string) => MeshBuilder,
  elevation: Elevation,
): void {
  const { model } = train;
  const consist = model.consist;
  const front = 3 * (consist.carFront[c] as number);
  const rear = 3 * (consist.carRear[c] as number);
  const f = consist.carCentreFraction[c] as number;
  const fx = pivots[front] as number;
  const fy = pivots[front + 1] as number;
  const dx = (pivots[rear] as number) - fx;
  const dy = (pivots[rear + 1] as number) - fy;
  const dz = (pivots[rear + 2] as number) - (pivots[front + 2] as number);
  const span =
    (consist.bogieOffsets[consist.carRear[c] as number] as number) -
    (consist.bogieOffsets[consist.carFront[c] as number] as number);
  const grade = gradeAngleDeg(dz, span, elevation);
  const reversed = model.cars[c]?.reversed ?? false;
  const heading = Math.atan2(-dy, -dx) * DEGREES;
  builder(model.carMeshes[c] as string).push(
    fx + f * dx,
    fy + f * dy,
    drawnHeight((pivots[front + 2] as number) + f * dz, elevation),
    reversed ? grade : -grade,
    reversed ? heading + 180 : heading,
    train,
    lampStates(model, c),
  );
}

/**
 * Whether the whole consist of a train lies on its shape. A train with a bogie beyond either end has
 * no track under part of it and is drawn as its chevron instead (D-055; ADR-0001 forbids extending
 * the end segment in a straight line). Leaves the pivots of the train in the scratch arrays.
 */
export function onShape(train: CarTrain): boolean {
  return samplePivots(train);
}

/**
 * Places one train whose pivots `onShape` has just sampled: every bogie pivot is the shape point at
 * its arc length behind the front (so the bogie is on the track and yawed by the track tangent
 * there), every car body centre lies on the chord between its two pivots with the chord's heading
 * and grade (architecture §8.1).
 */
export function placeTrain(
  train: CarTrain,
  builder: (mesh: string) => MeshBuilder,
  elevation: Elevation = FLAT,
): void {
  const { model } = train;
  const consist = model.consist;
  for (let b = 0; b < consist.bogieOffsets.length; b++) {
    builder(model.pivotMeshes[b] as string).push(
      pivots[3 * b] as number,
      pivots[3 * b + 1] as number,
      drawnHeight(pivots[3 * b + 2] as number, elevation),
      0,
      pivotYaws[b] as number,
      train,
      NO_LAMPS,
    );
  }
  for (let c = 0; c < consist.carCount; c++) placeCarBody(train, c, builder, elevation);
}

/** Ground distance from the view centre to the nearest pivot of the train sampled by `onShape`. */
function nearestPivotDistance(train: CarTrain, view: CarView): number {
  let nearest = Number.POSITIVE_INFINITY;
  const count = train.model.consist.bogieOffsets.length;
  for (let b = 0; b < count; b++) {
    const distance = groundDistance(
      view.centerX,
      view.centerY,
      pivots[3 * b] as number,
      pivots[3 * b + 1] as number,
    );
    if (distance < nearest) nearest = distance;
  }
  return nearest;
}

/** The loaded level of detail nearest to the wanted one (coarser first), or undefined. */
function loadedLod(
  model: CarModel,
  wanted: number,
  ready: ReadonlySet<string> | undefined,
): number | undefined {
  const order = [0, 1, -1, 2, -2];
  for (const step of order) {
    const lod = wanted + step;
    if (lod >= 0 && lod < LOD_LEVELS && meshesReady(model, lod, ready)) return lod;
  }
  return undefined;
}

function meshesReady(
  model: CarModel,
  lod: number,
  ready: ReadonlySet<string> | undefined,
): boolean {
  if (!ready) return false;
  for (const mesh of model.carMeshes) if (!ready.has(`${mesh}@${lod}`)) return false;
  for (const mesh of model.pivotMeshes) if (!ready.has(`${mesh}@${lod}`)) return false;
  return true;
}

/**
 * The level of detail a train is drawn at: the one its nearest pivot calls for, else the nearest
 * loaded one (so zooming into an unloaded level keeps the previous cars until it arrives), and
 * the wanted level's missing meshes go into `wanted` for the page to fetch. `ready` is false when
 * nothing is loaded; the wanted level is then placed so that it gets fetched.
 */
function chooseLod(
  train: CarTrain,
  view: CarView,
  wanted: Set<string>,
): { lod: number; ready: boolean } {
  const want = lodFor(view.zoom, nearestPivotDistance(train, view), view.fineRadiusM);
  const loaded = loadedLod(train.model, want, view.ready);
  if (loaded !== want) {
    for (const mesh of [...train.model.carMeshes, ...train.model.pivotMeshes]) {
      if (!view.ready?.has(`${mesh}@${want}`)) wanted.add(`${mesh}@${want}`);
    }
  }
  return { lod: loaded ?? want, ready: loaded !== undefined };
}

/**
 * The car instances of every chosen train that lies whole on its shape, grouped by mesh and level of
 * detail, trains in key order so the per-instance attributes that do not move (colour, livery, lamps)
 * stay equal from frame to frame while the chosen set does. `blend` (the worker's per-train clock) fades a train between its chevron and its cars over
 * CAR_BLEND_S instead of switching in one frame; without it the switch is immediate.
 */
export function writeCars(
  trains: readonly CarTrain[],
  view: CarView,
  cap = CAR_TRAIN_CAP,
  blend?: CarBlend,
): CarFrame {
  const fade = carFade(view.zoom, latOf(view.centerY));
  const none = {
    meshes: [],
    trainKeys: new Int32Array(0),
    drawnKeys: new Int32Array(0),
    blends: new Float32Array(0),
    wanted: [],
    fade,
  };
  if (fade <= 0) {
    blend?.clear();
    return none;
  }
  const placed: number[] = [];
  const drawn: number[] = [];
  const blends: number[] = [];
  const wanted = new Set<string>();
  const builders = new Map<string, MeshBuilder>();
  const chosen = chooseCarTrains(trains, view, cap);
  chosen.sort((a, b) => a.train.key - b.train.key);
  for (const { train } of chosen) {
    if (!onShape(train)) continue;
    const { lod, ready } = chooseLod(train, view, wanted);
    const mix = blend ? blend.step(train.key, ready ? 1 : 0) : 1;
    placed.push(train.key);
    if (ready) {
      drawn.push(train.key);
      blends.push(mix);
    }
    placeTrain(
      { ...train, alpha: train.alpha * mix },
      (mesh) => {
        const id = `${mesh}@${lod}`;
        let builder = builders.get(id);
        if (!builder) {
          builder = new MeshBuilder(mesh, lod);
          builders.set(id, builder);
        }
        return builder;
      },
      carElevation(view.elevation ?? FLAT),
    );
  }
  blend?.end();
  return {
    meshes: [...builders.values()].map((builder) => builder.finish()),
    trainKeys: Int32Array.from(placed),
    drawnKeys: Int32Array.from(drawn),
    blends: Float32Array.from(blends),
    wanted: [...wanted],
    fade,
  };
}
