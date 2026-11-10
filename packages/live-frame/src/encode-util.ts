import { MAX_U32 } from "./constants.ts";

const HEX = /^[0-9a-f]*$/;

export function requireInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${value}`);
  }
  return value;
}

export function centimetres(metres: number, name: string): number {
  if (!Number.isFinite(metres)) throw new RangeError(`${name} is not finite`);
  return requireInteger(Math.round(metres * 100), 0, MAX_U32, `${name} in centimetres`);
}

export function hexToBytes(hex: string, bytes: number, name: string): Uint8Array {
  if (hex.length !== bytes * 2 || !HEX.test(hex)) {
    throw new RangeError(`${name} must be ${bytes * 2} lowercase hex digits, got ${hex}`);
  }
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array, start: number, length: number): string {
  let hex = "";
  for (let i = start; i < start + length; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return hex;
}
