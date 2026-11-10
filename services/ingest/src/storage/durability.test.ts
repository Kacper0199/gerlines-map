import { createHash, randomBytes } from "node:crypto";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJsonLine } from "./files.ts";
import { encodeSegmentHeader } from "./frame.ts";
import { PayloadStore, type RecordDraft } from "./payload-store.ts";
import { listSidecars, readFetchRecords, readSegmentPayloads } from "./reader.ts";
import { parseJsonLinesDetailed } from "./sidecar.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const t0 = Date.parse("2026-10-25T09:10:20Z");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-durability-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function draft(atMs: number, outcome?: RecordDraft["outcome"]): RecordDraft {
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
    durationMs: 1,
    status: 200,
    headers: {},
    ...(outcome ? { outcome } : {}),
  };
}

function store(): PayloadStore {
  return new PayloadStore({
    root,
    source: "delfi-gtfs-rt",
    writer: "live",
    period: "hour",
    contentType: "application/x-protobuf",
  });
}

async function storeOne(at: number, payload: Buffer) {
  const writer = store();
  const record = await writer.storePayload(draft(at), payload, sha(payload), at);
  await writer.close();
  return record;
}

async function recovered(): Promise<Map<string, string>> {
  const records = await readFetchRecords(root, await listSidecars(root, "delfi-gtfs-rt"));
  const files = new Set(records.flatMap((record) => (record.object ? [record.object.file] : [])));
  const result = new Map<string, string>();
  for (const file of files) {
    try {
      for await (const { record, payload } of readSegmentPayloads(root, file, records)) {
        result.set(record.object?.key ?? "", sha(payload));
      }
    } catch {
      result.set(file, "unreadable");
    }
  }
  return result;
}

const segmentPath = () => join(root, "delfi-gtfs-rt/2026-10-25/09.seg.zst");

describe("segments never lose committed frames", () => {
  it("rotates to 09.1.seg.zst when the header is of a newer format, leaving the old file intact", async () => {
    const a = randomBytes(40_000);
    const first = await storeOne(t0, a);
    const original = await readFile(segmentPath());
    const newer = encodeSegmentHeader({
      format: "gerlines-segment",
      version: 99,
      source: "delfi-gtfs-rt",
      writer: "live",
      createdAt: "2026-10-25T09:00:00.000Z",
    });
    const replaced = Buffer.concat([newer, original.subarray(newer.length)]);
    await writeFile(segmentPath(), replaced);
    const rotations: string[] = [];
    const writer = new PayloadStore({
      root,
      source: "delfi-gtfs-rt",
      writer: "live",
      period: "hour",
      contentType: "x",
      onRotate: (from, to, reason) => rotations.push(`${from} -> ${to}: ${reason}`),
    });
    const b = randomBytes(40_000);
    const second = await writer.storePayload(draft(t0 + 60_000), b, sha(b), t0 + 60_000);
    await writer.close();

    expect(second.object?.file).toBe("delfi-gtfs-rt/2026-10-25/09.1.seg.zst");
    expect(second.object?.key).toBe("delfi-gtfs-rt/2026-10-25/09.1/00000");
    expect(rotations[0]).toMatch(/09\.seg\.zst -> .*09\.1\.seg\.zst: segment format version 99/);
    expect((await readFile(segmentPath())).equals(replaced)).toBe(true);
    expect((await recovered()).get(second.object?.key ?? "")).toBe(sha(b));
    expect(first.object?.file).toBe("delfi-gtfs-rt/2026-10-25/09.seg.zst");
  });

  it("rotates when committed frames point into a missing or shortened file", async () => {
    const a = randomBytes(40_000);
    await storeOne(t0, a);
    await writeFile(segmentPath(), (await readFile(segmentPath())).subarray(0, 100));
    const b = randomBytes(40_000);
    const second = await storeOne(t0 + 60_000, b);
    expect(second.object?.file).toBe("delfi-gtfs-rt/2026-10-25/09.1.seg.zst");
    expect((await readFile(segmentPath())).length).toBe(100);

    await rm(segmentPath());
    const c = randomBytes(40_000);
    const third = await storeOne(t0 + 120_000, c);
    expect(third.object?.file).toBe("delfi-gtfs-rt/2026-10-25/09.1.seg.zst");
    expect((await recovered()).get(third.object?.key ?? "")).toBe(sha(c));
  });

  it("appends after a valid header longer than 4096 bytes without truncating it", async () => {
    const big = encodeSegmentHeader({
      format: "gerlines-segment",
      version: 1,
      source: "delfi-gtfs-rt",
      writer: `live${" ".repeat(6000)}`,
      createdAt: "2026-10-25T09:00:00.000Z",
    });
    await storeOne(t0 - 1, Buffer.from("seed"));
    await writeFile(segmentPath(), big);
    await rm(join(root, "delfi-gtfs-rt/2026-10-25/09.jsonl"));
    const a = randomBytes(10_000);
    const record = await storeOne(t0, a);
    expect(record.object).toMatchObject({
      file: "delfi-gtfs-rt/2026-10-25/09.seg.zst",
      offset: big.length,
    });
    expect((await recovered()).get(record.object?.key ?? "")).toBe(sha(a));
  });
});

describe("invalid payloads", () => {
  it("are stored with their bytes and keep the invalid outcome, also when repeated", async () => {
    const writer = store();
    const html = Buffer.from("<html>maintenance</html>");
    const first = await writer.storePayload(draft(t0, "invalid"), html, sha(html), t0);
    const again = await writer.storePayload(
      draft(t0 + 60_000, "invalid"),
      html,
      sha(html),
      t0 + 60_000,
    );
    await writer.close();
    expect(first).toMatchObject({ outcome: "invalid", object: { seq: 0 } });
    expect(again).toMatchObject({ outcome: "invalid", sameAs: first.object?.key });
    expect((await recovered()).get(first.object?.key ?? "")).toBe(sha(html));
  });
});

describe("sidecar lines", () => {
  it("repairs a torn line again after a failed append", async () => {
    const path = join(root, "x.jsonl");
    const repaired = new Set<string>();
    await appendJsonLine(path, { n: 1 }, repaired);
    await appendFile(path, '{"n":2,"tor');
    await chmod(path, 0o444);
    await expect(appendJsonLine(path, { n: 3 }, repaired)).rejects.toThrow();
    await chmod(path, 0o644);
    await appendJsonLine(path, { n: 4 }, repaired);
    expect(await readFile(path, "utf8")).toBe('{"n":1}\n{"n":4}\n');
  });

  it("skips and reports lines that are not JSON instead of failing the whole file", () => {
    const parsed = parseJsonLinesDetailed<{ n: number }>('{"n":1}\n{"n":2,"n\n{"n":3}\n');
    expect(parsed.values).toEqual([{ n: 1 }, { n: 3 }]);
    expect(parsed.badLines).toEqual([2]);
  });
});
