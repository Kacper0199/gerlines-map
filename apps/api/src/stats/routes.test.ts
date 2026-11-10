import { StatsNetwork, StatsStation } from "@gerlines/schema/stats";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { openApiDocument } from "../search/openapi.ts";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import { readGate } from "./reads.ts";
import { registerStatsRoutes, resolveRange, STATS_RATE_LIMIT } from "./routes.ts";
import { StatsService } from "./service.ts";
import { GoldenReader, STATION_A, totals } from "./test-data.ts";

const NOW = Date.parse("2026-11-07T23:30:00Z");
const errors: string[] = [];
const logger = { error: (line: string) => void errors.push(line) };

function appWith(reader: GoldenReader | undefined, limit = STATS_RATE_LIMIT) {
  const app = new Hono();
  registerStatsRoutes(app, {
    service: reader && new StatsService(reader, () => NOW),
    logger,
    now: () => NOW,
    limiter: fixedWindowLimiter({ limit, windowMs: 60_000, now: () => NOW }),
    peerAddress: () => "203.0.113.9",
  });
  return app;
}

const golden = () =>
  new GoldenReader({
    "land_category_day:germany/": [
      { key: {}, ...totals({ n_stops: 10, n_observed_arr: 8, n_lt_6min_arr: 6 }) },
    ],
    "station_day/": [{ key: {}, ...totals({ n_stops: 4 }) }],
  });

describe("stats routes", () => {
  it("answers today for the Berlin service day, which is tomorrow in UTC terms after 23:00 UTC", async () => {
    const reader = golden();
    const response = await appWith(reader).request("/api/v1/stats/today?category=hsr,ld");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const body = StatsNetwork.parse(await response.json());
    expect(body.period).toEqual({ from: "2026-11-08", to: "2026-11-08", days: 1 });
    expect(body.summary.punctual6).toBe(0.75);
    expect(reader.calls[0]?.filter.categories).toEqual(["hsr", "ld"]);
  });

  it("caches settled periods for an hour and recent ones for a minute", async () => {
    const app = appWith(golden());
    const settled = await app.request("/api/v1/stats/period?from=2026-10-01&to=2026-10-31");
    expect(settled.status).toBe(200);
    expect(settled.headers.get("cache-control")).toBe("public, max-age=3600");
    const recent = await app.request("/api/v1/stats/period?from=2026-11-01&to=2026-11-06");
    expect(recent.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it.each([
    ["/api/v1/stats/period?from=2026-11-07&to=2026-11-01", "from"],
    ["/api/v1/stats/period?from=2025-01-01&to=2026-11-01", "to"],
    ["/api/v1/stats/period?from=2026-13-01", "from"],
    ["/api/v1/stats/today?category=tram", "category.0"],
    ["/api/v1/stats/stations/not-a-uuid", "id"],
    ["/api/v1/stats/lands/DE-XX", "code"],
    ["/api/v1/stats/trains/ICE%201001", "number"],
    ["/api/v1/stats/lines/RE5;DROP", "line"],
    ["/api/v1/stats/trains/1001?operator=DB%20AG", "operator"],
  ])("refuses %s with 400 naming %s", async (path, field) => {
    const response = await appWith(golden()).request(path);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((issue) => issue.path)).toContain(field);
  });

  it("answers a station, 404 for an unknown one, and a Land code in lower case", async () => {
    const app = appWith(golden());
    const station = await app.request(
      `/api/v1/stats/stations/${STATION_A.toUpperCase()}?from=2026-11-01`,
    );
    expect(station.status).toBe(200);
    expect(StatsStation.parse(await station.json()).period).toEqual({
      from: "2026-11-01",
      to: "2026-11-08",
      days: 8,
    });
    const unknown = await app.request(
      "/api/v1/stats/stations/00000000-0000-4000-8000-000000000000",
    );
    expect(unknown.status).toBe(404);
    expect((await app.request("/api/v1/stats/lands/de-by")).status).toBe(200);
  });

  it("answers a train and a line with an operator filter", async () => {
    const app = appWith(golden());
    expect((await app.request("/api/v1/stats/trains/1001?operator=db-fernverkehr-ag")).status).toBe(
      200,
    );
    expect((await app.request("/api/v1/stats/lines/S%2041")).status).toBe(200);
  });

  it("answers 503 not_configured without a database and 503 stats_unavailable when a query fails", async () => {
    const missing = await appWith(undefined).request("/api/v1/stats/today");
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "not_configured" });
    const reader = golden();
    reader.failWith = new Error("canceling statement due to statement timeout");
    errors.length = 0;
    const failed = await appWith(reader).request("/api/v1/stats/period?from=2026-11-01");
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("5");
    expect(await failed.json()).toEqual({ error: "stats_unavailable" });
    expect(errors[0]).toContain("statement timeout");
  });

  it("answers 503 with Retry-After and logs nothing while the statistics reads are all taken", async () => {
    const reader = golden();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = reader.rollup.bind(reader);
    reader.rollup = async (...args) => {
      await released;
      return original(...args);
    };
    const app = new Hono();
    registerStatsRoutes(app, {
      service: new StatsService(reader, () => NOW),
      logger,
      now: () => NOW,
      reads: readGate(1),
      peerAddress: () => "203.0.113.9",
    });
    errors.length = 0;
    const slow = app.request("/api/v1/stats/period?from=2026-10-01&to=2026-10-02");
    await new Promise((resolve) => setImmediate(resolve));
    const busy = await app.request("/api/v1/stats/period?from=2026-10-03&to=2026-10-04");
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(busy.headers.get("cache-control")).toBe("no-store");
    expect(await busy.json()).toEqual({ error: "stats_unavailable" });
    expect(errors).toEqual([]);
    release();
    expect((await slow).status).toBe(200);
    expect((await app.request("/api/v1/stats/period?from=2026-10-03&to=2026-10-04")).status).toBe(
      200,
    );
  });

  it("counts a read by its queries, so a network read takes the whole pool of six", async () => {
    const reader = golden();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = reader.rollup.bind(reader);
    reader.rollup = async (...args) => {
      await released;
      return original(...args);
    };
    const reads = readGate(6);
    const app = new Hono();
    registerStatsRoutes(app, {
      service: new StatsService(reader, () => NOW),
      logger,
      now: () => NOW,
      reads,
      peerAddress: () => "203.0.113.9",
    });
    const train = app.request("/api/v1/stats/trains/596?from=2026-10-01&to=2026-10-02");
    const line = app.request("/api/v1/stats/lines/RE%205?from=2026-10-01&to=2026-10-02");
    await new Promise((resolve) => setImmediate(resolve));
    expect(reads.inFlight()).toBe(6);
    const busy = await app.request("/api/v1/stats/period?from=2026-10-03&to=2026-10-04");
    expect(busy.status).toBe(503);
    release();
    expect([(await train).status, (await line).status]).toEqual([200, 200]);
    expect(reads.inFlight()).toBe(0);
    const network = app.request("/api/v1/stats/period?from=2026-10-05&to=2026-10-06");
    await new Promise((resolve) => setImmediate(resolve));
    expect(reads.inFlight()).toBe(0);
    expect((await network).status).toBe(200);
  });

  it("logs a failing read once a minute with the count of the lines it held back", async () => {
    const reader = golden();
    reader.failWith = new Error("canceling statement due to statement timeout");
    let now = NOW;
    const app = new Hono();
    registerStatsRoutes(app, {
      service: new StatsService(reader, () => now),
      logger,
      now: () => now,
      peerAddress: () => "203.0.113.9",
    });
    errors.length = 0;
    for (const day of ["01", "02", "03", "04", "05"]) {
      expect((await app.request(`/api/v1/stats/period?from=2026-10-${day}`)).status).toBe(503);
    }
    expect(errors).toHaveLength(1);
    now += 60_000;
    await app.request("/api/v1/stats/period?from=2026-10-06");
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("statement timeout");
    expect(errors[1]).toContain("4 more since the last line");
  });

  it("limits each client to its share of requests per minute", async () => {
    const app = appWith(golden(), 2);
    expect((await app.request("/api/v1/stats/today")).status).toBe(200);
    expect((await app.request("/api/v1/stats/today")).status).toBe(200);
    const refused = await app.request("/api/v1/stats/today");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
  });

  it("limits periods over 31 days to ten a minute per client on top of the general limit", async () => {
    const app = appWith(golden());
    for (let day = 1; day <= 10; day += 1) {
      const from = `2025-01-${String(day).padStart(2, "0")}`;
      const response = await app.request(`/api/v1/stats/period?from=${from}&to=2025-12-31`);
      expect(response.status).toBe(200);
    }
    const refused = await app.request("/api/v1/stats/period?from=2025-01-11&to=2025-12-31");
    expect(refused.status).toBe(429);
    const short = await app.request("/api/v1/stats/period?from=2025-12-01&to=2025-12-31");
    expect(short.status).toBe(200);
  });

  it("charges the long-period limit only when the answer is not cached", async () => {
    const app = appWith(golden());
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      const response = await app.request("/api/v1/stats/period?from=2025-01-01&to=2025-12-31");
      expect(response.status).toBe(200);
    }
    for (let day = 2; day <= 11; day += 1) {
      const from = `2025-01-${String(day).padStart(2, "0")}`;
      const response = await app.request(`/api/v1/stats/period?from=${from}&to=2025-12-31`);
      expect(response.status).toBe(day <= 10 ? 200 : 429);
    }
  });

  it("shares one read between concurrent requests and serves repeats from the cache", async () => {
    const reader = golden();
    const app = appWith(reader);
    const url = "/api/v1/stats/period?from=2025-11-01&to=2025-11-30&category=reg,hsr";
    const answers = await Promise.all([app.request(url), app.request(url)]);
    expect(answers.map((response) => response.status)).toEqual([200, 200]);
    const reads = reader.calls.length;
    expect(
      (await app.request("/api/v1/stats/period?from=2025-11-01&to=2025-11-30&category=hsr,reg"))
        .status,
    ).toBe(200);
    expect(reader.calls.length).toBe(reads);
    expect(reads).toBe(new Set(reader.calls.map((call) => JSON.stringify(call))).size);
  });

  it("refuses days outside 2000 to 2100 with 400", async () => {
    const app = appWith(golden());
    const old = await app.request("/api/v1/stats/period?from=0000-01-01&to=2025-01-01");
    expect(old.status).toBe(400);
    expect((await app.request("/api/v1/stats/period?from=2101-01-01")).status).toBe(400);
  });

  it("defaults a period to today and a future from to a single day", () => {
    expect(resolveRange({}, "2026-11-07")).toEqual({ from: "2026-11-07", to: "2026-11-07" });
    expect(resolveRange({ from: "2026-11-09" }, "2026-11-07")).toEqual({
      from: "2026-11-09",
      to: "2026-11-09",
    });
    expect(resolveRange({ to: "2026-11-01" }, "2026-11-07")).toEqual({
      from: "2026-11-01",
      to: "2026-11-01",
    });
  });
});

describe("stats in the app and the OpenAPI document", () => {
  it("is wired into createApp and described in OpenAPI 3.1", async () => {
    const app = createApp({});
    expect((await app.request("/api/v1/stats/today")).status).toBe(503);
    const document = openApiDocument("0.0.0");
    const paths = Object.keys(document.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/v1/stats/today",
        "/api/v1/stats/period",
        "/api/v1/stats/trains/{number}",
        "/api/v1/stats/trains/{number}/segments",
        "/api/v1/stats/lines/{line}",
        "/api/v1/stats/stations/{id}",
        "/api/v1/stats/lands/{code}",
      ]),
    );
    const period = document.paths["/api/v1/stats/period"] as {
      get: { parameters: { name: string }[]; responses: Record<string, unknown> };
    };
    expect(period.get.parameters.map((parameter) => parameter.name)).toEqual([
      "from",
      "to",
      "category",
    ]);
    expect(Object.keys(period.get.responses)).toEqual(["200", "400", "429", "503"]);
    const pathSchemaOf = (path: string) =>
      (
        (document.paths as Record<string, unknown>)[path] as {
          get: { parameters: { in: string; schema: { pattern?: string; enum?: string[] } }[] };
        }
      ).get.parameters.find((parameter) => parameter.in === "path")?.schema;
    expect(pathSchemaOf("/api/v1/stats/lines/{line}")?.pattern).toBe(
      "^[0-9A-Za-zÄÖÜäöüß+ -]{1,16}$",
    );
    expect(pathSchemaOf("/api/v1/stats/trains/{number}")?.pattern).toBe("^[0-9A-Za-z]{1,12}$");
    expect(pathSchemaOf("/api/v1/stats/trains/{number}/segments")?.pattern).toBe(
      "^[0-9A-Za-z]{1,12}$",
    );
    expect(pathSchemaOf("/api/v1/stats/lands/{code}")?.enum).toContain("DE-BY");
  });
});
