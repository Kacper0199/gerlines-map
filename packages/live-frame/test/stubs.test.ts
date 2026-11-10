import { describe, expect, it } from "vitest";
import { SECTION, SECTION_CRITICAL } from "../src/constants.ts";
import { readContainer } from "../src/container.ts";
import {
  decodeShapePack,
  encodeShapePack,
  FrameDecodeError,
  peekHeader,
  type ShapePack,
  type ShapeRecord,
  shapePackToObject,
  shapePolyline,
  VERSION_MINOR,
} from "../src/index.ts";
import { rebuilt } from "./craft.ts";
import { PACK_NUMBERED, PACK_STUBS } from "./fixtures.ts";

const STUB_IDS = [SECTION.stubCount, SECTION.stubX, SECTION.stubY, SECTION.stubDistance];
const BASE_IDS = new Set(
  [
    SECTION.packHash,
    SECTION.packVertexCount,
    SECTION.packStopCount,
    SECTION.packTunnelCount,
    SECTION.packLength,
    SECTION.packFlags,
    SECTION.packNumber,
    SECTION.vertexX,
    SECTION.vertexY,
    SECTION.vertexZ,
    SECTION.vertexM,
    SECTION.packStopArc,
    SECTION.packTunnel,
  ].map(Number),
);
const FIRST = PACK_STUBS.shapes[0] as ShapeRecord;

function withFirst(shape: Partial<ShapeRecord>): ShapePack {
  return { ...PACK_STUBS, shapes: [{ ...FIRST, ...shape }, PACK_STUBS.shapes[1] as ShapeRecord] };
}

function decodeError(run: () => unknown): FrameDecodeError {
  try {
    run();
  } catch (error) {
    if (error instanceof FrameDecodeError) return error;
    throw error;
  }
  throw new Error("expected a FrameDecodeError");
}

describe("shape pack track stubs (FORMAT.md 5.3, version 1.2)", () => {
  it("round-trips stubs and writes version 1.2 only when a shape has one", () => {
    const bytes = encodeShapePack(PACK_STUBS);
    expect(peekHeader(bytes).versionMinor).toBe(2);
    expect(VERSION_MINOR).toBe(4);
    expect(shapePackToObject(decodeShapePack(bytes))).toEqual(PACK_STUBS);
    expect(peekHeader(encodeShapePack(PACK_NUMBERED)).versionMinor).toBe(0);
    const none = {
      ...PACK_NUMBERED,
      shapes: PACK_NUMBERED.shapes.map((s) => ({ ...s, stubs: { before: null, after: null } })),
    };
    expect(encodeShapePack(none)).toEqual(encodeShapePack(PACK_NUMBERED));
  });

  it("keeps the pack's other columns byte for byte, so a 1.1 decoder reads the same shapes", () => {
    const bytes = encodeShapePack(PACK_STUBS);
    const container = readContainer(bytes, "shapePack", BASE_IDS);
    for (const id of STUB_IDS) {
      expect(container.sections.has(id)).toBe(true);
    }
    const directory = new DataView(bytes.buffer, bytes.byteOffset + 40);
    for (let i = 0; i < container.sections.size; i++) {
      expect(directory.getUint16(i * 12 + 2, true) & SECTION_CRITICAL).toBe(0);
    }
    const plain = decodeShapePack(encodeShapePack(PACK_NUMBERED));
    const view = decodeShapePack(bytes);
    for (const column of ["x", "y", "m", "stopArc", "tunnel", "length", "number"] as const) {
      expect(Array.from(view[column] ?? [])).toEqual(Array.from(plain[column] ?? []));
    }
    expect(view.stubCount).toBeDefined();
    expect(plain.stubCount).toBeUndefined();
  });

  it("gives each stub as a polyline from the shape's end vertex, distance 0 there", () => {
    const view = decodeShapePack(encodeShapePack(PACK_STUBS));
    const first = shapePolyline(view, 0);
    expect(Array.from(first.stubBefore?.x ?? [])).toEqual([1_492_000.12, 1_491_900.12, 1_491_800]);
    expect(Array.from(first.stubBefore?.y ?? [])).toEqual([
      6_894_000.01, 6_894_100.01, 6_894_250.5,
    ]);
    expect(Array.from(first.stubBefore?.d ?? [])).toEqual([0, 100.5, 250.75]);
    expect(Array.from(first.stubAfter?.x ?? [])).toEqual([1_492_250, 1_492_400]);
    expect(Array.from(first.stubAfter?.d ?? [])).toEqual([0, 180.25]);
    const second = shapePolyline(view, 1);
    expect(second.stubBefore).toBeUndefined();
    expect(second.stubAfter).toBeUndefined();
    expect(shapePolyline(decodeShapePack(encodeShapePack(PACK_NUMBERED)), 0).stubBefore).toBe(
      undefined,
    );
  });

  const invalid: [string, ShapePack, RegExp][] = [
    [
      "a stub without vertices",
      withFirst({ stubs: { before: { x: [], y: [], d: [] }, after: null } }),
      /stub before needs/,
    ],
    [
      "y shorter than x",
      withFirst({ stubs: { before: { x: [1, 2], y: [1], d: [1, 2] }, after: null } }),
      /stub before/,
    ],
    [
      "distance decreasing",
      withFirst({
        stubs: {
          before: { x: [1_491_900, 1_491_800], y: [6_894_100, 6_894_200], d: [20, 10] },
          after: null,
        },
      }),
      /stub before distance/,
    ],
    [
      "distance ending at 0",
      withFirst({ stubs: { before: null, after: { x: [1_492_250], y: [6_893_800.99], d: [0] } } }),
      /stub after distance/,
    ],
    [
      "x outside the square",
      withFirst({ stubs: { before: { x: [3e7], y: [0], d: [5] }, after: null } }),
      /stub before x/,
    ],
  ];

  it.each(invalid)("rejects %s", (_, pack, message) => {
    expect(() => encodeShapePack(pack)).toThrow(message);
  });

  it("rejects a pack whose stub columns are incomplete or do not add up", () => {
    const bytes = encodeShapePack(PACK_STUBS);
    const missing = rebuilt(bytes, { [SECTION.stubY]: null });
    expect(decodeError(() => decodeShapePack(missing)).code).toBe("corrupt");
    const short = rebuilt(bytes, { [SECTION.stubCount]: new Uint32Array([2, 1, 0]) });
    expect(decodeError(() => decodeShapePack(short)).message).toMatch(/stub count/);
    const sum = rebuilt(bytes, { [SECTION.stubCount]: new Uint32Array([2, 1, 0, 1]) });
    expect(decodeError(() => decodeShapePack(sum)).message).toMatch(/stub/);
    const zero = rebuilt(bytes, { [SECTION.stubDistance]: new Uint32Array([10050, 15025, 0]) });
    expect(decodeError(() => decodeShapePack(zero)).message).toMatch(/stub after/);
  });
});
