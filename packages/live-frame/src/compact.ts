import { corrupt } from "./errors.ts";

const WEB_MERCATOR_RADIUS_CM = 637_813_700;
const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const EXP_TERMS = 14;
const EXP_HALVINGS = 4;

/** The largest value a compact varint holds: 5 bytes of 7 bits. */
export const VARINT_MAX = 2 ** 35 - 1;

/**
 * e^u from a fixed Taylor series of u / 16 squared four times. It uses only + - * /, each rounded
 * once by IEEE 754, so every JavaScript engine computes the same double (Math.exp is
 * implementation-approximated in ECMAScript and may differ between engines).
 */
function exactExp(u: number): number {
  const r = u / 2 ** EXP_HALVINGS;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < EXP_TERMS; k++) {
    term = (term * r) / k;
    sum += term;
  }
  for (let k = 0; k < EXP_HALVINGS; k++) sum *= sum;
  return sum;
}

/**
 * The ground distance in centimetres, unrounded, between two vertices given as Web Mercator
 * centimetres: the WGS84 ellipsoid with the meridian and prime vertical radii at the mid latitude.
 * Only + - * / and sqrt, each rounded once as an IEEE 754 double (no fused operations in
 * ECMAScript), so every engine computes the same bits. Frozen with format 1.4 (FORMAT.md 5.4): any
 * change of operation or order is a format change, and `test/compact-digest.test.ts` pins it.
 */
export function groundStepCm(x0: number, y0: number, x1: number, y1: number): number {
  const e = exactExp((y0 + y1) / (2 * WEB_MERCATOR_RADIUS_CM));
  const inverse = 1 / e;
  const cos = 2 / (e + inverse);
  const sin = (e - inverse) / (e + inverse);
  const w = 1 - WGS84_E2 * sin * sin;
  const rootW = Math.sqrt(w);
  const east = (((x1 - x0) / WEB_MERCATOR_RADIUS_CM) * WGS84_A * cos) / rootW;
  const north =
    (((y1 - y0) / WEB_MERCATOR_RADIUS_CM) * WGS84_A * (1 - WGS84_E2) * cos) / (w * rootW);
  return Math.sqrt(east * east + north * north) * 100;
}

/** The predicted M step in whole centimetres (FORMAT.md 5.4). */
export function predictedStepCm(x0: number, y0: number, x1: number, y1: number): number {
  return Math.round(groundStepCm(x0, y0, x1, y1));
}

export function zigzag(value: number): number {
  return value >= 0 ? 2 * value : -2 * value - 1;
}

export function unzigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

/** LEB128 bytes of zigzag-coded integers (each of magnitude below 2^34). */
export function writeVarints(values: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(values.length * 5);
  let at = 0;
  for (let i = 0; i < values.length; i++) {
    let rest = zigzag(values[i] as number);
    if (!(Number.isInteger(rest) && rest <= VARINT_MAX)) {
      throw new RangeError(`compact value ${values[i]} out of range`);
    }
    while (rest >= 128) {
      out[at++] = (rest % 128) + 128;
      rest = Math.floor(rest / 128);
    }
    out[at++] = rest;
  }
  return out.slice(0, at);
}

/** A position in a column of zigzag varints, read value by value. */
export class VarintReader {
  readonly bytes: Uint8Array;
  readonly name: string;
  at = 0;
  private index = 0;

  constructor(bytes: Uint8Array, name: string) {
    this.bytes = bytes;
    this.name = name;
  }

  /** The next value; corrupt when the column ends inside it, or it is overlong or above 5 bytes. */
  read(): number {
    let value = 0;
    let scale = 1;
    for (let k = 0; ; k++) {
      if (this.at >= this.bytes.length) corrupt(`${this.name} ends inside value ${this.index}`);
      if (k === 5) corrupt(`${this.name} value ${this.index} is longer than 5 bytes`);
      const byte = this.bytes[this.at++] as number;
      if (k > 0 && byte === 0) corrupt(`${this.name} value ${this.index} is overlong`);
      value += (byte & 127) * scale;
      if (byte < 128) break;
      scale *= 128;
    }
    this.index++;
    return unzigzag(value);
  }

  /** Corrupt unless every byte of the column was read. */
  finish(): void {
    const left = this.bytes.length - this.at;
    if (left !== 0) corrupt(`${this.name} holds ${left} bytes after its values`);
  }
}

/** Exactly `count` zigzag varints filling `bytes`; anything else is corrupt. */
export function readVarints(bytes: Uint8Array, count: number, name: string): Float64Array {
  const reader = new VarintReader(bytes, name);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = reader.read();
  reader.finish();
  return out;
}
