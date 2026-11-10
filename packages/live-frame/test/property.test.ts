import fc from "fast-check";
import { describe, expect, it } from "vitest";
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
  frameToObject,
  type Keyframe,
  shapePackToObject,
} from "../src/index.ts";
import { deltaArb, headArb, keyframeArb, packArb, SEED } from "./arbitraries.ts";
import { resealed } from "./craft.ts";

const RUNS = { seed: SEED, numRuns: 200 };

function byKey<T extends { key: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.key - b.key);
}

interface Codec {
  readonly name: string;
  readonly sample: fc.Arbitrary<Uint8Array>;
  readonly decode: (bytes: Uint8Array) => unknown;
}

const CODECS: Codec[] = [
  { name: "keyframe", sample: keyframeArb.map(encodeKeyframe), decode: decodeKeyframe },
  { name: "delta", sample: deltaArb.map(encodeDelta), decode: decodeDelta },
  { name: "head", sample: headArb.map(encodeHead), decode: decodeHead },
  { name: "shape pack", sample: packArb.map(encodeShapePack), decode: decodeShapePack },
];

function outcome(run: () => unknown): string {
  try {
    run();
    return "decoded";
  } catch (error) {
    if (error instanceof FrameDecodeError) return error.code;
    throw error;
  }
}

describe("round trip", () => {
  it("keyframes decode to their input with trips in key order, and re-encode to the same bytes", () => {
    fc.assert(
      fc.property(keyframeArb, (frame) => {
        const bytes = encodeKeyframe(frame);
        const decoded = frameToObject(decodeKeyframe(bytes)) as Keyframe;
        expect(decoded).toEqual({ ...frame, trips: byKey(frame.trips) });
        expect(encodeKeyframe(decoded)).toEqual(bytes);
      }),
      RUNS,
    );
  });

  it("deltas decode to their input with sorted trips and removals", () => {
    fc.assert(
      fc.property(deltaArb, (frame) => {
        const bytes = encodeDelta(frame);
        const decoded = frameToObject(decodeDelta(bytes)) as Delta;
        expect(decoded).toEqual({
          ...frame,
          trips: byKey(frame.trips),
          removed: [...frame.removed].sort((a, b) => a - b),
        });
        expect(encodeDelta(decoded)).toEqual(bytes);
      }),
      RUNS,
    );
  });

  it("heads round-trip", () => {
    fc.assert(
      fc.property(headArb, (head) => {
        expect(decodeHead(encodeHead(head))).toEqual(head);
      }),
      RUNS,
    );
  });

  it("shape packs round-trip centimetre geometry exactly", () => {
    fc.assert(
      fc.property(packArb, (pack) => {
        const bytes = encodeShapePack(pack);
        const decoded = shapePackToObject(decodeShapePack(bytes));
        expect(decoded).toEqual(pack);
        expect(encodeShapePack(decoded)).toEqual(bytes);
      }),
      RUNS,
    );
  });
});

describe.each(CODECS)("$name decoder on damaged input", ({ sample, decode }) => {
  it("reports every truncation as truncated", () => {
    fc.assert(
      fc.property(sample, fc.nat(), (bytes, cut) => {
        const length = cut % bytes.length;
        expect(outcome(() => decode(bytes.slice(0, length)))).toBe("truncated");
      }),
      RUNS,
    );
  });

  it("rejects any changed byte without a matching checksum", () => {
    fc.assert(
      fc.property(sample, fc.nat(), fc.integer({ min: 1, max: 255 }), (bytes, at, mask) => {
        const copy = bytes.slice();
        const index = at % copy.length;
        copy[index] = (copy[index] as number) ^ mask;
        expect(outcome(() => decode(copy))).not.toBe("decoded");
      }),
      RUNS,
    );
  });

  it("throws only FrameDecodeError for changed bytes behind a valid checksum", () => {
    fc.assert(
      fc.property(
        sample,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })), {
          minLength: 1,
          maxLength: 6,
        }),
        (bytes, edits) => {
          const damaged = resealed(bytes, (copy) => {
            for (const [at, mask] of edits) {
              const index = 20 + (at % (copy.length - 20));
              copy[index] = (copy[index] as number) ^ mask;
            }
          });
          outcome(() => decode(damaged));
        },
      ),
      { ...RUNS, numRuns: 2000 },
    );
  });

  it("throws only FrameDecodeError for random bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(outcome(() => decode(bytes))).not.toBe("decoded");
      }),
      RUNS,
    );
  });
});

describe("random sections behind a valid header", () => {
  it("throws only FrameDecodeError", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CODECS),
        fc.uint8Array({ minLength: 0, maxLength: 400 }),
        fc.integer({ min: 0, max: 40 }),
        (codec, body, sections) => {
          const header = fc.sample(codec.sample, { seed: SEED, numRuns: 1 })[0] as Uint8Array;
          const bytes = new Uint8Array(40 + body.length);
          bytes.set(header.subarray(0, 40));
          bytes.set(body, 40);
          const forged = resealed(bytes, (copy) => {
            const view = new DataView(copy.buffer);
            view.setUint16(10, sections, true);
            view.setUint32(12, copy.length, true);
          });
          outcome(() => codec.decode(forged));
        },
      ),
      { ...RUNS, numRuns: 2000 },
    );
  });
});
