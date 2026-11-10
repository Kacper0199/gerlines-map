import { describe, expect, it } from "vitest";
import { HEADER, SECTION } from "../src/constants.ts";
import { readColumn, writeContainer } from "../src/container.ts";
import { crc32 } from "../src/crc32.ts";
import {
  decodeHead,
  decodeKeyframe,
  encodeHead,
  encodeKeyframe,
  FrameDecodeError,
  frameToObject,
  peekHeader,
} from "../src/index.ts";
import { HEAD, KEYFRAME } from "./fixtures.ts";

const META = { sequence: 5, baseSequence: 0, timetableVersion: 7, timeBase: 1000, shapeEpoch: 0 };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FrameDecodeError) return error.code;
    throw error;
  }
  return "decoded";
}

function resealed(bytes: Uint8Array, edit: (view: DataView) => void): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  edit(view);
  view.setUint32(HEADER.crc32, 0, true);
  view.setUint32(HEADER.crc32, crc32(copy), true);
  return copy;
}

describe("crc32", () => {
  it("matches the CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("container", () => {
  it("writes the header of FORMAT.md section 2.1", () => {
    const bytes = encodeKeyframe(KEYFRAME);
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("GLFR");
    expect(view.getUint8(HEADER.versionMajor)).toBe(1);
    expect(view.getUint8(HEADER.versionMinor)).toBe(0);
    expect(view.getUint8(HEADER.kind)).toBe(1);
    expect(view.getUint16(HEADER.headerLength, true)).toBe(40);
    expect(view.getUint32(HEADER.totalLength, true)).toBe(bytes.length);
    expect(view.getUint32(HEADER.sequence, true)).toBe(KEYFRAME.sequence);
    expect(view.getUint32(HEADER.timetableVersion, true)).toBe(KEYFRAME.timetableVersion);
    expect(view.getUint32(HEADER.timeBase, true)).toBe(KEYFRAME.timeBase);
    expect(peekHeader(bytes)).toMatchObject({ kind: "keyframe", sequence: 1000 });
  });

  it("starts every section at a multiple of 8 in ascending id order", () => {
    const bytes = encodeKeyframe(KEYFRAME);
    const view = new DataView(bytes.buffer);
    const count = view.getUint16(HEADER.sectionCount, true);
    let previousId = -1;
    for (let i = 0; i < count; i++) {
      const entry = 40 + i * 12;
      expect(view.getUint32(entry + 4, true) % 8).toBe(0);
      expect(view.getUint16(entry, true)).toBeGreaterThan(previousId);
      previousId = view.getUint16(entry, true);
    }
  });

  it("writes a container without sections", () => {
    const bytes = writeContainer("head", META, []);
    expect(bytes.length).toBe(40);
    expect(peekHeader(bytes).kind).toBe("head");
  });

  it("names each rejection with a code", () => {
    const bytes = encodeKeyframe(KEYFRAME);
    expect(codeOf(() => decodeKeyframe(bytes.subarray(0, 2)))).toBe("truncated");
    expect(codeOf(() => decodeKeyframe(bytes.subarray(0, 30)))).toBe("truncated");
    expect(codeOf(() => decodeKeyframe(bytes.subarray(0, bytes.length - 1)))).toBe("truncated");
    expect(codeOf(() => decodeKeyframe(new Uint8Array(64)))).toBe("bad_magic");
    const longer = new Uint8Array(bytes.length + 8);
    longer.set(bytes);
    expect(codeOf(() => decodeKeyframe(longer))).toBe("corrupt");
    const flipped = bytes.slice();
    flipped[bytes.length - 1] = (flipped[bytes.length - 1] ?? 0) ^ 1;
    expect(codeOf(() => decodeKeyframe(flipped))).toBe("checksum");
    expect(codeOf(() => decodeKeyframe(resealed(bytes, (v) => v.setUint8(4, 2))))).toBe(
      "unsupported_version",
    );
    expect(codeOf(() => decodeKeyframe(resealed(bytes, (v) => v.setUint8(6, 9))))).toBe(
      "wrong_kind",
    );
    expect(codeOf(() => decodeKeyframe(resealed(bytes, (v) => v.setUint16(8, 36, true))))).toBe(
      "corrupt",
    );
    expect(codeOf(() => decodeKeyframe(resealed(bytes, (v) => v.setUint16(8, 44, true))))).toBe(
      "corrupt",
    );
    expect(
      codeOf(() => decodeKeyframe(resealed(bytes, (v) => v.setUint16(10, 60_000, true)))),
    ).toBe("corrupt");
  });

  it("checks the CRC-32 before the version, the header length and the kind", () => {
    const bytes = encodeKeyframe(KEYFRAME);
    for (const [offset, value] of [
      [HEADER.versionMajor, 2],
      [HEADER.headerLength, 36],
      [HEADER.kind, 9],
    ] as const) {
      const damaged = bytes.slice();
      damaged[offset] = value;
      expect(codeOf(() => decodeKeyframe(damaged))).toBe("checksum");
    }
  });

  it("rejects sections outside the object, overlapping or repeated", () => {
    const data = new Uint32Array([1, 2]);
    const two = writeContainer("head", META, [
      { id: SECTION.head, data },
      { id: 0x99, data },
    ]);
    expect(codeOf(() => decodeHead(resealed(two, (v) => v.setUint32(44, 8, true))))).toBe(
      "corrupt",
    );
    expect(codeOf(() => decodeHead(resealed(two, (v) => v.setUint32(40 + 8, 4096, true))))).toBe(
      "corrupt",
    );
    expect(
      codeOf(() =>
        decodeHead(resealed(two, (v) => v.setUint32(40 + 12 + 4, v.getUint32(44, true), true))),
      ),
    ).toBe("corrupt");
    expect(
      codeOf(() => decodeHead(resealed(two, (v) => v.setUint16(52, SECTION.head, true)))),
    ).toBe("corrupt");
  });

  it("rejects a missing required section and a length that splits an element", () => {
    expect(codeOf(() => decodeHead(writeContainer("head", META, [])))).toBe("corrupt");
    const odd = writeContainer("head", META, [{ id: SECTION.head, data: new Uint8Array(5) }]);
    expect(codeOf(() => decodeHead(odd))).toBe("corrupt");
  });

  it("skips unknown sections, reads a newer minor and a longer header", () => {
    const head = encodeHead(HEAD);
    const decoded = decodeHead(head);
    const extra = writeContainer(
      "head",
      { ...HEAD, baseSequence: 0, shapeEpoch: 0 },
      [
        { id: SECTION.head, data: new Uint32Array([1000, 1001, 900]) },
        { id: 0x6f, data: new Float64Array([1.5]) },
      ],
      { versionMinor: 7, headerLength: 48 },
    );
    expect(decodeHead(extra)).toEqual(decoded);
    expect(peekHeader(extra)).toMatchObject({ versionMinor: 7, headerLength: 48 });
  });

  it("rejects an unknown critical section", () => {
    const bytes = writeContainer("head", META, [
      { id: SECTION.head, data: new Uint32Array([5, 5, 5]) },
      { id: 0x6f, data: new Uint8Array(1), critical: true },
    ]);
    expect(codeOf(() => decodeHead(bytes))).toBe("unsupported_version");
  });

  it("rejects header fields the encoder cannot store", () => {
    expect(() => writeContainer("head", { ...META, timeBase: 2 ** 32 }, [])).toThrow(/timeBase/);
  });
});

describe("readColumn", () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);

  it("views aligned little-endian data in place", () => {
    const column = readColumn(bytes, 0, 8, "u32");
    expect(column.buffer).toBe(bytes.buffer);
    expect(Array.from(column)).toEqual([0x03020100, 0x07060504]);
  });

  it("copies unaligned data with the same values", () => {
    const column = readColumn(bytes, 1, 4, "u16");
    expect(column.buffer).not.toBe(bytes.buffer);
    expect(Array.from(column)).toEqual([0x0201, 0x0403]);
  });

  it("reads element by element on a big-endian host", () => {
    for (const type of ["u8", "u16", "i16", "u32", "i32", "f32"] as const) {
      const native = readColumn(bytes, 0, 8, type);
      const portable = readColumn(bytes, 0, 8, type, false);
      expect(portable.buffer).not.toBe(bytes.buffer);
      expect(Array.from(portable)).toEqual(Array.from(native));
    }
  });
});

describe("keyframe through the container", () => {
  it("still decodes after a needless re-seal", () => {
    const bytes = resealed(encodeKeyframe(KEYFRAME), () => undefined);
    expect(frameToObject(decodeKeyframe(bytes)).trips).toHaveLength(4);
  });
});
