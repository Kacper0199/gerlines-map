import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeShapePack } from "../src/index.ts";
import {
  decodeShapePack as decode11,
  shapePackToObject as object11,
} from "./decoder-1.1/shape-pack.ts";
import { PACK_NUMBERED, PACK_STUBS } from "./fixtures.ts";

const vector = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../test-vectors/${name}.bin`, import.meta.url)));

describe("a 1.1 decoder reading a 1.2 pack with stubs", () => {
  it("reads the committed stub vector as the same pack without stubs", () => {
    const bytes = vector("shape-pack-stubs");
    expect(bytes).toEqual(encodeShapePack(PACK_STUBS));
    const view = decode11(bytes);
    expect(view.header.versionMinor).toBe(2);
    expect(object11(view)).toEqual(PACK_NUMBERED);
  });
});

describe("a 1.1 decoder meeting a 1.4 compact pack", () => {
  it("refuses it as an unsupported version instead of reading other values", () => {
    expect(() => decode11(vector("shape-pack-compact"))).toThrow(
      expect.objectContaining({ code: "unsupported_version" }),
    );
  });
});
