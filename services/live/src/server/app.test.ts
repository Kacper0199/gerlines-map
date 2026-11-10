import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import type { Head } from "@gerlines/live-frame";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileStore } from "../publish/storage.ts";
import {
  chooseEncoding,
  createLiveApp,
  createWaitingApp,
  ENGINE_STALL_MS,
  EngineHeartbeat,
  HeadBuffer,
} from "./app.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";
const payload = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 251);
const headBytes = Uint8Array.from([1, 2, 3, 4]);
const head: Head = {
  kind: "head",
  sequence: 42,
  timetableVersion: 1,
  timeBase: 1_761_400_000,
  keyframeSequence: 42,
  oldestSequence: 1,
};

let root: string;
let app: ReturnType<typeof createLiveApp>;

/** An object with the copies a pack set build writes beside it. */
async function writeObject(relative: string, bytes: Uint8Array): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  await writeFile(`${path}.br`, brotliCompressSync(bytes));
  await writeFile(`${path}.gz`, gzipSync(bytes));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "live-app-"));
  const store = new FileStore(root);
  await store.object("k", 42, payload);
  await store.object("d", 41, payload);
  await store.pack(1, 7, payload);
  await writeObject("sets/1/b/2995000/0.bin", payload);
  await writeObject("sets/1/i/2995000.bin", payload);
  await store.head(headBytes, head);
  app = createLiveApp(store);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function get(path: string, acceptEncoding?: string) {
  const response = await app.request(path, {
    headers: acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding },
  });
  return { response, body: new Uint8Array(await response.arrayBuffer()) };
}

function expectBinary(response: Response, cacheControl: string): void {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe(cacheControl);
  expect(response.headers.get("vary")).toBe("Accept-Encoding");
}

describe("live server headers (FORMAT.md section 7)", () => {
  it("serves brotli bytes when br is accepted", async () => {
    const { response, body } = await get("/live/v1/k/42.bin", "gzip, deflate, br");
    expectBinary(response, IMMUTABLE);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(new Uint8Array(brotliDecompressSync(body))).toEqual(payload);
  });

  it("serves the gzip copy when only gzip is accepted", async () => {
    const { response, body } = await get("/live/v1/d/41.bin", "gzip");
    expectBinary(response, IMMUTABLE);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(gunzipSync(body))).toEqual(payload);
  });

  it("serves plain bytes without an accepted encoding", async () => {
    const { response, body } = await get("/live/v1/s/1/7.bin", "identity");
    expectBinary(response, IMMUTABLE);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(body).toEqual(payload);
  });

  it("serves pack sets with brotli and immutable caching", async () => {
    for (const path of ["b/2995000/0", "i/2995000"]) {
      const { response, body } = await get(`/live/v1/sets/1/${path}.bin`, "br, gzip");
      expectBinary(response, IMMUTABLE);
      expect(response.headers.get("content-encoding")).toBe("br");
      expect(new Uint8Array(brotliDecompressSync(body))).toEqual(payload);
    }
    for (const path of [
      "/live/v1/sets/1/x/2995000.bin",
      "/live/v1/sets/1/b/2995000.bin",
      "/live/v1/sets/1/b/2995000/01.bin",
      "/live/v1/sets/1/b/2995001/0.bin",
      "/live/v1/sets/1/i/0.bin",
    ]) {
      expect((await get(path, "br")).response.status, path).toBe(404);
    }
  });

  it("sends the head plain with max-age 1", async () => {
    const { response, body } = await get("/live/v1/head", "br");
    expectBinary(response, "public, max-age=1");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(body).toEqual(headBytes);
  });

  it("answers 404 with a structured error for unknown or malformed paths", async () => {
    for (const path of [
      "/live/v1/k/43.bin",
      "/live/v1/k/042.bin",
      "/live/v1/d/..%2Fhead.bin",
      "/live/v1/s/1/7.br",
      "/live/v1/x/1.bin",
    ]) {
      const { response, body } = await get(path, "br");
      expect(response.status, path).toBe(404);
      expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
        error: { code: "NOT_FOUND", message: "no such object" },
      });
    }
  });
});

describe("the head from a prepared buffer", () => {
  it("serves the buffer's bytes with the head headers and never reads the store", async () => {
    const reads: string[] = [];
    const prepared = new HeadBuffer();
    const buffered = createLiveApp(
      {
        read: async (relative) => {
          reads.push(relative);
          return null;
        },
      },
      { head: prepared },
    );
    expect((await buffered.request("/live/v1/head")).status).toBe(404);
    prepared.set(headBytes);
    const response = await buffered.request("/live/v1/head", {
      headers: { "Accept-Encoding": "br" },
    });
    expectBinary(response, "public, max-age=1");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(headBytes);
    prepared.set(Uint8Array.from([9, 9]));
    const next = await buffered.request("/live/v1/head");
    expect(new Uint8Array(await next.arrayBuffer())).toEqual(Uint8Array.from([9, 9]));
    expect(reads).toEqual([]);
  });

  it("keeps its own copy of the bytes it was given", () => {
    const prepared = new HeadBuffer();
    const bytes = Uint8Array.from([1, 2]);
    prepared.set(bytes);
    bytes[0] = 7;
    expect(prepared.current()).toEqual(Uint8Array.from([1, 2]));
  });
});

describe("the health check with the engine's heartbeat", () => {
  it("is ok while the engine beats and 503 after 30 s without a beat", async () => {
    let now = 1_000_000;
    const engine = new EngineHeartbeat(() => now);
    const checked = createLiveApp({ read: async () => null }, { engine });
    expect((await checked.request("/healthz")).status).toBe(200);
    now += ENGINE_STALL_MS;
    expect((await checked.request("/healthz")).status).toBe(200);
    now += 1;
    const stalled = await checked.request("/healthz");
    expect(stalled.status).toBe(503);
    expect(stalled.headers.get("cache-control")).toBe("no-store");
    expect(await stalled.json()).toEqual({ ok: false, engineSilentS: 30 });
    engine.beat();
    expect((await checked.request("/healthz")).status).toBe(200);
  });

  it("counts from its start until the first beat", () => {
    let now = 5;
    const engine = new EngineHeartbeat(() => now);
    now += 7;
    expect(engine.silentMs()).toBe(7);
  });
});

describe("chooseEncoding", () => {
  it("honours q=0 and the wildcard", () => {
    expect(chooseEncoding("br;q=0, gzip")).toBe("gzip");
    expect(chooseEncoding("*")).toBe("br");
    expect(chooseEncoding("*;q=0")).toBeNull();
    expect(chooseEncoding(undefined)).toBeNull();
  });
});

describe("the waiting app", () => {
  it("answers 503 with the reason on the health check and on every live path", async () => {
    const waiting = createWaitingApp(4);
    const health = await waiting.request("/healthz");
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ok: false, waitingFor: "packs", epoch: 4 });
    const live = await waiting.request("/live/v1/head");
    expect(live.status).toBe(503);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(await live.json()).toMatchObject({ error: { code: "WAITING_FOR_PACKS" } });
  });
});
