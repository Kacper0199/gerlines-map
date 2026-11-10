import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { VirtualClock } from "../testing/virtual-clock.ts";
import { IRIS_LEASE_PATH, IrisLease, withIrisLease } from "./iris-lease.ts";

const START = Date.parse("2026-10-29T10:00:00Z");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-iris-lease-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const container = { pid: 1, host: "recorder-container" };
const laptop = { pid: 4242, host: "laptop" };

describe("IrisLease", () => {
  it("lets one process hold it and tells the other who does", async () => {
    const clock = new VirtualClock(START);
    const recorder = new IrisLease({ root, clock, ...container });
    const cli = new IrisLease({ root, clock, ...laptop });
    expect(await recorder.hold()).toBeNull();
    expect(await cli.hold()).toMatch(/pid 1 on recorder-container/);
    await recorder.release();
    expect(await cli.hold()).toBeNull();
    expect(await recorder.hold()).toMatch(/pid 4242 on laptop/);
  });

  it("stays held while it is renewed and passes on only after 90 s without renewal", async () => {
    const clock = new VirtualClock(START);
    const recorder = new IrisLease({ root, clock, ...container });
    const cli = new IrisLease({ root, clock, ...laptop });
    expect(await recorder.hold()).toBeNull();
    await clock.runUntil(START + 60_000);
    expect(await recorder.hold()).toBeNull();
    await clock.runUntil(START + 140_000);
    expect(await cli.hold()).not.toBeNull();
    await clock.runUntil(START + 151_000);
    expect(await cli.hold()).toBeNull();
    expect(await recorder.hold()).toMatch(/pid 4242 on laptop/);
  });
});

describe("withIrisLease", () => {
  it("refuses to start while another process holds the lease", async () => {
    await new IrisLease({ root, clock: systemClock, ...container }).hold();
    let ran = false;
    await expect(
      withIrisLease({ root, clock: systemClock, ...laptop }, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/IRIS lease is held by pid 1 on recorder-container/);
    expect(ran).toBe(false);
  });

  it("holds the lease while the task runs and releases it afterwards", async () => {
    const owner = await withIrisLease({ root, clock: systemClock, ...laptop }, async () =>
      JSON.parse(await readFile(join(root, IRIS_LEASE_PATH), "utf8")),
    );
    expect(owner).toMatchObject(laptop);
    await expect(stat(join(root, IRIS_LEASE_PATH))).rejects.toThrow(/ENOENT/);
  });

  it("aborts the task when a renewal finds the lease taken over, and leaves the new owner's file", async () => {
    const path = join(root, IRIS_LEASE_PATH);
    const reason = await withIrisLease(
      { root, clock: systemClock, ...laptop, renewEveryMs: 10 },
      async (signal) => {
        const now = new Date().toISOString();
        await writeFile(path, JSON.stringify({ ...container, startedAt: now, heartbeatAt: now }));
        for (let waited = 0; !signal.aborted && waited < 5_000; waited += 10) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return signal.reason;
      },
    );
    expect(String(reason)).toMatch(/pid 1 on recorder-container/);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(container);
  });
});

describe("db-apis CLI", () => {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const offline = {
    PATH: process.env.PATH ?? "",
    DB_CLIENT_ID: "made-up-db-client-id-0000",
    DB_API_KEY: "made-up-db-api-key-1111111",
    APP_NAME: "gerlines-test",
    APP_CONTACT: "test@example.org",
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
  };
  const run = (args: string[], env: Record<string, string> = offline) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, timeout: 20_000 });

  it("refuses iris-run and sample while the recorder holds the IRIS lease", async () => {
    await new IrisLease({ root, clock: systemClock, ...container }).hold();
    for (const command of ["iris-run", "sample"]) {
      const result = run([command, "--out", join(root, "out"), "--recordings", root]);
      expect(result.status, command).toBe(1);
      expect(result.stderr, command).toMatch(/IRIS lease is held by pid 1 on recorder-container/);
    }
    await expect(stat(join(root, "out", "run.json"))).rejects.toThrow(/ENOENT/);
  }, 60_000);

  it("refuses iris-run without the recordings folder that holds the lease", () => {
    const result = run(["iris-run", "--out", join(root, "out")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--recordings/);
    const missing = run(["iris-run", "--out", join(root, "out"), "--recordings", join(root, "x")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/does not exist/);
  }, 60_000);
});
