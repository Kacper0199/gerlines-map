import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  decodeSegmentHeader,
  encodeFrame,
  encodeSegmentHeader,
  STORAGE_FORMAT_VERSION,
  windowLogFor,
} from "./frame.ts";

function snapshot(seed: Buffer, changes: number): Buffer {
  const copy = Buffer.from(seed);
  for (let index = 0; index < changes; index += 1) {
    copy[(index * 7919) % copy.length] = index % 256;
  }
  return copy;
}

describe("frames", () => {
  it("round-trips a keyframe byte for byte", async () => {
    const payload = randomBytes(50_000);
    expect(
      decodeFrame(await encodeFrame(payload, null), null, payload.length).equals(payload),
    ).toBe(true);
  });

  it("stores a similar payload against its base in far fewer bytes than alone", async () => {
    const base = randomBytes(400_000);
    const next = snapshot(base, 200);
    const alone = await encodeFrame(next, null);
    const patched = await encodeFrame(next, base);
    expect(decodeFrame(patched, base, next.length).equals(next)).toBe(true);
    expect(patched.length * 20).toBeLessThan(alone.length);
  });

  it("refuses to decode a patch frame against the wrong base", async () => {
    const base = randomBytes(100_000);
    const frame = await encodeFrame(snapshot(base, 10), base);
    expect(() => decodeFrame(frame, randomBytes(100_000), 200_000)).toThrow();
  });

  it("detects a corrupted frame through the zstd checksum", async () => {
    const payload = Buffer.from("a".repeat(10_000) + randomBytes(5_000).toString("hex"));
    const frame = await encodeFrame(payload, null);
    frame[frame.length - 2] = (frame[frame.length - 2] ?? 0) ^ 0xff;
    expect(() => decodeFrame(frame, null, payload.length)).toThrow();
  });

  it("sizes the window to hold base and payload", () => {
    expect(windowLogFor(1_000)).toBe(20);
    expect(windowLogFor(7_000_000)).toBe(24);
    expect(windowLogFor(42_000_000)).toBe(27);
    expect(windowLogFor(500_000_000)).toBe(27);
  });
});

describe("segment header", () => {
  it("round-trips and carries the storage format version", () => {
    const encoded = encodeSegmentHeader({
      format: "gerlines-segment",
      version: STORAGE_FORMAT_VERSION,
      source: "delfi-gtfs-rt",
      writer: "live",
      createdAt: "2026-10-25T09:00:00.000Z",
    });
    const { header, length } = decodeSegmentHeader(Buffer.concat([encoded, Buffer.from("rest")]));
    expect(length).toBe(encoded.length);
    expect(header).toMatchObject({ source: "delfi-gtfs-rt", version: 1 });
  });

  it("refuses a newer format version", () => {
    const encoded = encodeSegmentHeader({
      format: "gerlines-segment",
      version: 99,
      source: "x",
      writer: "live",
      createdAt: "2026-10-25T09:00:00.000Z",
    });
    expect(() => decodeSegmentHeader(encoded)).toThrow(/newer/);
  });
});
