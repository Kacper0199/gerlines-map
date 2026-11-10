import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeDelta, encodeHead, encodeKeyframe, type Head } from "@gerlines/live-frame";
import { afterEach, describe, expect, it } from "vitest";
import { newChainStart, restoreChain } from "./restore.ts";
import { FileStore } from "./storage.ts";

const N = 25_700_000;
const TIME = 1_792_922_400;
let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function publishedChain(): Promise<FileStore> {
  root = await mkdtemp(join(tmpdir(), "live-restore-"));
  const store = new FileStore(root);
  const base = { timetableVersion: 1, shapeEpoch: 1, timeBase: TIME, trips: [] };
  await store.object("k", N, encodeKeyframe({ kind: "keyframe", sequence: N, ...base }));
  const delta = { kind: "delta" as const, sequence: N + 1, baseSequence: N, removed: [], ...base };
  await store.object("d", N + 1, encodeDelta(delta));
  const head: Head = {
    kind: "head",
    sequence: N + 1,
    timetableVersion: 1,
    timeBase: TIME,
    keyframeSequence: N,
    oldestSequence: N + 1,
  };
  await store.head(encodeHead(head), head);
  return store;
}

function strayDelta(sequence: number): Uint8Array {
  return encodeDelta({
    kind: "delta",
    sequence,
    baseSequence: sequence - 1,
    timetableVersion: 1,
    shapeEpoch: 1,
    timeBase: TIME + 2,
    trips: [],
    removed: [],
  });
}

describe("restoreChain", () => {
  it("continues a chain whose head names the newest object", async () => {
    const restored = await restoreChain(await publishedChain(), 1);
    expect(restored.kind).toBe("chain");
    if (restored.kind === "chain") expect(restored.chain.sequence).toBe(N + 1);
  });

  it("starts a new chain above a delta written after the head", async () => {
    const store = await publishedChain();
    await store.object("d", N + 2, strayDelta(N + 2));
    const restored = await restoreChain(store, 1);
    expect(restored).toMatchObject({ kind: "none", floor: N + 2 });
    expect(newChainStart(TIME, restored.kind === "none" ? restored.floor : 0)).toBeGreaterThan(
      N + 2,
    );
  });

  it("takes the floor from the objects when the head is missing", async () => {
    root = await mkdtemp(join(tmpdir(), "live-restore-"));
    const store = new FileStore(root);
    await store.object("d", N + 5, strayDelta(N + 5));
    expect(await restoreChain(store, 1)).toMatchObject({
      kind: "none",
      reason: "no head",
      floor: N + 5,
    });
  });

  it("starts a new chain when a delta the head names is missing", async () => {
    const store = await publishedChain();
    await rm(join(root, "d", `${N + 1}.bin`));
    expect(await restoreChain(store, 1)).toMatchObject({
      kind: "none",
      reason: `delta ${N + 1} missing`,
      floor: N + 1,
    });
  });

  it("starts a new chain when the keyframe is damaged", async () => {
    const store = await publishedChain();
    await writeFile(join(root, "k", `${N}.bin`), new Uint8Array([1, 2, 3, 4]));
    const restored = await restoreChain(store, 1);
    expect(restored.kind).toBe("none");
    if (restored.kind === "none") {
      expect(restored.reason).toMatch(/^damaged/);
      expect(restored.floor).toBe(N + 1);
    }
  });

  it("starts a new chain when the keyframe names another shape epoch", async () => {
    const store = await publishedChain();
    expect(await restoreChain(store, 2)).toMatchObject({
      kind: "none",
      reason: "keyframe of shape epoch 1, packs at 2",
      floor: N + 1,
    });
  });
});
