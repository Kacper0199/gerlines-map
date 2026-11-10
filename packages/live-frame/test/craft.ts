import { HEADER } from "../src/constants.ts";
import { type SectionInput, writeContainer } from "../src/container.ts";
import { crc32 } from "../src/crc32.ts";
import { peekHeader } from "../src/index.ts";

/** The sections of an encoded object as copies, keyed by id. */
export function sectionsOf(bytes: Uint8Array): Map<number, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint16(HEADER.headerLength, true);
  const count = view.getUint16(HEADER.sectionCount, true);
  const sections = new Map<number, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const entry = headerLength + i * 12;
    const offset = view.getUint32(entry + 4, true);
    const length = view.getUint32(entry + 8, true);
    sections.set(view.getUint16(entry, true), bytes.slice(offset, offset + length));
  }
  return sections;
}

export function sectionOffset(bytes: Uint8Array, id: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint16(HEADER.headerLength, true);
  const count = view.getUint16(HEADER.sectionCount, true);
  for (let i = 0; i < count; i++) {
    const entry = headerLength + i * 12;
    if (view.getUint16(entry, true) === id) return view.getUint32(entry + 4, true);
  }
  throw new RangeError(`no section 0x${id.toString(16)}`);
}

/** Re-encodes an object with some sections replaced (or removed with null). */
export function rebuilt(
  bytes: Uint8Array,
  changes: Record<number, ArrayBufferView | null>,
  meta: Partial<{ sequence: number; baseSequence: number; shapeEpoch: number }> = {},
): Uint8Array {
  const header = peekHeader(bytes);
  const sections = sectionsOf(bytes);
  for (const [id, data] of Object.entries(changes)) {
    if (data === null) sections.delete(Number(id));
    else sections.set(Number(id), new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  const inputs: SectionInput[] = [...sections].map(([id, data]) => ({ id, data }));
  return writeContainer(header.kind, { ...header, ...meta }, inputs);
}

/** A copy with fresh CRC-32 after `edit`, so only structural checks can reject it. */
export function resealed(bytes: Uint8Array, edit: (copy: Uint8Array) => void): Uint8Array {
  const copy = bytes.slice();
  edit(copy);
  const view = new DataView(copy.buffer);
  view.setUint32(HEADER.crc32, 0, true);
  view.setUint32(HEADER.crc32, crc32(copy), true);
  return copy;
}

export function u32(...values: number[]): Uint32Array {
  return Uint32Array.from(values);
}

export function u16(...values: number[]): Uint16Array {
  return Uint16Array.from(values);
}

/**
 * The same object with every section moved to an odd offset (a valid layout that encoders do not
 * write), so a decoder must copy its columns instead of viewing them in place.
 */
export function unaligned(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint16(HEADER.headerLength, true);
  const sections = [...sectionsOf(bytes)];
  let offset = headerLength + sections.length * 12 + 1;
  const placed = sections.map(([id, data]) => {
    const start = offset;
    offset = start + data.length + ((start + data.length) % 2 === 0 ? 1 : 0);
    return { id, data, start };
  });
  const last = placed.at(-1);
  const totalLength = last ? last.start + last.data.length : headerLength;
  const out = new Uint8Array(totalLength);
  out.set(bytes.subarray(0, headerLength));
  const target = new DataView(out.buffer);
  target.setUint32(HEADER.totalLength, totalLength, true);
  placed.forEach(({ id, data, start }, i) => {
    const entry = headerLength + i * 12;
    target.setUint16(entry, id, true);
    target.setUint32(entry + 4, start, true);
    target.setUint32(entry + 8, data.length, true);
    out.set(data, start);
  });
  return resealed(out, () => undefined);
}

/** The same object as a later minor version with extra sections. */
export function extended(
  bytes: Uint8Array,
  extra: readonly SectionInput[],
  layout: { versionMinor: number; headerLength?: number },
): Uint8Array {
  const header = peekHeader(bytes);
  const sections: SectionInput[] = [...sectionsOf(bytes)].map(([id, data]) => ({ id, data }));
  return writeContainer(header.kind, header, [...sections, ...extra], layout);
}
