import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "./storage.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "live-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (fill: number, length = 4096) => new Uint8Array(length).fill(fill);

describe("FileStore", () => {
  it("writes an object with brotli and gzip copies that decode to it", async () => {
    const seen: string[] = [];
    const store = new FileStore(root, (event) => seen.push(`${event.kind}:${event.path}`));
    await store.object("d", 12, bytes(7));
    const plain = await readFile(join(root, "d", "12.bin"));
    expect(
      Buffer.compare(brotliDecompressSync(await readFile(join(root, "d", "12.bin.br"))), plain),
    ).toBe(0);
    expect(Buffer.compare(gunzipSync(await readFile(join(root, "d", "12.bin.gz"))), plain)).toBe(0);
    expect(seen).toEqual(["d:d/12.bin"]);
    expect((await readdir(join(root, "d"))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("keeps an object written twice with the same bytes and refuses other bytes", async () => {
    const store = new FileStore(root);
    await store.object("k", 5, bytes(1));
    await expect(store.object("k", 5, bytes(1))).resolves.toBeUndefined();
    await expect(store.object("k", 5, bytes(2))).rejects.toThrow(/immutable/);
    expect(Buffer.compare(await readFile(join(root, "k", "5.bin")), Buffer.from(bytes(1)))).toBe(0);
  });

  it("prunes objects below a sequence with their encodings and finds the highest", async () => {
    const store = new FileStore(root);
    for (const sequence of [3, 4, 9]) await store.object("d", sequence, bytes(sequence));
    await store.object("k", 4, bytes(40));
    expect(await store.highestSequence()).toBe(9);
    expect(await store.prune(5)).toBe(9);
    expect((await readdir(join(root, "d"))).sort()).toEqual(["9.bin", "9.bin.br", "9.bin.gz"]);
    expect(await readdir(join(root, "k"))).toEqual([]);
  });

  it("reads a missing path as null", async () => {
    expect(await new FileStore(root).read("head")).toBeNull();
    expect(await new FileStore(root).highestSequence()).toBe(0);
  });
});

describe("FileStore.hasPacks", () => {
  it("is true only once the epoch's packs are marked complete, never for a pack alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-packs-"));
    try {
      const store = new FileStore(dir);
      expect(await store.hasPacks(4)).toBe(false);
      await store.pack(4, 7, new Uint8Array([1, 2, 3]));
      expect(await store.hasPacks(4)).toBe(false);
      await store.markPacksComplete(4, 1, { shapes: 1 });
      expect(await store.hasPacks(4)).toBe(true);
      expect(await store.hasPacks(4, 1)).toBe(true);
      expect(await store.hasPacks(4, 2)).toBe(false);
      expect(await store.hasPacks(5)).toBe(false);
      expect(JSON.parse(String(await store.read("s/4/complete.json")))).toMatchObject({
        epoch: 4,
        versions: { "1": { shapes: 1 } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to mark a build of no shapes complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-packs-"));
    try {
      const store = new FileStore(dir);
      await expect(store.markPacksComplete(4, 1, { shapes: 0 })).rejects.toThrow(/no shapes/);
      expect(await store.hasPacks(4)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forgets a version's mark when its build starts again, keeping other versions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-packs-"));
    try {
      const store = new FileStore(dir);
      await store.pack(4, 7, new Uint8Array([1]));
      await store.markPacksComplete(4, 1, { shapes: 1 });
      await store.markPacksComplete(4, 2, { shapes: 1 });
      await store.clearPacksComplete(4, 1);
      expect(await store.hasPacks(4, 1)).toBe(false);
      expect(await store.hasPacks(4, 2)).toBe(true);
      await store.clearPacksComplete(4, 2);
      expect(await store.hasPacks(4)).toBe(false);
      expect(await store.read("s/4/complete.json")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not count a mark whose packs are fewer than its shape count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-packs-"));
    try {
      const store = new FileStore(dir);
      await store.pack(4, 7, new Uint8Array([1]));
      await store.markPacksComplete(4, 1, { shapes: 2 });
      expect(await store.hasPacks(4, 1)).toBe(false);
      await store.pack(4, 8, new Uint8Array([2]));
      expect(await store.hasPacks(4, 1)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
