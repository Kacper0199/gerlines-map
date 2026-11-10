import type { CarFrame, MeshInstances } from "./car-instances.ts";
import { SlotLayout } from "./slot-layout.ts";

/** The instances of one mesh at one level of detail inside the fleet's shared arrays. */
export interface FleetRange {
  readonly mesh: string;
  readonly lod: number;
  /** Index of the first instance of this mesh in the shared arrays. */
  readonly start: number;
  readonly count: number;
}

/**
 * Every mesh's instances of a car frame in one set of arrays, so one deck layer holds them all and
 * one buffer per attribute reaches the GPU; each mesh is a contiguous range of it.
 */
export interface Fleet {
  /** Instances the arrays hold: those of the ranges and any unused room between them. */
  readonly count: number;
  readonly ranges: readonly FleetRange[];
  readonly positions: Float64Array;
  readonly matrices: Float32Array;
  readonly colors: Uint8Array;
  readonly liveryRows: Float32Array;
  readonly lamps: Float32Array;
  readonly selected: Float32Array;
  readonly trainKeys: Int32Array;
  /**
   * Counts the frames in which the colour, livery, lamp or selection values (or the instance count) differ
   * from the frame before; equal numbers mean equal values. Only a fleet merged by `FleetMerger` has one.
   */
  readonly staticsVersion?: number;
  /** Tells one merger's versions from another's, so a restarted worker cannot reuse a stale attribute. */
  readonly staticsEpoch?: number;
}

function place<T extends Float64Array | Float32Array | Uint8Array | Int32Array>(
  make: (length: number) => T,
  parts: readonly MeshInstances[],
  pick: (mesh: MeshInstances) => T,
  stride: number,
  starts: readonly number[],
  total: number,
): T {
  const out = make(total * stride);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as MeshInstances;
    out.set(pick(part).subarray(0, part.count * stride), (starts[i] as number) * stride);
  }
  return out;
}

/**
 * Merges the meshes of a frame into the shared arrays. Without a `layout` they sit one after the
 * other; with one each mesh keeps its slot from frame to frame (the arrays then have unused room
 * between the slots, which no model draws).
 */
export function mergeFleet(meshes: readonly MeshInstances[], layout?: SlotLayout): Fleet {
  const parts = meshes.filter((mesh) => mesh.count > 0);
  let starts: number[];
  let count: number;
  if (layout) {
    ({ starts, total: count } = layout.place(
      parts.map((part) => ({ id: `${part.mesh}@${part.lod}`, count: part.count })),
    ));
  } else {
    starts = [];
    count = 0;
    for (const part of parts) {
      starts.push(count);
      count += part.count;
    }
  }
  const ranges: FleetRange[] = parts.map((part, i) => ({
    mesh: part.mesh,
    lod: part.lod,
    start: starts[i] as number,
    count: part.count,
  }));
  const at = <T extends Float64Array | Float32Array | Uint8Array | Int32Array>(
    make: (length: number) => T,
    pick: (mesh: MeshInstances) => T,
    stride: number,
  ) => place(make, parts, pick, stride, starts, count);
  return {
    count,
    ranges,
    positions: at(
      (n) => new Float64Array(n),
      (m) => m.positions,
      3,
    ),
    matrices: at(
      (n) => new Float32Array(n),
      (m) => m.matrices,
      12,
    ),
    colors: at(
      (n) => new Uint8Array(n),
      (m) => m.colors,
      4,
    ),
    liveryRows: at(
      (n) => new Float32Array(n),
      (m) => m.liveryRows,
      1,
    ),
    lamps: at(
      (n) => new Float32Array(n),
      (m) => m.lamps,
      2,
    ),
    selected: at(
      (n) => new Float32Array(n),
      (m) => m.selected,
      1,
    ),
    trainKeys: at(
      (n) => new Int32Array(n),
      (m) => m.trainKeys,
      1,
    ),
  };
}

/** The static columns of a fleet, copied: the fleet's own arrays leave with the message that carries them. */
type Statics = Pick<Fleet, "count" | "colors" | "liveryRows" | "lamps" | "selected">;

function copyOfStatics(fleet: Fleet): Statics {
  return {
    count: fleet.count,
    colors: fleet.colors.slice(),
    liveryRows: fleet.liveryRows.slice(),
    lamps: fleet.lamps.slice(),
    selected: fleet.selected.slice(),
  };
}

function sameStatics(a: Statics, b: Statics): boolean {
  return (
    a.count === b.count &&
    sameValues(a.colors, b.colors) &&
    sameValues(a.liveryRows, b.liveryRows) &&
    sameValues(a.lamps, b.lamps) &&
    sameValues(a.selected, b.selected)
  );
}

function sameValues(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Merges the frames in the worker, so the page neither concatenates the arrays of 19 meshes every
 * frame nor compares the values that hardly ever change: it gets the statics version instead.
 */
export class FleetMerger {
  private last: Statics | undefined;
  private version = 0;
  private readonly epoch = Math.floor(Math.random() * 2 ** 31);
  private readonly layout = new SlotLayout();
  private readonly starts = new Map<string, number>();
  private moves = 0;
  private slots = 0;

  /** For the probes: slots in the arrays of the last frame, and slots that moved since the first frame. */
  stats(): { slots: number; moves: number } {
    return { slots: this.slots, moves: this.moves };
  }

  merge(meshes: readonly MeshInstances[]): Fleet {
    const fleet = mergeFleet(meshes, this.layout);
    this.slots = fleet.count;
    for (const range of fleet.ranges) {
      const id = `${range.mesh}@${range.lod}`;
      const before = this.starts.get(id);
      if (before !== undefined && before !== range.start) this.moves += 1;
      this.starts.set(id, range.start);
    }
    if (!(this.last && sameStatics(this.last, fleet))) {
      this.version += 1;
      this.last = copyOfStatics(fleet);
    }
    return { ...fleet, staticsVersion: this.version, staticsEpoch: this.epoch };
  }
}

const fleets = new WeakMap<CarFrame, Fleet>();

/** The fleet of a frame: the one the worker merged, else merged here once however often the page renders it. */
export function fleetOf(frame: CarFrame): Fleet {
  if (frame.fleet) return frame.fleet;
  const known = fleets.get(frame);
  if (known) return known;
  const fleet = mergeFleet(frame.meshes);
  fleets.set(frame, fleet);
  return fleet;
}

let indexes = new Float32Array(0);
let indexAttribute: { readonly value: Float32Array; readonly size: 1 } | undefined;

/**
 * 0, 1, 2 and so on, one per fleet instance: a model draws a slice of the fleet's buffers, and
 * picking needs the index within the whole fleet, which gl_InstanceID does not give. The same
 * attribute object is handed out until the fleet outgrows it, so deck never uploads it again.
 */
export function fleetIndexAttribute(count: number): { value: Float32Array; size: 1 } {
  if (!indexAttribute || indexes.length < count) {
    const length = Math.max(count, Math.ceil(indexes.length * 1.5), 512);
    indexes = Float32Array.from({ length }, (_, i) => i);
    indexAttribute = { value: indexes, size: 1 };
  }
  return indexAttribute;
}
