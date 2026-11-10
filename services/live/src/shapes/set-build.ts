import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import {
  decodeShapePack,
  encodeShapePack,
  FrameDecodeError,
  MAX_PACK_SET_PARTS,
  type ShapeRecord,
  shapePackToObject,
} from "@gerlines/live-frame";

/** Brotli quality of pack sets: 6.11 MB in 16.6 s against 6.09 MB in 29 s at 11. */
export const SET_BROTLI_QUALITY = 10;

/** One pack set to build (FORMAT.md 4.2), as plain data so it can cross to a worker thread. */
export interface SetJob {
  /** The live directory (`data/live/v1`), holding `s/<epoch>/` and `sets/<epoch>/`. */
  readonly root: string;
  readonly epoch: number;
  readonly id: number;
  readonly timetableVersion: number;
  /** Shape numbers the frames name until the window ends. */
  readonly wanted: readonly number[];
  /** The shape numbers of base `id - 1` when it is published, else null (no increment). */
  readonly previous: readonly number[] | null;
  readonly partVertices: number;
}

export interface SetResult {
  readonly id: number;
  readonly numbers: number[];
  readonly parts: number;
  readonly increment: number;
  readonly absent: number;
  /** Single packs that failed to decode, by number (treated as absent and logged). */
  readonly corrupt: number[];
  readonly plainBytes: number;
  readonly brBytes: number;
  readonly incrementBrBytes: number;
  readonly encodeMs: number;
  readonly compressMs: number;
}

/** File operations of a build, so a test can fail the store halfway. */
export interface SetFiles {
  read(path: string): Uint8Array | null;
  write(path: string, bytes: Uint8Array): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

export const diskFiles: SetFiles = {
  read: (path) => (existsSync(path) ? new Uint8Array(readFileSync(path)) : null),
  write: (path, bytes) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  },
  rename: (from, to) => {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  },
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  exists: (path) => existsSync(path),
};

/** A Morton key of a shape's middle vertex, so shapes near each other sit together in a set. */
function placeKey(shape: ShapeRecord): number {
  const middle = Math.floor(shape.x.length / 2);
  const cell = (metres: number) =>
    Math.min(65_535, Math.max(0, Math.floor(((metres + 20_037_509) / 40_075_017) * 65_536)));
  const qx = cell(shape.x[middle] as number);
  const qy = cell(shape.y[middle] as number);
  let key = 0;
  for (let bit = 15; bit >= 0; bit--) key = key * 4 + ((qx >> bit) & 1) * 2 + ((qy >> bit) & 1);
  return key;
}

/** Shapes in place order cut into parts of about `vertices` vertices, at most MAX_PACK_SET_PARTS. */
export function partsOf(shapes: readonly ShapeRecord[], vertices: number): ShapeRecord[][] {
  const ordered = [...shapes].sort(
    (a, b) => placeKey(a) - placeKey(b) || (a.number ?? 0) - (b.number ?? 0),
  );
  const total = ordered.reduce((sum, shape) => sum + shape.x.length, 0);
  const size = Math.max(vertices, Math.ceil(total / MAX_PACK_SET_PARTS));
  const parts: ShapeRecord[][] = [[]];
  let filled = 0;
  for (const shape of ordered) {
    if (filled >= size) {
      parts.push([]);
      filled = 0;
    }
    (parts.at(-1) as ShapeRecord[]).push(shape);
    filled += shape.x.length;
  }
  return parts;
}

/** Paths of a set below the live directory (FORMAT.md 7). */
export function setPaths(root: string, epoch: number, id: number) {
  const sets = join(root, "sets", String(epoch));
  return {
    sets,
    base: join(sets, "b", String(id)),
    increment: join(sets, "i", `${id}.bin`),
    staging: join(sets, `.staging-${id}`),
  };
}

const COPIES = ["", ".br", ".gz"] as const;

/**
 * Decoded single packs by number: shapes are immutable within an epoch, so a build reads only the
 * shapes the last one did not use, and the cache keeps only those of the last build.
 */
export class ShapeCache {
  #epoch = -1;
  #shapes = new Map<number, ShapeRecord>();

  get size(): number {
    return this.#shapes.size;
  }

  /** The shapes of `wanted` with a readable pack, the numbers without one, and the corrupt ones. */
  take(job: SetJob, files: SetFiles) {
    if (job.epoch !== this.#epoch) {
      this.#epoch = job.epoch;
      this.#shapes = new Map();
    }
    const kept = new Map<number, ShapeRecord>();
    const absent: number[] = [];
    const corrupt: number[] = [];
    for (const number of job.wanted) {
      const shape = this.#shapes.get(number) ?? readShape(job, number, files, corrupt);
      if (shape) kept.set(number, shape);
      else absent.push(number);
    }
    this.#shapes = kept;
    return { shapes: [...kept.values()], absent: absent.sort((a, b) => a - b), corrupt };
  }
}

function readShape(job: SetJob, number: number, files: SetFiles, corrupt: number[]) {
  const bytes = files.read(join(job.root, "s", String(job.epoch), `${number}.bin`));
  if (!bytes) return null;
  try {
    const pack = shapePackToObject(decodeShapePack(bytes));
    const shape = pack.shapes[0];
    if (pack.shapes.length === 1 && shape?.number === number) return shape;
  } catch (error) {
    if (!(error instanceof FrameDecodeError)) throw error;
  }
  corrupt.push(number);
  return null;
}

function writeCopies(files: SetFiles, path: string, bytes: Uint8Array): number {
  const br = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: SET_BROTLI_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
  files.write(`${path}.br`, br);
  files.write(`${path}.gz`, gzipSync(bytes, { level: 9 }));
  files.write(path, bytes);
  return br.length;
}

/**
 * Builds set `job.id` in a staging directory and moves it into place (FORMAT.md 4.2): the
 * increment's files first, then the base directory with one rename, so `b/<id>/` on disk means a
 * whole set. Leftovers of an earlier attempt at this id (staging, an increment without its base)
 * are removed first: no head named them, so no client or edge holds them.
 */
export function buildSetFiles(job: SetJob, cache: ShapeCache, files: SetFiles = diskFiles) {
  const paths = setPaths(job.root, job.epoch, job.id);
  if (files.exists(paths.base)) throw new Error(`set ${job.id} is published already`);
  files.remove(paths.staging);
  for (const copy of COPIES) files.remove(`${paths.increment}${copy}`);
  const started = performance.now();
  const { shapes, absent, corrupt } = cache.take(job, files);
  const pack = (records: readonly ShapeRecord[], withAbsent: boolean) =>
    encodeShapePack({
      kind: "shapePack",
      timetableVersion: job.timetableVersion,
      shapeEpoch: job.epoch,
      shapes: records,
      coding: "compact",
      ...(withAbsent ? { absent } : {}),
    });
  const previous = job.previous ? new Set(job.previous) : null;
  const added = previous ? shapes.filter((shape) => !previous.has(shape.number ?? -1)) : [];
  const parts = partsOf(shapes, job.partVertices).map((part, index) => pack(part, index === 0));
  const increment = previous ? pack(added, true) : null;
  const encodeMs = performance.now() - started;
  const numbers = shapes.map((shape) => shape.number as number).sort((a, b) => a - b);
  const staged = join(paths.staging, "b");
  let brBytes = 0;
  parts.forEach((bytes, index) => {
    brBytes += writeCopies(files, join(staged, `${index}.bin`), bytes);
  });
  files.write(join(staged, "shapes.json"), new TextEncoder().encode(JSON.stringify(numbers)));
  const incrementBrBytes = increment
    ? writeCopies(files, join(paths.staging, "i.bin"), increment)
    : 0;
  const compressMs = performance.now() - started - encodeMs;
  if (increment) {
    for (const copy of [".br", ".gz", ""]) {
      files.rename(join(paths.staging, `i.bin${copy}`), `${paths.increment}${copy}`);
    }
  }
  files.rename(staged, paths.base);
  files.remove(paths.staging);
  return {
    id: job.id,
    numbers,
    parts: parts.length,
    increment: increment ? added.length : 0,
    absent: absent.length,
    corrupt,
    plainBytes: parts.reduce((sum, bytes) => sum + bytes.length, 0),
    brBytes,
    incrementBrBytes,
    encodeMs: Math.round(encodeMs),
    compressMs: Math.round(compressMs),
  } satisfies SetResult;
}

/** A published base: its parts and shape numbers, or null when `b/<id>/` is not there. */
export function readBase(root: string, epoch: number, id: number, files: SetFiles = diskFiles) {
  const { base } = setPaths(root, epoch, id);
  const numbers = files.read(join(base, "shapes.json"));
  if (!numbers) return null;
  let parts = 0;
  while (parts < MAX_PACK_SET_PARTS && files.exists(join(base, `${parts}.bin`))) parts++;
  if (parts === 0) return null;
  return { id, parts, shapes: new Set(JSON.parse(new TextDecoder().decode(numbers)) as number[]) };
}

/** Removes sets below `belowId` of `epoch`, every other epoch's sets and stale staging. */
export function pruneSets(root: string, epoch: number, belowId: number, building: number): number {
  const all = join(root, "sets");
  let removed = 0;
  const drop = (path: string) => {
    rmSync(path, { recursive: true, force: true });
    removed++;
  };
  const list = (path: string) => (existsSync(path) ? readdirSync(path) : []);
  for (const name of list(all)) if (name !== String(epoch)) drop(join(all, name));
  const sets = join(all, String(epoch));
  for (const part of ["b", "i"]) {
    for (const name of list(join(sets, part))) {
      const id = Number.parseInt(name, 10);
      if (Number.isInteger(id) && id < belowId) drop(join(sets, part, name));
    }
  }
  for (const name of list(sets)) {
    if (name.startsWith(".staging-") && name !== `.staging-${building}`) drop(join(sets, name));
  }
  return removed;
}
