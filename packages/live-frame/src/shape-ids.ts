import { MAX_U16, MAX_U32, SECTION, SHAPE_ID_BYTES } from "./constants.ts";
import { type Container, optionalSection, type SectionInput } from "./container.ts";
import { bytesToHex, hexToBytes, requireInteger } from "./encode-util.ts";
import { corrupt } from "./errors.ts";

/**
 * A shape reference in a frame: the first 8 bytes of the shape's content hash as 16 lowercase hex
 * digits, or the shape's stable number (FORMAT.md 3.4). One frame uses one of the two forms.
 */
export type ShapeId = string | number;

/** The shape table of a decoded frame: exactly one of the two columns is set. */
export interface ShapeTable {
  readonly count: number;
  /** count × 8 bytes of content-hash prefixes. */
  readonly hashPrefix: Uint8Array | undefined;
  readonly number: Uint32Array | undefined;
}

export function shapeKey(id: ShapeId): string {
  return typeof id === "number" ? `#${id}` : id;
}

/** Writes the shape table: shape numbers when the frame's shape epoch is at least 1, else hash prefixes. */
export class ShapeIdWriter {
  private readonly rows = new Map<string, number>();
  private readonly ids: ShapeId[] = [];
  private readonly shapeEpoch: number;
  private readonly numbered: boolean;

  constructor(shapeEpoch: number) {
    this.shapeEpoch = requireInteger(shapeEpoch, 0, MAX_U32, "shapeEpoch");
    this.numbered = shapeEpoch > 0;
  }

  row(id: ShapeId, name: string): number {
    const key = shapeKey(id);
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing;
    if ((typeof id === "number") !== this.numbered) {
      const form = this.numbered ? "shape numbers" : "hash prefixes";
      throw new RangeError(
        `${name}: a frame with shapeEpoch ${this.shapeEpoch} names shapes by ${form}`,
      );
    }
    if (typeof id === "number") requireInteger(id, 0, MAX_U32, name);
    else hexToBytes(id, SHAPE_ID_BYTES, name);
    if (this.ids.length > MAX_U16) throw new RangeError(`more than ${MAX_U16 + 1} shapes`);
    this.rows.set(key, this.ids.length);
    this.ids.push(id);
    return this.ids.length - 1;
  }

  sections(): SectionInput[] {
    if (this.numbered) {
      return [{ id: SECTION.shapeNumber, data: Uint32Array.from(this.ids as number[]) }];
    }
    const bytes = new Uint8Array(this.ids.length * SHAPE_ID_BYTES);
    this.ids.forEach((id, row) => {
      bytes.set(hexToBytes(id as string, SHAPE_ID_BYTES, "shape id"), row * SHAPE_ID_BYTES);
    });
    return [{ id: SECTION.shapeId, data: bytes }];
  }
}

function requireUnique(count: number, keyOf: (row: number) => string | number): void {
  const seen = new Set<string | number>();
  for (let row = 0; row < count; row++) {
    const key = keyOf(row);
    if (seen.has(key)) corrupt(`shape ${key} repeated`);
    seen.add(key);
  }
}

export function readShapeTable(container: Container): ShapeTable {
  const hashPrefix = optionalSection(container, SECTION.shapeId, "u8");
  const number = optionalSection(container, SECTION.shapeNumber, "u32");
  if ((hashPrefix === undefined) === (number === undefined)) {
    corrupt("a frame needs exactly one of the shape id sections 0x30 and 0x31");
  }
  if ((number !== undefined) !== container.header.shapeEpoch > 0) {
    corrupt(`shape epoch ${container.header.shapeEpoch} does not match the shape id section`);
  }
  if (number) {
    requireUnique(number.length, (row) => number[row] as number);
    return { count: number.length, hashPrefix, number };
  }
  const bytes = hashPrefix as Uint8Array;
  if (bytes.length % SHAPE_ID_BYTES !== 0) corrupt("shape id table length");
  const count = bytes.length / SHAPE_ID_BYTES;
  requireUnique(count, (row) => bytesToHex(bytes, row * SHAPE_ID_BYTES, SHAPE_ID_BYTES));
  return { count, hashPrefix, number };
}

export function shapeIdAt(table: ShapeTable, row: number): ShapeId {
  if (table.number) return table.number[row] as number;
  return bytesToHex(table.hashPrefix as Uint8Array, row * SHAPE_ID_BYTES, SHAPE_ID_BYTES);
}
