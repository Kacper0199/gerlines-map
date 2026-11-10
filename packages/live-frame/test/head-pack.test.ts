import { describe, expect, it } from "vitest";
import { SECTION } from "../src/constants.ts";
import { readContainer, writeContainer } from "../src/container.ts";
import {
  decodeHead,
  decodeShapePack,
  encodeHead,
  encodeShapePack,
  FrameDecodeError,
  type HeadCount,
  peekHeader,
  type ShapePack,
  type ShapeRecord,
  shapePackToObject,
  shapePolyline,
} from "../src/index.ts";
import { HEAD, HEAD_COUNTS, PACK, PACK_NUMBERED } from "./fixtures.ts";

const METRIC_ORDER = ["running", "untracked", "cancelled", "realtime"];
const CATEGORY_ORDER = ["unknown", "hsr", "ld", "night", "rfast", "reg", "sbahn", "urban", "bus"];

function sortedCounts(counts: readonly HeadCount[]): HeadCount[] {
  const code = (count: HeadCount) =>
    (METRIC_ORDER.indexOf(count.metric) + 1) * 256 +
    (count.category === null ? 255 : CATEGORY_ORDER.indexOf(count.category));
  return [...counts].sort((a, b) => code(a) - code(b));
}

const SHAPE = PACK.shapes[0] as ShapeRecord;

function packWith(shape: Partial<ShapeRecord>): ShapePack {
  return { ...PACK, shapes: [{ ...SHAPE, ...shape }] };
}

describe("head", () => {
  it("round-trips", () => {
    expect(decodeHead(encodeHead(HEAD))).toEqual(HEAD);
  });

  it("rejects sequences out of order on both sides", () => {
    expect(() => encodeHead({ ...HEAD, keyframeSequence: HEAD.sequence + 1 })).toThrow(RangeError);
    expect(() => encodeHead({ ...HEAD, oldestSequence: HEAD.sequence + 1 })).toThrow(RangeError);
    const meta = { sequence: 10, baseSequence: 0, timetableVersion: 1, timeBase: 1, shapeEpoch: 0 };
    const bad = (values: number[]) =>
      writeContainer("head", meta, [{ id: SECTION.head, data: Uint32Array.from(values) }]);
    expect(() => decodeHead(bad([5, 9, 1]))).toThrow(FrameDecodeError);
    expect(() => decodeHead(bad([11, 10, 1]))).toThrow(FrameDecodeError);
    expect(() => decodeHead(bad([5, 10, 11]))).toThrow(FrameDecodeError);
    expect(() => decodeHead(bad([5, 10]))).toThrow(FrameDecodeError);
  });
});

describe("head counts (FORMAT 1.1, section 0x61)", () => {
  it("round-trips the counts, written in code order", () => {
    const decoded = decodeHead(encodeHead(HEAD_COUNTS));
    expect(decoded).toEqual({ ...HEAD_COUNTS, counts: sortedCounts(HEAD_COUNTS.counts ?? []) });
  });

  it("writes version 1.1 only when the head carries counts", () => {
    expect(peekHeader(encodeHead(HEAD_COUNTS)).versionMinor).toBe(1);
    expect(peekHeader(encodeHead(HEAD)).versionMinor).toBe(0);
    expect(encodeHead({ ...HEAD, counts: [] })).toEqual(encodeHead(HEAD));
  });

  it("is skipped by a decoder that does not know it", () => {
    const bytes = encodeHead(HEAD_COUNTS);
    const asOneZero = readContainer(bytes, "head", new Set([SECTION.head]));
    expect(asOneZero.sections.has(SECTION.headCounts)).toBe(true);
    const { counts: _counts, ...withoutCounts } = decodeHead(bytes);
    expect(withoutCounts).toEqual(decodeHead(encodeHead(HEAD)));
  });

  it("rejects counts the format cannot hold", () => {
    const one = { metric: "running", category: null, count: 1 } as const;
    expect(() => encodeHead({ ...HEAD, counts: [one, one] })).toThrow(RangeError);
    expect(() => encodeHead({ ...HEAD, counts: [{ ...one, count: -1 }] })).toThrow(RangeError);
    expect(() => encodeHead({ ...HEAD, counts: [{ ...one, count: 1.5 }] })).toThrow(RangeError);
    expect(() => encodeHead({ ...HEAD, counts: [{ ...one, count: 2 ** 32 }] })).toThrow(RangeError);
  });

  it("decodes codes in ascending order only and skips unknown metrics and categories", () => {
    const meta = {
      sequence: HEAD.sequence,
      baseSequence: 0,
      timetableVersion: 7,
      timeBase: 1,
      shapeEpoch: 0,
    };
    const head = Uint32Array.from([HEAD.keyframeSequence, HEAD.sequence, HEAD.oldestSequence]);
    const withCounts = (values: number[]) =>
      writeContainer("head", meta, [
        { id: SECTION.head, data: head },
        { id: SECTION.headCounts, data: Uint32Array.from(values) },
      ]);
    expect(decodeHead(withCounts([0x0101, 2, 0x0120, 1, 0x01ff, 5, 0x09ff, 7])).counts).toEqual([
      { metric: "running", category: "hsr", count: 2 },
      { metric: "running", category: null, count: 5 },
    ]);
    for (const values of [
      [0x01ff, 5, 0x0101, 2],
      [0x0101, 5, 0x0101, 2],
      [0x0101, 5, 0x0102],
    ]) {
      expect(() => decodeHead(withCounts(values))).toThrow(
        expect.objectContaining({ code: "corrupt" }),
      );
    }
  });
});

describe("shape pack", () => {
  it("round-trips centimetre coordinates, float32 z, stops and tunnels", () => {
    expect(shapePackToObject(decodeShapePack(encodeShapePack(PACK)))).toEqual(PACK);
  });

  it("stores x and y as centimetre differences after an absolute first vertex", () => {
    const view = decodeShapePack(encodeShapePack(PACK));
    expect(Array.from(view.x.subarray(0, 3))).toEqual([149_200_012, 10_038, 14_950]);
    expect(Array.from(view.vertexOffset)).toEqual([0, 3, 5]);
    expect(view.x.buffer).toBe(view.hash.buffer);
  });

  it("gives a polyline in metres that createShape accepts", () => {
    const view = decodeShapePack(encodeShapePack(PACK));
    const first = shapePolyline(view, 0);
    expect(Array.from(first.x)).toEqual(SHAPE.x);
    expect(Array.from(first.z ?? [])).toEqual(SHAPE.z);
    expect(Array.from(first.tunnels)).toEqual([20, 80.75]);
    expect(first.length).toBe(312.4);
    expect(Array.from(first.s)).toEqual(SHAPE.m);
    const second = shapePolyline(view, 1);
    expect("z" in second).toBe(false);
    expect(() => shapePolyline(view, 2)).toThrow(RangeError);
  });

  it("round-trips shape numbers with the epoch and refuses them on only some shapes", () => {
    const view = decodeShapePack(encodeShapePack(PACK_NUMBERED));
    expect(shapePolyline(view, 1).number).toBe(4021);
    expect(view.header.shapeEpoch).toBe(PACK_NUMBERED.shapeEpoch);
    expect(shapePackToObject(view)).toEqual(PACK_NUMBERED);
    const some = {
      ...PACK_NUMBERED,
      shapes: [PACK_NUMBERED.shapes[0] as ShapeRecord, PACK.shapes[1] as ShapeRecord],
    };
    expect(() => encodeShapePack(some)).toThrow(/every shape/);
    expect(() => encodeShapePack({ ...PACK_NUMBERED, shapeEpoch: 0 })).toThrow(/shapeEpoch 0/);
    const twice = {
      ...PACK_NUMBERED,
      shapes: PACK.shapes.map((s) => ({ ...s, number: 9 })),
    };
    expect(() => encodeShapePack(twice)).toThrow(/number repeated/);
  });

  it("writes an empty number column for an empty pack of a numbered registry", () => {
    const empty: ShapePack = { ...PACK_NUMBERED, shapes: [] };
    const view = decodeShapePack(encodeShapePack(empty));
    expect(view.number?.length).toBe(0);
    expect(shapePackToObject(view)).toEqual(empty);
  });

  it("leaves the z column out when no shape has elevation", () => {
    const flat = packWith({ z: null });
    const view = decodeShapePack(encodeShapePack(flat));
    expect(view.z).toBeUndefined();
    expect(shapePackToObject(view)).toEqual(flat);
  });

  const invalid: [string, ShapePack, RegExp][] = [
    ["a short hash", packWith({ hash: "abc" }), /hash/],
    ["one vertex", packWith({ x: [1], y: [1], z: null, m: [0] }), /two vertices/],
    ["m shorter than x", packWith({ m: [0, 312.4] }), /m length/],
    ["m not from 0", packWith({ m: [0.01, 150, 312.4] }), /m\[0\]/],
    ["m decreasing", packWith({ m: [0, 160, 150] }), /m decreases/],
    ["m not finite", packWith({ m: [0, Number.NaN, 312.4] }), /finite/],
    ["m ending before the length", packWith({ m: [0, 150, 312.3] }), /length/],
    ["y shorter than x", packWith({ y: [1, 2], z: null }), /as many y/],
    ["z shorter than x", packWith({ z: [1] }), /z length/],
    ["z not finite", packWith({ z: [1, Number.NaN, 2] }), /float32/],
    ["z beyond float32", packWith({ z: [1, 1e39, 2] }), /float32/],
    ["x outside the square", packWith({ x: [3e7, 0, 0] }), /x\[0\]/],
    ["x not finite", packWith({ x: [0, Number.POSITIVE_INFINITY, 0] }), /finite/],
    ["stops decreasing", packWith({ stops: [100, 50] }), /stop 1/],
    ["stop past the end", packWith({ stops: [400] }), /stop 0/],
    ["tunnel reversed", packWith({ tunnels: [[80, 20]] }), /tunnel 0/],
    [
      "tunnels overlapping",
      packWith({
        tunnels: [
          [10, 50],
          [40, 60],
        ],
      }),
      /tunnel 1/,
    ],
    ["tunnel past the end", packWith({ tunnels: [[10, 400]] }), /tunnel 0/],
    ["repeated hash", { ...PACK, shapes: [SHAPE, SHAPE] }, /repeated/],
  ];

  it.each(invalid)("rejects %s", (_, pack, message) => {
    expect(() => encodeShapePack(pack)).toThrow(message);
  });

  it("rejects a step across the antimeridian", () => {
    expect(() => encodeShapePack(packWith({ x: [-2e7, 2e7], y: [0, 0], z: null }))).toThrow(/step/);
  });
});
