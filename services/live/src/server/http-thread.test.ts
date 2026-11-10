import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Head } from "@gerlines/live-frame";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileStore } from "../publish/storage.ts";
import { type HttpThread, startHttpThread } from "./http-thread.ts";

const head: Head = {
  kind: "head",
  sequence: 42,
  timetableVersion: 1,
  timeBase: 1_761_400_000,
  keyframeSequence: 42,
  oldestSequence: 1,
};
const payload = Uint8Array.from({ length: 512 }, (_, i) => i % 251);

const STALL_MS = 400;
let root: string;
let thread: HttpThread;
let origin: string;

async function bytesOf(path: string): Promise<{ status: number; bytes: Uint8Array }> {
  const response = await fetch(`${origin}${path}`, { headers: { "Accept-Encoding": "identity" } });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met");
}

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}

const CLIENT = `
const [url, ms] = process.argv.slice(1);
const durations = [];
const end = Date.now() + Number(ms);
let first = true;
while (Date.now() < end) {
  const started = performance.now();
  const response = await fetch(url);
  await response.arrayBuffer();
  if (response.status !== 200) process.exit(2);
  durations.push(performance.now() - started);
  if (first) { first = false; durations.length = 0; process.stdout.write("started\\n"); }
}
process.stdout.write(JSON.stringify({ count: durations.length, max: Math.max(...durations) }) + "\\n");
`;

describe("the live HTTP thread", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "live-http-thread-"));
    const store = new FileStore(root);
    await store.object("k", 42, payload);
    thread = await startHttpThread({
      root,
      host: "127.0.0.1",
      port: 0,
      playback: null,
      engineStallMs: STALL_MS,
    });
    origin = `http://127.0.0.1:${thread.port}`;
  });

  afterAll(async () => {
    await thread?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("answers 404 for the head until one is posted, then the newest posted head", async () => {
    expect((await bytesOf("/live/v1/head")).status).toBe(404);
    thread.postHead(Uint8Array.from([1, 2, 3]));
    await until(async () => (await bytesOf("/live/v1/head")).status === 200);
    expect((await bytesOf("/live/v1/head")).bytes).toEqual(Uint8Array.from([1, 2, 3]));
    thread.postHead(Uint8Array.from([4, 5]));
    await until(async () => (await bytesOf("/live/v1/head")).bytes.length === 2);
    expect((await bytesOf("/live/v1/head")).bytes).toEqual(Uint8Array.from([4, 5]));
  });

  it("serves the published objects and the health check from the store", async () => {
    const keyframe = await bytesOf("/live/v1/k/42.bin");
    expect(keyframe.status).toBe(200);
    expect(keyframe.bytes).toEqual(payload);
    expect((await bytesOf("/live/v1/d/43.bin")).status).toBe(404);
    thread.beat();
    await until(async () => (await bytesOf("/healthz")).status === 200);
  });

  it("answers the head while the engine's thread is busy", async () => {
    thread.postHead(Uint8Array.from([7]));
    await until(async () => (await bytesOf("/live/v1/head")).bytes[0] === 7);
    const client = spawn(
      process.execPath,
      ["--input-type=module", "-e", CLIENT, `${origin}/live/v1/head`, "1500"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    const started = new Promise<void>((resolve) => {
      client.stdout.on("data", (chunk: Buffer) => {
        output += String(chunk);
        if (output.includes("started")) resolve();
      });
    });
    const exited = new Promise<number | null>((resolve) => client.on("exit", resolve));
    await started;
    busy(800);
    expect(await exited).toBe(0);
    const result = JSON.parse(output.trim().split("\n").at(-1) as string) as {
      count: number;
      max: number;
    };
    expect(result.count).toBeGreaterThan(20);
    expect(result.max).toBeLessThan(400);
  });

  it("serves the playback routes beside the live ones when a playback directory is given", async () => {
    const withPlayback = await startHttpThread({
      root,
      host: "127.0.0.1",
      port: 0,
      playback: root,
    });
    try {
      const base = `http://127.0.0.1:${withPlayback.port}`;
      expect((await fetch(`${base}/playback/v1/windows`)).status).toBe(200);
      expect((await fetch(`${base}/live/v1/k/42.bin`)).status).toBe(200);
      expect((await fetch(`${origin}/playback/v1/windows`)).status).toBe(404);
    } finally {
      await withPlayback.close();
    }
  });

  it("fails its health check when the engine stops beating and passes again on a beat", async () => {
    thread.beat();
    await until(async () => (await bytesOf("/healthz")).status === 200);
    await until(async () => (await bytesOf("/healthz")).status === 503);
    thread.beat();
    await until(async () => (await bytesOf("/healthz")).status === 200);
  });

  it("runs with a small heap of its own", () => {
    expect(thread.heapLimitMb).toBeGreaterThan(0);
    expect(thread.heapLimitMb).toBeLessThan(128);
  });

  it("reports why a thread that was serving stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-http-failing-"));
    try {
      const script = join(dir, "failing-worker.mjs");
      await writeFile(
        script,
        [
          'import { parentPort } from "node:worker_threads";',
          'parentPort.postMessage({ type: "listening", port: 1, heapLimitMb: 1 });',
          'setTimeout(() => { parentPort.postMessage({ type: "failed", error: "Error: EMFILE" }); process.exit(1); }, 50);',
        ].join("\n"),
      );
      const failing = await startHttpThread(
        { root, host: "127.0.0.1", port: 0, playback: null },
        pathToFileURL(script),
      );
      const stopped = await new Promise<Error>((resolve) => failing.onExit(resolve));
      expect(stopped.message).toMatch(/code 1/);
      expect(stopped.message).toMatch(/EMFILE/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start on an address in use", async () => {
    await expect(
      startHttpThread({ root, host: "127.0.0.1", port: thread.port, playback: null }),
    ).rejects.toThrow(/EADDRINUSE|address/i);
  });

  it("primes the head from the file the store holds when it starts", async () => {
    const primedRoot = await mkdtemp(join(tmpdir(), "live-http-primed-"));
    try {
      await new FileStore(primedRoot).head(Uint8Array.from([3, 1, 4]), head);
      const primed = await startHttpThread({
        root: primedRoot,
        host: "127.0.0.1",
        port: 0,
        playback: null,
      });
      try {
        const response = await fetch(`http://127.0.0.1:${primed.port}/live/v1/head`);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([3, 1, 4]));
      } finally {
        await primed.close();
      }
    } finally {
      await rm(primedRoot, { recursive: true, force: true });
    }
  });
});
