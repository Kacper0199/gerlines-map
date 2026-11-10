import { describe, expect, it } from "vitest";
import { SECTION } from "../src/constants.ts";
import { readContainer } from "../src/container.ts";
import {
  decodeHead,
  encodeHead,
  type Head,
  MAX_PACK_SET_INCREMENTS,
  type PackSets,
  packSetPlan,
  peekHeader,
} from "../src/index.ts";
import { rebuilt, u32 } from "./craft.ts";
import { HEAD, HEAD_COUNTS } from "./fixtures.ts";

const PACK_SETS: PackSets = { epoch: 3, latest: 2_995_000, first: 2_994_996, parts: 7 };
const SETS: Head = { ...HEAD, packSets: PACK_SETS };

describe("head pack sets (1.4, FORMAT.md 4.2)", () => {
  it("round-trips and writes 1.4 only with pack sets", () => {
    const bytes = encodeHead(SETS);
    expect(peekHeader(bytes).versionMinor).toBe(4);
    expect(decodeHead(bytes)).toEqual(SETS);
    const both = encodeHead({ ...HEAD_COUNTS, packSets: PACK_SETS });
    expect(peekHeader(both).versionMinor).toBe(4);
    expect(decodeHead(both).packSets).toEqual(PACK_SETS);
    expect(peekHeader(encodeHead(HEAD_COUNTS)).versionMinor).toBe(1);
    expect(peekHeader(encodeHead(HEAD)).versionMinor).toBe(0);
  });

  it("is skipped by a decoder that knows only 1.1", () => {
    const container = readContainer(
      encodeHead(SETS),
      "head",
      new Set([SECTION.head, SECTION.headCounts]),
    );
    expect(container.sections.has(SECTION.headPackSets)).toBe(true);
  });

  it("refuses sets out of order on encode and reads an odd section as no sets", () => {
    expect(() =>
      encodeHead({ ...HEAD, packSets: { epoch: 3, latest: 5, first: 6, parts: 1 } }),
    ).toThrow(RangeError);
    expect(() =>
      encodeHead({ ...HEAD, packSets: { epoch: 0, latest: 5, first: 5, parts: 1 } }),
    ).toThrow(RangeError);
    const bytes = encodeHead(SETS);
    expect(() =>
      encodeHead({ ...HEAD, packSets: { epoch: 3, latest: 5, first: 5, parts: 0 } }),
    ).toThrow(RangeError);
    for (const values of [
      u32(3, 5, 6, 1),
      u32(0, 5, 5, 1),
      u32(3, 5, 5, 0),
      u32(3, 5, 5, 65),
      u32(3, 5, 5),
    ]) {
      const odd = decodeHead(rebuilt(bytes, { [SECTION.headPackSets]: values }));
      expect(odd.packSets).toBeUndefined();
      expect(odd.sequence).toBe(SETS.sequence);
    }
    const longer = decodeHead(rebuilt(bytes, { [SECTION.headPackSets]: u32(3, 9, 8, 2, 77, 1) }));
    expect(longer.packSets).toEqual({ epoch: 3, latest: 9, first: 8, parts: 2 });
  });

  describe("plan", () => {
    const head = (latest: number, first: number): Head => ({
      ...HEAD,
      packSets: { epoch: 3, latest, first, parts: 2 },
    });

    it("asks for nothing without sets or when the latest is held", () => {
      expect(packSetPlan(HEAD, null)).toBeNull();
      expect(packSetPlan(head(10, 8), { epoch: 3, id: 10 })).toBeNull();
    });

    it("loads the base set on joining, after another epoch or a broken chain", () => {
      expect(packSetPlan(head(10, 8), null)).toEqual({ base: 10, parts: 2 });
      expect(packSetPlan(head(10, 8), { epoch: 2, id: 9 })).toEqual({ base: 10, parts: 2 });
      expect(packSetPlan(head(10, 8), { epoch: 3, id: 7 })).toEqual({ base: 10, parts: 2 });
      expect(packSetPlan(head(10, 8), { epoch: 3, id: 11 })).toEqual({ base: 10, parts: 2 });
    });

    it("loads the increments after the held set while the head keeps them", () => {
      expect(packSetPlan(head(10, 8), { epoch: 3, id: 9 })).toEqual({ from: 10, to: 10 });
      expect(packSetPlan(head(10, 8), { epoch: 3, id: 8 })).toEqual({ from: 9, to: 10 });
      const far = head(100, 0);
      expect(packSetPlan(far, { epoch: 3, id: 100 - MAX_PACK_SET_INCREMENTS })).toEqual({
        from: 101 - MAX_PACK_SET_INCREMENTS,
        to: 100,
      });
      expect(packSetPlan(far, { epoch: 3, id: 99 - MAX_PACK_SET_INCREMENTS })).toEqual({
        base: 100,
        parts: 2,
      });
    });
  });
});
