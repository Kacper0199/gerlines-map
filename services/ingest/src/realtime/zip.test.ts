import { describe, expect, it } from "vitest";
import { zip } from "./zip.test-support.ts";
import { ZipArchive } from "./zip.ts";

describe("ZipArchive", () => {
  it("reads deflated members", () => {
    const archive = ZipArchive.fromBytes(
      zip([{ name: "stops.txt", data: Buffer.from("a,b\n1,2\n") }]),
    );
    expect(archive.read("stops.txt").toString()).toBe("a,b\n1,2\n");
  });

  it("refuses an archive whose members together inflate past the cap", () => {
    const bytes = zip([
      { name: "a.txt", data: Buffer.from("x"), declaredSize: 900 * 1024 * 1024 },
      { name: "b.txt", data: Buffer.from("y"), declaredSize: 900 * 1024 * 1024 },
    ]);
    expect(() => ZipArchive.fromBytes(bytes)).toThrow(/inflates to more than/);
  });

  it("never inflates a member past the size its directory declares", () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const archive = ZipArchive.fromBytes(zip([{ name: "a.txt", data: big, declaredSize: 10 }]));
    expect(() => archive.read("a.txt")).toThrow("zip member a.txt inflates past its declared size");
  });

  it("names a corrupt directory instead of failing with a range error", () => {
    const bytes = zip([{ name: "stops.txt", data: Buffer.from("a\n") }]);
    const broken = Buffer.from(bytes);
    broken.writeUInt32LE(bytes.length + 1000, bytes.length - 6);
    expect(() => ZipArchive.fromBytes(broken)).toThrow("zip central directory is corrupt");
    const outside = Buffer.from(bytes);
    const centralAt = outside.readUInt32LE(outside.length - 6);
    outside.writeUInt32LE(bytes.length + 5000, centralAt + 42);
    expect(() => ZipArchive.fromBytes(outside).read("stops.txt")).toThrow(
      "zip member stops.txt: data outside the archive",
    );
  });
});
