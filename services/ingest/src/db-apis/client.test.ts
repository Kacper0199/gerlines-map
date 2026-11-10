import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import { redactText, redactUrl } from "../redact.ts";
import { DbApiClient, dbApiSecrets, irisPath, loadDbCredentials } from "./client.ts";
import {
  ApiLimiter,
  bucketCeiling,
  DB_API_LIMITS,
  IRIS_MIN_HEADROOM,
  IRIS_PLAN_LIMIT_PER_MINUTE,
  IRIS_SCHEDULE_CADENCE,
  irisBudget,
} from "./limits.ts";
import { irisTasks } from "./live.ts";
import { IRIS_STATIONS } from "./stations.ts";

const credentials = { clientId: "made-up-client-id-0000", apiKey: "made-up-api-key-11111111" };
const seen: IncomingMessage["headers"][] = [];
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(request.headers);
    if (request.url?.includes("/rchg/8000429")) {
      response.writeHead(429, { "retry-after": "120" }).end();
    } else if (request.url?.includes("/rchg/8000503")) {
      response.writeHead(503).end();
    } else {
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end("<timetable station='X'/>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function fakeClock(start = 0): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += Math.max(ms, 0);
    },
  };
}

function realClockClient(): DbApiClient {
  const clock: Clock = { now: () => Date.now(), sleep: async () => undefined };
  return new DbApiClient({ credentials, userAgent: "GerLinesTest/0.0.0 (+test)", clock, baseUrl });
}

describe("DbApiClient", () => {
  it("sends the K1 headers and the User-Agent, never the keys in the URL", async () => {
    const response = await realClockClient().get("timetables", irisPath("fchg", 8000105));
    expect(response.status).toBe(200);
    expect(response.body?.toString()).toContain("timetable");
    const headers = seen.at(-1) ?? {};
    expect(headers["db-client-id"]).toBe(credentials.clientId);
    expect(headers["db-api-key"]).toBe(credentials.apiKey);
    expect(headers["user-agent"]).toBe("GerLinesTest/0.0.0 (+test)");
    expect(headers.accept).toBe("application/xml");
    expect(response.url).toBe(`${baseUrl}/timetables/v1/fchg/8000105`);
    expect(JSON.stringify(response)).not.toContain(credentials.apiKey);
    expect(JSON.stringify(response)).not.toContain(credentials.clientId);
  });

  it("holds every caller of the API back for Retry-After after a 429, and a minute after a 503", async () => {
    const client = realClockClient();
    const before = Date.now();
    const limited = await client.get("timetables", "/rchg/8000429");
    expect(limited.status).toBe(429);
    expect(limited.retryAfterMs).toBe(120_000);
    expect(client.limiter("timetables").pausedUntilMs).toBeGreaterThanOrEqual(before + 120_000);
    expect(client.limiter("stada").pausedUntilMs).toBe(0);
    const unavailable = await realClockClient().get("timetables", "/rchg/8000503");
    expect(unavailable.retryAfterMs).toBe(60_000);
  });

  it("redacts both header values from errors and URLs", () => {
    const secrets = dbApiSecrets(credentials);
    const leak = `GET https://x.example/?k=${credentials.apiKey} as ${credentials.clientId} failed`;
    expect(redactText(leak, secrets)).not.toMatch(/made-up/);
    expect(redactUrl(`https://x.example/${credentials.apiKey}`, secrets)).toBe(
      "https://x.example/redacted",
    );
  });

  it("loads K1 only when both values are set", () => {
    expect(loadDbCredentials({ DB_CLIENT_ID: "a", DB_API_KEY: " " })).toBeNull();
    expect(loadDbCredentials({ DB_CLIENT_ID: " a ", DB_API_KEY: "b" })).toEqual({
      clientId: "a",
      apiKey: "b",
    });
  });

  it("builds IRIS paths, the plan in German local time", () => {
    expect(irisPath("plan", 8000105, Date.parse("2026-10-25T23:06:00Z"))).toBe(
      "/plan/8000105/261026/00",
    );
    expect(irisPath("rchg", 8000105)).toBe("/rchg/8000105");
    expect(() => irisPath("plan", 8000105)).toThrow(/hour/);
    expect(() => irisPath("fchg", 0)).toThrow(/EVA/);
  });
});

describe("IRIS limits", () => {
  it("keeps any rolling minute at least 30 % under the plan limit", () => {
    const ceiling = bucketCeiling(DB_API_LIMITS.timetables);
    expect(ceiling).toBeLessThanOrEqual(IRIS_PLAN_LIMIT_PER_MINUTE * (1 - IRIS_MIN_HEADROOM));
  });

  it("fits the chosen station set and cadence under the ceiling with room for other callers", () => {
    const budget = irisBudget({ stations: IRIS_STATIONS.length, ...IRIS_SCHEDULE_CADENCE });
    expect(budget.plannedPerMinute).toBeCloseTo(24.33, 2);
    expect(budget.ceilingPerMinute).toBe(41);
    expect(budget.ceilingHeadroom).toBeGreaterThanOrEqual(IRIS_MIN_HEADROOM);
    expect(budget.spareForOtherCallersPerMinute).toBeGreaterThan(10);
  });

  it("lets at most the ceiling through in a minute of back-to-back callers", async () => {
    const clock = fakeClock();
    const limiter = new ApiLimiter(DB_API_LIMITS.timetables, clock);
    const times: number[] = [];
    while (clock.now() < 60_000) {
      await limiter.acquire();
      if (clock.now() < 60_000) times.push(clock.now());
    }
    expect(times.length).toBeLessThanOrEqual(bucketCeiling(DB_API_LIMITS.timetables));
    expect(times.length).toBeGreaterThanOrEqual(40);
  });

  it("waits out a pause before taking a token", async () => {
    const clock = fakeClock(1_000);
    const limiter = new ApiLimiter(DB_API_LIMITS.timetables, clock);
    limiter.pauseFor(30_000);
    await limiter.acquire();
    expect(clock.now()).toBeGreaterThanOrEqual(31_000);
  });

  it("spreads each endpoint's polls over its period and polls distinct stations", () => {
    expect(new Set(IRIS_STATIONS.map((station) => station.eva)).size).toBe(IRIS_STATIONS.length);
    const tasks = irisTasks(IRIS_STATIONS, IRIS_SCHEDULE_CADENCE);
    expect(tasks).toHaveLength(IRIS_STATIONS.length * 3);
    const rchgOffsets = tasks.filter((t) => t.endpoint === "rchg").map((t) => t.offsetMs);
    expect(new Set(rchgOffsets).size).toBe(IRIS_STATIONS.length);
    expect(Math.max(...rchgOffsets)).toBeLessThan(IRIS_SCHEDULE_CADENCE.rchgEveryMs);
  });
});
