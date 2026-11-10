import { describe, expect, it } from "vitest";
import { SECTION } from "../src/constants.ts";
import {
  decodeDelta,
  decodeKeyframe,
  decodeShapePack,
  encodeDelta,
  encodeKeyframe,
  encodeShapePack,
  FrameDecodeError,
  type ShapePack,
} from "../src/index.ts";
import { rebuilt, u16, u32 } from "./craft.ts";
import { DELTA, KEYFRAME, KEYFRAME_NUMBERED, PACK, PACK_NUMBERED, stop, trip } from "./fixtures.ts";

function rejection(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FrameDecodeError) return `${error.code} ${error.message}`;
    throw error;
  }
  return "decoded";
}

const keyframe = encodeKeyframe(KEYFRAME);
const delta = encodeDelta(DELTA);

function stopFlagsWith(flags: number): Uint8Array {
  const column = Uint8Array.from(decodeKeyframe(keyframe).stops.flags);
  column[1] = flags;
  return column;
}

describe("keyframe content checks", () => {
  const cases: [string, Record<number, ArrayBufferView | null>, RegExp][] = [
    ["missing trip keys", { [SECTION.tripKey]: null }, /required section 0x10/],
    ["columns of different length", { [SECTION.tripDelay]: new Int16Array(3) }, /trip columns/],
    ["a repeated key", { [SECTION.tripKey]: u32(30, 10, 30, 40) }, /trip key repeated/],
    ["shape row out of range", { [SECTION.tripShape]: u16(0, 1, 1, 2) }, /shape row/],
    ["line row out of range", { [SECTION.tripLine]: u16(0, 1, 7, 0xffff) }, /line row/],
    ["a trip without stops", { [SECTION.tripStopCount]: u16(3, 0, 3, 5) }, /fewer than two/],
    ["a trip with one stop", { [SECTION.tripStopCount]: u16(3, 3, 1, 4) }, /fewer than two/],
    ["a stop with both times unknown", { [SECTION.stopFlags]: stopFlagsWith(3) }, /both times/],
    ["an unknown arrival with a dwell", { [SECTION.stopFlags]: stopFlagsWith(1) }, /dwell/],
    ["an unknown departure with a dwell", { [SECTION.stopFlags]: stopFlagsWith(2) }, /dwell/],
    ["too few stops", { [SECTION.tripStopCount]: u16(3, 3, 2, 4) }, /stop table shorter/],
    ["too many stops", { [SECTION.tripStopCount]: u16(3, 3, 2, 2) }, /stop table longer/],
    [
      "stop columns of different length",
      { [SECTION.stopDwell]: new Uint16Array(4) },
      /stop columns/,
    ],
    [
      "a first stop with a run time",
      { [SECTION.stopRun]: u16(5, 300, 300, 0, 600, 0, 1770, 2080, 0, 300, 540) },
      /first stop has a run time/,
    ],
    ["arc column too short", { [SECTION.stopArc]: u32(100) }, /arc column shorter/],
    ["arc column too long", { [SECTION.stopArc]: u32(1, 2, 3) }, /arc column longer/],
    ["arc positions decreasing", { [SECTION.stopArc]: u32(500, 400) }, /decrease/],
    ["shape ids cut", { [SECTION.shapeId]: new Uint8Array(12) }, /shape id table length/],
    ["shape id repeated", { [SECTION.shapeId]: new Uint8Array(16) }, /repeated/],
    ["both shape id forms", { [SECTION.shapeNumber]: u32(1, 2) }, /exactly one/],
    ["no shape ids", { [SECTION.shapeId]: null }, /exactly one/],
    ["string offsets empty", { [SECTION.stringOffsets]: u32() }, /do not span/],
    ["string offsets not from 0", { [SECTION.stringOffsets]: u32(1, 4, 25, 28) }, /do not span/],
    ["string offsets decreasing", { [SECTION.stringOffsets]: u32(0, 7, 3, 29) }, /decrease/],
    [
      "string not UTF-8",
      {
        [SECTION.stringOffsets]: u32(0, 1, 2, 3),
        [SECTION.stringBytes]: Uint8Array.from([0x41, 0xff, 0x42]),
      },
      /not UTF-8/,
    ],
    [
      "string repeated",
      {
        [SECTION.stringOffsets]: u32(0, 1, 2, 3),
        [SECTION.stringBytes]: Uint8Array.from([0x41, 0x42, 0x41]),
      },
      /string 2 repeated/,
    ],
  ];

  it.each(cases)("rejects %s", (_, changes, message) => {
    const result = rejection(() => decodeKeyframe(rebuilt(keyframe, changes)));
    expect(result).toMatch(/^corrupt /);
    expect(result).toMatch(message);
  });
});

describe("shape epoch", () => {
  const numbered = encodeKeyframe(KEYFRAME_NUMBERED);
  const numberedPack = encodeShapePack(PACK_NUMBERED);
  const cases: [string, () => unknown][] = [
    ["numbers at epoch 0", () => decodeKeyframe(rebuilt(numbered, {}, { shapeEpoch: 0 }))],
    ["hash prefixes at epoch 2", () => decodeKeyframe(rebuilt(keyframe, {}, { shapeEpoch: 2 }))],
    [
      "pack numbers at epoch 0",
      () => decodeShapePack(rebuilt(numberedPack, {}, { shapeEpoch: 0 })),
    ],
    [
      "a pack without numbers at epoch 2",
      () => decodeShapePack(rebuilt(encodeShapePack(PACK), {}, { shapeEpoch: 2 })),
    ],
  ];

  it.each(cases)("rejects %s", (_, run) => {
    expect(rejection(run)).toMatch(/^corrupt .*epoch/);
  });

  it("rejects a repeated shape number", () => {
    const repeated = rebuilt(numbered, { [SECTION.shapeNumber]: u32(5, 5) });
    expect(rejection(() => decodeKeyframe(repeated))).toMatch(/^corrupt .*shape 5 repeated/);
  });
});

describe("delta content checks", () => {
  it("rejects removals out of order or also updated", () => {
    expect(
      rejection(() => decodeDelta(rebuilt(delta, { [SECTION.removed]: u32(40, 20) }))),
    ).toMatch(/not ascending/);
    expect(rejection(() => decodeDelta(rebuilt(delta, { [SECTION.removed]: u32(5, 50) })))).toMatch(
      /both updated and removed/,
    );
    expect(rejection(() => decodeDelta(rebuilt(delta, { [SECTION.removed]: null })))).toMatch(
      /0x50/,
    );
  });

  it("rejects a base sequence other than sequence - 1", () => {
    for (const baseSequence of [1001, 1002, 999]) {
      expect(rejection(() => decodeDelta(rebuilt(delta, {}, { baseSequence })))).toMatch(
        /base must be sequence - 1/,
      );
    }
  });
});

describe("encoder stop checks", () => {
  it("rejects a stop arriving before the previous stop departs instead of clamping it", () => {
    const base = 1_793_947_000;
    const backwards = trip(26_724_253, {
      firstStop: 0,
      stops: [
        stop(base + 680, base + 680, { cancelled: true }),
        stop(base + 710, base + 740, { cancelled: true }),
        stop(base + 800, base + 800, { cancelled: true }),
        stop(base + 771, base + 830, { realtime: true }),
        stop(base + 1440, base + 1440, { realtime: true }),
      ],
    });
    expect(() => encodeDelta({ ...DELTA, trips: [backwards], removed: [] })).toThrow(
      /trip 26724253 stop 3 run must be an integer from 0 to 65535, got -29/,
    );
  });
});

describe("shape pack content checks", () => {
  const pack = encodeShapePack(PACK);
  const numberedPack = encodeShapePack(PACK_NUMBERED);
  const flat: ShapePack = { ...PACK, shapes: PACK.shapes.map((shape) => ({ ...shape, z: null })) };
  const cases: [string, Uint8Array, Record<number, ArrayBufferView | null>, RegExp][] = [
    ["a cut hash", pack, { [SECTION.packHash]: new Uint8Array(40) }, /hash column/],
    ["shape columns differ", pack, { [SECTION.packLength]: u32(1) }, /shape columns/],
    ["shape numbers short", numberedPack, { [SECTION.packNumber]: u32(1) }, /shape columns/],
    ["shape number repeated", numberedPack, { [SECTION.packNumber]: u32(3, 3) }, /number repeated/],
    ["vertex columns differ", pack, { [SECTION.vertexY]: new Int32Array(4) }, /vertex columns/],
    [
      "z not finite",
      pack,
      { [SECTION.vertexZ]: Float32Array.from([1, 2, Number.NaN, 0, 0]) },
      /not finite/,
    ],
    ["half a tunnel", pack, { [SECTION.packTunnel]: u32(2000) }, /half a span/],
    ["no m column", pack, { [SECTION.vertexM]: null }, /0x7d/],
    ["m column short", pack, { [SECTION.vertexM]: u32(0, 1, 2, 3) }, /vertex columns/],
    ["m not from 0", pack, { [SECTION.vertexM]: u32(1, 15_049, 16_190, 0, 50_834) }, /m starts/],
    [
      "m not adding up",
      pack,
      { [SECTION.vertexM]: u32(0, 15_050, 16_190, 0, 50_833) },
      /m adds up/,
    ],
    ["counts not matching", pack, { [SECTION.packVertexCount]: u32(3, 3) }, /vertex counts/],
    ["a repeated hash", pack, { [SECTION.packHash]: new Uint8Array(64) }, /hash repeated/],
    ["one vertex", pack, { [SECTION.packVertexCount]: u32(1, 4) }, /fewer than two/],
    [
      "elevation without z",
      encodeShapePack(flat),
      { [SECTION.packFlags]: Uint8Array.from([1, 0]) },
      /no z column/,
    ],
    [
      "x outside the square",
      pack,
      { [SECTION.vertexX]: Int32Array.from([2_000_000_000, 10_000_000, 0, 0, 0]) },
      /Web Mercator/,
    ],
    ["stops out of order", pack, { [SECTION.packStopArc]: u32(0, 20_000, 10_000) }, /stop arc/],
    ["tunnel past the end", pack, { [SECTION.packTunnel]: u32(2000, 99_000) }, /tunnels/],
  ];

  it.each(cases)("rejects %s", (_, bytes, changes, message) => {
    const result = rejection(() => decodeShapePack(rebuilt(bytes, changes)));
    expect(result).toMatch(/^corrupt /);
    expect(result).toMatch(message);
  });
});
