import { describe, expect, it } from "vitest";
import type { RunRow } from "../index-db.ts";
import { silentLogger } from "../log.ts";
import type { SourceDefinition } from "../sources.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { FakeIndex } from "../testing/fake-index.ts";
import { IndexSink } from "./index-sink.ts";

const source = { id: "vbn-rt" } as SourceDefinition;
const startedAt = "2026-11-08T15:01:00.000Z";

function runRow(status: RunRow["status"] = "running"): RunRow {
  return {
    id: "run-1",
    source: source.id,
    job: "record",
    appVersion: "0.1.0",
    startedAt,
    status,
    finishedAt: status === "running" ? null : "2026-11-08T15:30:00.000Z",
    error: null,
  };
}

function fetched(n: number): FetchRecord {
  return {
    v: 2,
    type: "fetch",
    source: source.id,
    run: "run-1",
    writer: "live",
    url: "https://example.org/rt.pb",
    method: "GET",
    startedAt,
    observedAt: startedAt,
    durationMs: 10,
    outcome: "stored",
    status: 200,
    headers: {},
    sha256: `${n}`.padStart(64, "0"),
    bytes: 10,
    object: {
      id: `object-${n}`,
      key: `vbn-rt/${n}`,
      encoding: "zstd",
      file: "segment",
      contentType: "application/x-protobuf",
    },
  } as FetchRecord;
}

async function start(sink: IndexSink): Promise<void> {
  await sink.sources([source]);
  await sink.failStaleRuns(source.id, "record", "run-1", new Date(startedAt));
  await sink.run(runRow());
}

describe("IndexSink after writes the database refused", () => {
  it("writes the source and run rows again before the objects that reference them", async () => {
    const index = new FakeIndex({ failFirst: 3 });
    const sink = new IndexSink(index, silentLogger);
    await start(sink);
    expect(index.runs.size).toBe(0);

    await sink.objects([fetched(1)]);

    expect([...index.objects.keys()]).toEqual(["object-1"]);
    expect(index.runs.get("run-1")?.status).toBe("running");
    expect(index.calls.slice(3)).toEqual(["sources", "stale runs", "run", "objects"]);
  });

  it("keeps only the latest row of a run whose writes were refused", async () => {
    const index = new FakeIndex({ down: true });
    const sink = new IndexSink(index, silentLogger);
    await start(sink);
    await sink.run(runRow("succeeded"));
    index.down = false;
    index.calls.length = 0;

    await sink.objects([fetched(1)]);

    expect(index.runs.get("run-1")?.status).toBe("succeeded");
    expect(index.calls).toEqual(["sources", "stale runs", "run", "objects"]);
  });

  it("retries nothing once the rows are written", async () => {
    const index = new FakeIndex({ failFirst: 1 });
    const sink = new IndexSink(index, silentLogger);
    await start(sink);
    await sink.objects([fetched(1)]);
    index.calls.length = 0;

    await sink.objects([fetched(2)]);

    expect(index.calls).toEqual(["objects"]);
  });

  it("writes nothing extra when the database accepted every write", async () => {
    const index = new FakeIndex();
    const sink = new IndexSink(index, silentLogger);
    await start(sink);
    await sink.objects([fetched(1)]);

    expect(index.calls).toEqual(["sources", "stale runs", "run", "objects"]);
    expect(sink.dirty).toBe(false);
  });

  it("stays dirty and skips the objects while the run row is still refused", async () => {
    const index = new FakeIndex({ down: true });
    const sink = new IndexSink(index, silentLogger);
    await start(sink);

    await sink.objects([fetched(1)]);

    expect(index.objects.size).toBe(0);
    expect(sink.dirty).toBe(true);
    expect(index.calls.at(-1)).toBe("sources");
  });
});

describe("IndexSink writes only what a write depends on", () => {
  const other = { id: "vbb-rt" } as SourceDefinition;

  it("lets the writes of one source through while a row of another is refused for good", async () => {
    const index = new FakeIndex();
    index.refusedSources.add(other.id);
    const sink = new IndexSink(index, silentLogger);
    await sink.sources([other]);
    await start(sink);
    index.calls.length = 0;

    await sink.objects([fetched(1)]);
    await sink.gap(source.id, { start: 0, end: 1 });

    expect([...index.objects.keys()]).toEqual(["object-1"]);
    expect(index.gaps).toHaveLength(1);
    expect(index.calls).toEqual(["objects", "gap"]);
  });

  it("writes the pending source row before a gap of that source", async () => {
    const index = new FakeIndex({ failFirst: 1 });
    const sink = new IndexSink(index, silentLogger);
    await sink.sources([source]);
    index.calls.length = 0;

    await sink.gap(source.id, { start: 0, end: 1 });

    expect(index.calls).toEqual(["sources", "gap"]);
    expect(index.sources.has(source.id)).toBe(true);
  });

  it("keeps a newer run row issued while the older one is being written, one write at a time", async () => {
    const index = new FakeIndex();
    const sink = new IndexSink(index, silentLogger);
    await sink.sources([source]);
    let release = () => {};
    index.gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = sink.run(runRow("running"));
    while (index.runWritesInFlight === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = sink.run(runRow("succeeded"));
    index.gate = null;
    release();
    await Promise.all([first, second]);

    expect(index.runs.get("run-1")?.status).toBe("succeeded");
    expect(index.calls.filter((call) => call === "run")).toHaveLength(2);
    expect(index.maxRunWritesInFlight).toBe(1);
  });
});

describe("IndexSink around a reconcile", () => {
  it("drops the rows pending before a reconcile that ends clean, since the reindex wrote them", async () => {
    const index = new FakeIndex({ down: true });
    const sink = new IndexSink(index, silentLogger);
    await start(sink);
    const reconcile = sink.beginReconcile();
    index.down = false;
    index.sources.add(source.id);
    index.runs.set("run-1", runRow());
    expect(sink.endReconcile(reconcile, "clean")).toBe(true);
    index.calls.length = 0;

    await sink.objects([fetched(1)]);

    expect(index.calls).toEqual(["objects"]);
    expect(sink.dirty).toBe(false);
  });

  it("keeps a row that changed during the reconcile", async () => {
    const index = new FakeIndex({ down: true });
    const sink = new IndexSink(index, silentLogger);
    await start(sink);
    const reconcile = sink.beginReconcile();
    await sink.run(runRow("succeeded"));
    index.down = false;
    index.sources.add(source.id);
    sink.endReconcile(reconcile, "clean");
    index.calls.length = 0;

    await sink.objects([fetched(1)]);

    expect(index.calls).toEqual(["run", "objects"]);
    expect(index.runs.get("run-1")?.status).toBe("succeeded");
  });

  it("stays dirty when a write fails during a reconcile that ends clean", async () => {
    const index = new FakeIndex();
    const sink = new IndexSink(index, silentLogger);
    await start(sink);
    const reconcile = sink.beginReconcile();
    index.down = true;
    await sink.objects([fetched(1)]);

    expect(sink.endReconcile(reconcile, "clean")).toBe(false);
    expect(sink.dirty).toBe(true);
  });

  it("keeps the index dirty after an aborted or failed reconcile", async () => {
    const index = new FakeIndex({ down: true });
    const sink = new IndexSink(index, silentLogger);
    await start(sink);

    expect(sink.endReconcile(sink.beginReconcile(), "aborted")).toBe(false);
    expect(sink.dirty).toBe(true);
    expect(sink.endReconcile(sink.beginReconcile(), "failed")).toBe(false);
    expect(sink.dirty).toBe(true);
  });

  it("an aborted reconcile leaves a clean index clean", () => {
    const sink = new IndexSink(new FakeIndex(), silentLogger);

    expect(sink.endReconcile(sink.beginReconcile(), "aborted")).toBe(true);
    expect(sink.dirty).toBe(false);
  });

  it("reports once that a write succeeded after writes had failed", async () => {
    const index = new FakeIndex({ down: true });
    const sink = new IndexSink(index, silentLogger);
    await start(sink);
    expect(sink.takeRecovered()).toBe(false);
    index.down = false;

    await sink.objects([fetched(1)]);

    expect(sink.takeRecovered()).toBe(true);
    expect(sink.takeRecovered()).toBe(false);
  });
});
