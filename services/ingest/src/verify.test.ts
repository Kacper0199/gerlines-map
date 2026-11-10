import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PayloadStore, type RecordDraft } from "./storage/payload-store.ts";
import type { FetchRecord } from "./storage/sidecar.ts";
import { verifySource } from "./verify.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const t0 = Date.parse("2026-10-25T09:10:20Z");
let root: string;
let stored: FetchRecord[];

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
    durationMs: 1,
    status: 200,
    headers: {},
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-verify-"));
  const store = new PayloadStore({
    root,
    source: "delfi-gtfs-rt",
    writer: "live",
    period: "hour",
    contentType: "application/x-protobuf",
  });
  stored = [];
  let payload = randomBytes(30_000);
  for (let minute = 0; minute < 3; minute += 1) {
    const at = t0 + minute * 60_000;
    stored.push(await store.storePayload(draft(at), payload, sha(payload), at));
    payload = Buffer.concat([payload.subarray(0, 29_000), randomBytes(1_000)]);
  }
  await store.close();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sidecar = () => join(root, "delfi-gtfs-rt/2026-10-25/09.jsonl");

describe("verifySource", () => {
  it("recovers every payload of an intact recording", async () => {
    const report = await verifySource(root, "delfi-gtfs-rt");
    expect(report).toMatchObject({ checked: 3, matched: 3, mismatched: [], errors: [] });
  });

  it("fails on a corrupted frame", async () => {
    const object = stored[1]?.object;
    const handle = await open(join(root, object?.file ?? ""), "r+");
    await handle.write(Buffer.from([0xff, 0x00, 0xff]), 0, 3, (object?.offset ?? 0) + 10);
    await handle.close();
    const report = await verifySource(root, "delfi-gtfs-rt");
    expect(report.errors.length + report.mismatched.length).toBeGreaterThan(0);
    expect(report.matched).toBeLessThan(3);
  });

  it("fails on a sameAs that names no stored object, with or without a window", async () => {
    const dangling = {
      ...draft(t0 + 300_000),
      outcome: "unchanged",
      sha256: sha(Buffer.from("x")),
      bytes: 1,
      sameAs: "delfi-gtfs-rt/2026-10-25/08/00000",
    };
    await appendFile(sidecar(), `${JSON.stringify(dangling)}\n`);
    expect((await verifySource(root, "delfi-gtfs-rt")).errors).toEqual([
      expect.stringMatching(/sameAs delfi-gtfs-rt\/2026-10-25\/08\/00000 names no stored object/),
    ]);
    const windowed = await verifySource(root, "delfi-gtfs-rt", {
      from: t0 + 200_000,
      to: t0 + 400_000,
    });
    expect(windowed.errors).toHaveLength(1);
  });

  it("reports a sidecar line that is not JSON", async () => {
    await appendFile(sidecar(), "{not json}\n");
    const report = await verifySource(root, "delfi-gtfs-rt");
    expect(report.errors).toEqual(["delfi-gtfs-rt/2026-10-25/09.jsonl:4: not a JSON line"]);
    expect(report.matched).toBe(3);
  });
});
