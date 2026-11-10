import {
  type ControllerParams,
  type CrossfadeReason,
  groundDistance,
  MotionFleet,
  type Shape,
  segmentAt,
  vertexX,
  vertexY,
  vertexZ,
} from "@gerlines/geo";
import type { TripRecord } from "@gerlines/live-frame";
import {
  CarBlend,
  type CarFrame,
  type CarTrain,
  type CarView,
  writeCars,
} from "../cars/car-instances.ts";
import { type CarCatalog, type CarModel, liveryRowOf, modelForTrain } from "../cars/catalog.ts";
import { dayOf } from "../cars/livery.ts";
import {
  type DeckBox,
  type DeckWindows,
  emptyDeck,
  MAX_DECK_VERTICES,
  mergeWindows,
} from "../map/terrain/deck-windows.ts";
import { drawnHeight, type Elevation, FLAT } from "../map/terrain/elevation.ts";
import type { ColourMode } from "../modes/colour-mode.ts";
import { DELAY_CLASSES, DELAY_DRAW_ORDER, type DelayClass, delayClassOf } from "../modes/delay.ts";
import { type LabelMode, labelOf } from "../modes/label-mode.ts";
import {
  OPERATOR_DRAW_ORDER,
  OPERATOR_GROUPS,
  type OperatorGroup,
  operatorGroupOf,
} from "../modes/operator-groups.ts";
import { type CategoryKey, DRAW_ORDER } from "../motion/categories.ts";
import type { EngineStats, Frame, Palette, Rgb, SelectedFrame } from "../motion/frame.ts";
import type { SelectionStops } from "../motion/protocol.ts";
import { categoryKeyOf } from "./categories.ts";
import type { ChainChanges } from "./chain.ts";
import { fillColour, writeGroup } from "./frame-writer.ts";
import { arcVertices, bearingOf, latOf, lonOf, shapeHeights, shapeLonLat } from "./geometry.ts";
import { type LoadedShape, shapeIdOf, URGENT_PRIORITY } from "./shape-store.ts";
import { liveTrainId } from "./train-ids.ts";
import { planOfTrip } from "./trip-plan.ts";

/** The part of ShapeStore the trains need (a fake stands in for it in tests). */
export interface ShapeSource {
  get(id: string): LoadedShape | undefined;
  isMissing(id: string): boolean;
  request(epoch: number, shapeId: number | string, priority?: number): void;
  retain(id: string): void;
  release(id: string): void;
  withdraw(id: string): void;
}

/** The palette row chosen for a trip, valid for the catalogue and day it was chosen with. */
interface ChosenLivery {
  readonly trip: TripRecord;
  readonly catalog: CarCatalog;
  readonly day: string;
  readonly model: CarModel;
  readonly row: number;
}

export interface TrainEntry {
  readonly key: number;
  slot: number;
  shapeId: string;
  trip: TripRecord;
  category: CategoryKey;
  delayClass: DelayClass;
  operatorGroup: OperatorGroup;
  label: string;
  livery?: ChosenLivery;
}

export interface SelectedRoute {
  readonly legKey: string;
  readonly path: Float32Array;
  /** Height of each vertex on the relief, metres, undefined where the map is flat. */
  readonly heights: Float32Array | undefined;
  /**
   * Position of each stop of the shape's stop list on `path` as a fractional vertex index, the whole trip and not
   * only the stops ahead, with the times the trip holds for the stops ahead; undefined while the shape is not
   * loaded or the trip has explicit stop positions.
   */
  readonly stops: SelectionStops | undefined;
}

/**
 * The positions of every stop of the shape's stop list, not only of the stops the frame still holds: the plan of a
 * trip starts at the last stop it departed, and the detail lists the whole trip. A trip with explicit stop
 * positions (added stops) does not follow the shape's list, so it has none.
 */
function selectionStopsOf(
  trip: TripRecord,
  loaded: LoadedShape,
  shape: Shape,
): SelectionStops | undefined {
  if (trip.stops.some((stop) => stop.s !== null && stop.s !== undefined)) return undefined;
  return {
    vertices: arcVertices(shape, loaded.stops),
    firstStop: trip.firstStop,
    arrivals: Float64Array.from(trip.stops, (stop) => stop.arrival ?? stop.departure ?? Number.NaN),
    departures: Float64Array.from(
      trip.stops,
      (stop) => stop.departure ?? stop.arrival ?? Number.NaN,
    ),
    cancelled: Uint8Array.from(trip.stops, (stop) => (stop.cancelled ? 1 : 0)),
  };
}

/** Whether two loaded shapes are one track: the same content and the same stop positions. */
function sameTrack(a: LoadedShape | undefined, b: LoadedShape): boolean {
  if (a === undefined || a.hash !== b.hash || a.length !== b.length) return false;
  if (a.stops.length !== b.stops.length) return false;
  return a.stops.every((arc, index) => arc === b.stops[index]);
}

/** The livery row of an entry, chosen once per trip, catalogue, model and day. */
function liveryRowOfEntry(
  entry: TrainEntry,
  catalog: CarCatalog,
  model: CarModel,
  day: string,
): number {
  const chosen = entry.livery;
  if (
    chosen?.trip === entry.trip &&
    chosen.catalog === catalog &&
    chosen.model === model &&
    chosen.day === day
  ) {
    return chosen.row;
  }
  const row = liveryRowOf(catalog, model, entry.trip, day);
  entry.livery = { trip: entry.trip, catalog, day, model, row };
  return row;
}

function byCategoryOrder(a: TrainEntry, b: TrainEntry): number {
  const order = DRAW_ORDER[a.category] - DRAW_ORDER[b.category];
  return order !== 0 ? order : a.key - b.key;
}

function byDelayOrder(a: TrainEntry, b: TrainEntry): number {
  const order = DELAY_DRAW_ORDER[a.delayClass] - DELAY_DRAW_ORDER[b.delayClass];
  return order !== 0 ? order : byCategoryOrder(a, b);
}

function byOperatorOrder(a: TrainEntry, b: TrainEntry): number {
  const order = OPERATOR_DRAW_ORDER[a.operatorGroup] - OPERATOR_DRAW_ORDER[b.operatorGroup];
  return order !== 0 ? order : byCategoryOrder(a, b);
}

function orderFor(mode: ColourMode): (a: TrainEntry, b: TrainEntry) => number {
  if (mode === "delay") return byDelayOrder;
  return mode === "operator" ? byOperatorOrder : byCategoryOrder;
}

function delayClassOfTrip(trip: TripRecord): DelayClass {
  return delayClassOf({ delay: trip.delay, realtime: trip.realtime, foreign: trip.foreign });
}

/**
 * The trains of the live frames in one MotionFleet: a trip of a frame becomes a slot placed on its
 * own shape, a later frame replaces its plan (the fleet blends or fades), a removal frees the slot.
 * A trip whose shape pack has not arrived waits and is added when it does; one without a usable plan
 * or shape is not drawn and counted. Positions come out as longitude and latitude in degrees
 * (Float64) for the map layers.
 */
export class LiveTrains {
  readonly fleet: MotionFleet;
  private readonly shapes: ShapeSource;
  private readonly entries = new Map<number, TrainEntry>();
  private readonly waiting = new Map<number, { trip: TripRecord; epoch: number }>();
  private readonly waitingByShape = new Map<string, Set<number>>();
  private readonly failed = new Set<number>();
  private ordered: TrainEntry[] = [];
  private orderStale = true;
  private version = 0;
  private palette: Palette;
  private hidden: ReadonlySet<CategoryKey> = new Set();
  private hiddenGroups: ReadonlySet<OperatorGroup> = new Set();
  private colourMode: ColourMode = "category";
  private labelMode: LabelMode = "off";
  private selectedKey: number | null = null;
  private hint = 0;
  private opacity = 1;
  private elevation: Elevation = FLAT;
  private deckSignature = "";
  private hiddenChanges = 0;
  private readonly carBlend = new CarBlend();
  readonly crossfades: Record<CrossfadeReason, number> = {
    start: 0,
    distance: 0,
    shape: 0,
    stop: 0,
    gap: 0,
    invalid: 0,
  };
  updates = 0;
  /** The first few `stop` and `distance` crossfades with the state they happened in (diagnosis). */
  readonly crossfadeSamples: Record<string, number>[] = [];

  constructor(shapes: ShapeSource, palette: Palette, controller?: ControllerParams) {
    this.shapes = shapes;
    this.palette = palette;
    this.fleet = new MotionFleet(controller);
  }

  get idsVersion(): number {
    return this.version;
  }

  get size(): number {
    return this.entries.size;
  }

  get waitingCount(): number {
    return this.waiting.size;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  /** Whether the train is drawn or only waits for its track (a train without one is not held). */
  holds(key: number): boolean {
    return this.entries.has(key) || this.waiting.has(key);
  }

  entry(key: number): TrainEntry | undefined {
    return this.entries.get(key);
  }

  values(): IterableIterator<TrainEntry> {
    return this.entries.values();
  }

  /** Drops every train (the time line they belong to ended). */
  clear(): void {
    for (const key of [...this.entries.keys(), ...this.waiting.keys(), ...this.failed]) {
      this.remove(key);
    }
  }

  setTimeScale(scale: number): void {
    this.fleet.timeScale = scale;
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
  }

  /** Every train drawn at this share of its own opacity (a playback seek fades them out and in). */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  setColourMode(mode: ColourMode): void {
    if (mode === this.colourMode) return;
    this.colourMode = mode;
    if (this.hiddenGroups.size > 0) this.hiddenChanges++;
    this.markChanged();
  }

  setElevation(elevation: Elevation): void {
    this.elevation = elevation;
  }

  setLabelMode(mode: LabelMode): void {
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    for (const entry of this.entries.values()) entry.label = labelOf(mode, entry.trip);
    this.markChanged();
  }

  /** Changes with the shown categories, which decide the shapes of the deck. */
  get hiddenVersion(): number {
    return this.hiddenChanges;
  }

  setHiddenCategories(categories: readonly CategoryKey[]): void {
    this.hidden = new Set(categories);
    this.hiddenChanges++;
    this.markChanged();
  }

  /** The operator groups the visitor hid; they only hide trains while the operator colour mode is on. */
  setHiddenOperatorGroups(groups: readonly OperatorGroup[]): void {
    this.hiddenGroups = new Set(groups);
    if (this.colourMode === "operator") this.hiddenChanges++;
    this.markChanged();
  }

  /** Whether the map draws the train under the legend's filters: the one rule the frame, the cars and the nearest list share. */
  isShown(entry: TrainEntry): boolean {
    return !this.isHidden(entry);
  }

  private isHidden(entry: TrainEntry): boolean {
    return (
      this.hidden.has(entry.category) ||
      (this.colourMode === "operator" && this.hiddenGroups.has(entry.operatorGroup))
    );
  }

  select(key: number | null): void {
    this.selectedKey = key;
    const waiting = key === null ? undefined : this.waiting.get(key);
    if (waiting) this.shapes.request(waiting.epoch, waiting.trip.shapeId, URGENT_PRIORITY);
  }

  /**
   * Applies one frame's changes at time `now`. After a reload the trips its `keys` do not hold are
   * removed, also those a failed earlier follow left behind.
   */
  apply(changes: ChainChanges, now: number): void {
    for (const key of changes.removed) this.remove(key);
    if (changes.keys) {
      for (const key of [...this.entries.keys(), ...this.waiting.keys(), ...this.failed]) {
        if (!changes.keys.has(key)) this.remove(key);
      }
    }
    for (const trip of changes.changed) this.place(trip, changes.shapeEpoch, now);
  }

  onShapeLoaded(id: string, now: number): void {
    const keys = this.waitingByShape.get(id);
    if (!keys) return;
    this.waitingByShape.delete(id);
    for (const key of [...keys]) {
      const waiting = this.waiting.get(key);
      if (!waiting) continue;
      this.waiting.delete(key);
      this.place(waiting.trip, waiting.epoch, now);
    }
  }

  advance(now: number): void {
    this.fleet.advance(now);
  }

  stats(): EngineStats {
    const counts: Record<CategoryKey, number> = {
      hsr: 0,
      ld: 0,
      night: 0,
      rfast: 0,
      reg: 0,
      sbahn: 0,
      foreign: 0,
    };
    const delayCounts = Object.fromEntries(DELAY_CLASSES.map((name) => [name, 0])) as Record<
      DelayClass,
      number
    >;
    const operatorCounts = Object.fromEntries(OPERATOR_GROUPS.map((group) => [group, 0])) as Record<
      OperatorGroup,
      number
    >;
    let realtime = 0;
    for (const entry of this.entries.values()) {
      counts[entry.category]++;
      delayCounts[entry.delayClass]++;
      operatorCounts[entry.operatorGroup]++;
      if (entry.trip.realtime) realtime++;
    }
    return {
      trips: this.entries.size,
      realtime,
      counts,
      delayCounts,
      operatorCounts,
      untracked: this.failed.size + this.untrackedWaiting(),
    };
  }

  buildFrame({ includeIds, cars }: { includeIds: boolean; cars?: CarFrame | undefined }): Frame {
    if (this.orderStale) {
      this.ordered = [...this.entries.values()].sort(orderFor(this.colourMode));
      this.orderStale = false;
    }
    const shown = this.ordered.filter((entry) => !this.isHidden(entry));
    const normal = shown.filter((entry) => entry.category !== "night");
    const night = shown.filter((entry) => entry.category === "night");
    const carTier = cars && cars.drawnKeys.length > 0 ? carHandOver(cars) : undefined;
    const labelling = this.labelMode !== "off";
    return {
      groups: [
        writeGroup(
          normal,
          false,
          includeIds,
          this.fleet,
          this.palette,
          carTier,
          this.colourMode,
          labelling,
          this.elevation,
          this.opacity,
        ),
        writeGroup(
          night,
          true,
          includeIds,
          this.fleet,
          this.palette,
          carTier,
          this.colourMode,
          labelling,
          this.elevation,
          this.opacity,
        ),
      ],
      selected: this.selectedFrame(),
      ...(cars ? { cars } : {}),
    };
  }

  /**
   * The 3D cars of the shown trains within the view (nearest first, capped), each train as the
   * model of its series (or the generic model of its category); the selected train's mode band
   * takes the selection colour.
   */
  buildCars(
    catalog: CarCatalog,
    view: CarView,
    selection: Rgb,
    nowS: number = performance.now() / 1000,
    planS: number = Date.now() / 1000,
  ): CarFrame {
    const candidates: CarTrain[] = [];
    const fleet = this.fleet;
    const day = dayOf(planS);
    for (const entry of this.entries.values()) {
      if (this.isHidden(entry)) continue;
      const slot = entry.slot;
      const x = fleet.x[slot] as number;
      const y = fleet.y[slot] as number;
      const model = modelForTrain(catalog, entry.trip);
      if (!model) continue;
      if (groundDistance(view.centerX, view.centerY, x, y) > view.radiusM + model.consist.length) {
        continue;
      }
      const alpha = fleet.alive[slot] ? (fleet.alpha[slot] as number) : 0;
      if (alpha <= 0) continue;
      candidates.push({
        key: entry.key,
        model,
        liveryRow: liveryRowOfEntry(entry, catalog, model, day),
        shape: fleet.shapeOf(slot),
        headS: fleet.s[slot] as number,
        x,
        y,
        alpha: alpha * this.opacity,
        color:
          entry.key === this.selectedKey
            ? selection
            : fillColour(entry, this.palette, this.colourMode),
        selected: entry.key === this.selectedKey,
      });
    }
    this.carBlend.begin(nowS);
    return writeCars(candidates, { ...view, elevation: this.elevation }, undefined, this.carBlend);
  }

  /**
   * The track of every shape that runs through the box, from its vertices at their drawn height:
   * the vertices inside the box and one more on each side, one run per stretch, shapes with the
   * same content once, nearest the centre of the box first, up to `maxVertices`. A bridge is there with or without a train. The page
   * draws the stretches where the line runs high above the relief, such as a viaduct. Undefined
   * when it is what the last call returned.
   */
  deckWindows(box: DeckBox, maxVertices = MAX_DECK_VERTICES): DeckWindows | undefined {
    if (this.elevation.scale === 0) return emptyDeck();
    const seen = new Set<string>();
    const candidates: {
      id: string;
      shape: Shape;
      windows: Window[];
      size: number;
      away: number;
    }[] = [];
    const centreX = (box.minX + box.maxX) / 2;
    const centreY = (box.minY + box.maxY) / 2;
    for (const entry of this.entries.values()) {
      if (this.isHidden(entry)) continue;
      const hash = this.shapes.get(entry.shapeId)?.hash ?? entry.shapeId;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const shape = this.fleet.shapeOf(entry.slot);
      const windows = windowsInBox(shape, box);
      const size = windows.reduce((sum, { from, to }) => sum + to - from + 1, 0);
      if (size === 0) continue;
      const away = distanceToBox(boundsOf(shape), centreX, centreY);
      candidates.push({ id: entry.shapeId, shape, windows, size, away });
    }
    candidates.sort((a, b) => a.away - b.away);
    const byShape = new Map<string, { shape: Shape; windows: Window[] }>();
    let vertices = 0;
    for (const { id, shape, windows, size } of candidates) {
      if (vertices + size > maxVertices) continue;
      vertices += size;
      byShape.set(id, { shape, windows });
    }
    const signature = deckSignature(byShape, this.elevation.scale);
    if (signature === this.deckSignature) return undefined;
    this.deckSignature = signature;
    return writeDeck(byShape, this.elevation);
  }

  /** Forgets what the last call returned, so the next one returns its deck again. */
  resetDeck(): void {
    this.deckSignature = "";
  }

  /** The speed in m/s of the selected train's plan at the display clock, null when it has none (see MotionFleet.planSpeed). */
  selectedSpeed(): number | null {
    const entry = this.selectedKey === null ? undefined : this.entries.get(this.selectedKey);
    return entry ? (this.fleet.planSpeed(entry.slot) ?? null) : null;
  }

  /** The whole shape of the selected train as longitude and latitude pairs. */
  selectedRoute(): SelectedRoute | null {
    const entry = this.selectedKey === null ? undefined : this.entries.get(this.selectedKey);
    if (!entry) return null;
    const shape = this.fleet.shapeOf(entry.slot);
    return {
      legKey: entry.shapeId,
      path: shapeLonLat(shape),
      heights:
        this.elevation.scale === 0
          ? undefined
          : shapeHeights(shape, { ...this.elevation, liftM: 0 }),
      stops: this.selectedStops(),
    };
  }

  /** The stops of the selected trip on its shape with the times the trip holds now; the times move with the delay. */
  selectedStops(): SelectionStops | undefined {
    const entry = this.selectedKey === null ? undefined : this.entries.get(this.selectedKey);
    const loaded = entry && this.shapes.get(entry.shapeId);
    if (!entry || !loaded) return undefined;
    return selectionStopsOf(entry.trip, loaded, this.fleet.shapeOf(entry.slot));
  }

  /** Trips waiting for a pack and not drawn: one already drawn on its old shape is still tracked. */
  private untrackedWaiting(): number {
    let count = 0;
    for (const key of this.waiting.keys()) {
      if (!this.entries.has(key)) count++;
    }
    return count;
  }

  private markChanged(): void {
    this.version++;
    this.orderStale = true;
  }

  private remove(key: number): void {
    this.failed.delete(key);
    this.dropWaiting(key);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.fleet.remove(entry.slot);
    this.shapes.release(entry.shapeId);
    this.entries.delete(key);
    this.markChanged();
  }

  private dropWaiting(key: number): void {
    const waiting = this.waiting.get(key);
    if (!waiting) return;
    this.waiting.delete(key);
    const id = shapeIdOf(waiting.epoch, waiting.trip.shapeId);
    const keys = this.waitingByShape.get(id);
    keys?.delete(key);
    if (keys?.size === 0) {
      this.waitingByShape.delete(id);
      this.shapes.withdraw(id);
    }
  }

  private place(trip: TripRecord, epoch: number, now: number): void {
    if (trip.cancelled) {
      this.remove(trip.key);
      return;
    }
    const category = categoryKeyOf(trip);
    if (category === null) {
      this.remove(trip.key);
      this.failed.add(trip.key);
      return;
    }
    const id = shapeIdOf(epoch, trip.shapeId);
    const shape = this.shapes.get(id);
    if (!shape) {
      this.queue(trip, epoch, id);
      return;
    }
    this.dropWaiting(trip.key);
    this.failed.delete(trip.key);
    const plan = planOfTrip(trip, shape);
    if (plan === null) {
      this.remove(trip.key);
      this.failed.add(trip.key);
      return;
    }
    const entry = this.entries.get(trip.key);
    if (!entry) {
      this.shapes.retain(id);
      const slot = this.fleet.add(shape.shape, plan, now);
      this.entries.set(trip.key, {
        key: trip.key,
        slot,
        shapeId: id,
        trip,
        category,
        delayClass: delayClassOfTrip(trip),
        operatorGroup: operatorGroupOf(trip.operator),
        label: labelOf(this.labelMode, trip),
      });
      this.markChanged();
      return;
    }
    this.updates++;
    const sameShape = entry.shapeId === id || sameTrack(this.shapes.get(entry.shapeId), shape);
    const result = this.fleet.update(entry.slot, plan, now, sameShape ? undefined : shape.shape);
    if (result.crossfade) {
      this.crossfades[result.crossfade]++;
      this.sampleCrossfade(entry, result.crossfade, result.error, now);
    }
    if (entry.shapeId !== id) {
      this.shapes.retain(id);
      this.shapes.release(entry.shapeId);
      entry.shapeId = id;
    }
    entry.trip = trip;
    const delayClass = delayClassOfTrip(trip);
    const classChanged = delayClass !== entry.delayClass;
    entry.delayClass = delayClass;
    const operatorGroup = operatorGroupOf(trip.operator);
    const groupChanged = operatorGroup !== entry.operatorGroup;
    entry.operatorGroup = operatorGroup;
    const label = labelOf(this.labelMode, trip);
    const labelChanged = label !== entry.label;
    entry.label = label;
    const categoryChanged = category !== entry.category;
    entry.category = category;
    const classMoved =
      (classChanged && this.colourMode === "delay") ||
      (groupChanged && this.colourMode === "operator");
    if (labelChanged || categoryChanged || classMoved) this.markChanged();
  }

  private sampleCrossfade(entry: TrainEntry, reason: string, error: number, now: number): void {
    if (this.crossfadeSamples.length >= 40) return;
    const slot = entry.slot;
    const fleet = this.fleet;
    this.crossfadeSamples.push({
      key: entry.key,
      reason: reason === "stop" ? 1 : 0,
      now,
      slotTime: fleet.time[slot] as number,
      lag: now - (fleet.time[slot] as number),
      error,
      s: fleet.s[slot] as number,
      v: fleet.v[slot] as number,
      targetS: fleet.targetS[slot] as number,
      cap: fleet.cap[slot] as number,
    });
  }

  private queue(trip: TripRecord, epoch: number, id: string): void {
    this.dropWaiting(trip.key);
    if (this.shapes.isMissing(id)) {
      this.failed.add(trip.key);
      return;
    }
    this.failed.delete(trip.key);
    this.waiting.set(trip.key, { trip, epoch });
    let keys = this.waitingByShape.get(id);
    if (!keys) {
      keys = new Set();
      this.waitingByShape.set(id, keys);
    }
    keys.add(trip.key);
    this.shapes.request(epoch, trip.shapeId, trip.key === this.selectedKey ? URGENT_PRIORITY : 0);
  }

  private selectedFrame(): SelectedFrame | null {
    const entry = this.selectedKey === null ? undefined : this.entries.get(this.selectedKey);
    if (!entry) return null;
    const slot = entry.slot;
    const fleet = this.fleet;
    const shape = fleet.shapeOf(slot);
    this.hint = segmentAt(shape, fleet.s[slot] as number, this.hint);
    return {
      id: liveTrainId(entry.key),
      lon: lonOf(fleet.x[slot] as number),
      lat: latOf(fleet.y[slot] as number),
      bearing: bearingOf(fleet.tangentX[slot] as number, fleet.tangentY[slot] as number),
      z: drawnHeight(fleet.z[slot] as number, this.elevation),
      alpha: fleet.alpha[slot] as number,
      legKey: entry.shapeId,
      vertex: this.hint,
    };
  }
}

/** How far each car-drawn train's chevron has given way: the zoom fade times the train's own blend. */
function carHandOver(cars: CarFrame): ReadonlyMap<number, number> {
  const handOver = new Map<number, number>();
  cars.drawnKeys.forEach((key, index) => {
    handOver.set(key, cars.fade * (cars.blends[index] ?? 1));
  });
  return handOver;
}

const BOUNDS = new WeakMap<Shape, DeckBox>();

function boundsOf(shape: Shape): DeckBox {
  let box = BOUNDS.get(shape);
  if (box) return box;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < shape.vertexCount; i++) {
    const x = vertexX(shape, i);
    const y = vertexY(shape, i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  box = { minX, minY, maxX, maxY };
  BOUNDS.set(shape, box);
  return box;
}

type Window = { from: number; to: number };

/** Metres from a point to a box, zero inside it. */
function distanceToBox(box: DeckBox, x: number, y: number): number {
  return Math.hypot(
    Math.max(box.minX - x, 0, x - box.maxX),
    Math.max(box.minY - y, 0, y - box.maxY),
  );
}

/** The vertices of a shape inside a box, with one more on each side, as runs of consecutive indices. */
function windowsInBox(shape: Shape, box: DeckBox): { from: number; to: number }[] {
  const bounds = boundsOf(shape);
  if (
    bounds.maxX < box.minX ||
    bounds.minX > box.maxX ||
    bounds.maxY < box.minY ||
    bounds.minY > box.maxY
  ) {
    return [];
  }
  const windows: { from: number; to: number }[] = [];
  const last = shape.vertexCount - 1;
  let from = -1;
  for (let i = 0; i <= last; i++) {
    const x = vertexX(shape, i);
    const y = vertexY(shape, i);
    const inside = x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
    if (inside && from < 0) from = i;
    if (!inside && from >= 0) {
      windows.push({ from: Math.max(0, from - 1), to: i });
      from = -1;
    }
  }
  if (from >= 0) windows.push({ from: Math.max(0, from - 1), to: last });
  return mergeWindows(windows);
}

function deckSignature(
  byShape: ReadonlyMap<string, { windows: { from: number; to: number }[] }>,
  scale: number,
): string {
  let signature = `${scale}`;
  for (const [id, { windows }] of byShape) {
    signature += `|${id}`;
    for (const { from, to } of windows) signature += `,${from}-${to}`;
  }
  return signature;
}

function writeDeck(
  byShape: ReadonlyMap<string, { shape: Shape; windows: { from: number; to: number }[] }>,
  elevation: Elevation,
): DeckWindows {
  const shapeIds: string[] = [];
  const first: number[] = [];
  const counts: number[] = [];
  const runs: { shape: Shape; from: number; to: number }[] = [];
  for (const [id, { shape, windows }] of byShape) {
    for (const { from, to } of mergeWindows(windows)) {
      shapeIds.push(id);
      first.push(from);
      counts.push(to - from + 1);
      runs.push({ shape, from, to });
    }
  }
  const ground = { ...elevation, liftM: 0 };
  const paths = new Float32Array(3 * counts.reduce((sum, count) => sum + count, 0));
  let at = 0;
  for (const { shape, from, to } of runs) {
    for (let i = from; i <= to; i++) {
      paths[at++] = lonOf(vertexX(shape, i));
      paths[at++] = latOf(vertexY(shape, i));
      paths[at++] = drawnHeight(vertexZ(shape, i), ground);
    }
  }
  return {
    shapeIds,
    first: Uint32Array.from(first),
    counts: Uint32Array.from(counts),
    paths,
  };
}
