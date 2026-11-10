import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrainDetailPublisher } from "./detail/publisher.ts";
import { FileStore } from "./publish/storage.ts";
import {
  connectValkey,
  detailEnabled,
  detailPublisherFor,
  detailReadMode,
  notifierFromEnvironment,
  openDetail,
  PLACEHOLDER_SECRET,
  parseClock,
  serveAndTick,
  waitForPacks,
  waitServing,
} from "./run.ts";
import type { HttpThread } from "./server/http-thread.ts";

describe("connectValkey", () => {
  const saved = process.env.VALKEY_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.VALKEY_URL;
    else process.env.VALKEY_URL = saved;
  });

  it("refuses to run without VALKEY_URL unless keys may live in memory", async () => {
    delete process.env.VALKEY_URL;
    await expect(connectValkey(false)).rejects.toThrow(/--memory-keys/);
    await expect(connectValkey(true)).resolves.toBeNull();
  });
});

describe("parseClock", () => {
  it("replays from an instant at a speed", () => {
    let wall = 100;
    const clock = parseClock("replay:2026-10-25T12:00:00Z:10", () => wall);
    wall = 101;
    expect(clock.now()).toBe(Date.parse("2026-10-25T12:00:00Z") / 1000 + 10);
  });
});

describe("notifierFromEnvironment", () => {
  const url = "http://127.0.0.1:8000";

  it("sends no notices without CENTRIFUGO_URL", () => {
    expect(notifierFromEnvironment({})).toBeNull();
  });

  it("refuses a missing key and the placeholder outside the local stack", () => {
    expect(() => notifierFromEnvironment({ CENTRIFUGO_URL: url })).toThrow(/empty/);
    expect(() =>
      notifierFromEnvironment({ CENTRIFUGO_URL: url, CENTRIFUGO_HTTP_API_KEY: PLACEHOLDER_SECRET }),
    ).toThrow(/placeholder/);
    expect(
      notifierFromEnvironment({
        CENTRIFUGO_URL: url,
        CENTRIFUGO_HTTP_API_KEY: PLACEHOLDER_SECRET,
        LIVE_LOCAL_STACK: "1",
      }),
    ).not.toBeNull();
  });
});

describe("detailPublisherFor", () => {
  const db = {} as Parameters<typeof detailPublisherFor>[0]["db"];
  const valkey = { pipeline: () => ({}) } as unknown as Parameters<
    typeof detailPublisherFor
  >[0]["valkey"];
  const logger = { info: () => {}, error: () => {} };

  it("reads the folded stop state on the system clock and the forecasts on a replay", () => {
    expect(detailReadMode("system")).toBe("current");
    expect(detailReadMode("replay:2026-10-27T02:28:00Z:10")).toBe("history");
  });

  it("publishes details only with Valkey, where the API reads them", () => {
    expect(detailPublisherFor({ db, valkey: null, mode: "current", env: {}, logger })).toBeNull();
    expect(detailPublisherFor({ db, valkey, mode: "current", env: {}, logger })).toBeInstanceOf(
      TrainDetailPublisher,
    );
  });

  it("is switched off by LIVE_DETAIL=0", () => {
    expect(
      detailPublisherFor({ db, valkey, mode: "current", env: { LIVE_DETAIL: "0" }, logger }),
    ).toBeNull();
  });

  it("pushes to Centrifugo under the same key rules as the notices", () => {
    const url = "http://127.0.0.1:8000";
    expect(() =>
      detailPublisherFor({ db, valkey, mode: "current", env: { CENTRIFUGO_URL: url }, logger }),
    ).toThrow(/empty/);
    expect(() =>
      detailPublisherFor({
        db,
        valkey,
        mode: "current",
        env: { CENTRIFUGO_URL: url, CENTRIFUGO_HTTP_API_KEY: PLACEHOLDER_SECRET },
        logger,
      }),
    ).toThrow(/placeholder/);
    expect(() =>
      detailPublisherFor({
        db,
        valkey,
        mode: "current",
        env: { CENTRIFUGO_URL: "http://centrifugo.example.org", CENTRIFUGO_HTTP_API_KEY: "k" },
        logger,
      }),
    ).toThrow(/https/);
    const publisher = detailPublisherFor({
      db,
      valkey,
      mode: "current",
      env: { CENTRIFUGO_URL: url, CENTRIFUGO_HTTP_API_KEY: "k" },
      logger,
    });
    expect(publisher?.pushes).toBe(true);
  });
});

describe("openDetail", () => {
  function fakes(status = "wait") {
    const calls: string[] = [];
    const connection = {
      status,
      pipeline: () => ({}),
      connect: async () => void calls.push("connect"),
      quit: async () => void calls.push("quit"),
    };
    const valkey = {
      duplicate: () => {
        calls.push("duplicate");
        return connection;
      },
    } as unknown as Parameters<typeof openDetail>[0]["valkey"];
    const db = { destroy: async () => void calls.push("destroy") } as unknown as ReturnType<
      Parameters<typeof openDetail>[0]["openDatabase"]
    >;
    const openDatabase = () => {
      calls.push("open pool");
      return db;
    };
    return { calls, valkey, openDatabase };
  }
  const logger = { info: () => {}, error: () => {} };

  it("gives the writer a Valkey connection and a database pool of its own, closed together", async () => {
    const f = fakes();
    const detail = await openDetail({ ...f, mode: "current", env: {}, logger });
    expect(detail?.publisher).toBeInstanceOf(TrainDetailPublisher);
    expect(f.calls).toEqual(["duplicate", "connect", "open pool"]);
    await detail?.close();
    expect(f.calls.slice(3)).toEqual(["destroy", "quit"]);
  });

  it("connects a duplicated client only when it is not connecting already", async () => {
    const f = fakes("connecting");
    await openDetail({ ...f, mode: "current", env: {}, logger });
    expect(f.calls).toEqual(["duplicate", "open pool"]);
  });

  it("opens nothing without Valkey, when switched off, or with a bad Centrifugo setting", async () => {
    const f = fakes();
    expect(await openDetail({ ...f, valkey: null, mode: "current", env: {}, logger })).toBeNull();
    for (const value of ["0", "false", "off", "no"]) {
      expect(detailEnabled({ LIVE_DETAIL: value })).toBe(false);
      expect(
        await openDetail({ ...f, mode: "current", env: { LIVE_DETAIL: value }, logger }),
      ).toBeNull();
    }
    expect(detailEnabled({})).toBe(true);
    expect(detailEnabled({ LIVE_DETAIL: "1" })).toBe(true);
    await expect(
      openDetail({
        ...f,
        mode: "current",
        env: { CENTRIFUGO_URL: "http://127.0.0.1:8000" },
        logger,
      }),
    ).rejects.toThrow(/empty/);
    expect(f.calls).toEqual([]);
  });
});

describe("Centrifugo access", () => {
  it("refuses a key over plain http to a remote host for the notices too", () => {
    expect(() =>
      notifierFromEnvironment({
        CENTRIFUGO_URL: "http://centrifugo.example.org",
        CENTRIFUGO_HTTP_API_KEY: "k",
      }),
    ).toThrow(/https/);
    expect(
      notifierFromEnvironment({
        CENTRIFUGO_URL: "http://centrifugo:8000",
        CENTRIFUGO_HTTP_API_KEY: "k",
      }),
    ).not.toBeNull();
  });
});

describe("waitForPacks", () => {
  it("waits with a log line instead of exiting until the epoch's packs are there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-wait-"));
    try {
      const store = new FileStore(dir);
      const logs: Record<string, unknown>[] = [];
      let looks = 0;
      let clock = 0;
      const ready = await waitForPacks(store, 4, {
        log: (f) => logs.push(f),
        stopped: () => false,
        everyMs: 30_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          looks++;
          if (looks === 2) await store.pack(4, 1, new Uint8Array([1]));
          if (looks === 3) await store.markPacksComplete(4, 1, { shapes: 1 });
        },
      });
      expect(ready).toBe(true);
      expect(looks).toBe(3);
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({
        msg: "waiting for packs",
        epoch: 4,
        missing: `${dir}/s/4/complete.json`,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("logs once a minute of waiting whatever the look interval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-wait-"));
    try {
      const logs: Record<string, unknown>[] = [];
      let clock = 0;
      let looks = 0;
      await waitForPacks(new FileStore(dir), 4, {
        log: (f) => logs.push(f),
        stopped: () => looks === 20,
        everyMs: 7_000,
        now: () => clock,
        sleep: async (ms) => {
          looks++;
          clock += ms;
        },
      });
      expect(logs.map((f) => f.waitedS)).toEqual([0, 63, 126]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives up when the process is asked to stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-wait-"));
    try {
      let stop = false;
      const ready = await waitForPacks(new FileStore(dir), 4, {
        log: () => {},
        stopped: () => stop,
        sleep: async () => {
          stop = true;
        },
      });
      expect(ready).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return typeof address === "object" && address ? address.port : 0;
}

describe("waitServing", () => {
  it("answers 503 on the health check while waiting and frees the port once the packs are there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-wait-"));
    try {
      const store = new FileStore(dir);
      const port = await freePort();
      const waited = waitServing(
        store,
        4,
        { host: "127.0.0.1", port },
        { log: () => {}, stopped: () => false, everyMs: 50, timetableVersion: 2 },
      );
      let health: Response | null = null;
      for (let i = 0; i < 50 && !health; i++) {
        health = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
        if (!health) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(health?.status).toBe(503);
      await store.pack(4, 1, new Uint8Array([1]));
      await store.markPacksComplete(4, 1, { shapes: 1 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await freePortIsFree(port)).toBe(false);
      await store.markPacksComplete(4, 2, { shapes: 1 });
      expect(await waited).toBe(true);
      expect(await freePortIsFree(port)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

async function freePortIsFree(port: number): Promise<boolean> {
  const server = createServer();
  const ok = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (ok) await new Promise((resolve) => server.close(resolve));
  return ok;
}

describe("serveAndTick", () => {
  function fakeThread() {
    let exit: ((error: Error) => void) | undefined;
    const calls: string[] = [];
    const thread: HttpThread = {
      port: 1,
      heapLimitMb: 88,
      postHead: () => {},
      beat: () => calls.push("beat"),
      onExit: (listener) => {
        exit = listener;
      },
      close: async () => {
        calls.push("close thread");
      },
    };
    return { thread, calls, exit: (error: Error) => exit?.(error) };
  }

  it("closes the engine's resources and rethrows when the server does not start", async () => {
    const closed: string[] = [];
    await expect(
      serveAndTick({
        start: async () => {
          throw new Error("EADDRINUSE");
        },
        step: async () => {},
        stopped: () => false,
        stop: () => {},
        close: async () => {
          closed.push("resources");
        },
        log: () => {},
        pauseMs: 0,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
    expect(closed).toEqual(["resources"]);
  });

  it("beats after each step, then closes the thread before the resources", async () => {
    const t = fakeThread();
    let steps = 0;
    const code = await serveAndTick({
      start: async () => t.thread,
      step: async () => {
        steps++;
        t.calls.push("step");
      },
      stopped: () => steps >= 3,
      stop: () => {},
      close: async () => {
        t.calls.push("resources");
      },
      log: () => {},
      pauseMs: 0,
    });
    expect(code).toBe(0);
    expect(t.calls).toEqual([
      "step",
      "beat",
      "step",
      "beat",
      "step",
      "beat",
      "close thread",
      "resources",
    ]);
  });

  it("stops with exit code 1 and logs the cause when the thread ends on its own", async () => {
    const t = fakeThread();
    let stopping = false;
    const logged: Record<string, unknown>[] = [];
    const code = await serveAndTick({
      start: async () => t.thread,
      step: async () => {
        t.exit(new Error("live HTTP thread exited with code 1: Error: EMFILE"));
      },
      stopped: () => stopping,
      stop: () => {
        stopping = true;
      },
      close: async () => {},
      log: (fields) => logged.push(fields),
      pauseMs: 0,
    });
    expect(code).toBe(1);
    expect(logged).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "http server stopped",
        error: expect.stringMatching(/EMFILE/),
      }),
    ]);
  });
});
