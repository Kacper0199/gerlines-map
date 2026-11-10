import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.ts";
import type { CheckpointLine } from "./processor.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerlines-checkpoint-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function* lines(instances: number): Generator<CheckpointLine> {
  yield {
    kind: "head",
    version: 1,
    feedVersions: ["2026-10-24T14:58:08"],
    database: "gerlines_rt",
  };
  yield {
    kind: "source",
    name: "delfi-gtfs-rt",
    cursor: "c",
    lastPrimaryAt: null,
    dayRanges: [["2026-10-29", { first: 1, last: 2 }]],
    entries: ["a", "c"],
    foldAt: [["a", 5]],
    pruned: { newestHeader: null, lastFoldAt: null },
    fold: { source: "delfi-gtfs-rt", ignoredAfterEviction: 0, evicted: [["x", "2026-10-28"]] },
  };
  for (let n = 0; n < instances; n += 1) {
    yield {
      kind: "instance",
      source: "delfi-gtfs-rt",
      value: {
        run: {
          kind: "timetable",
          instanceId: `i${n}`,
          serviceDate: "2026-10-29",
          feedVersionId: 3,
          tripKey: `t${n}`,
        },
        stops: [],
        legs: [1],
        lastScheduled: 10,
        cancelled: false,
        cancelEmitted: false,
        delayEmitted: 60,
        lastSeenAt: 7,
      },
    };
  }
}

describe("checkpoint files", () => {
  it("writes the snapshot whole and reads it back", async () => {
    const path = join(dir, "realtime.checkpoint.gz");
    await writeCheckpoint(path, lines(2_000));
    const snapshot = await readCheckpoint(path);
    expect(snapshot?.feedVersions).toEqual(["2026-10-24T14:58:08"]);
    expect(snapshot?.sources[0]?.fold.instances).toHaveLength(2_000);
    expect(snapshot?.sources[0]?.fold.evicted).toEqual([["x", "2026-10-28"]]);
    expect(await readdir(dir)).toEqual(["realtime.checkpoint.gz"]);
    expect(snapshot?.database).toBe("gerlines_rt");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("ignores a checkpoint that inflates past the cap", async () => {
    const path = join(dir, "large.checkpoint.gz");
    await writeCheckpoint(path, lines(2_000));
    expect(await readCheckpoint(path, 64 * 1024)).toBeUndefined();
    expect(await readCheckpoint(path)).toBeDefined();
  });

  it("reads a missing or damaged file as no checkpoint", async () => {
    expect(await readCheckpoint(join(dir, "absent.gz"))).toBeUndefined();
    const damaged = join(dir, "damaged.gz");
    await writeFile(damaged, "not gzip");
    expect(await readCheckpoint(damaged)).toBeUndefined();
  });
});
