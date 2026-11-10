import {
  type Delta,
  decodeDelta,
  decodeHead,
  decodeKeyframe,
  decodeShapePack,
  encodeDelta,
  encodeHead,
  encodeKeyframe,
  encodeShapePack,
  FrameDecodeError,
  type FrameErrorCode,
  frameToObject,
  type Head,
  type Keyframe,
  type ShapePack,
  shapePackToObject,
} from "../src/index.ts";

export type Decoder = "keyframe" | "delta" | "head" | "shapePack";
type Expected = Keyframe | Delta | Head | ShapePack;

/** The JSON half of a golden vector. Shared by the Node tests and the browser worker check. */
export interface VectorFile {
  readonly name: string;
  readonly description: string;
  readonly decoder: Decoder;
  readonly expected?: Expected;
  readonly error?: FrameErrorCode;
  readonly byteLength: number;
}

export type DecodeOutcome = { value: Expected } | { error: FrameErrorCode };

function decodeAs(decoder: Decoder, bytes: Uint8Array): Expected {
  switch (decoder) {
    case "keyframe":
      return frameToObject(decodeKeyframe(bytes));
    case "delta":
      return frameToObject(decodeDelta(bytes));
    case "head":
      return decodeHead(bytes);
    case "shapePack":
      return shapePackToObject(decodeShapePack(bytes));
  }
}

export function decodeVector(decoder: Decoder, bytes: Uint8Array): DecodeOutcome {
  try {
    return { value: decodeAs(decoder, bytes) };
  } catch (error) {
    if (error instanceof FrameDecodeError) return { error: error.code };
    throw error;
  }
}

/** A copy of the bytes starting at byte 1 of a fresh buffer: every column is misaligned. */
export function atOddOffset(bytes: Uint8Array): Uint8Array {
  const shifted = new Uint8Array(bytes.length + 1);
  shifted.set(bytes, 1);
  return shifted.subarray(1);
}

export function encodeVector(file: VectorFile): Uint8Array {
  const value = file.expected;
  switch (value?.kind) {
    case "keyframe":
      return encodeKeyframe(value);
    case "delta":
      return encodeDelta(value);
    case "head":
      return encodeHead(value);
    case "shapePack":
      return encodeShapePack(value);
    default:
      throw new RangeError(`vector ${file.name} has no expected value`);
  }
}
