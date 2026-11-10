import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PayloadStore, type PayloadStoreOptions, type RecordDraft } from "./payload-store.ts";
import { listSidecars, readFetchRecords, readSegmentPayloads, sha256OfFile } from "./reader.ts";
import type { FetchRecord } from "./sidecar.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const t0 = Date.parse("2026-10-25T09:58:20Z");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function draft(atMs: number): RecordDraft {
  const iso = new Date(atMs).toISOString();
  return {
    v: 1,
    type: "fetch",
    source: "delfi-gtfs-rt",
    run: "0199f000-0000-7000-8000-000000000000",
    writer: "live",
    url: "https://example.org/latest.pbf",
    method: "GET",
    startedAt: iso,
    observedAt: iso,
    durationMs: 120,
    status: 200,
    headers: {},
  };
}

function options(overrides: Partial<PayloadStoreOptions> = {}): PayloadStoreOptions {
  return {
    root,
    source: "delfi-gtfs-rt",
    writer: "live",
    period: "hour",
    contentType: "application/x-protobuf",
    ...overrides,
  };
}

function evolve(previous: Buffer): Buffer {
  const next = Buffer.from(previous);
  randomBytes(64).copy(next, Math.floor(Math.random() * (next.length - 64)));
  return next;
}

async function recoverAll(): Promise<Map<string, string>> {
  const records = await readFetchRecords(root, await listSidecars(root, "delfi-gtfs-rt"));
  const segments = new Set(
    records.flatMap((record) => (record.object ? [record.object.file] : [])),
  );
  const recovered = new Map<string, string>();
  for (const segment of segments) {
    for await (const { record, payload } of readSegmentPayloads(root, segment, records)) {
      recovered.set(record.object?.key ?? "", sha(payload));
    }
  }
  return recovered;
}

describe("PayloadStore", () => {
  it("stores payloads across an hour boundary and recovers each byte for byte", async () => {
    const store = new PayloadStore(options());
    let payload: Buffer = randomBytes(200_000);
    const stored: FetchRecord[] = [];
    for (let minute = 0; minute < 4; minute += 1) {
      const at = t0 + minute * 60_000;
      stored.push(await store.storePayload(draft(at), payload, sha(payload), at));
      payload = evolve(payload);
    }
    await store.close();

    expect(stored.map((record) => record.object?.file)).toEqual([
      "delfi-gtfs-rt/2026-10-25/09.seg.zst",
      "delfi-gtfs-rt/2026-10-25/09.seg.zst",
      "delfi-gtfs-rt/2026-10-25/10.seg.zst",
      "delfi-gtfs-rt/2026-10-25/10.seg.zst",
    ]);
    expect(stored.map((record) => record.object?.base)).toEqual([null, 0, null, 0]);
    const recovered = await recoverAll();
    for (const record of stored) {
      expect(recovered.get(record.object?.key ?? "")).toBe(record.sha256);
    }
  });

  it("records an identical payload as unchanged without a new frame", async () => {
    const store = new PayloadStore(options());
    const payload = randomBytes(10_000);
    const first = await store.storePayload(draft(t0), payload, sha(payload), t0);
    const segmentSize = (await stat(join(root, first.object?.file ?? ""))).size;
    const second = await store.storePayload(draft(t0 + 60_000), payload, sha(payload), t0 + 60_000);
    await store.close();
    expect(second).toMatchObject({
      outcome: "unchanged",
      sameAs: first.object?.key,
      sha256: first.sha256,
    });
    expect((await stat(join(root, first.object?.file ?? ""))).size).toBe(segmentSize);
  });

  it("continues a segment after a crash: cuts uncommitted bytes and a torn sidecar line", async () => {
    const first = new PayloadStore(options());
    const a = randomBytes(100_000);
    const recordA = await first.storePayload(draft(t0), a, sha(a), t0);
    await first.close();
    const segmentPath = join(root, recordA.object?.file ?? "");
    const sidecarPath = join(root, "delfi-gtfs-rt/2026-10-25/09.jsonl");
    await appendFile(segmentPath, randomBytes(3_000));
    await appendFile(sidecarPath, '{"v":1,"type":"fetch","source":"delfi-gt');

    const restarted = new PayloadStore(
      options({ last: { sha256: recordA.sha256 ?? "", key: recordA.object?.key ?? "" } }),
    );
    const b = evolve(a);
    const recordB = await restarted.storePayload(draft(t0 + 60_000), b, sha(b), t0 + 60_000);
    await restarted.close();

    expect(recordB.object).toMatchObject({ seq: 1, base: null });
    expect(recordB.object?.offset).toBe(
      (recordA.object?.offset ?? 0) + (recordA.object?.length ?? 0),
    );
    const lines = (await readFile(sidecarPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const recovered = await recoverAll();
    expect(recovered.get(recordA.object?.key ?? "")).toBe(sha(a));
    expect(recovered.get(recordB.object?.key ?? "")).toBe(sha(b));
  });

  it("replaces a segment whose header was never completed", async () => {
    const path = join(root, "delfi-gtfs-rt/2026-10-25/09.seg.zst");
    await new PayloadStore(options()).close();
    await rm(path, { force: true });
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(root, "delfi-gtfs-rt/2026-10-25"), { recursive: true }),
    );
    await writeFile(path, Buffer.from([0x50, 0x2a]));
    const store = new PayloadStore(options());
    const payload = randomBytes(5_000);
    const record = await store.storePayload(draft(t0), payload, sha(payload), t0);
    await store.close();
    expect((await recoverAll()).get(record.object?.key ?? "")).toBe(sha(payload));
  });

  it("keeps a static file whole under a UTC name and skips an identical one", async () => {
    const store = new PayloadStore(
      options({ source: "gtfsde-static-fv", period: "day", contentType: "application/zip" }),
    );
    const bytes = randomBytes(30_000);
    const temp = join(root, "download.part");
    await writeFile(temp, bytes);
    const record = await store.storeFile(
      draft(t0),
      temp,
      "latest.zip",
      sha(bytes),
      bytes.length,
      t0,
    );
    expect(record.object).toMatchObject({
      encoding: "identity",
      file: "gtfsde-static-fv/2026-10-25/095820Z-latest.zip",
    });
    expect((await sha256OfFile(join(root, record.object?.file ?? ""))).sha256).toBe(sha(bytes));
    await writeFile(temp, bytes);
    const again = await store.storeFile(
      draft(t0 + 1000),
      temp,
      "latest.zip",
      sha(bytes),
      bytes.length,
      t0 + 1000,
    );
    expect(again).toMatchObject({ outcome: "unchanged", sameAs: record.object?.key });
    await store.close();
  });

  it("writes failures and 304s to the sidecar of their hour", async () => {
    const store = new PayloadStore(options());
    await store.note({ ...draft(t0), outcome: "not-modified", status: 304 }, t0);
    await store.note(
      { ...draft(t0 + 120_000), outcome: "failure", status: null, error: "timeout" },
      t0 + 120_000,
    );
    await store.close();
    const records = await readFetchRecords(root, await listSidecars(root, "delfi-gtfs-rt"));
    expect(records.map((record) => [record.outcome, record.startedAt.slice(11, 13)])).toEqual([
      ["not-modified", "09"],
      ["failure", "10"],
    ]);
  });
});
