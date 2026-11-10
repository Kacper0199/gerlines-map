import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { decodeShapePack, type ShapePackView, shapePolyline } from "@gerlines/live-frame";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../publish/storage.ts";
import { packSetsEnabled, startPackSetBuild } from "../run.ts";
import { diskFiles, type SetFiles } from "./set-build.ts";
import {
  inlineRunner,
  PACK_SET_LEAD_S,
  PACK_SET_WINDOW_S,
  PackSetPublisher,
  packSetDue,
  WorkerRunner,
} from "./sets.ts";

const FIXTURE = new URL("../../../../apps/web/e2e/fixture/data/live/s/3/", import.meta.url);
const EPOCH = 3;

let root = "";
let numbers: number[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "live-sets-"));
  const store = new FileStore(root);
  const names = (await readdir(FIXTURE)).filter((name) => name.endsWith(".bin")).slice(0, 6);
  numbers = names.map((name) => Number.parseInt(name, 10)).sort((a, b) => a - b);
  for (const number of numbers) {
    const bytes = new Uint8Array(await readFile(new URL(`${number}.bin`, FIXTURE)));
    await store.pack(EPOCH, number, bytes);
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function packAt(relative: string): Promise<ShapePackView> {
  const plain = await readFile(join(root, relative));
  const br = await readFile(join(root, `${relative}.br`));
  expect(Buffer.compare(brotliDecompressSync(br), plain)).toBe(0);
  return decodeShapePack(new Uint8Array(plain));
}

const base = (id: number, part = 0) => packAt(`sets/${EPOCH}/b/${id}/${part}.bin`);
const increment = (id: number) => packAt(`sets/${EPOCH}/i/${id}.bin`);
const numbersOf = (view: ShapePackView) => Array.from(view.number ?? []).sort((a, b) => a - b);
const upTo = (count: number) => () => numbers.slice(0, count);
const listed = async (path: string) => (await readdir(join(root, path)).catch(() => [])).sort();

/** Disk files that throw on the `failAt`th write, as a full disk or an I/O error would. */
function failingFiles(failAt: number): SetFiles {
  let writes = 0;
  return {
    ...diskFiles,
    write: (path, bytes) => {
      writes++;
      if (writes === failAt) throw new Error("ENOSPC: no space left on device");
      diskFiles.write(path, bytes);
    },
  };
}

describe("PackSetPublisher", () => {
  it("names the set whose window starts within the lead", () => {
    const id = 2_995_000;
    const start = id * PACK_SET_WINDOW_S;
    expect(packSetDue(start - PACK_SET_LEAD_S - 1)).toBe(id - 1);
    expect(packSetDue(start - PACK_SET_LEAD_S)).toBe(id);
  });

  it("publishes a base set whose shapes decode to the same positions as their packs", async () => {
    const sets = new PackSetPublisher(root, EPOCH);
    expect(sets.current()).toBeNull();
    const id = sets.due(2_995_000 * PACK_SET_WINDOW_S) as number;
    let asked = 0;
    const report = await sets.build(
      id,
      (until) => {
        asked = until;
        return [...numbers.slice(0, 4), 999_999_999];
      },
      2,
    );
    expect(asked).toBe((id + 1) * PACK_SET_WINDOW_S);
    expect(report).toMatchObject({ id, shapes: 4, parts: 1, increment: 0, absent: 1 });
    expect(report.adopted).toBe(false);
    expect(sets.current()).toEqual({ epoch: EPOCH, latest: id, first: id, parts: 1 });
    expect(sets.due(2_995_000 * PACK_SET_WINDOW_S)).toBeNull();
    const set = await base(id);
    expect(set.compact).toBe(true);
    expect(Array.from(set.absent ?? [])).toEqual([999_999_999]);
    expect(numbersOf(set)).toEqual(numbers.slice(0, 4));
    for (let i = 0; i < set.count; i++) {
      const single = await packAt(`s/${EPOCH}/${set.number?.[i]}.bin`);
      expect(shapePolyline(set, i)).toEqual(shapePolyline(single, 0));
    }
    expect(await listed(`sets/${EPOCH}`)).toEqual(["b"]);
  });

  it("cuts a large base set into parts of nearby shapes", async () => {
    const sets = new PackSetPublisher(root, EPOCH, { partVertices: 1 });
    const report = await sets.build(100, upTo(6), 2);
    expect(report.parts).toBe(6);
    expect(sets.current()).toMatchObject({ parts: 6 });
    const seen: number[] = [];
    for (let part = 0; part < 6; part++) {
      const view = await base(100, part);
      expect(view.count).toBe(1);
      seen.push(view.number?.[0] as number);
    }
    expect(seen.sort((a, b) => a - b)).toEqual(numbers);
  });

  it("publishes the next window's increment with only the new shapes", async () => {
    const sets = new PackSetPublisher(root, EPOCH);
    await sets.build(100, upTo(3), 2);
    const report = await sets.build(101, upTo(5), 2);
    expect(report).toMatchObject({ id: 101, shapes: 5, increment: 2 });
    expect(numbersOf(await increment(101))).toEqual(numbers.slice(3, 5));
    expect(Array.from((await increment(101)).absent ?? [1])).toEqual([]);
    expect(sets.current()).toEqual({ epoch: EPOCH, latest: 101, first: 100, parts: 1 });
  });

  it("starts a new chain after a window without a set", async () => {
    const sets = new PackSetPublisher(root, EPOCH);
    await sets.build(100, upTo(3), 2);
    await sets.build(102, upTo(4), 2);
    expect(sets.current()).toEqual({ epoch: EPOCH, latest: 102, first: 102, parts: 1 });
    await expect(increment(102)).rejects.toThrow();
  });

  it("leaves nothing in place when the store fails halfway, waits for the next window, then builds", async () => {
    for (const failAt of [1, 3, 5, 7]) {
      await rm(join(root, "sets"), { recursive: true, force: true });
      await new PackSetPublisher(root, EPOCH, { partVertices: 1 }).build(100, upTo(3), 2);
      const sets = new PackSetPublisher(root, EPOCH, {
        partVertices: 1,
        runner: inlineRunner(failingFiles(failAt)),
      });
      const now = 101 * PACK_SET_WINDOW_S - PACK_SET_LEAD_S;
      expect(sets.due(now)).toBe(101);
      await expect(sets.build(101, upTo(6), 2)).rejects.toThrow("ENOSPC");
      expect(sets.current()).toBeNull();
      expect(await listed(`sets/${EPOCH}/b`)).toEqual(["100"]);
      expect(await listed(`sets/${EPOCH}/i`)).toEqual([]);
      expect(sets.due(now)).toBeNull();
      expect(sets.due(now + 300)).toBeNull();
      expect(sets.due(now + PACK_SET_WINDOW_S)).toBe(102);
      const retry = new PackSetPublisher(root, EPOCH, { partVertices: 1 });
      await retry.build(101, upTo(6), 2);
      expect(retry.current()).toEqual({ epoch: EPOCH, latest: 101, first: 100, parts: 6 });
      expect(await listed(`sets/${EPOCH}`)).toEqual(["b", "i"]);
    }
  });

  it("cleans up an increment moved into place without its base before building again", async () => {
    await new PackSetPublisher(root, EPOCH).build(100, upTo(3), 2);
    let renames = 0;
    const files: SetFiles = {
      ...diskFiles,
      rename: (from, to) => {
        renames++;
        if (renames === 4) throw new Error("EIO: i/o error");
        diskFiles.rename(from, to);
      },
    };
    const sets = new PackSetPublisher(root, EPOCH, { runner: inlineRunner(files) });
    await expect(sets.build(101, upTo(5), 2)).rejects.toThrow("EIO");
    expect(sets.current()).toBeNull();
    expect(await listed(`sets/${EPOCH}/i`)).toEqual(["101.bin", "101.bin.br", "101.bin.gz"]);
    const retry = new PackSetPublisher(root, EPOCH);
    await retry.build(101, upTo(6), 2);
    expect(numbersOf(await increment(101))).toEqual(numbers.slice(3, 6));
    expect(retry.current()).toEqual({ epoch: EPOCH, latest: 101, first: 100, parts: 1 });
  });

  it("counts a single pack that does not decode as absent and names it", async () => {
    const broken = numbers[1] as number;
    await writeFile(join(root, "s", String(EPOCH), `${broken}.bin`), Uint8Array.from([1, 2, 3]));
    const sets = new PackSetPublisher(root, EPOCH);
    const report = await sets.build(100, upTo(3), 2);
    expect(report).toMatchObject({ shapes: 2, absent: 1, corrupt: [broken] });
    expect(Array.from((await base(100)).absent ?? [])).toEqual([broken]);
  });

  it("adopts the sets it finds after a restart and walks the chain back", async () => {
    const before = new PackSetPublisher(root, EPOCH, { partVertices: 1 });
    for (let id = 100; id <= 103; id++) await before.build(id, upTo(2 + (id - 100)), 2);
    const after = new PackSetPublisher(root, EPOCH);
    const adopted = await after.build(103, upTo(6), 2);
    expect(adopted).toMatchObject({ id: 103, shapes: 5, parts: 5, adopted: true });
    expect(after.current()).toEqual({ epoch: EPOCH, latest: 103, first: 100, parts: 5 });
    const fresh = new PackSetPublisher(root, EPOCH);
    await fresh.build(104, upTo(6), 2);
    expect(fresh.current()).toEqual({ epoch: EPOCH, latest: 104, first: 100, parts: 1 });
  });

  it("keeps the last sets only and drops other epochs", async () => {
    await mkdir(join(root, "sets", "2", "b", "9"), { recursive: true });
    const sets = new PackSetPublisher(root, EPOCH, { kept: 2 });
    for (let id = 100; id <= 104; id++) await sets.build(id, upTo(2 + (id % 3)), 2);
    expect(sets.current()).toEqual({ epoch: EPOCH, latest: 104, first: 102, parts: 1 });
    expect(await listed("sets")).toEqual([String(EPOCH)]);
    expect(await listed(`sets/${EPOCH}/b`)).toEqual(["102", "103", "104"]);
    const increments = await listed(`sets/${EPOCH}/i`);
    expect(increments.filter((name) => name.endsWith(".bin"))).toEqual([
      "102.bin",
      "103.bin",
      "104.bin",
    ]);
  });

  it("builds on a worker thread", async () => {
    const runner = new WorkerRunner();
    try {
      const sets = new PackSetPublisher(root, EPOCH, { runner: runner.run });
      const report = await sets.build(100, upTo(4), 2);
      expect(report).toMatchObject({ shapes: 4, parts: 1 });
      expect(numbersOf(await base(100))).toEqual(numbers.slice(0, 4));
    } finally {
      await runner.close();
    }
  });
});

describe("live run pack set wiring", () => {
  it("turns sets off for 0, false, off and no", () => {
    for (const value of ["0", "false", "OFF", " no "]) {
      expect(packSetsEnabled({ LIVE_PACK_SETS: value })).toBe(false);
    }
    for (const value of [undefined, "1", "on", ""]) {
      expect(packSetsEnabled({ LIVE_PACK_SETS: value })).toBe(true);
    }
  });

  it("starts the due build once, logs it, and logs a failure without throwing", async () => {
    const lines: Record<string, unknown>[] = [];
    const sets = new PackSetPublisher(root, EPOCH);
    const engine = { shapesAhead: upTo(2), timetableVersion: 2 };
    const now = 100 * PACK_SET_WINDOW_S;
    const started = startPackSetBuild(sets, engine, now, (fields) => lines.push(fields));
    expect(startPackSetBuild(sets, engine, now, (fields) => lines.push(fields))).toBeNull();
    await started;
    expect(lines).toEqual([expect.objectContaining({ msg: "pack set", id: 100, shapes: 2 })]);
    const failing = new PackSetPublisher(root, EPOCH, { runner: inlineRunner(failingFiles(1)) });
    await startPackSetBuild(failing, engine, now + PACK_SET_WINDOW_S, (fields) =>
      lines.push(fields),
    );
    expect(lines.at(-1)).toMatchObject({ level: "error", msg: "pack set failed", id: 101 });
  });
});
