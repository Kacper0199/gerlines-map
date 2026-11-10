import { predictedStepCm, readVarints, VarintReader, writeVarints } from "./compact.ts";
import {
  COMPACT_MINOR,
  CONTENT_HASH_BYTES,
  MAX_U32,
  MERCATOR_LIMIT_CM,
  PACK_FLAG,
  SECTION,
  STUB_MINOR,
} from "./constants.ts";
import {
  type Container,
  type FrameHeader,
  optionalSection,
  readContainer,
  type SectionInput,
  section,
  writeContainer,
} from "./container.ts";
import { bytesToHex, centimetres, hexToBytes, requireInteger } from "./encode-util.ts";
import { corrupt } from "./errors.ts";
import type { ShapePack, ShapeRecord, StubRecord } from "./model.ts";

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
  SECTION.stubCount,
  SECTION.stubX,
  SECTION.stubY,
  SECTION.stubDistance,
  SECTION.compactX,
  SECTION.compactY,
  SECTION.compactZ,
  SECTION.compactM,
  SECTION.packAbsent,
]);

const COMPACT_IDS = [SECTION.compactX, SECTION.compactY, SECTION.compactM] as const;
const PLAIN_IDS = [SECTION.vertexX, SECTION.vertexY, SECTION.vertexM] as const;

const STUB_SIDES = ["before", "after"] as const;

/**
 * A decoded shape pack as typed columns (FORMAT.md section 5) with per-shape row offsets. Columns
 * may be views of the input buffer: treat them as read-only.
 */
export interface ShapePackView {
  readonly header: FrameHeader;
  readonly count: number;
  /** Whether the vertex columns came in the compact coding of 1.4 (FORMAT.md 5.4). */
  readonly compact: boolean;
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
  /** Track stubs (1.2): count × 2 vertex counts (before, after), absent in packs without stubs. */
  readonly stubCount: Uint32Array | undefined;
  /** count × 2 + 1 entries: the first stub vertex of each (shape, side) in the stub columns. */
  readonly stubOffset: Float64Array | undefined;
  /** Centimetre differences as stored, the first of each stub from the shape's end vertex. */
  readonly stubX: Int32Array | undefined;
  readonly stubY: Int32Array | undefined;
  /** Ground distance differences in centimetres, the first from the shape's end vertex. */
  readonly stubDistance: Uint32Array | undefined;
  /** Shape numbers without a pack (1.4, section 0x88), ascending; absent outside pack sets. */
  readonly absent: Uint32Array | undefined;
}

/**
 * A track stub from a shape's end vertex outward in metres: Web Mercator x and y, `d` the ground
 * distance from the end vertex (0 at index 0, the end vertex itself), on the pipeline's M scale.
 */
export interface StubPolyline {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly d: Float64Array;
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
  /** Track before the first vertex (a point at M < 0 lies at d = -M), when the pack has one. */
  readonly stubBefore?: StubPolyline;
  /** Track after the last vertex (a point at M > length lies at d = M - length). */
  readonly stubAfter?: StubPolyline;
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

interface StubBuffers {
  count: number[];
  x: number[];
  y: number[];
  d: number[];
}

function endCentimetres(values: readonly number[], at: number): number {
  return Math.round((values.at(at) as number) * 100);
}

function writeStub(
  stub: StubRecord | null | undefined,
  start: readonly [number, number],
  name: string,
  out: StubBuffers,
): void {
  if (!stub) {
    out.count.push(0);
    return;
  }
  const n = stub.x.length;
  if (n === 0 || stub.y.length !== n || stub.d.length !== n) {
    throw new RangeError(`${name} needs at least one vertex and as many y and d as x`);
  }
  let [px, py] = start;
  let previous = 0;
  for (let i = 0; i < n; i++) {
    const coordinate = (value: number, axis: string) => {
      if (!Number.isFinite(value)) throw new RangeError(`${name} ${axis}[${i}] is not finite`);
      return requireInteger(
        Math.round(value * 100),
        -MERCATOR_LIMIT_CM,
        MERCATOR_LIMIT_CM,
        `${name} ${axis}[${i}] in centimetres`,
      );
    };
    const cx = coordinate(stub.x[i] as number, "x");
    const cy = coordinate(stub.y[i] as number, "y");
    out.x.push(requireInteger(cx - px, MIN_I32, MAX_I32, `${name} x step`));
    out.y.push(requireInteger(cy - py, MIN_I32, MAX_I32, `${name} y step`));
    [px, py] = [cx, cy];
    const d = centimetres(stub.d[i] as number, `${name} distance ${i}`);
    if (d < previous) throw new RangeError(`${name} distance decreases at ${i}`);
    out.d.push(d - previous);
    previous = d;
  }
  if (previous === 0) throw new RangeError(`${name} distance ends at 0`);
  out.count.push(n);
}

/** The stub columns of FORMAT.md 5.3, or none when no shape has a stub (the pack stays 1.0). */
function stubSections(shapes: readonly ShapeRecord[]): SectionInput[] {
  if (!shapes.some((shape) => shape.stubs?.before || shape.stubs?.after)) return [];
  const out: StubBuffers = { count: [], x: [], y: [], d: [] };
  shapes.forEach((shape, i) => {
    const ends = {
      before: [endCentimetres(shape.x, 0), endCentimetres(shape.y, 0)] as const,
      after: [endCentimetres(shape.x, -1), endCentimetres(shape.y, -1)] as const,
    };
    for (const side of STUB_SIDES) {
      writeStub(shape.stubs?.[side], ends[side], `shape ${i} stub ${side}`, out);
    }
  });
  return [
    { id: SECTION.stubCount, data: Uint32Array.from(out.count) },
    { id: SECTION.stubX, data: Int32Array.from(out.x) },
    { id: SECTION.stubY, data: Int32Array.from(out.y) },
    { id: SECTION.stubDistance, data: Uint32Array.from(out.d) },
  ];
}

/** M steps as residuals against the predicted step from the absolute coordinates (5.4). */
function arcResiduals(out: PackBuffers, counts: Uint32Array): number[] {
  const residuals = new Array<number>(out.m.length);
  let v = 0;
  for (const n of counts) {
    let x = 0;
    let y = 0;
    for (let j = 0; j < n; j++, v++) {
      if (j === 0) {
        x = out.x[v] as number;
        y = out.y[v] as number;
        residuals[v] = out.m[v] as number;
        continue;
      }
      const nx = x + (out.x[v] as number);
      const ny = y + (out.y[v] as number);
      residuals[v] = (out.m[v] as number) - predictedStepCm(x, y, nx, ny);
      x = nx;
      y = ny;
    }
  }
  return residuals;
}

/** Elevation as whole centimetre differences, or null when a value is not a whole centimetre. */
function elevationSteps(z: Float32Array, counts: Uint32Array): number[] | null {
  const steps = new Array<number>(z.length);
  let v = 0;
  for (const n of counts) {
    let previous = 0;
    for (let j = 0; j < n; j++, v++) {
      const value = z[v] as number;
      const cm = Math.round(value * 100);
      if (Math.fround(cm / 100) !== value) return null;
      steps[v] = j === 0 ? cm : cm - previous;
      previous = cm;
    }
  }
  return steps;
}

function compactSections(out: PackBuffers, counts: Uint32Array, elevation: boolean) {
  const sections: SectionInput[] = [
    { id: SECTION.compactX, data: writeVarints(out.x), critical: true },
    { id: SECTION.compactY, data: writeVarints(out.y), critical: true },
    { id: SECTION.compactM, data: writeVarints(arcResiduals(out, counts)), critical: true },
  ];
  if (!elevation) return sections;
  const steps = elevationSteps(out.z, counts);
  sections.push(
    steps
      ? { id: SECTION.compactZ, data: writeVarints(steps), critical: true }
      : { id: SECTION.vertexZ, data: out.z },
  );
  return sections;
}

function packSections(
  shapes: readonly ShapeRecord[],
  shapeEpoch: number,
  compact: boolean,
): SectionInput[] {
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
  const elevation = shapes.some((shape) => shape.z !== null);
  const sections: SectionInput[] = [
    { id: SECTION.packHash, data: hash },
    { id: SECTION.packVertexCount, data: counts.vertex },
    { id: SECTION.packStopCount, data: counts.stop },
    { id: SECTION.packTunnelCount, data: counts.tunnel },
    { id: SECTION.packLength, data: length },
    { id: SECTION.packFlags, data: flags },
    { id: SECTION.packStopArc, data: Uint32Array.from(out.stopArc) },
    { id: SECTION.packTunnel, data: Uint32Array.from(out.tunnel) },
  ];
  if (compact) sections.push(...compactSections(out, counts.vertex, elevation));
  else {
    sections.push(
      { id: SECTION.vertexX, data: out.x },
      { id: SECTION.vertexY, data: out.y },
      { id: SECTION.vertexM, data: out.m },
    );
    if (elevation) sections.push({ id: SECTION.vertexZ, data: out.z });
  }
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
  sections.push(...stubSections(shapes));
  return sections;
}

/**
 * Section 0x88: ascending unique shape numbers, none of them in the pack, with an epoch; written
 * also when empty, so a newer set can tell a client that shapes it named before now have packs.
 */
function absentSection(pack: ShapePack): SectionInput[] {
  const absent = pack.absent;
  if (absent === undefined) return [];
  if (pack.shapeEpoch === 0) throw new RangeError("absent shape numbers need a shape epoch");
  const held = new Set(pack.shapes.map((shape) => shape.number));
  absent.forEach((number, i) => {
    requireInteger(number, 0, MAX_U32, `absent ${i}`);
    if (i > 0 && number <= (absent[i - 1] as number)) throw new RangeError("absent not ascending");
    if (held.has(number)) throw new RangeError(`absent shape ${number} is in the pack`);
  });
  return [{ id: SECTION.packAbsent, data: Uint32Array.from(absent) }];
}

/**
 * Writes a shape pack: the 1.0 vertex columns (1.2 with stubs) by default, byte for byte as before
 * 1.4, or with `coding: "compact"` the compact columns of 1.4, which decode to the same values.
 */
export function encodeShapePack(pack: ShapePack): Uint8Array<ArrayBuffer> {
  const compact = pack.coding === "compact";
  const sections = packSections(
    pack.shapes,
    requireInteger(pack.shapeEpoch, 0, MAX_U32, "shapeEpoch"),
    compact,
  );
  const absent = absentSection(pack);
  sections.push(...absent);
  const stubs = sections.some((input) => input.id === SECTION.stubCount);
  const minor = compact || absent.length > 0 ? COMPACT_MINOR : stubs ? STUB_MINOR : undefined;
  return writeContainer(
    "shapePack",
    {
      sequence: 0,
      baseSequence: 0,
      timetableVersion: pack.timetableVersion,
      timeBase: 0,
      shapeEpoch: pack.shapeEpoch,
    },
    sections,
    minor === undefined ? {} : { versionMinor: minor },
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

function stubEnd(view: ShapePackView, shape: number, last: boolean): [number, number] {
  const from = view.vertexOffset[shape] as number;
  const to = view.vertexOffset[shape + 1] as number;
  let x = 0;
  let y = 0;
  for (let v = from; v < (last ? to : from + 1); v++) {
    x = v === from ? (view.x[v] as number) : x + (view.x[v] as number);
    y = v === from ? (view.y[v] as number) : y + (view.y[v] as number);
  }
  return [x, y];
}

function checkStubs(view: ShapePackView): void {
  const { stubCount, stubOffset, stubX, stubY, stubDistance } = view;
  if (!stubCount || !stubOffset || !stubX || !stubY || !stubDistance) return;
  for (let k = 0; k < view.count * 2; k++) {
    const from = stubOffset[k] as number;
    const to = stubOffset[k + 1] as number;
    if (from === to) continue;
    const shape = k >> 1;
    const name = `shape ${shape} stub ${STUB_SIDES[k & 1]}`;
    let [x, y] = stubEnd(view, shape, (k & 1) === 1);
    let d = 0;
    for (let v = from; v < to; v++) {
      x += stubX[v] as number;
      y += stubY[v] as number;
      if (Math.abs(x) > MERCATOR_LIMIT_CM || Math.abs(y) > MERCATOR_LIMIT_CM) {
        corrupt(`${name} leaves the Web Mercator square`);
      }
      d += stubDistance[v] as number;
    }
    if (d === 0) corrupt(`${name} has no length`);
  }
}

function readStubs(container: Container, count: number) {
  const ids = [SECTION.stubCount, SECTION.stubX, SECTION.stubY, SECTION.stubDistance];
  const present = ids.filter((id) => container.sections.has(id)).length;
  if (present === 0) return {};
  if (present < ids.length) corrupt("stub columns are incomplete");
  const stubCount = section(container, SECTION.stubCount, "u32");
  const stubX = section(container, SECTION.stubX, "i32");
  const stubY = section(container, SECTION.stubY, "i32");
  const stubDistance = section(container, SECTION.stubDistance, "u32");
  if (stubCount.length !== count * 2) corrupt("stub count column is not two per shape");
  if (stubY.length !== stubX.length || stubDistance.length !== stubX.length) {
    corrupt("stub columns differ");
  }
  return {
    stubCount,
    stubOffset: offsets(stubCount, stubX.length, "stub"),
    stubX,
    stubY,
    stubDistance,
  };
}

interface VertexColumns {
  readonly compact: boolean;
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly z: Float32Array | undefined;
  readonly m: Uint32Array;
}

function rawSection(container: Container, id: number): Uint8Array {
  const range = container.sections.get(id);
  if (!range) corrupt(`required section 0x${id.toString(16)} missing`);
  return container.bytes.subarray(range.offset, range.offset + range.length);
}

function signed32(values: Float64Array, name: string): Int32Array {
  const out = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as number;
    if (value < MIN_I32 || value > MAX_I32) corrupt(`${name} value ${i} does not fit i32`);
    out[i] = value;
  }
  return out;
}

function compactArcs(residual: Float64Array, x: Int32Array, y: Int32Array, counts: Uint32Array) {
  const m = new Uint32Array(residual.length);
  let v = 0;
  for (const n of counts) {
    let cx = 0;
    let cy = 0;
    for (let j = 0; j < n; j++, v++) {
      let value = residual[v] as number;
      if (j === 0) {
        cx = x[v] as number;
        cy = y[v] as number;
      } else {
        const nx = cx + (x[v] as number);
        const ny = cy + (y[v] as number);
        value += predictedStepCm(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
      }
      if (!(value >= 0 && value <= MAX_U32)) corrupt(`m step ${v} out of range`);
      m[v] = value;
    }
  }
  return m;
}

function compactElevation(container: Container, total: number, counts: Uint32Array) {
  const steps = readVarints(rawSection(container, SECTION.compactZ), total, "z");
  const z = new Float32Array(total);
  let v = 0;
  for (const n of counts) {
    let cm = 0;
    for (let j = 0; j < n; j++, v++) {
      cm = j === 0 ? (steps[v] as number) : cm + (steps[v] as number);
      z[v] = cm / 100;
    }
  }
  return z;
}

/** The vertex columns in either coding, as the 1.0 columns would hold them. */
function readVertices(container: Container, counts: Uint32Array): VertexColumns {
  const has = (id: number) => container.sections.has(id);
  const compact = COMPACT_IDS.filter(has).length;
  if (compact === 0) {
    const x = section(container, SECTION.vertexX, "i32");
    const y = section(container, SECTION.vertexY, "i32");
    const m = section(container, SECTION.vertexM, "u32");
    if (has(SECTION.compactZ)) corrupt("compact z without compact vertex columns");
    return { compact: false, x, y, m, z: optionalSection(container, SECTION.vertexZ, "f32") };
  }
  if (compact < COMPACT_IDS.length) corrupt("compact vertex columns are incomplete");
  if (PLAIN_IDS.some(has)) corrupt("both vertex codings present");
  if (has(SECTION.compactZ) && has(SECTION.vertexZ)) corrupt("both z codings present");
  let total = 0;
  for (const n of counts) total += n;
  if (total > rawSection(container, SECTION.compactX).length) corrupt("vertex counts too large");
  const x = signed32(readVarints(rawSection(container, SECTION.compactX), total, "x"), "x");
  const y = signed32(readVarints(rawSection(container, SECTION.compactY), total, "y"), "y");
  const residual = readVarints(rawSection(container, SECTION.compactM), total, "m");
  const z = has(SECTION.compactZ)
    ? compactElevation(container, total, counts)
    : optionalSection(container, SECTION.vertexZ, "f32");
  return { compact: true, x, y, z, m: compactArcs(residual, x, y, counts) };
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
  const { compact, x, y, z, m } = readVertices(container, table.vertexCount);
  if (y.length !== x.length || m.length !== x.length || (z && z.length !== x.length)) {
    corrupt("vertex columns differ");
  }
  if (z?.some((value) => !Number.isFinite(value))) corrupt("z holds a value that is not finite");
  const stopArc = section(container, SECTION.packStopArc, "u32");
  const tunnel = section(container, SECTION.packTunnel, "u32");
  if (tunnel.length % 2 !== 0) corrupt("tunnel column holds half a span");
  const stubs = readStubs(container, count);
  const absent = readAbsent(container, number);
  const view: ShapePackView = {
    header: container.header,
    count,
    compact,
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
    stubCount: undefined,
    stubOffset: undefined,
    stubX: undefined,
    stubY: undefined,
    stubDistance: undefined,
    ...stubs,
    absent,
  };
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) checkShape(view, i, seen);
  checkStubs(view);
  return view;
}

function readAbsent(container: Container, number: Uint32Array | undefined) {
  const absent = optionalSection(container, SECTION.packAbsent, "u32");
  if (!absent) return undefined;
  if (!number) corrupt("absent shape numbers without a shape epoch");
  const held = new Set(number);
  for (let i = 0; i < absent.length; i++) {
    const value = absent[i] as number;
    if (i > 0 && value <= (absent[i - 1] as number)) corrupt("absent shape numbers not ascending");
    if (held.has(value)) corrupt(`absent shape ${value} is in the pack`);
  }
  return absent;
}

/** Decodes and validates a shape pack; throws FrameDecodeError. */
export function decodeShapePack(input: ArrayBufferLike | ArrayBufferView): ShapePackView {
  return readPack(readContainer(input, "shapePack", KNOWN));
}

/**
 * A shape pack read one shape at a time, so a large pack set part can be decoded between frames:
 * `open` checks the container and the shape table, `read` decodes and checks the next shape with
 * the rules of `decodeShapePack` and returns its polyline, `skip` passes over it, and `finish`
 * checks that the vertex columns hold nothing more. Throws FrameDecodeError.
 */
export interface ShapePackCursor {
  readonly header: FrameHeader;
  readonly count: number;
  readonly number: Uint32Array | undefined;
  readonly vertexCount: Uint32Array;
  readonly absent: Uint32Array | undefined;
  /** The index of the shape `read` or `skip` handles next. */
  readonly next: number;
  read(): ShapePolyline;
  skip(): void;
  finish(): void;
}

interface CompactColumns {
  readonly x: VarintReader;
  readonly y: VarintReader;
  readonly m: VarintReader;
  readonly z: VarintReader | undefined;
  readonly floatZ: Float32Array | undefined;
}

function compactColumns(container: Container, total: number): CompactColumns {
  const has = (id: number) => container.sections.has(id);
  if (COMPACT_IDS.filter(has).length < COMPACT_IDS.length) {
    corrupt("compact vertex columns are incomplete");
  }
  if (PLAIN_IDS.some(has)) corrupt("both vertex codings present");
  if (has(SECTION.compactZ) && has(SECTION.vertexZ)) corrupt("both z codings present");
  const raw = (id: number) => rawSection(container, id);
  if (total > raw(SECTION.compactX).length) corrupt("vertex counts too large");
  const floatZ = optionalSection(container, SECTION.vertexZ, "f32");
  if (floatZ && floatZ.length !== total) corrupt("vertex columns differ");
  return {
    x: new VarintReader(raw(SECTION.compactX), "x"),
    y: new VarintReader(raw(SECTION.compactY), "y"),
    m: new VarintReader(raw(SECTION.compactM), "m"),
    z: has(SECTION.compactZ) ? new VarintReader(raw(SECTION.compactZ), "z") : undefined,
    floatZ,
  };
}

/** One shape's elevation from the compact z steps or the float column, if the pack has either. */
function shapeElevation(columns: CompactColumns, n: number, from: number) {
  if (columns.floatZ) return columns.floatZ.slice(from, from + n);
  const reader = columns.z;
  if (!reader) return undefined;
  const z = new Float32Array(n);
  let cm = 0;
  for (let j = 0; j < n; j++) {
    cm = j === 0 ? reader.read() : cm + reader.read();
    z[j] = cm / 100;
  }
  return z;
}

/** One shape's vertex columns from the compact readers, as `readVertices` would hold them. */
function compactShape(columns: CompactColumns, n: number, from: number) {
  const x = new Int32Array(n);
  const y = new Int32Array(n);
  const m = new Uint32Array(n);
  let cx = 0;
  let cy = 0;
  for (let j = 0; j < n; j++) {
    const dx = columns.x.read();
    const dy = columns.y.read();
    if (dx < MIN_I32 || dx > MAX_I32 || dy < MIN_I32 || dy > MAX_I32) {
      corrupt(`vertex ${from + j} does not fit i32`);
    }
    x[j] = dx;
    y[j] = dy;
    let step = columns.m.read();
    if (j > 0) step += predictedStepCm(cx, cy, cx + dx, cy + dy);
    cx = j === 0 ? dx : cx + dx;
    cy = j === 0 ? dy : cy + dy;
    if (!(step >= 0 && step <= MAX_U32)) corrupt(`m step ${from + j} out of range`);
    m[j] = step;
  }
  const z = shapeElevation(columns, n, from);
  if (z?.some((value) => !Number.isFinite(value))) corrupt("z holds a value that is not finite");
  return { x, y, m, z };
}

function skipCompact(columns: CompactColumns, n: number): void {
  for (let j = 0; j < n; j++) {
    columns.x.read();
    columns.y.read();
    columns.m.read();
    columns.z?.read();
  }
}

/** A view of shape `i` alone, so the checks and `shapePolyline` of whole packs apply to it. */
function singleView(
  view: Omit<ShapePackView, "x" | "y" | "z" | "m">,
  i: number,
  vertices: { x: Int32Array; y: Int32Array; m: Uint32Array; z: Float32Array | undefined },
): ShapePackView {
  const one = <T extends Uint8Array | Uint32Array>(column: T, width = 1) =>
    column.subarray(i * width, (i + 1) * width) as T;
  const span = (offsets: Float64Array): [number, number] => [
    offsets[i] as number,
    offsets[i + 1] as number,
  ];
  const [stopFrom, stopTo] = span(view.stopOffset);
  const [tunnelFrom, tunnelTo] = span(view.tunnelOffset);
  const stubs =
    view.stubCount && view.stubOffset && view.stubX && view.stubY && view.stubDistance
      ? (() => {
          const from = view.stubOffset[2 * i] as number;
          const to = view.stubOffset[2 * i + 2] as number;
          const count = view.stubCount.subarray(2 * i, 2 * i + 2);
          return {
            stubCount: count,
            stubOffset: offsets(count, to - from, "stub"),
            stubX: view.stubX.subarray(from, to),
            stubY: view.stubY.subarray(from, to),
            stubDistance: view.stubDistance.subarray(from, to),
          };
        })()
      : {};
  return {
    ...view,
    count: 1,
    hash: one(view.hash, CONTENT_HASH_BYTES),
    vertexCount: one(view.vertexCount),
    stopCount: one(view.stopCount),
    tunnelCount: one(view.tunnelCount),
    length: one(view.length),
    flags: one(view.flags),
    number: view.number ? one(view.number) : undefined,
    vertexOffset: Float64Array.of(0, vertices.x.length),
    stopOffset: Float64Array.of(0, stopTo - stopFrom),
    tunnelOffset: Float64Array.of(0, tunnelTo - tunnelFrom),
    stopArc: view.stopArc.subarray(stopFrom, stopTo),
    tunnel: view.tunnel.subarray(2 * tunnelFrom, 2 * tunnelTo),
    ...vertices,
    ...stubs,
  };
}

function wholeCursor(view: ShapePackView): ShapePackCursor {
  let next = 0;
  return {
    header: view.header,
    count: view.count,
    number: view.number,
    vertexCount: view.vertexCount,
    absent: view.absent,
    get next() {
      return next;
    },
    read: () => shapePolyline(view, next++),
    skip: () => {
      next++;
    },
    finish: () => {},
  };
}

/** Opens a shape pack for reading shape by shape (compact packs) or as a whole (1.0 to 1.2). */
export function openShapePack(input: ArrayBufferLike | ArrayBufferView): ShapePackCursor {
  const container = readContainer(input, "shapePack", KNOWN);
  if (!COMPACT_IDS.some((id) => container.sections.has(id))) {
    return wholeCursor(readPack(container));
  }
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
  let total = 0;
  for (const n of table.vertexCount) total += n;
  const columns = compactColumns(container, total);
  const stopArc = section(container, SECTION.packStopArc, "u32");
  const tunnel = section(container, SECTION.packTunnel, "u32");
  if (tunnel.length % 2 !== 0) corrupt("tunnel column holds half a span");
  const view = {
    header: container.header,
    count,
    compact: true,
    hash,
    ...table,
    number,
    vertexOffset: offsets(table.vertexCount, total, "vertex"),
    stopOffset: offsets(table.stopCount, stopArc.length, "stop"),
    tunnelOffset: offsets(table.tunnelCount, tunnel.length / 2, "tunnel"),
    stopArc,
    tunnel,
    stubCount: undefined,
    stubOffset: undefined,
    stubX: undefined,
    stubY: undefined,
    stubDistance: undefined,
    ...readStubs(container, count),
    absent: readAbsent(container, number),
  };
  const seen = new Set<string>();
  let next = 0;
  const advance = () => {
    if (next >= count) throw new RangeError(`no shape ${next}`);
    return next++;
  };
  return {
    header: view.header,
    count,
    number,
    vertexCount: table.vertexCount,
    absent: view.absent,
    get next() {
      return next;
    },
    read: () => {
      const i = advance();
      const from = view.vertexOffset[i] as number;
      const one = singleView(view, i, compactShape(columns, table.vertexCount[i] as number, from));
      checkShape(one, 0, seen);
      checkStubs(one);
      return shapePolyline(one, 0);
    },
    skip: () => {
      const i = advance();
      const key = bytesToHex(hash, i * CONTENT_HASH_BYTES, CONTENT_HASH_BYTES);
      if (seen.has(key)) corrupt(`shape ${i} hash repeated`);
      seen.add(key);
      skipCompact(columns, table.vertexCount[i] as number);
    },
    finish: () => {
      if (next !== count) throw new RangeError(`${count - next} shapes not read`);
      columns.x.finish();
      columns.y.finish();
      columns.m.finish();
      columns.z?.finish();
    },
  };
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

function stubPolyline(
  view: ShapePackView,
  shape: number,
  polyline: { x: Float64Array; y: Float64Array },
  last: boolean,
): StubPolyline | undefined {
  const k = shape * 2 + (last ? 1 : 0);
  const { stubOffset, stubX, stubY, stubDistance } = view;
  if (!stubOffset || !stubX || !stubY || !stubDistance) return undefined;
  const from = stubOffset[k] as number;
  const to = stubOffset[k + 1] as number;
  if (from === to) return undefined;
  const n = to - from + 1;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const d = new Float64Array(n);
  let [cx, cy] = stubEnd(view, shape, last);
  let cd = 0;
  x[0] = (last ? polyline.x.at(-1) : polyline.x[0]) as number;
  y[0] = (last ? polyline.y.at(-1) : polyline.y[0]) as number;
  for (let v = from; v < to; v++) {
    cx += stubX[v] as number;
    cy += stubY[v] as number;
    cd += stubDistance[v] as number;
    x[v - from + 1] = cx / 100;
    y[v - from + 1] = cy / 100;
    d[v - from + 1] = cd / 100;
  }
  return { x, y, d };
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
  const stubBefore = stubPolyline(view, shape, polyline, false);
  const stubAfter = stubPolyline(view, shape, polyline, true);
  const withStubs = {
    ...polyline,
    ...(stubBefore ? { stubBefore } : {}),
    ...(stubAfter ? { stubAfter } : {}),
  };
  const z = view.z;
  return (view.flags[shape] as number) & PACK_FLAG.elevation && z
    ? { ...withStubs, z: z.subarray(from, to) }
    : withStubs;
}

function stubRecord(stub: StubPolyline | undefined): StubRecord | null {
  if (!stub) return null;
  return {
    x: Array.from(stub.x.subarray(1)),
    y: Array.from(stub.y.subarray(1)),
    d: Array.from(stub.d.subarray(1)),
  };
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
      ...(view.stubCount
        ? {
            stubs: {
              before: stubRecord(polyline.stubBefore),
              after: stubRecord(polyline.stubAfter),
            },
          }
        : {}),
    };
  });
  const { timetableVersion, shapeEpoch } = view.header;
  return {
    kind: "shapePack",
    timetableVersion,
    shapeEpoch,
    shapes,
    ...(view.compact ? { coding: "compact" as const } : {}),
    ...(view.absent ? { absent: Array.from(view.absent) } : {}),
  };
}
