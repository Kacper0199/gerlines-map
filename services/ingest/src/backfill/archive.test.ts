import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { silentLogger } from "../log.ts";
import { IndexSink } from "../recorder/index-sink.ts";
import { recorderSources } from "../sources.ts";
import { readJsonLinesFile } from "../storage/files.ts";
import { PayloadStore, type RecordDraft } from "../storage/payload-store.ts";
import { listSidecars, readFetchRecords, readSegmentPayloads } from "../storage/reader.ts";
import {
  type ArchiveManifestLine,
  type ArchivePassOptions,
  archivePass,
  berlinDayStart,
  MAX_MEMBERS,
  manifestPath,
  SPOOL_DIR,
  throttled,
} from "./archive.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));
const feedA = fixture("delfi-gtfs-rt-first40.pb");
const feedB = fixture("gtfsde-rt-first40.pb");
const feedC = fixture("vbn-gtfs-rt-first40.pb");
const notAFeed = Buffer.from("<html>mirror maintenance</html>");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const delfi = recorderSources({ otdChApiKey: null, sncbApiKey: null }).find(
  (source) => source.id === "delfi-gtfs-rt",
);
if (!delfi) throw new Error("delfi-gtfs-rt missing");

const DAY = "2026-10-28";
const T = (hhmm: string) => Date.parse(`2026-10-28T${hhmm}:01Z`);
const local = (at: number) =>
  `${new Date(at + 3_600_000).toISOString().slice(0, 19)}+01:00.gtfs-rt.pbf`;

function tarEntry(name: string, data: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar  \0", 257, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

const members: [number, Buffer][] = [
  [T("08:02"), notAFeed],
  [T("08:00"), feedA],
  [T("08:03"), feedC],
  [T("08:01"), feedB],
];
const archive = brotliCompressSync(
  Buffer.concat([
    tarEntry(`${DAY}/`, Buffer.alloc(0), "5"),
    ...members.map(([at, data]) => tarEntry(`${DAY}/${local(at)}`, data)),
    tarEntry(`${DAY}/README`, Buffer.from("hello")),
    Buffer.alloc(1024),
  ]),
);

const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>();

function route(name: string, handler: (response: ServerResponse) => void): string {
  routes.set(`/t/${name}/${DAY}.tar.br`, (_request, response) => handler(response));
  return `${base}/t/${name}/`;
}

function serve(name: string, body: Buffer, withLength = true): string {
  return route(name, (response) => {
    response.writeHead(200, withLength ? { "content-length": String(body.length) } : {});
    response.end(body);
  });
}

let server: Server;
let base: string;
let root: string;
let store: string;
let manifests: string;
const requests: { url: string; agent: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", agent: request.headers["user-agent"] });
    const custom = routes.get(request.url ?? "");
    if (custom) {
      custom(request, response);
      return;
    }
    if (request.url === `/archive/${DAY}.tar.br`) {
      response
        .writeHead(200, {
          "content-length": String(archive.length),
          "last-modified": "Thu, 29 Oct 2026 12:12:00 GMT",
        })
        .end(archive);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function live(at: number, payload: Buffer): Promise<void> {
  const writer = new PayloadStore({
    root,
    source: "delfi-gtfs-rt",
    writer: "live",
    period: "hour",
    contentType: "application/x-protobuf",
  });
  const iso = new Date(at + 19_000).toISOString();
  const draft: RecordDraft = {
    v: 1,
    type: "fetch",
    source: "delfi-gtfs-rt",
    run: "run-live",
    writer: "live",
    url: "https://stc.traines.eu/x",
    method: "GET",
    startedAt: iso,
    observedAt: iso,
    durationMs: 1,
    status: 200,
    headers: {},
  };
  await writer.storePayload(draft, payload, sha(payload), at + 19_000);
  await writer.close();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-archive-rec-"));
  store = await mkdtemp(join(tmpdir(), "gerlines-archive-store-"));
  manifests = await mkdtemp(join(tmpdir(), "gerlines-archive-manifests-"));
  requests.length = 0;
  await live(T("08:00"), feedA);
  await live(T("08:03"), feedB);
});

afterEach(async () => {
  routes.clear();
  for (const dir of [root, store, manifests]) await rm(dir, { recursive: true, force: true });
});

function options(extra: Partial<ArchivePassOptions> = {}): ArchivePassOptions {
  return {
    root,
    storeRoot: store,
    manifestRoot: manifests,
    day: DAY,
    source: delfi as NonNullable<typeof delfi>,
    userAgent: "gerlines/0.1.0 (+test@example.org)",
    clock: systemClock,
    logger: silentLogger,
    index: new IndexSink(null, silentLogger),
    signal: new AbortController().signal,
    dryRun: false,
    archiveBase: `${base}/archive/`,
    appVersion: "0.1.0",
    ...extra,
  };
}

describe("berlinDayStart", () => {
  it("finds the UTC start of a German day in winter and in summer time", () => {
    expect(new Date(berlinDayStart("2026-10-28")).toISOString()).toBe("2026-10-27T23:00:00.000Z");
    expect(new Date(berlinDayStart("2026-10-25")).toISOString()).toBe("2026-10-24T22:00:00.000Z");
  });
});

describe("archivePass", () => {
  it("writes a manifest of every snapshot and stores only the missing minutes, in time order", async () => {
    const report = await archivePass(options());
    expect(requests).toEqual([
      { url: `/archive/${DAY}.tar.br`, agent: "gerlines/0.1.0 (+test@example.org)" },
    ]);
    expect(report).toMatchObject({
      day: DAY,
      archiveBytes: archive.length,
      snapshots: 4,
      otherMembers: 1,
      missingBefore: 2,
      inArchive: 2,
      stored: 1,
      invalid: 1,
      notInArchive: [],
      recordedMatched: 1,
      recordedDiffering: [new Date(T("08:03")).toISOString()],
      complete: true,
    });

    const lines = await readJsonLinesFile<ArchiveManifestLine>(
      manifestPath(manifests, "delfi-gtfs-rt", DAY),
    );
    expect(lines[0]).toMatchObject({ type: "archive", day: DAY, snapshots: 4, complete: true });
    const snapshots = lines.filter((line) => line.type === "snapshot");
    expect(snapshots.map((line) => [line.at, line.sha256, line.bytes])).toEqual(
      [...members]
        .sort(([a], [b]) => a - b)
        .map(([at, data]) => [new Date(at).toISOString(), sha(data), data.length]),
    );

    const records = await readFetchRecords(store, await listSidecars(store, "delfi-gtfs-rt"));
    expect(records.map((record) => [record.observedAt, record.outcome, record.writer])).toEqual([
      [new Date(T("08:01")).toISOString(), "stored", "archive"],
      [new Date(T("08:02")).toISOString(), "invalid", "archive"],
    ]);
    expect(records[0]?.provenance).toBe("backfill:traines-mirror-day-archive");
    expect(records[0]?.url).toBe(`${base}/archive/${DAY}.tar.br#${DAY}/${local(T("08:01"))}`);
    const file = records[0]?.object?.file ?? "";
    expect(file).toMatch(/\/08\.archive\.seg\.zst$/);
    const recovered: Buffer[] = [];
    for await (const { payload } of readSegmentPayloads(store, file, records))
      recovered.push(payload);
    expect(recovered.map(sha)).toEqual([sha(feedB), sha(notAFeed)]);
    expect(await readdir(join(store, SPOOL_DIR))).toEqual([]);
  });

  it("only writes the manifest and counts in a dry run", async () => {
    const report = await archivePass(options({ dryRun: true }));
    expect(report).toMatchObject({ missingBefore: 2, inArchive: 2, stored: 0, complete: true });
    expect(await listSidecars(store, "delfi-gtfs-rt")).toEqual([]);
    const lines = await readJsonLinesFile<ArchiveManifestLine>(
      manifestPath(manifests, "delfi-gtfs-rt", DAY),
    );
    expect(lines.filter((line) => line.type === "snapshot")).toHaveLength(4);
  });

  it("writes no manifest when the archive is not there", async () => {
    await expect(archivePass(options({ day: "2026-10-27" }))).rejects.toThrow(/HTTP 404/);
    expect(await readdir(manifests)).toEqual([]);
  });
});

const tarOf = (entries: readonly Buffer[], end = true) =>
  Buffer.concat([...entries, ...(end ? [Buffer.alloc(1024)] : [])]);
const memberAt = (at: number, data: Buffer) => tarEntry(`${DAY}/${local(at)}`, data);

async function noManifest(): Promise<void> {
  expect(await readdir(manifests)).toEqual([]);
}

describe("archivePass on a broken or hostile mirror", () => {
  it("fails without a manifest when the socket drops before Content-Length bytes arrive", async () => {
    const archiveBase = route("cut-length", (response) => {
      response.writeHead(200, { "content-length": String(archive.length) });
      response.write(archive.subarray(0, Math.floor(archive.length / 2)));
      setTimeout(() => response.destroy(), 20);
    });
    await expect(archivePass(options({ archiveBase }))).rejects.toThrow();
    await noManifest();
  });

  it("fails without a manifest when the brotli stream is cut and no length was sent", async () => {
    const archiveBase = serve("cut-brotli", archive.subarray(0, archive.length - 40), false);
    await expect(archivePass(options({ archiveBase }))).rejects.toThrow();
    await noManifest();
  });

  it("marks the manifest incomplete when the tar has no end-of-archive blocks", async () => {
    const body = brotliCompressSync(
      tarOf([memberAt(T("08:01"), feedB), memberAt(T("08:02"), feedC)], false),
    );
    const report = await archivePass(options({ archiveBase: serve("no-end", body) }));
    expect(report.complete).toBe(false);
    const lines = await readJsonLinesFile<ArchiveManifestLine>(
      manifestPath(manifests, "delfi-gtfs-rt", DAY),
    );
    expect(lines[0]).toMatchObject({ type: "archive", complete: false });
  });

  it("refuses an archive with more members than a day can hold", async () => {
    const tiny = Buffer.from("x");
    const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, index) =>
      tarEntry(`${DAY}/junk-${index}`, tiny),
    );
    const fastest = { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } };
    const archiveBase = serve("many", brotliCompressSync(tarOf(many), fastest));
    await expect(archivePass(options({ archiveBase }))).rejects.toThrow(/members/);
    await noManifest();
  });

  it("refuses a long-name record over 1 KiB", async () => {
    const name = Buffer.from(`${DAY}/${"n".repeat(2 * 1024 * 1024)}`);
    const archiveBase = serve(
      "long-name",
      brotliCompressSync(
        tarOf([tarEntry("././@LongLink", name, "L"), memberAt(T("08:01"), feedB)]),
      ),
    );
    await expect(archivePass(options({ archiveBase }))).rejects.toThrow(/name record/);
    await noManifest();
  });

  it("gives up when the mirror sends no headers in time", async () => {
    const archiveBase = route("no-headers", () => undefined);
    await expect(archivePass(options({ archiveBase, headersTimeoutMs: 150 }))).rejects.toThrow(
      /no response headers/,
    );
    await noManifest();
  });

  it("gives up when the body stalls", async () => {
    const archiveBase = route("stall", (response) => {
      response.writeHead(200, { "content-length": String(archive.length) });
      response.write(archive.subarray(0, 100));
    });
    await expect(archivePass(options({ archiveBase, idleTimeoutMs: 150 }))).rejects.toThrow(
      /no bytes/,
    );
    await noManifest();
  });

  it("caps the compressed and the decompressed bytes", async () => {
    const archiveBase = serve("caps", archive, false);
    await expect(archivePass(options({ archiveBase, maxArchiveBytes: 100 }))).rejects.toThrow(
      /compressed bytes/,
    );
    await expect(archivePass(options({ archiveBase, maxDecodedBytes: 4096 }))).rejects.toThrow(
      /decompressed bytes/,
    );
    await noManifest();
  });

  it("counts members outside the day and repeated minutes without storing them", async () => {
    const body = brotliCompressSync(
      tarOf([
        memberAt(T("08:01"), feedB),
        memberAt(T("08:01"), feedC),
        memberAt(T("08:02") + 2 * 86_400_000, feedC),
      ]),
    );
    const report = await archivePass(options({ archiveBase: serve("window", body) }));
    expect(report).toMatchObject({ snapshots: 1, outOfWindow: 1, repeated: 1, complete: true });
    const lines = await readJsonLinesFile<ArchiveManifestLine>(
      manifestPath(manifests, "delfi-gtfs-rt", DAY),
    );
    expect(lines.filter((line) => line.type === "snapshot")).toHaveLength(1);
  });

  it("stops before downloading when free space is under the floor", async () => {
    await expect(
      archivePass(options({ diskFloorBytes: 1000, freeBytes: async () => 10 })),
    ).rejects.toThrow(/floor/);
    expect(requests).toEqual([]);
    await noManifest();
  });

  it("stops while spooling when free space falls under the floor", async () => {
    let calls = 0;
    const freeBytes = async () => (++calls > 1 ? 10 : 10_000);
    await expect(archivePass(options({ diskFloorBytes: 1000, freeBytes }))).rejects.toThrow(
      /floor/,
    );
    await noManifest();
    expect(await readdir(join(store, SPOOL_DIR))).toEqual([]);
  });
});

describe("archivePass reruns and leftovers", () => {
  it("stores nothing again on a second pass, invalid minutes included", async () => {
    await archivePass(options());
    const again = await archivePass(options());
    expect(again).toMatchObject({ stored: 0, unchanged: 0, invalid: 0, missingBefore: 0 });
    const records = await readFetchRecords(store, await listSidecars(store, "delfi-gtfs-rt"));
    expect(records).toHaveLength(2);
  });

  it("removes spool folders a killed pass left behind more than a day ago", async () => {
    const old = join(store, SPOOL_DIR, "2026-10-20-1");
    const fresh = join(store, SPOOL_DIR, "2026-10-21-2");
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await utimes(old, twoDaysAgo, twoDaysAgo);
    await archivePass(options({ dryRun: true }));
    expect(await readdir(join(store, SPOOL_DIR))).toEqual(["2026-10-21-2"]);
  });
});

describe("throttled", () => {
  it("holds a stream to the given rate", async () => {
    const chunks = Array.from({ length: 6 }, () => Buffer.alloc(1000));
    async function* source() {
      yield* chunks;
    }
    const started = Date.now();
    let total = 0;
    for await (const chunk of throttled(source(), 20_000, systemClock)) total += chunk.length;
    expect(total).toBe(6000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });
});
