import type { Head } from "@gerlines/live-frame";
import { describe, expect, it, vi } from "vitest";
import { PackSetLoader } from "./pack-sets.ts";

const HEAD: Head = {
  kind: "head",
  sequence: 10,
  timetableVersion: 2,
  timeBase: 1_797_000_000,
  keyframeSequence: 9,
  oldestSequence: 2,
};

const withSets = (latest: number, first = latest - 3, epoch = 3, parts = 1): Head => ({
  ...HEAD,
  packSets: { epoch, latest, first, parts },
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(answer: (path: string) => number | null = () => 4) {
  const paths: string[] = [];
  const store = {
    loadSets: vi.fn(
      async (_epoch: number, parts: readonly (() => Promise<Uint8Array | null>)[]) => {
        let added = 0;
        let read = 0;
        for (const fetch of parts) {
          await fetch();
          const count = answer(paths.at(-1) as string);
          if (count === null) return { added, read, failure: "not_found" };
          added += count;
          read++;
        }
        return { added, read, failure: null };
      },
    ),
  };
  const loader = new PackSetLoader({
    store,
    read: async (path) => {
      paths.push(path);
      return new Uint8Array(1);
    },
  });
  return { loader, paths, store };
}

describe("PackSetLoader", () => {
  it("does nothing for a head without sets or of another epoch than the frames", async () => {
    const { loader, paths } = setup();
    loader.offer(HEAD, null);
    loader.offer(withSets(100, 97, 2), 3);
    await settle();
    expect(paths).toEqual([]);
  });

  it("loads the base set on joining, then the increments as the windows pass", async () => {
    const { loader, paths } = setup();
    loader.offer(withSets(100), null);
    await settle();
    loader.offer(withSets(100), 3);
    loader.offer(withSets(102), 3);
    await settle();
    expect(paths).toEqual(["sets/3/b/100/0.bin", "sets/3/i/101.bin", "sets/3/i/102.bin"]);
    expect(loader.stats()).toEqual({
      held: { epoch: 3, id: 102 },
      sets: 3,
      shapes: 12,
      failures: 0,
      failuresByCode: {},
    });
  });

  it("runs one plan at a time", async () => {
    const { loader, paths } = setup();
    loader.offer(withSets(100), null);
    loader.offer(withSets(100), null);
    await settle();
    expect(paths).toEqual(["sets/3/b/100/0.bin"]);
  });

  it("does not ask again for a set it could not read until a newer one is named", async () => {
    const { loader, paths } = setup((path) => (path.includes("/100/") ? null : 4));
    loader.offer(withSets(100), null);
    await settle();
    loader.offer(withSets(100), null);
    await settle();
    loader.offer(withSets(101), null);
    await settle();
    expect(paths).toEqual(["sets/3/b/100/0.bin", "sets/3/b/101/0.bin"]);
    expect(loader.stats()).toMatchObject({ held: { epoch: 3, id: 101 }, failures: 1 });
  });

  it("loads the base again after a gap the increments do not bridge", async () => {
    const { loader, paths } = setup();
    loader.offer(withSets(100), null);
    await settle();
    loader.offer(withSets(110, 108), 3);
    await settle();
    expect(paths).toEqual(["sets/3/b/100/0.bin", "sets/3/b/110/0.bin"]);
  });

  it("reads every part of a base set in order", async () => {
    const { loader, paths } = setup();
    loader.offer(withSets(100, 97, 3, 3), null);
    await settle();
    expect(paths).toEqual(["sets/3/b/100/0.bin", "sets/3/b/100/1.bin", "sets/3/b/100/2.bin"]);
    expect(loader.stats()).toEqual({
      held: { epoch: 3, id: 100 },
      sets: 3,
      shapes: 12,
      failures: 0,
      failuresByCode: {},
    });
  });

  it("holds the increments it read when a later one fails", async () => {
    const { loader, paths } = setup((path) => (path.endsWith("/102.bin") ? null : 4));
    loader.offer(withSets(100), null);
    await settle();
    loader.offer(withSets(103), 3);
    await settle();
    expect(paths.slice(1)).toEqual(["sets/3/i/101.bin", "sets/3/i/102.bin"]);
    expect(loader.stats()).toMatchObject({ held: { epoch: 3, id: 101 }, failures: 1 });
  });

  it("holds a base read in part, so the next window brings an increment", async () => {
    const { loader, paths } = setup((path) => (path.endsWith("/100/1.bin") ? null : 4));
    loader.offer(withSets(100, 97, 3, 3), null);
    await settle();
    expect(loader.stats()).toMatchObject({
      held: { epoch: 3, id: 100 },
      failures: 1,
      failuresByCode: { not_found: 1 },
    });
    loader.offer(withSets(101, 98, 3, 3), 3);
    await settle();
    expect(paths.at(-1)).toBe("sets/3/i/101.bin");
  });
});
