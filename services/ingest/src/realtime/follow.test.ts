import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PayloadStore, type RecordDraft } from "../storage/payload-store.ts";
import type { Writer } from "../storage/sidecar.ts";
import { RecordingFollower } from "./follow.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const t0 = Date.parse("2026-10-29T09:58:00Z");
const MINUTE = 60_000;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-follow-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function draft(source: string, atMs: number, writer: Writer = "live"): RecordDraft {
  const iso = new Date(atMs).toISOString();
  return {
    v: 1,
    type: "fetch",
    source,
    run: "0199f000-0000-7000-8000-000000000000",
    writer,
    url: "https://example.org/latest.pbf",
    method: "GET",
    startedAt: iso,
    observedAt: iso,
    durationMs: 120,
    status: 200,
    headers: {},
  };
}

function store(source: string, writer: Writer = "live"): PayloadStore {
  return new PayloadStore({
    root,
    source,
    writer,
    period: "hour",
    contentType: "application/x-protobuf",
  });
}

function payloadAt(n: number): Buffer {
  const bytes = randomBytes(4096);
  bytes.writeUInt32BE(n, 0);
  return bytes;
}

async function put(
  target: PayloadStore,
  source: string,
  at: number,
  payload: Buffer,
  writer?: Writer,
) {
  return target.storePayload(draft(source, at, writer), payload, sha(payload), at);
}

describe("RecordingFollower", () => {
  it("returns each new payload once, in order, and decodes it from its segment chain", async () => {
    const live = store("delfi-gtfs-rt");
    const payloads = [0, 1, 2, 3].map(payloadAt);
    const follower = new RecordingFollower(root, ["delfi-gtfs-rt"], t0 - MINUTE);
    await put(live, "delfi-gtfs-rt", t0, payloads[0] as Buffer);
    await put(live, "delfi-gtfs-rt", t0 + MINUTE, payloads[1] as Buffer);
    const first = await follower.poll();
    expect(first.map((record) => record.observedAt)).toEqual([
      new Date(t0).toISOString(),
      new Date(t0 + MINUTE).toISOString(),
    ]);
    expect(await follower.poll()).toEqual([]);
    await put(live, "delfi-gtfs-rt", t0 + 2 * MINUTE, payloads[2] as Buffer);
    await put(live, "delfi-gtfs-rt", t0 + 3 * MINUTE, payloads[3] as Buffer);
    await live.close();
    const second = await follower.poll();
    expect(second.map((record) => record.object?.file)).toEqual([
      "delfi-gtfs-rt/2026-10-29/10.seg.zst",
      "delfi-gtfs-rt/2026-10-29/10.seg.zst",
    ]);
    const decoded = [];
    for (const record of [...first, ...second]) decoded.push(await follower.decode(record));
    expect(decoded.map(sha)).toEqual(payloads.map(sha));
    expect(sha(await follower.decode(first[1] as never))).toBe(sha(payloads[1] as Buffer));
  });

  it("finds payloads a backfill writes for an hour already read, and ignores ones before the start", async () => {
    const live = store("delfi-gtfs-rt");
    const follower = new RecordingFollower(root, ["delfi-gtfs-rt"], t0 - 10 * MINUTE);
    await put(live, "delfi-gtfs-rt", t0, payloadAt(1));
    await live.close();
    expect(await follower.poll()).toHaveLength(1);
    const backfill = store("delfi-gtfs-rt", "backfill");
    const late = payloadAt(2);
    await put(backfill, "delfi-gtfs-rt", t0 - 5 * MINUTE, late, "backfill");
    await put(backfill, "delfi-gtfs-rt", t0 - 30 * MINUTE, payloadAt(3), "backfill");
    await backfill.close();
    const found = await follower.poll();
    expect(found.map((record) => record.observedAt)).toEqual([
      new Date(t0 - 5 * MINUTE).toISOString(),
    ]);
    expect(sha(await follower.decode(found[0] as never))).toBe(sha(late));
    expect(follower.find(found[0]?.object?.id ?? "")).toBe(found[0]);
  });

  it("counts the sidecar lines it cannot read, an overlong one once with its tail", async () => {
    const live = store("delfi-gtfs-rt");
    const follower = new RecordingFollower(root, ["delfi-gtfs-rt"], t0 - MINUTE);
    await put(live, "delfi-gtfs-rt", t0, payloadAt(1));
    await live.close();
    expect(await follower.poll()).toHaveLength(1);
    expect(follower.takeSkippedLines()).toBe(0);
    const sidecar = join(root, "delfi-gtfs-rt/2026-10-29/09.jsonl");
    await appendFile(sidecar, "x".repeat(1_200_000));
    expect(await follower.poll()).toEqual([]);
    await appendFile(sidecar, `${"y".repeat(100)}\n{"type":"fetch",\n`);
    expect(await follower.poll()).toEqual([]);
    expect(follower.takeSkippedLines()).toBe(2);
    expect(follower.takeSkippedLines()).toBe(0);
  });

  it("forgets records and files older than it keeps", async () => {
    const live = store("gtfsde-rt");
    const follower = new RecordingFollower(root, ["gtfsde-rt"], t0 - MINUTE);
    await put(live, "gtfsde-rt", t0, payloadAt(1));
    await put(live, "gtfsde-rt", t0 + 3 * 60 * MINUTE, payloadAt(2));
    await live.close();
    const records = await follower.poll();
    expect(records).toHaveLength(2);
    follower.forget(t0 + 60 * MINUTE);
    expect(follower.find(records[0]?.object?.id ?? "")).toBeUndefined();
    expect(follower.find(records[1]?.object?.id ?? "")).toBe(records[1]);
    expect(follower.knownRecords()).toBe(1);
    expect(await follower.poll()).toEqual([]);
    follower.forget(t0 + 2 * 86_400_000);
    expect(follower.trackedFiles()).toBe(0);
  });
});
