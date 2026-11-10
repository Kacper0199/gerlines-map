import {
  BASE_MINOR,
  DIRECTORY_ENTRY_LENGTH,
  type FrameKind,
  HEADER,
  HEADER_LENGTH,
  KIND_CODES,
  MAGIC,
  MAX_U32,
  SECTION_ALIGNMENT,
  SECTION_CRITICAL,
  VERSION_MAJOR,
} from "./constants.ts";
import { crc32Update } from "./crc32.ts";
import { corrupt, FrameDecodeError } from "./errors.ts";

export interface FrameHeader {
  readonly kind: FrameKind;
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly headerLength: number;
  readonly totalLength: number;
  readonly sequence: number;
  readonly baseSequence: number;
  readonly timetableVersion: number;
  readonly timeBase: number;
  readonly shapeEpoch: number;
}

export interface ContainerMeta {
  readonly sequence: number;
  readonly baseSequence: number;
  readonly timetableVersion: number;
  readonly timeBase: number;
  readonly shapeEpoch: number;
}

export interface SectionInput {
  readonly id: number;
  readonly data: ArrayBufferView;
  readonly critical?: boolean;
}

/** Layout overrides for compatibility tests and newer minors; 1.0 content uses the defaults. */
export interface ContainerLayout {
  readonly versionMajor?: number;
  readonly versionMinor?: number;
  readonly headerLength?: number;
}

interface SectionRange {
  readonly offset: number;
  readonly length: number;
}

export interface Container {
  readonly header: FrameHeader;
  readonly bytes: Uint8Array;
  readonly sections: ReadonlyMap<number, SectionRange>;
}

const KIND_BY_CODE = new Map<number, FrameKind>(
  Object.entries(KIND_CODES).map(([kind, code]) => [code, kind as FrameKind]),
);

export const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function align(value: number): number {
  return Math.ceil(value / SECTION_ALIGNMENT) * SECTION_ALIGNMENT;
}

function requireU32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new RangeError(`${name} must be an integer from 0 to ${MAX_U32}, got ${value}`);
  }
  return value;
}

function checksum(bytes: Uint8Array, totalLength: number): number {
  const zero = new Uint8Array(4);
  let crc = crc32Update(0, bytes, 0, HEADER.crc32);
  crc = crc32Update(crc, zero, 0, 4);
  return crc32Update(crc, bytes, HEADER.crc32 + 4, totalLength);
}

/** Writes header, directory and sections (8-byte aligned, ascending id) into one buffer. */
export function writeContainer(
  kind: FrameKind,
  meta: ContainerMeta,
  sections: readonly SectionInput[],
  layout: ContainerLayout = {},
): Uint8Array<ArrayBuffer> {
  if (!HOST_LITTLE_ENDIAN) throw new Error("the encoder needs a little-endian host");
  const headerLength = layout.headerLength ?? HEADER_LENGTH;
  const ordered = [...sections].sort((a, b) => a.id - b.id);
  let offset = align(headerLength + ordered.length * DIRECTORY_ENTRY_LENGTH);
  const placed = ordered.map((section) => {
    const start = offset;
    offset = align(start + section.data.byteLength);
    return { section, start };
  });
  const totalLength = placed.length
    ? (placed.at(-1)?.start ?? 0) + (ordered.at(-1)?.data.byteLength ?? 0)
    : align(headerLength);
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(HEADER.magic, MAGIC, true);
  view.setUint8(HEADER.versionMajor, layout.versionMajor ?? VERSION_MAJOR);
  view.setUint8(HEADER.versionMinor, layout.versionMinor ?? BASE_MINOR);
  view.setUint8(HEADER.kind, KIND_CODES[kind]);
  view.setUint16(HEADER.headerLength, headerLength, true);
  view.setUint16(HEADER.sectionCount, ordered.length, true);
  view.setUint32(HEADER.totalLength, totalLength, true);
  view.setUint32(HEADER.sequence, requireU32(meta.sequence, "sequence"), true);
  view.setUint32(HEADER.baseSequence, requireU32(meta.baseSequence, "baseSequence"), true);
  view.setUint32(
    HEADER.timetableVersion,
    requireU32(meta.timetableVersion, "timetableVersion"),
    true,
  );
  view.setUint32(HEADER.timeBase, requireU32(meta.timeBase, "timeBase"), true);
  view.setUint32(HEADER.shapeEpoch, requireU32(meta.shapeEpoch, "shapeEpoch"), true);
  placed.forEach(({ section, start }, index) => {
    const entry = headerLength + index * DIRECTORY_ENTRY_LENGTH;
    view.setUint16(entry, section.id, true);
    view.setUint16(entry + 2, section.critical ? SECTION_CRITICAL : 0, true);
    view.setUint32(entry + 4, start, true);
    view.setUint32(entry + 8, section.data.byteLength, true);
    bytes.set(
      new Uint8Array(section.data.buffer, section.data.byteOffset, section.data.byteLength),
      start,
    );
  });
  view.setUint32(HEADER.crc32, checksum(bytes, totalLength), true);
  return bytes;
}

export function toBytes(input: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}

function readHeader(bytes: Uint8Array, view: DataView): FrameHeader {
  if (bytes.length < 4) throw new FrameDecodeError("truncated", `${bytes.length} bytes`);
  if (view.getUint32(HEADER.magic, true) !== MAGIC) {
    throw new FrameDecodeError("bad_magic", "not a GerLines live frame");
  }
  if (bytes.length < HEADER_LENGTH) {
    throw new FrameDecodeError("truncated", `${bytes.length} bytes, header needs ${HEADER_LENGTH}`);
  }
  const totalLength = view.getUint32(HEADER.totalLength, true);
  if (bytes.length < totalLength) {
    throw new FrameDecodeError("truncated", `${bytes.length} of ${totalLength} bytes`);
  }
  if (bytes.length > totalLength) corrupt(`${bytes.length} bytes, header says ${totalLength}`);
  if (view.getUint32(HEADER.crc32, true) !== checksum(bytes, totalLength)) {
    throw new FrameDecodeError("checksum", "CRC-32 differs");
  }
  const versionMajor = view.getUint8(HEADER.versionMajor);
  if (versionMajor !== VERSION_MAJOR) {
    throw new FrameDecodeError("unsupported_version", `major version ${versionMajor}`);
  }
  const headerLength = view.getUint16(HEADER.headerLength, true);
  if (headerLength < HEADER_LENGTH || headerLength % SECTION_ALIGNMENT !== 0) {
    corrupt(`header length ${headerLength}`);
  }
  const kind = KIND_BY_CODE.get(view.getUint8(HEADER.kind));
  if (!kind) throw new FrameDecodeError("wrong_kind", `kind ${view.getUint8(HEADER.kind)}`);
  return {
    kind,
    versionMajor,
    versionMinor: view.getUint8(HEADER.versionMinor),
    headerLength,
    totalLength,
    sequence: view.getUint32(HEADER.sequence, true),
    baseSequence: view.getUint32(HEADER.baseSequence, true),
    timetableVersion: view.getUint32(HEADER.timetableVersion, true),
    timeBase: view.getUint32(HEADER.timeBase, true),
    shapeEpoch: view.getUint32(HEADER.shapeEpoch, true),
  };
}

function readDirectory(
  view: DataView,
  header: FrameHeader,
  sectionCount: number,
  known: ReadonlySet<number>,
): Map<number, SectionRange> {
  const directoryEnd = header.headerLength + sectionCount * DIRECTORY_ENTRY_LENGTH;
  if (directoryEnd > header.totalLength) corrupt(`directory of ${sectionCount} entries overflows`);
  const sections = new Map<number, SectionRange>();
  const ranges: SectionRange[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const entry = header.headerLength + index * DIRECTORY_ENTRY_LENGTH;
    const id = view.getUint16(entry, true);
    const flags = view.getUint16(entry + 2, true);
    const offset = view.getUint32(entry + 4, true);
    const length = view.getUint32(entry + 8, true);
    if (offset < directoryEnd || offset + length > header.totalLength) {
      corrupt(`section 0x${id.toString(16)} outside the object`);
    }
    if (sections.has(id)) corrupt(`section 0x${id.toString(16)} repeated`);
    const range = { offset, length };
    ranges.push(range);
    sections.set(id, range);
    if (!known.has(id) && flags & SECTION_CRITICAL) {
      throw new FrameDecodeError("unsupported_version", `critical section 0x${id.toString(16)}`);
    }
  }
  ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) {
    const before = ranges[i - 1] as SectionRange;
    if (before.offset + before.length > (ranges[i] as SectionRange).offset) {
      corrupt("sections overlap");
    }
  }
  return sections;
}

/**
 * Parses and checks the container (FORMAT.md section 2): magic, version, length, CRC-32, kind and
 * directory. `known` lists the section ids the caller reads; unknown critical sections are rejected.
 */
export function readContainer(
  input: ArrayBufferLike | ArrayBufferView,
  expected: FrameKind,
  known: ReadonlySet<number>,
): Container {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readHeader(bytes, view);
  if (header.kind !== expected) {
    throw new FrameDecodeError("wrong_kind", `expected ${expected}, got ${header.kind}`);
  }
  const sectionCount = view.getUint16(HEADER.sectionCount, true);
  return { header, bytes, sections: readDirectory(view, header, sectionCount, known) };
}

/** Reads the header of any kind after checking length and CRC-32. */
export function peekHeader(input: ArrayBufferLike | ArrayBufferView): FrameHeader {
  const bytes = toBytes(input);
  return readHeader(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

type ElementType = "u8" | "u16" | "i16" | "u32" | "i32" | "f32";

interface ElementTypes {
  u8: Uint8Array;
  u16: Uint16Array;
  i16: Int16Array;
  u32: Uint32Array;
  i32: Int32Array;
  f32: Float32Array;
}

const ELEMENT = {
  u8: { ctor: Uint8Array, get: (v: DataView, o: number) => v.getUint8(o) },
  u16: { ctor: Uint16Array, get: (v: DataView, o: number) => v.getUint16(o, true) },
  i16: { ctor: Int16Array, get: (v: DataView, o: number) => v.getInt16(o, true) },
  u32: { ctor: Uint32Array, get: (v: DataView, o: number) => v.getUint32(o, true) },
  i32: { ctor: Int32Array, get: (v: DataView, o: number) => v.getInt32(o, true) },
  f32: { ctor: Float32Array, get: (v: DataView, o: number) => v.getFloat32(o, true) },
} as const;

/**
 * A typed view of bytes[offset, offset + length): zero-copy when the host is little-endian and the
 * address is aligned to the element size, else a copy read element by element.
 */
export function readColumn<T extends ElementType>(
  bytes: Uint8Array,
  offset: number,
  length: number,
  type: T,
  hostLittleEndian = HOST_LITTLE_ENDIAN,
): ElementTypes[T] {
  const { ctor, get } = ELEMENT[type];
  const size = ctor.BYTES_PER_ELEMENT;
  if (length % size !== 0) corrupt(`section length ${length} is not a multiple of ${size}`);
  const count = length / size;
  const address = bytes.byteOffset + offset;
  if (hostLittleEndian && address % size === 0) {
    return new ctor(bytes.buffer as ArrayBuffer, address, count) as ElementTypes[T];
  }
  const out = new ctor(count);
  const view = new DataView(bytes.buffer, address, length);
  for (let i = 0; i < count; i++) out[i] = get(view, i * size);
  return out as ElementTypes[T];
}

export function section<T extends ElementType>(
  container: Container,
  id: number,
  type: T,
): ElementTypes[T] {
  const range = container.sections.get(id);
  if (!range) corrupt(`required section 0x${id.toString(16)} missing`);
  return readColumn(container.bytes, range.offset, range.length, type);
}

export function optionalSection<T extends ElementType>(
  container: Container,
  id: number,
  type: T,
): ElementTypes[T] | undefined {
  return container.sections.has(id) ? section(container, id, type) : undefined;
}
