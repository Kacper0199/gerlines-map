export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

export class WireError extends Error {}

const TWO_POW_32 = 0x1_0000_0000;
const utf8 = new TextDecoder("utf-8", { fatal: false });

/** What one decode may allocate: nested messages in all, and the longest string. */
export interface WireBudget {
  messages: number;
  readonly maxMessages: number;
  readonly maxStringBytes: number;
}

const UNLIMITED: WireBudget = {
  messages: Number.POSITIVE_INFINITY,
  maxMessages: Number.POSITIVE_INFINITY,
  maxStringBytes: Number.POSITIVE_INFINITY,
};

/** Protocol buffer wire reader over one message; every read is bounds-checked. */
export class WireReader {
  readonly bytes: Uint8Array;
  readonly end: number;
  position: number;
  private readonly view: DataView;
  private readonly budget: WireBudget;

  constructor(bytes: Uint8Array, start = 0, end = bytes.length, budget: WireBudget = UNLIMITED) {
    this.bytes = bytes;
    this.end = end;
    this.position = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.budget = budget;
  }

  get done(): boolean {
    return this.position >= this.end;
  }

  private byte(): number {
    if (this.position >= this.end) throw new WireError("varint runs past the end of the message");
    const value = this.bytes[this.position] ?? 0;
    this.position += 1;
    return value;
  }

  /** Low and high 32 bits of a varint, both unsigned. */
  varint64(): { lo: number; hi: number } {
    let lo = 0;
    let hi = 0;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.byte();
      const bits = byte & 0x7f;
      if (index < 4) {
        lo += bits * 2 ** (7 * index);
      } else if (index === 4) {
        lo += (bits & 0x0f) * 2 ** 28;
        hi += bits >> 4;
      } else {
        hi += bits * 2 ** (7 * index - 32);
      }
      if (byte < 0x80) return { lo: lo >>> 0, hi: hi >>> 0 };
    }
    throw new WireError("varint longer than 10 bytes");
  }

  /** An unsigned varint as a number; exact up to 2^53. */
  uint(): number {
    const { lo, hi } = this.varint64();
    return hi * TWO_POW_32 + lo;
  }

  /** A signed int64 varint (two's complement) as a number; exact within ±2^53. */
  int64(): number {
    const { lo, hi } = this.varint64();
    if (hi & 0x8000_0000) return -((~hi >>> 0) * TWO_POW_32 + ((~lo >>> 0) + 1));
    return hi * TWO_POW_32 + lo;
  }

  /** A signed int32 varint: negative values arrive sign-extended to ten bytes. */
  int32(): number {
    return this.varint64().lo | 0;
  }

  bool(): boolean {
    return this.uint() !== 0;
  }

  float(): number {
    this.need(4);
    const value = this.view.getFloat32(this.position, true);
    this.position += 4;
    return value;
  }

  double(): number {
    this.need(8);
    const value = this.view.getFloat64(this.position, true);
    this.position += 8;
    return value;
  }

  tag(): { field: number; wireType: number } {
    const key = this.uint();
    return { field: Math.floor(key / 8), wireType: key % 8 };
  }

  /** The bytes of a length-delimited field, without counting it as a message. */
  private span(): { start: number; end: number } {
    const length = this.uint();
    const start = this.position;
    if (start + length > this.end) {
      throw new WireError("length-delimited field runs past the end of the message");
    }
    this.position = start + length;
    return { start, end: start + length };
  }

  /** A nested message; each one counts against the decode's message budget. */
  message(): WireReader {
    const { start, end } = this.span();
    this.budget.messages -= 1;
    if (this.budget.messages < 0) {
      throw new WireError(`feed has more than ${this.budget.maxMessages} messages`);
    }
    return new WireReader(this.bytes, start, end, this.budget);
  }

  text(): string {
    const { start, end } = this.span();
    if (end - start > this.budget.maxStringBytes) {
      throw new WireError(`string longer than ${this.budget.maxStringBytes} bytes`);
    }
    return utf8.decode(this.bytes.subarray(start, end));
  }

  skip(wireType: number): void {
    if (wireType === WIRE_VARINT) this.varint64();
    else if (wireType === WIRE_FIXED64) this.advance(8);
    else if (wireType === WIRE_LENGTH_DELIMITED) this.span();
    else if (wireType === WIRE_FIXED32) this.advance(4);
    else throw new WireError(`unsupported wire type ${wireType}`);
  }

  private need(count: number): void {
    if (this.position + count > this.end) {
      throw new WireError("fixed-width field runs past the end of the message");
    }
  }

  private advance(count: number): void {
    this.need(count);
    this.position += count;
  }
}
