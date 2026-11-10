import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import index from "../test-vectors/index.json" with { type: "json" };
import { atOddOffset, decodeVector, encodeVector, type VectorFile } from "./golden.ts";
import { goldenVectors } from "./vectors.ts";

const directory = new URL("../test-vectors/", import.meta.url);

function load(name: string): { file: VectorFile; bytes: Uint8Array } {
  return {
    file: JSON.parse(readFileSync(new URL(`${name}.json`, directory), "utf8")) as VectorFile,
    bytes: new Uint8Array(readFileSync(new URL(`${name}.bin`, directory))),
  };
}

describe("golden vectors", () => {
  it("are the vectors the generator defines (rerun pnpm vectors after a deliberate change)", () => {
    expect(index).toEqual(goldenVectors().map((vector) => vector.name));
    for (const vector of goldenVectors()) {
      const { file, bytes } = load(vector.name);
      expect(bytes).toEqual(vector.bytes);
      expect(file.byteLength).toBe(bytes.length);
    }
  });

  it.each(index)("%s decodes to its JSON", (name) => {
    const { file, bytes } = load(name);
    expect(decodeVector(file.decoder, bytes)).toEqual(
      file.error ? { error: file.error } : { value: file.expected },
    );
  });

  it.each(index)("%s decodes the same from an odd byte offset", (name) => {
    const { file, bytes } = load(name);
    expect(decodeVector(file.decoder, atOddOffset(bytes))).toEqual(
      file.error ? { error: file.error } : { value: file.expected },
    );
  });

  it.each(index.filter((name) => !/^invalid-|future|unaligned/.test(name)))(
    "%s JSON encodes to its bytes",
    (name) => {
      const { file, bytes } = load(name);
      expect(encodeVector(file)).toEqual(bytes);
    },
  );
});
