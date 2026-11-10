import { DataStatus, STATUS_PATH } from "@gerlines/schema/status";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "../search/openapi.ts";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import type { RecordedSource } from "./build.ts";
import { statusDatabaseOptions } from "./config.ts";
import { registerStatusRoutes, STATUS_RATE_LIMIT } from "./routes.ts";
import { STATUS_CACHE_MS, StatusService } from "./service.ts";
import type { LiveFreshnessReader, RecorderStore } from "./store.ts";

const START = Date.parse("2026-11-08T12:00:00Z");
const LEAKY = "connect ECONNREFUSED db.internal.example:5432 /srv/gerlines/data/recordings";

class FakeStore implements RecorderStore {
  calls = 0;
  failing = false;
  asked: { sources: readonly string[]; prefixes: readonly string[] } | null = null;
  private readonly rows: readonly RecordedSource[];
  constructor(rows: readonly RecordedSource[]) {
    this.rows = rows;
  }
  async recorded(sources: readonly string[], prefixes: readonly string[]) {
    this.calls += 1;
    this.asked = { sources, prefixes };
    if (this.failing) throw new Error(LEAKY);
    return [...this.rows];
  }
}

function setup({
  rows = [{ source: "gtfsde-rt", recordedAt: START - 60_000, recording: true }],
  live = {
    freshness: async () => ({
      confirmed: new Date(START - 4_000).toISOString(),
      feeds: { "gtfsde-rt": new Date(START - 90_000).toISOString() },
    }),
  } as LiveFreshnessReader | null,
  configured = true,
  limit = STATUS_RATE_LIMIT,
}: {
  rows?: readonly RecordedSource[];
  live?: LiveFreshnessReader | null;
  configured?: boolean;
  limit?: number;
} = {}) {
  let now = START;
  const clock = () => now;
  const errors: string[] = [];
  const logger = { error: (line: string) => void errors.push(line) };
  const store = new FakeStore(rows);
  const app = new Hono();
  registerStatusRoutes(app, {
    service: configured
      ? new StatusService({ store, live: live ?? undefined, logger, now: clock })
      : undefined,
    logger,
    now: clock,
    limiter: fixedWindowLimiter({ limit, windowMs: 60_000, now: clock }),
    peerAddress: () => "203.0.113.9",
  });
  return {
    app,
    store,
    errors,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe(`GET ${STATUS_PATH}`, () => {
  it("answers every source of the map with its state and the live engine's frame age", async () => {
    const { app, store } = setup();
    const response = await app.request(STATUS_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=30");
    const body = DataStatus.parse(await response.json());
    expect(body.at).toBe("2026-11-08T12:00:00.000Z");
    expect(body.live).toEqual({
      confirmedAt: "2026-11-08T11:59:56.000Z",
      frameAgeSeconds: 4,
      staleAfterSeconds: 30,
      state: "ok",
    });
    expect(body.sources.find((source) => source.id === "gtfsde-realtime")).toEqual({
      id: "gtfsde-realtime",
      name: "gtfs.de",
      kind: "realtime",
      country: "DE",
      recordedAt: "2026-11-08T11:59:00.000Z",
      dataTime: "2026-11-08T11:58:30.000Z",
      staleAfterSeconds: 300,
      state: "ok",
    });
    expect(body.sources.find((source) => source.id === "delfi-realtime")?.state).toBe(
      "not_recorded",
    );
    expect(store.asked?.sources).toContain("delfi-mobilithek-rt");
    expect(store.asked?.prefixes).toEqual(["db-iris-fchg-"]);
  });

  it("reads once per 30 s for every client and says how long the answer stays current", async () => {
    const { app, store, advance } = setup();
    await Promise.all([app.request(STATUS_PATH), app.request(STATUS_PATH)]);
    advance(20_500);
    const held = await app.request(STATUS_PATH);
    expect(held.headers.get("cache-control")).toBe("public, max-age=10");
    expect(((await held.json()) as { at: string }).at).toBe("2026-11-08T12:00:00.000Z");
    expect(store.calls).toBe(1);
    advance(STATUS_CACHE_MS);
    const fresh = await app.request(STATUS_PATH);
    expect(((await fresh.json()) as { at: string }).at).toBe("2026-11-08T12:00:50.500Z");
    expect(store.calls).toBe(2);
  });

  it("answers 503 status_unavailable without the reason, and holds the failure for 30 s", async () => {
    const { app, store, errors, advance } = setup();
    store.failing = true;
    const failed = await app.request(STATUS_PATH);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(failed.headers.get("retry-after")).toBe("30");
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({ error: "status_unavailable" });
    expect(text).not.toMatch(/internal|5432|srv|recordings/);
    expect(errors.join("\n")).not.toMatch(/internal|5432|srv|recordings/);
    expect(errors).toEqual(["status: recorder rows unreadable (Error)"]);
    store.failing = false;
    advance(12_400);
    const held = await Promise.all([app.request(STATUS_PATH), app.request(STATUS_PATH)]);
    expect(held.map((response) => response.status)).toEqual([503, 503]);
    expect(held.map((response) => response.headers.get("retry-after"))).toEqual(["18", "18"]);
    advance(17_599);
    expect((await app.request(STATUS_PATH)).headers.get("retry-after")).toBe("1");
    expect(store.calls).toBe(1);
    advance(1);
    expect((await app.request(STATUS_PATH)).status).toBe(200);
    expect(store.calls).toBe(2);
  });

  it("says the live engine has no reading when the live store fails or is not set up", async () => {
    const failing = setup({
      live: {
        freshness: async () => {
          throw new Error(LEAKY);
        },
      },
    });
    const body = DataStatus.parse(await (await failing.app.request(STATUS_PATH)).json());
    expect(body.live.state).toBe("not_recorded");
    expect(body.sources.find((source) => source.id === "gtfsde-realtime")?.dataTime).toBeNull();
    expect(failing.errors).toEqual(["status: live store unreadable (Error)"]);
    const none = setup({ live: null });
    const plain = DataStatus.parse(await (await none.app.request(STATUS_PATH)).json());
    expect(plain.live.frameAgeSeconds).toBeNull();
  });

  it("leaks no address, path or key of the stores in a healthy answer", async () => {
    const { app } = setup();
    const text = await (await app.request(STATUS_PATH)).text();
    expect(text).not.toMatch(
      /postgres|redis|valkey|live:|raw_object|\/data\/|localhost|127\.0\.0\.1/i,
    );
  });

  it("answers 503 not_configured without a database", async () => {
    const { app } = setup({ configured: false });
    const response = await app.request(STATUS_PATH);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it("limits each client to 60 requests a minute", async () => {
    const { app } = setup({ limit: 2 });
    expect((await app.request(STATUS_PATH)).status).toBe(200);
    expect((await app.request(STATUS_PATH)).status).toBe(200);
    const refused = await app.request(STATUS_PATH);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(STATUS_RATE_LIMIT).toBe(60);
  });
});

describe("status database options", () => {
  const logger = { error: () => undefined };

  it("takes the status database, else the statistics or search database", () => {
    expect(statusDatabaseOptions({}, logger)).toBeUndefined();
    expect(
      statusDatabaseOptions({ SEARCH_DATABASE_URL: "postgres://reader@db/gerlines" }, logger),
    ).toMatchObject({ databaseUrl: "postgres://reader@db/gerlines", maxConnections: 2 });
    expect(
      statusDatabaseOptions(
        {
          STATUS_DATABASE_URL: "postgresql://status@db/gerlines",
          STATS_DATABASE_URL: "postgres://stats@db/gerlines",
        },
        logger,
      )?.databaseUrl,
    ).toBe("postgresql://status@db/gerlines");
    expect(() => statusDatabaseOptions({ STATUS_DATABASE_URL: "mysql://x" }, logger)).toThrow(
      "STATUS_DATABASE_URL must be a postgres:// URL",
    );
    expect(() => statusDatabaseOptions({ STATS_DATABASE_URL: "mysql://x" }, logger)).toThrow(
      "STATS_DATABASE_URL must be a postgres:// URL",
    );
    expect(() => statusDatabaseOptions({ SEARCH_DATABASE_URL: "mysql://x" }, logger)).toThrow(
      "SEARCH_DATABASE_URL must be a postgres:// URL",
    );
  });

  it("reads in read-only transactions, also through the owner roles it falls back to", () => {
    const options = statusDatabaseOptions(
      { SEARCH_DATABASE_URL: "postgres://owner@db/gerlines" },
      logger,
    );
    expect(options?.readOnly).toBe(true);
  });
});

describe("status in the OpenAPI document", () => {
  it("names the route, its answer and its errors", () => {
    const document = openApiDocument("0.0.0") as { paths: Record<string, { get: unknown }> };
    const item = document.paths[STATUS_PATH]?.get as {
      operationId: string;
      responses: Record<string, unknown>;
    };
    expect(item.operationId).toBe("dataStatus");
    expect(Object.keys(item.responses)).toEqual(["200", "429", "503"]);
  });
});
