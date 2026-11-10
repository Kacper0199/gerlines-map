import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reindexAll } from "./reindex.ts";
import type { SourceDefinition } from "./sources.ts";
import { RunLog } from "./storage/runs.ts";
import { FakeIndex } from "./testing/fake-index.ts";

let root: string;
const sources = ["first-rt", "second-rt", "third-rt"].map(
  (id) => ({ id, periodMs: 60_000 }) as SourceDefinition,
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-reindex-unit-"));
  const runs = new RunLog(root);
  for (const [n, source] of sources.entries()) {
    await runs.start({
      run: `run-${n}`,
      source: source.id,
      job: "record",
      appVersion: "0.1.0",
      at: "2026-11-08T15:00:00.000Z",
    });
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("reindexAll", () => {
  it("stops between sources once the signal aborts", async () => {
    const index = new FakeIndex();
    const stop = new AbortController();
    index.onWrite = (what) => {
      if (what === "run") stop.abort();
    };

    const reports = await reindexAll(root, index, sources, { signal: stop.signal });

    expect(reports.map((report) => report.source)).toEqual(["first-rt"]);
    expect([...index.runs.keys()]).toEqual(["run-0"]);
  });

  it("reindexes every source without a signal", async () => {
    const index = new FakeIndex();

    const reports = await reindexAll(root, index, sources);

    expect(reports).toHaveLength(3);
    expect(index.runs.size).toBe(3);
  });
});
