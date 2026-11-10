import {
  type Container,
  type FrameHeader,
  optionalSection,
  readContainer,
  type SectionInput,
  section,
  writeContainer,
} from "../../src/container.ts";
import { bytesToHex, centimetres, hexToBytes, requireInteger } from "../../src/encode-util.ts";
import { corrupt } from "../../src/errors.ts";
import type { ShapePack, ShapeRecord } from "../../src/model.ts";
import { CONTENT_HASH_BYTES, MAX_U32, MERCATOR_LIMIT_CM, PACK_FLAG, SECTION } from "./constants.ts";

const MIN_I32 = -0x80000000;
const MAX_I32 = 0x7fffffff;

const KNOWN: ReadonlySet<number> = new Set([
  SECTION.packHash,
  SECTION.packVertexCount,
  SECTION.packStopCount,
  SECTION.packTunnelCount,
  SECTION.packLength,
  SECTION.packFlags,
  SECTION.packNumber,
  SECTION.vertexX,
  SECTION.vertexY,
  SECTION.vertexZ,
  SECTION.vertexM,
  SECTION.packStopArc,
  SECTION.packTunnel,
]);

/**
 * A decoded shape pack as typed columns (FORMAT.md section 5) with per-shape row offsets. Columns
 * may be views of the input buffer: treat them as read-only.
 */
export interface ShapePackView {
  readonly header: FrameHeader;
  readonly count: number;
  /** count × 32 bytes. */
  readonly hash: Uint8Array;
  readonly vertexCount: Uint32Array;
  readonly stopCount: Uint32Array;
  readonly tunnelCount: Uint32Array;
  readonly length: Uint32Array;
  readonly flags: Uint8Array;
  readonly number: Uint32Array | undefined;
  /** count + 1 entries each. */
  readonly vertexOffset: Float64Array;
  readonly stopOffset: Float64Array;
  readonly tunnelOffset: Float64Array;
  /** Centimetre differences as stored (first vertex of each shape absolute). */
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly z: Float32Array | undefined;
  /** Arc length differences in centimetres as stored (0 at the first vertex of each shape). */
  readonly m: Uint32Array;
  readonly stopArc: Uint32Array;
  /** Pairs (start, end) in centimetres. */
  readonly tunnel: Uint32Array;
}

/**
 * One shape in metres, ready for `createShape` of `@gerlines/geo` ({ x, y, z?, s } is its
 * MercatorPolyline): Web Mercator x and y, z when the shape has elevation, s the arc length of each
 * vertex (the pipeline's M, so the kernel's arc length is the one of the stops), the length, stop
 * arc positions and tunnel spans as (start, end) pairs.
 */
export interface ShapePolyline {
  readonly hash: string;
  readonly number: number | null;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z?: Float32Array;
  readonly s: Float64Array;
  readonly length: number;
  readonly stops: Float64Array;
  readonly tunnels: Float64Array;
}

interface PackBuffers {
  x: Int32Array;
  y: Int32Array;
  z: Float32Array;
  m: Uint32Array;
  stopArc: number[];
  tunnel: number[];
}

function writeCoordinates(values: readonly number[], name: string, out: Int32Array, row: number) {
  let previous = 0;
  values.forEach((metres, i) => {
    if (!Number.isFinite(metres)) throw new RangeError(`${name}[${i}] is not finite`);
    const cm = requireInteger(
      Math.round(metres * 100),
      -MERCATOR_LIMIT_CM,
      MERCATOR_LIMIT_CM,
      `${name}[${i}] in centimetres`,
    );
    out[row + i] = i === 0 ? cm : requireInteger(cm - previous, MIN_I32, MAX_I32, `${name} step`);
    previous = cm;
  });
}

function writeElevation(shape: ShapeRecord, name: string, out: Float32Array, row: number) {
  const z = shape.z;
  if (z === null) return;
  if (z.length !== shape.x.length) throw new RangeError(`${name} z length differs from x`);
  z.forEach((value, i) => {
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
      throw new RangeError(`${name} z[${i}] is not a finite float32`);
    }
    out[row + i] = value;
  });
}

function writeArcLength(
  shape: ShapeRecord,
  name: string,
  length: number,
  out: Uint32Array,
  row: number,
) {
  if (shape.m.length !== shape.x.length) throw new RangeError(`${name} m length differs from x`);
  let previous = 0;
  shape.m.forEach((metres, i) => {
    const arc = centimetres(metres, `${name} m[${i}]`);
    if (i === 0 && arc !== 0) throw new RangeError(`${name} m[0] must be 0, got ${metres}`);
    if (arc < previous) throw new RangeError(`${name} m decreases at ${i}`);
    out[row + i] = arc - previous;
    previous = arc;
  });
  if (previous !== length) {
    throw new RangeError(`${name} m ends at ${previous / 100}, not at the length ${length / 100}`);
  }
}

function writeStopsAndTunnels(shape: ShapeRecord, name: string, length: number, out: PackBuffers) {
  let previous = 0;
  shape.stops.forEach((s, j) => {
    const arc = centimetres(s, `${name} stop ${j}`);
    if (arc < previous || arc > length) throw new RangeError(`${name} stop ${j} out of order`);
    out.stopArc.push(arc);
    previous = arc;
  });
  previous = 0;
  shape.tunnels.forEach(([from, to], k) => {
    const start = centimetres(from, `${name} tunnel ${k} start`);
    const end = centimetres(to, `${name} tunnel ${k} end`);
    if (start < previous || end <= start || end > length) {
      throw new RangeError(`${name} tunnel ${k} out of order`);
    }
    out.tunnel.push(start, end);
    previous = end;
  });
}

function packSections(shapes: readonly ShapeRecord[], shapeEpoch: number): SectionInput[] {
  const n = shapes.length;
  const vertexTotal = shapes.reduce((sum, shape) => sum + shape.x.length, 0);
  const hash = new Uint8Array(n * CONTENT_HASH_BYTES);
  const counts = {
    vertex: new Uint32Array(n),
    stop: new Uint32Array(n),
    tunnel: new Uint32Array(n),
  };
  const length = new Uint32Array(n);
  const flags = new Uint8Array(n);
  const out: PackBuffers = {
    x: new Int32Array(vertexTotal),
    y: new Int32Array(vertexTotal),
    z: new Float32Array(vertexTotal),
    m: new Uint32Array(vertexTotal),
    stopArc: [],
    tunnel: [],
  };
  const seen = new Set<string>();
  let row = 0;
  shapes.forEach((shape, i) => {
    const name = `shape ${i}`;
    if (seen.has(shape.hash)) throw new RangeError(`${name} hash repeated`);
    seen.add(shape.hash);
    hash.set(hexToBytes(shape.hash, CONTENT_HASH_BYTES, `${name} hash`), i * CONTENT_HASH_BYTES);
    if (shape.x.length < 2 || shape.y.length !== shape.x.length) {
      throw new RangeError(`${name} needs at least two vertices and as many y as x`);
    }
    counts.vertex[i] = shape.x.length;
    counts.stop[i] = shape.stops.length;
    counts.tunnel[i] = shape.tunnels.length;
    length[i] = centimetres(shape.length, `${name} length`);
    flags[i] = shape.z === null ? 0 : PACK_FLAG.elevation;
    writeCoordinates(shape.x, `${name} x`, out.x, row);
    writeCoordinates(shape.y, `${name} y`, out.y, row);
    writeElevation(shape, name, out.z, row);
    writeArcLength(shape, name, length[i] as number, out.m, row);
    writeStopsAndTunnels(shape, name, length[i] as number, out);
    row += shape.x.length;
  });
  const sections: SectionInput[] = [
    { id: SECTION.packHash, data: hash },
    { id: SECTION.packVertexCount, data: counts.vertex },
    { id: SECTION.packStopCount, data: counts.stop },
    { id: SECTION.packTunnelCount, data: counts.tunnel },
    { id: SECTION.packLength, data: length },
    { id: SECTION.packFlags, data: flags },
    { id: SECTION.vertexX, data: out.x },
    { id: SECTION.vertexY, data: out.y },
    { id: SECTION.vertexM, data: out.m },
    { id: SECTION.packStopArc, data: Uint32Array.from(out.stopArc) },
    { id: SECTION.packTunnel, data: Uint32Array.from(out.tunnel) },
  ];
  if (shapes.some((shape) => shape.z !== null)) sections.push({ id: SECTION.vertexZ, data: out.z });
  const numbered = shapes.filter((shape) => shape.number !== null).length;
  if (shapeEpoch === 0 && numbered > 0) {
    throw new RangeError("a pack with shapeEpoch 0 has no shape numbers");
  }
  if (shapeEpoch > 0) {
    if (numbered < n) {
      throw new RangeError(`a pack with shapeEpoch ${shapeEpoch} needs a number for every shape`);
    }
    const numbers = shapes.map((shape, i) =>
      requireInteger(shape.number as number, 0, MAX_U32, `shape ${i} number`),
    );
    if (new Set(numbers).size < n) throw new RangeError("shape number repeated");
    sections.push({ id: SECTION.packNumber, data: Uint32Array.from(numbers) });
  }
  return sections;
}

export function encodeShapePack(pack: ShapePack): Uint8Array<ArrayBuffer> {
  return writeContainer(
    "shapePack",
    {
      sequence: 0,
      baseSequence: 0,
      timetableVersion: pack.timetableVersion,
      timeBase: 0,
      shapeEpoch: pack.shapeEpoch,
    },
    packSections(pack.shapes, requireInteger(pack.shapeEpoch, 0, MAX_U32, "shapeEpoch")),
  );
}

function offsets(counts: Uint32Array, total: number, name: string): Float64Array {
  const out = new Float64Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) out[i + 1] = (out[i] as number) + (counts[i] as number);
  if (out[counts.length] !== total) corrupt(`${name} counts do not match the ${name} column`);
  return out;
}

function checkCoordinates(values: Int32Array, from: number, to: number, name: string): void {
  let cm = 0;
  for (let v = from; v < to; v++) {
    cm = v === from ? (values[v] as number) : cm + (values[v] as number);
    if (Math.abs(cm) > MERCATOR_LIMIT_CM) corrupt(`${name} leaves the Web Mercator square`);
  }
}

function checkArcs(view: ShapePackView, i: number): void {
  const length = view.length[i] as number;
  let previous = 0;
  for (let j = view.stopOffset[i] as number; j < (view.stopOffset[i + 1] as number); j++) {
    const arc = view.stopArc[j] as number;
    if (arc < previous || arc > length) corrupt(`shape ${i} stop arc positions out of order`);
    previous = arc;
  }
  previous = 0;
  for (let k = view.tunnelOffset[i] as number; k < (view.tunnelOffset[i + 1] as number); k++) {
    const start = view.tunnel[2 * k] as number;
    const end = view.tunnel[2 * k + 1] as number;
    if (start < previous || end <= start || end > length)
      corrupt(`shape ${i} tunnels out of order`);
    previous = end;
  }
}

function checkArcLength(view: ShapePackView, from: number, to: number, i: number): void {
  if (view.m[from] !== 0) corrupt(`shape ${i} m starts at ${view.m[from]}, not 0`);
  let sum = 0;
  for (let v = from + 1; v < to; v++) sum += view.m[v] as number;
  if (sum !== view.length[i]) corrupt(`shape ${i} m adds up to ${sum}, not its length`);
}

function checkShape(view: ShapePackView, i: number, seen: Set<string>): void {
  const hash = bytesToHex(view.hash, i * CONTENT_HASH_BYTES, CONTENT_HASH_BYTES);
  if (seen.has(hash)) corrupt(`shape ${i} hash repeated`);
  seen.add(hash);
  if ((view.vertexCount[i] as number) < 2) corrupt(`shape ${i} has fewer than two vertices`);
  const flags = view.flags[i] as number;
  if (flags & PACK_FLAG.elevation && !view.z) corrupt(`shape ${i} has elevation but no z column`);
  const from = view.vertexOffset[i] as number;
  const to = view.vertexOffset[i + 1] as number;
  checkCoordinates(view.x, from, to, `shape ${i} x`);
  checkCoordinates(view.y, from, to, `shape ${i} y`);
  checkArcLength(view, from, to, i);
  checkArcs(view, i);
}

function readPack(container: Container): ShapePackView {
  const hash = section(container, SECTION.packHash, "u8");
  if (hash.length % CONTENT_HASH_BYTES !== 0) corrupt("hash column length");
  const count = hash.length / CONTENT_HASH_BYTES;
  const table = {
    vertexCount: section(container, SECTION.packVertexCount, "u32"),
    stopCount: section(container, SECTION.packStopCount, "u32"),
    tunnelCount: section(container, SECTION.packTunnelCount, "u32"),
    length: section(container, SECTION.packLength, "u32"),
    flags: section(container, SECTION.packFlags, "u8"),
  };
  const number = optionalSection(container, SECTION.packNumber, "u32");
  if ((number !== undefined) !== container.header.shapeEpoch > 0) {
    corrupt(`shape epoch ${container.header.shapeEpoch} does not match the shape number section`);
  }
  if ([...Object.values(table), number ?? table.flags].some((column) => column.length !== count)) {
    corrupt("shape columns differ in length");
  }
  if (number && new Set(number).size < count) corrupt("shape number repeated");
  const x = section(container, SECTION.vertexX, "i32");
  const y = section(container, SECTION.vertexY, "i32");
  const z = optionalSection(container, SECTION.vertexZ, "f32");
  const m = section(container, SECTION.vertexM, "u32");
  if (y.length !== x.length || m.length !== x.length || (z && z.length !== x.length)) {
    corrupt("vertex columns differ");
  }
  if (z?.some((value) => !Number.isFinite(value))) corrupt("z holds a value that is not finite");
  const stopArc = section(container, SECTION.packStopArc, "u32");
  const tunnel = section(container, SECTION.packTunnel, "u32");
  if (tunnel.length % 2 !== 0) corrupt("tunnel column holds half a span");
  const view: ShapePackView = {
    header: container.header,
    count,
    hash,
    ...table,
    number,
    vertexOffset: offsets(table.vertexCount, x.length, "vertex"),
    stopOffset: offsets(table.stopCount, stopArc.length, "stop"),
    tunnelOffset: offsets(table.tunnelCount, tunnel.length / 2, "tunnel"),
    x,
    y,
    z,
    m,
    stopArc,
    tunnel,
  };
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) checkShape(view, i, seen);
  return view;
}

/** Decodes and validates a shape pack; throws FrameDecodeError. */
export function decodeShapePack(input: ArrayBufferLike | ArrayBufferView): ShapePackView {
  return readPack(readContainer(input, "shapePack", KNOWN));
}

function prefixSum(values: Int32Array, from: number, to: number): Float64Array {
  const out = new Float64Array(to - from);
  let cm = 0;
  for (let v = from; v < to; v++) {
    cm = v === from ? (values[v] as number) : cm + (values[v] as number);
    out[v - from] = cm / 100;
  }
  return out;
}

function arcLength(values: Uint32Array, from: number, to: number): Float64Array {
  const out = new Float64Array(to - from);
  let cm = 0;
  for (let v = from + 1; v < to; v++) {
    cm += values[v] as number;
    out[v - from] = cm / 100;
  }
  return out;
}

function metres(values: Uint32Array, from: number, to: number): Float64Array {
  const out = new Float64Array(to - from);
  for (let i = from; i < to; i++) out[i - from] = (values[i] as number) / 100;
  return out;
}

export function shapePolyline(view: ShapePackView, shape: number): ShapePolyline {
  if (!(shape >= 0 && shape < view.count)) throw new RangeError(`no shape ${shape}`);
  const from = view.vertexOffset[shape] as number;
  const to = view.vertexOffset[shape + 1] as number;
  const polyline = {
    hash: bytesToHex(view.hash, shape * CONTENT_HASH_BYTES, CONTENT_HASH_BYTES),
    number: view.number ? (view.number[shape] as number) : null,
    x: prefixSum(view.x, from, to),
    y: prefixSum(view.y, from, to),
    s: arcLength(view.m, from, to),
    length: (view.length[shape] as number) / 100,
    stops: metres(
      view.stopArc,
      view.stopOffset[shape] as number,
      view.stopOffset[shape + 1] as number,
    ),
    tunnels: metres(
      view.tunnel,
      2 * (view.tunnelOffset[shape] as number),
      2 * (view.tunnelOffset[shape + 1] as number),
    ),
  };
  const z = view.z;
  return (view.flags[shape] as number) & PACK_FLAG.elevation && z
    ? { ...polyline, z: z.subarray(from, to) }
    : polyline;
}

export function shapePackToObject(view: ShapePackView): ShapePack {
  const shapes = Array.from({ length: view.count }, (_, i): ShapeRecord => {
    const polyline = shapePolyline(view, i);
    const tunnels: [number, number][] = [];
    for (let k = 0; k < polyline.tunnels.length; k += 2) {
      tunnels.push([polyline.tunnels[k] as number, polyline.tunnels[k + 1] as number]);
    }
    return {
      hash: polyline.hash,
      number: polyline.number,
      x: Array.from(polyline.x),
      y: Array.from(polyline.y),
      z: polyline.z ? Array.from(polyline.z) : null,
      m: Array.from(polyline.s),
      length: polyline.length,
      stops: Array.from(polyline.stops),
      tunnels,
    };
  });
  const { timetableVersion, shapeEpoch } = view.header;
  return { kind: "shapePack", timetableVersion, shapeEpoch, shapes };
}
