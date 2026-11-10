import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { predictedStepCm, readVarints, writeVarints, zigzag } from "../src/compact.ts";
import { SECTION } from "../src/constants.ts";
import { readContainer } from "../src/container.ts";
import {
  decodeShapePack,
  encodeShapePack,
  FrameDecodeError,
  openShapePack,
  peekHeader,
  type ShapePack,
  type ShapePackView,
  shapePackToObject,
  shapePolyline,
} from "../src/index.ts";
import { packArb, SEED } from "./arbitraries.ts";
import { rebuilt } from "./craft.ts";
import { PACK, PACK_NUMBERED, PACK_STUBS } from "./fixtures.ts";

const FIXTURE_PACKS = new URL("../../../apps/web/e2e/fixture/data/live/s/3/", import.meta.url);

/** The section ids a 1.3 decoder knew: it must refuse a compact pack, never misread it. */
const KNOWN_1_3 = new Set<number>([
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
  SECTION.stubCount,
  SECTION.stubX,
  SECTION.stubY,
  SECTION.stubDistance,
]);

function compact(pack: ShapePack): ShapePack {
  return { ...pack, coding: "compact" };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof FrameDecodeError) return error.code;
    throw error;
  }
  return undefined;
}

function expectSamePolylines(a: ShapePackView, b: ShapePackView): void {
  expect(b.count).toBe(a.count);
  for (let i = 0; i < a.count; i++) {
    const left = shapePolyline(a, i);
    const right = shapePolyline(b, i);
    expect(right).toEqual(left);
  }
}

describe("compact vertex coding (1.4)", () => {
  it("decodes to the same shapes as the 1.0 and 1.2 coding", () => {
    for (const pack of [PACK, PACK_NUMBERED, PACK_STUBS]) {
      const bytes = encodeShapePack(compact(pack));
      expect(peekHeader(bytes).versionMinor).toBe(4);
      expect(shapePackToObject(decodeShapePack(bytes))).toEqual(compact(pack));
      expectSamePolylines(decodeShapePack(encodeShapePack(pack)), decodeShapePack(bytes));
    }
  });

  it("leaves the default coding byte for byte as before", () => {
    expect(peekHeader(encodeShapePack(PACK)).versionMinor).toBe(0);
    expect(peekHeader(encodeShapePack(PACK_STUBS)).versionMinor).toBe(2);
    expect(shapePackToObject(decodeShapePack(encodeShapePack(PACK))).coding).toBeUndefined();
  });

  it("is refused by a 1.3 decoder as an unsupported version", () => {
    const bytes = encodeShapePack(compact(PACK_STUBS));
    expect(codeOf(() => readContainer(bytes, "shapePack", KNOWN_1_3))).toBe("unsupported_version");
  });

  it("keeps elevation that is not a whole centimetre in the float column", () => {
    const shape = PACK.shapes[0];
    if (!shape?.z) throw new Error("fixture shape without elevation");
    const pack: ShapePack = {
      ...PACK,
      shapes: [{ ...shape, z: shape.z.map((z) => z + 0.0031) }, ...PACK.shapes.slice(1)],
    };
    const bytes = encodeShapePack(compact(pack));
    const container = readContainer(bytes, "shapePack", new Set(Object.values(SECTION)));
    expect(container.sections.has(SECTION.vertexZ)).toBe(true);
    expect(container.sections.has(SECTION.compactZ)).toBe(false);
    expectSamePolylines(decodeShapePack(encodeShapePack(pack)), decodeShapePack(bytes));
  });

  it("round-trips any pack the 1.0 coding holds to the same decoded values", () => {
    fc.assert(
      fc.property(packArb, (pack) => {
        const plain = decodeShapePack(encodeShapePack(pack));
        const packed = decodeShapePack(encodeShapePack(compact(pack)));
        expectSamePolylines(plain, packed);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("reads every real pack of the WP-9.3 fixture to the same positions, smaller", () => {
    const names = readdirSync(FIXTURE_PACKS).filter((name) => name.endsWith(".bin"));
    expect(names.length).toBeGreaterThan(30);
    let before = 0;
    let after = 0;
    for (const name of names) {
      const held = new Uint8Array(readFileSync(new URL(name, FIXTURE_PACKS)));
      const old = decodeShapePack(held);
      const bytes = encodeShapePack(compact(shapePackToObject(old)));
      expectSamePolylines(old, decodeShapePack(bytes));
      before += held.length;
      after += bytes.length;
    }
    expect(after).toBeLessThan(before * 0.6);
  });

  it("predicts real M steps within a few centimetres", () => {
    const names = readdirSync(FIXTURE_PACKS).filter((name) => name.endsWith(".bin"));
    let worst = 0;
    for (const name of names) {
      const view = decodeShapePack(new Uint8Array(readFileSync(new URL(name, FIXTURE_PACKS))));
      let x = view.x[0] as number;
      let y = view.y[0] as number;
      for (let v = 1; v < view.x.length; v++) {
        const nx = x + (view.x[v] as number);
        const ny = y + (view.y[v] as number);
        worst = Math.max(worst, Math.abs((view.m[v] as number) - predictedStepCm(x, y, nx, ny)));
        [x, y] = [nx, ny];
      }
    }
    expect(worst).toBeLessThanOrEqual(3);
  });

  it("pins the prediction to the bit", () => {
    expect(predictedStepCm(149_200_012, 689_400_001, 149_210_050, 689_390_000)).toBe(8630);
    expect(predictedStepCm(0, 0, 10_000, 0)).toBe(10_000);
    expect(predictedStepCm(-2_003_750_834, 2_003_750_834, -2_003_740_834, 2_003_750_834)).toBe(866);
  });

  describe("rejects", () => {
    const bytes = encodeShapePack(compact(PACK_STUBS));

    it("a varint column with bytes after its values", () => {
      const x = writeVarints([...readVarints(rawOf(bytes, SECTION.compactX), 5, "x"), 1]);
      expect(codeOf(() => decodeShapePack(rebuilt(bytes, { [SECTION.compactX]: x })))).toBe(
        "corrupt",
      );
    });

    it("a varint column that ends inside a value", () => {
      const x = rawOf(bytes, SECTION.compactX).slice(0, -1);
      expect(codeOf(() => decodeShapePack(rebuilt(bytes, { [SECTION.compactX]: x })))).toBe(
        "corrupt",
      );
    });

    it("a varint longer than five bytes", () => {
      const long = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
      expect(codeOf(() => readVarints(long, 1, "x"))).toBe("corrupt");
    });

    it("both codings of the vertex columns, or only part of the compact one", () => {
      const both = rebuilt(bytes, { [SECTION.vertexX]: new Int32Array(5) });
      expect(codeOf(() => decodeShapePack(both))).toBe("corrupt");
      const part = rebuilt(bytes, { [SECTION.compactM]: null });
      expect(codeOf(() => decodeShapePack(part))).toBe("corrupt");
    });

    it("a residual that makes an M step negative or breaks the length", () => {
      const residual = readVarints(rawOf(bytes, SECTION.compactM), 5, "m");
      const negative = Array.from(residual, (r, i) => (i === 1 ? r - 1e7 : r));
      expect(
        codeOf(() =>
          decodeShapePack(rebuilt(bytes, { [SECTION.compactM]: writeVarints(negative) })),
        ),
      ).toBe("corrupt");
      const longer = Array.from(residual, (r, i) => (i === 1 ? r + 1 : r));
      expect(
        codeOf(() => decodeShapePack(rebuilt(bytes, { [SECTION.compactM]: writeVarints(longer) }))),
      ).toBe("corrupt");
    });
  });

  it("writes zigzag varints of up to 35 bits", () => {
    const values = [0, -1, 1, 63, -64, 2 ** 31 - 1, -(2 ** 31), 2 ** 34 - 1, -(2 ** 34)];
    expect(Array.from(readVarints(writeVarints(values), values.length, "v"))).toEqual(values);
    expect(zigzag(-(2 ** 34))).toBe(2 ** 35 - 1);
    expect(() => writeVarints([2 ** 34])).toThrow(RangeError);
  });
});

function rawOf(bytes: Uint8Array, id: number): Uint8Array {
  const container = readContainer(bytes, "shapePack", new Set(Object.values(SECTION)));
  const range = container.sections.get(id);
  if (!range) throw new Error(`no section ${id}`);
  return bytes.slice(range.offset, range.offset + range.length);
}

describe("absent shape numbers (1.4, section 0x88)", () => {
  const withAbsent: ShapePack = { ...PACK_NUMBERED, coding: "compact", absent: [5, 4022] };

  it("round-trips in a pack set and is skipped by a 1.3 decoder", () => {
    const bytes = encodeShapePack(withAbsent);
    expect(shapePackToObject(decodeShapePack(bytes))).toEqual(withAbsent);
    const plain = encodeShapePack({ ...PACK_NUMBERED, absent: [5] });
    expect(peekHeader(plain).versionMinor).toBe(4);
    const container = readContainer(plain, "shapePack", KNOWN_1_3);
    expect(container.sections.has(SECTION.packAbsent)).toBe(true);
  });

  it("refuses numbers out of order, held in the pack, or without an epoch", () => {
    expect(() => encodeShapePack({ ...withAbsent, absent: [9, 5] })).toThrow(RangeError);
    expect(() => encodeShapePack({ ...withAbsent, absent: [17] })).toThrow(RangeError);
    expect(() =>
      encodeShapePack({ ...PACK, coding: "compact", shapeEpoch: 0, absent: [3] }),
    ).toThrow(RangeError);
    const bytes = encodeShapePack(withAbsent);
    for (const values of [Uint32Array.from([9, 5]), Uint32Array.from([17])]) {
      const broken = rebuilt(bytes, { [SECTION.packAbsent]: values });
      expect(codeOf(() => decodeShapePack(broken))).toBe("corrupt");
    }
  });
});

describe("reading a pack shape by shape", () => {
  function all(bytes: Uint8Array) {
    const cursor = openShapePack(bytes);
    const out = [];
    while (cursor.next < cursor.count) out.push(cursor.read());
    cursor.finish();
    return out;
  }

  it("gives the polylines of decodeShapePack for any pack in either coding", () => {
    fc.assert(
      fc.property(packArb, fc.boolean(), (pack, packed) => {
        const bytes = encodeShapePack(packed ? compact(pack) : pack);
        const view = decodeShapePack(bytes);
        expect(all(bytes)).toEqual(
          Array.from({ length: view.count }, (_, i) => shapePolyline(view, i)),
        );
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("reads the real fixture shapes from one compact pack, skipping some", () => {
    const names = readdirSync(FIXTURE_PACKS).filter((name) => name.endsWith(".bin"));
    const shapes = names.flatMap(
      (name) =>
        shapePackToObject(
          decodeShapePack(new Uint8Array(readFileSync(new URL(name, FIXTURE_PACKS)))),
        ).shapes,
    );
    const bytes = encodeShapePack({
      ...PACK,
      shapeEpoch: 3,
      shapes,
      coding: "compact",
      absent: [],
    });
    const view = decodeShapePack(bytes);
    const cursor = openShapePack(bytes);
    expect(Array.from(cursor.absent ?? [1])).toEqual([]);
    for (let i = 0; i < view.count; i++) {
      if (i % 3 === 0) cursor.skip();
      else expect(cursor.read()).toEqual(shapePolyline(view, i));
    }
    cursor.finish();
  });

  it("finds bytes left after the last shape and a broken residual", () => {
    const bytes = encodeShapePack(compact(PACK_STUBS));
    const x = writeVarints([...readVarints(rawOf(bytes, SECTION.compactX), 5, "x"), 1]);
    const trailing = openShapePack(rebuilt(bytes, { [SECTION.compactX]: x }));
    trailing.read();
    trailing.read();
    expect(codeOf(() => trailing.finish())).toBe("corrupt");
    const residual = readVarints(rawOf(bytes, SECTION.compactM), 5, "m");
    const longer = Array.from(residual, (r, i) => (i === 1 ? r + 1 : r));
    const broken = openShapePack(rebuilt(bytes, { [SECTION.compactM]: writeVarints(longer) }));
    expect(codeOf(() => broken.read())).toBe("corrupt");
  });

  it("refuses an overlong varint", () => {
    expect(codeOf(() => readVarints(Uint8Array.from([0x81, 0x00]), 1, "x"))).toBe("corrupt");
    expect(Array.from(readVarints(Uint8Array.from([0x81, 0x01]), 1, "x"))).toEqual([-65]);
  });
});
