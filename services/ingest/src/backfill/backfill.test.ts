import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import { silentLogger } from "../log.ts";
import { IndexSink } from "../recorder/index-sink.ts";
import { recorderSources } from "../sources.ts";
import { PayloadStore } from "../storage/payload-store.ts";
import { listSidecars, readFetchRecords } from "../storage/reader.ts";
import { RunLog } from "../storage/runs.ts";
import { verifySource } from "../verify.ts";
import { type BackfillOptions, backfillRecent } from "./backfill.ts";

const payloads: [Buffer, Buffer] = [
  readFileSync(new URL("../../test/fixtures/delfi-gtfs-rt-first40.pb", import.meta.url)),
  readFileSync(new URL("../../test/fixtures/gtfsde-rt-first40.pb", import.meta.url)),
];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const name = (local: string) => encodeURIComponent(`${local}.gtfs-rt.pbf`);
const files: Record<string, Buffer> = {
  [`/mirror/2026-10-25/${name("2026-10-25T10:06:01+01:00")}`]: payloads[0] as Buffer,
  [`/mirror/2026-10-25/${name("2026-10-25T10:07:01+01:00")}`]: payloads[1] as Buffer,
};
const requests: { url: string; at: number }[] = [];
let failSecond = false;
let invalidFirst = false;
let server: Server;
let base: string;
let root: string;
let now = 0;
const clock: Clock = {
  now: () => now,
  sleep: async (ms) => {
    now += Math.max(0, ms);
  },
};

const delfi = recorderSources({ otdChApiKey: null, sncbApiKey: null }).find(
  (s) => s.id === "delfi-gtfs-rt",
);
if (!delfi) throw new Error("delfi-gtfs-rt missing");

function listing(): string {
  return `<pre>${Object.keys(files)
    .map((path) => `<a href="${path.split("/").at(-1)}">x</a>`)
    .join("\n")}</pre>`;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "";
    requests.push({ url, at: now });
    if (url === "/mirror/") {
      response
        .writeHead(200)
        .end('<pre><a href="../">../</a><a href="2026-10-25/">2026-10-25/</a></pre>');
    } else if (url === "/mirror/2026-10-25/") {
      response.writeHead(200).end(listing());
    } else if (invalidFirst && url.includes("10%3A06")) {
      response.writeHead(200).end(Buffer.from([0x12, 0x00]));
    } else if (failSecond && url.includes("10%3A07")) {
      response.writeHead(503).end();
    } else if (files[url]) {
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(files[url]);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mirror/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-backfill-"));
  requests.length = 0;
  failSecond = false;
  invalidFirst = false;
  now = Date.parse("2026-10-25T12:00:00Z");
  const live = new PayloadStore({
    root,
    source: "delfi-gtfs-rt",
    writer: "live",
    period: "hour",
    contentType: "application/x-protobuf",
  });
  for (const [iso, payload] of [
    ["2026-10-25T09:05:21Z", payloads[1]],
    ["2026-10-25T09:09:20Z", payloads[0]],
  ] as const) {
    await live.storePayload(
      {
        v: 1,
        type: "fetch",
        source: "delfi-gtfs-rt",
        run: "0199f000-0000-7000-8000-000000000001",
        writer: "live",
        url: "https://example.org/live",
        method: "GET",
        startedAt: iso,
        observedAt: iso,
        durationMs: 1,
        status: 200,
        headers: {},
      },
      payload,
      sha(payload),
      Date.parse(iso),
    );
  }
  await live.close();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function options(overrides: Partial<BackfillOptions> = {}): BackfillOptions {
  return {
    root,
    source: delfi as NonNullable<typeof delfi>,
    userAgent: "gerlines/0.1.0 (+test@example.org)",
    clock,
    logger: silentLogger,
    index: new IndexSink(null, silentLogger),
    signal: new AbortController().signal,
    days: 2,
    dryRun: false,
    mirrorBase: base,
    archiveBase: "https://archive.example.org/",
    appVersion: "0.1.0",
    ...overrides,
  };
}

describe("backfillRecent", () => {
  it("fills the missing minutes with the mirror's bytes, 2 s apart, and reports what the mirror lacks", async () => {
    const report = await backfillRecent(options());
    expect(report).toMatchObject({
      gapsBefore: 1,
      missing: 3,
      available: 2,
      fetched: 2,
      stored: 2,
      stoppedOn: null,
    });
    expect(report.notInMirror).toEqual(["2026-10-25T09:08:01.000Z"]);
    expect(report.archives).toEqual([]);
    expect(report.gapsAfter).toEqual([
      { from: "2026-10-25T09:07:01.000Z", to: "2026-10-25T09:09:20.000Z" },
    ]);

    const fileRequests = requests.filter((r) => r.url.endsWith(".pbf"));
    expect(fileRequests).toHaveLength(2);
    for (let index = 1; index < requests.length; index += 1) {
      expect((requests[index]?.at ?? 0) - (requests[index - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
        2_000,
      );
    }
    const backfilled = (
      await readFetchRecords(root, await listSidecars(root, "delfi-gtfs-rt"))
    ).filter((r) => r.writer === "backfill");
    expect(backfilled.map((r) => [r.observedAt, r.sha256, r.provenance])).toEqual([
      [
        "2026-10-25T09:06:01.000Z",
        sha(payloads[0] as Buffer),
        "backfill:traines-mirror-day-folder",
      ],
      [
        "2026-10-25T09:07:01.000Z",
        sha(payloads[1] as Buffer),
        "backfill:traines-mirror-day-folder",
      ],
    ]);
    expect(backfilled[0]?.object?.file).toBe("delfi-gtfs-rt/2026-10-25/09.backfill.seg.zst");
    const verified = await verifySource(root, "delfi-gtfs-rt");
    expect(verified).toMatchObject({ mismatched: [], errors: [], checked: 4, matched: 4 });
    const runs = await new RunLog(root).read("delfi-gtfs-rt");
    expect(runs).toMatchObject([{ job: "backfill", status: "succeeded" }]);
  });

  it("stops at the first error and closes its run as failed", async () => {
    failSecond = true;
    const report = await backfillRecent(options());
    expect(report).toMatchObject({ fetched: 1, stored: 1, invalid: 0 });
    expect(report.stoppedOn).toMatch(/HTTP 503/);
    expect(report.gapsAfter).toHaveLength(1);
    expect((await new RunLog(root).read("delfi-gtfs-rt"))[0]).toMatchObject({ status: "failed" });
  });

  it("stores an upstream minute that is not a GTFS-RT feed as invalid and continues", async () => {
    invalidFirst = true;
    const report = await backfillRecent(options());
    expect(report).toMatchObject({ fetched: 2, stored: 1, invalid: 1, stoppedOn: null });
    expect(report.invalidMinutes).toEqual(["2026-10-25T09:06:01.000Z"]);
    const backfilled = (
      await readFetchRecords(root, await listSidecars(root, "delfi-gtfs-rt"))
    ).filter((r) => r.writer === "backfill");
    expect(backfilled.map((r) => [r.observedAt, r.outcome])).toEqual([
      ["2026-10-25T09:06:01.000Z", "invalid"],
      ["2026-10-25T09:07:01.000Z", "stored"],
    ]);
    expect(backfilled[0]?.object).toBeDefined();
    expect((await new RunLog(root).read("delfi-gtfs-rt"))[0]).toMatchObject({
      status: "succeeded",
    });
  });

  it("starts at --from and leaves earlier missing minutes alone", async () => {
    const report = await backfillRecent(options({ from: Date.parse("2026-10-25T09:06:30Z") }));
    expect(report).toMatchObject({
      since: "2026-10-25T09:06:30.000Z",
      missing: 2,
      available: 1,
      fetched: 1,
      stored: 1,
    });
    expect(report.notInMirror).toEqual(["2026-10-25T09:08:01.000Z"]);
    const fetched = requests
      .filter((r) => r.url.endsWith(".pbf"))
      .map((r) => decodeURIComponent(r.url));
    expect(fetched).toEqual(["/mirror/2026-10-25/2026-10-25T10:07:01+01:00.gtfs-rt.pbf"]);
  });

  it("refuses a --from in the future", async () => {
    await expect(
      backfillRecent(options({ from: Date.parse("2026-10-25T12:00:01Z") })),
    ).rejects.toThrow(/from/);
  });

  it("names the daily archive for days that left the minute folders, without downloading", async () => {
    const store = new PayloadStore({
      root,
      source: "delfi-gtfs-rt",
      writer: "live",
      period: "hour",
      contentType: "x",
    });
    for (const iso of ["2026-10-23T22:30:20Z", "2026-10-23T22:33:20Z"]) {
      await store.note(
        {
          v: 1,
          type: "fetch",
          source: "delfi-gtfs-rt",
          run: "r",
          writer: "live",
          url: "u",
          method: "GET",
          startedAt: iso,
          observedAt: iso,
          durationMs: 1,
          status: 304,
          headers: {},
          outcome: "not-modified",
        },
        Date.parse(iso),
      );
    }
    await store.close();
    const report = await backfillRecent(options({ dryRun: true, days: 3 }));
    expect(report.archives).toContain("https://archive.example.org/2026-10-24.tar.br");
    expect(requests.some((r) => r.url.endsWith(".pbf"))).toBe(false);
  });

  it("fetches a minute lost to one failed fetch, although no gap of twice the cadence exists", async () => {
    await notModified("2026-10-25T09:07:20Z");
    const report = await backfillRecent(options());
    expect(report).toMatchObject({
      gapsBefore: 0,
      missing: 2,
      available: 1,
      fetched: 1,
      stored: 1,
    });
    expect(report.notInMirror).toEqual(["2026-10-25T09:08:01.000Z"]);
    const fetched = requests
      .filter((r) => r.url.endsWith(".pbf"))
      .map((r) => decodeURIComponent(r.url));
    expect(fetched).toEqual(["/mirror/2026-10-25/2026-10-25T10:06:01+01:00.gtfs-rt.pbf"]);
  });

  it("finds a five-day hole from the last success however old and names its archives", async () => {
    await notModified("2026-10-19T10:00:20Z");
    const report = await backfillRecent(options({ dryRun: true }));
    expect(report.gapsAfter[0]).toEqual({
      from: "2026-10-19T10:00:20.000Z",
      to: "2026-10-25T09:05:21.000Z",
    });
    for (const day of [
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
    ]) {
      expect(report.archives).toContain(`https://archive.example.org/${day}.tar.br`);
    }
    expect(report.archives).not.toContain("https://archive.example.org/2026-10-25.tar.br");
  });
});

async function notModified(iso: string): Promise<void> {
  const store = new PayloadStore({
    root,
    source: "delfi-gtfs-rt",
    writer: "live",
    period: "hour",
    contentType: "x",
  });
  await store.note(
    {
      v: 1,
      type: "fetch",
      source: "delfi-gtfs-rt",
      run: "r",
      writer: "live",
      url: "u",
      method: "GET",
      startedAt: iso,
      observedAt: iso,
      durationMs: 1,
      status: 304,
      headers: {},
      outcome: "not-modified",
    },
    Date.parse(iso),
  );
  await store.close();
}
