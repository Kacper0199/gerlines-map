import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTar, type TarEntry } from "./tar.ts";

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function entry(name: string, data: Buffer, type = "0"): Buffer {
  return Buffer.concat([header(name, data.length, type), padded(data)]);
}

async function* chunked(buffer: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size);
  }
}

async function collect(
  source: AsyncIterable<Buffer>,
  maxEntryBytes = 1024 * 1024,
): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  for await (const item of readTar(source, { maxEntryBytes })) entries.push(item);
  return entries;
}

describe("readTar", () => {
  it("yields files with their bytes across any chunking, skipping directories", async () => {
    const a = Buffer.from("first payload");
    const b = Buffer.alloc(1300, 7);
    const tar = Buffer.concat([
      entry("2026-10-28/", Buffer.alloc(0), "5"),
      entry("2026-10-28/2026-10-28T08:05:01+01:00.gtfs-rt.pbf", a),
      entry("2026-10-28/2026-10-28T06:06:01+01:00.gtfs-rt.pbf", b),
      Buffer.alloc(1024),
    ]);
    for (const size of [1, 7, 512, 1000, tar.length]) {
      const entries = await collect(chunked(tar, size));
      expect(
        entries.map((e) => e.name),
        String(size),
      ).toEqual([
        "2026-10-28/2026-10-28T08:05:01+01:00.gtfs-rt.pbf",
        "2026-10-28/2026-10-28T06:06:01+01:00.gtfs-rt.pbf",
      ]);
      expect(entries[0]?.data.equals(a)).toBe(true);
      expect(entries[1]?.data.equals(b)).toBe(true);
    }
  });

  it("reads GNU long names and pax paths", async () => {
    const long = `${"d".repeat(120)}/file.pbf`;
    const pax = Buffer.from(`${(`path=pax/name.pbf\n`.length + 3).toString()} path=pax/name.pbf\n`);
    const tar = Buffer.concat([
      entry("././@LongLink", Buffer.from(`${long}\0`), "L"),
      entry(long.slice(0, 100), Buffer.from("x"), "0"),
      entry("PaxHeader", pax, "x"),
      entry("short", Buffer.from("y"), "0"),
      Buffer.alloc(1024),
    ]);
    const entries = await collect(chunked(tar, 300));
    expect(entries.map((e) => e.name)).toEqual([long, "pax/name.pbf"]);
  });

  it("refuses an entry larger than the limit instead of buffering it", async () => {
    const tar = Buffer.concat([entry("big", Buffer.alloc(5000)), Buffer.alloc(1024)]);
    await expect(collect(chunked(tar, 512), 4096)).rejects.toThrow(/exceeds 4096/);
  });

  it("fails on a stream that ends inside an entry", async () => {
    const tar = entry("cut", Buffer.alloc(3000)).subarray(0, 2000);
    await expect(collect(chunked(tar, 512))).rejects.toThrow(/ends inside/);
  });

  it("fails on a header whose checksum does not match", async () => {
    const tar = Buffer.concat([entry("ok", Buffer.from("a")), Buffer.alloc(1024)]);
    tar[0] = "X".charCodeAt(0);
    await expect(collect(chunked(tar, 512))).rejects.toThrow(/checksum/);
  });
});

describe("readTar on an archive made by the system tar", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gerlines-tar-"));
    await mkdir(join(dir, "2026-10-28"));
    await writeFile(
      join(dir, "2026-10-28", "2026-10-28T00:00:01+01:00.gtfs-rt.pbf"),
      Buffer.alloc(70_000, 3),
    );
    await writeFile(join(dir, "2026-10-28", "2026-10-28T00:01:01+01:00.gtfs-rt.pbf"), "small");
    execFileSync("tar", ["-cf", "day.tar", "2026-10-28"], {
      cwd: dir,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists every file with its size", async () => {
    const tar = await readFile(join(dir, "day.tar"));
    const entries = await collect(chunked(tar, 4096));
    expect(
      entries
        .map((e) => [e.name, e.data.length])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ["2026-10-28/2026-10-28T00:00:01+01:00.gtfs-rt.pbf", 70_000],
      ["2026-10-28/2026-10-28T00:01:01+01:00.gtfs-rt.pbf", 5],
    ]);
  });
});
