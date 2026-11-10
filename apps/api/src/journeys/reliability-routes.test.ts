import { JOURNEY_RELIABILITY_PATH, JourneyReliabilityResponse } from "@gerlines/schema/journeys";
import type { StatsTrain } from "@gerlines/schema/stats";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import { type ReliabilitySource, readGate } from "./reliability.ts";
import { registerJourneyRoutes } from "./routes.ts";

const NOW = Date.parse("2026-11-08T09:00:00Z");

function train(number: string): StatsTrain {
  return {
    kind: "train",
    period: { from: "2026-10-10", to: "2026-11-08", days: 30 },
    freshness: { refreshedAt: "2026-11-08T08:50:00.000Z", maxLagMinutes: 40, note: "lag" },
    generatedAt: new Date(NOW).toISOString(),
    number,
    operatorId: null,
    groups: [
      {
        operator: { id: "db-fernverkehr-ag", name: "DB Fernverkehr AG" },
        category: "hsr",
        line: null,
        runs: 28,
        summary: {
          stops: 500,
          cancelled: 4,
          additional: 0,
          noData: 0,
          observed: 480,
          observedArrivals: 400,
          punctual6: 0.75,
          punctual16: 0.9,
          cancelledShare: 0.008,
          meanDelayS: 240,
          medianDelayS: 120,
          p90DelayS: 900,
          maxDelayS: 3600,
          platformChanged: 3,
          observedCarried: 0,
          observedPropagated: 0,
        },
        byDay: [],
        delayHistogram: [],
      },
    ],
  };
}

function appWith(source: ReliabilitySource | undefined, limit = 60, reads = readGate()) {
  const lines: string[] = [];
  const app = new Hono();
  registerJourneyRoutes(app, {
    router: undefined,
    reliability: source,
    logger: { error: (line) => void lines.push(line) },
    now: () => NOW,
    reliabilityLimiter: fixedWindowLimiter({ limit, windowMs: 60_000, now: () => NOW }),
    reliabilityReads: reads,
  });
  return { app, lines };
}

const okSource: ReliabilitySource = { train: async (number) => train(number) };

describe(`GET ${JOURNEY_RELIABILITY_PATH}`, () => {
  it("answers each asked train in the shared contract, cacheable for five minutes", async () => {
    const { app } = appWith(okSource);
    const response = await app.request(
      `${JOURNEY_RELIABILITY_PATH}?train=hsr~597~DB%20Fernverkehr%20AG&train=reg~4711`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const body = JourneyReliabilityResponse.parse(await response.json());
    expect(body.trains.map((entry) => entry.status)).toEqual(["known", "missing"]);
    expect(body.refreshedAt).toBe("2026-11-08T08:50:00.000Z");
  });

  it("refuses a malformed train with 400", async () => {
    const { app } = appWith(okSource);
    const response = await app.request(`${JOURNEY_RELIABILITY_PATH}?train=ice~597`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("answers 503 not_configured without statistics", async () => {
    const { app } = appWith(undefined);
    const response = await app.request(`${JOURNEY_RELIABILITY_PATH}?train=hsr~597`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it("answers 503 stats_unavailable with Retry-After when the statistics fail, and logs why", async () => {
    const { app, lines } = appWith({ train: async () => Promise.reject(new Error("timeout")) });
    const response = await app.request(`${JOURNEY_RELIABILITY_PATH}?train=hsr~597`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "stats_unavailable" });
    expect(lines.join()).toContain("timeout");
  });

  it("limits requests per client", async () => {
    const { app } = appWith(okSource, 1);
    expect((await app.request(`${JOURNEY_RELIABILITY_PATH}?train=hsr~597`)).status).toBe(200);
    const refused = await app.request(`${JOURNEY_RELIABILITY_PATH}?train=hsr~597`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
  });

  it("charges the client one request per train it has to read, cached trains free", async () => {
    const { app } = appWith(okSource, 4);
    const three = `${JOURNEY_RELIABILITY_PATH}?train=hsr~597&train=hsr~598&train=hsr~599`;
    expect((await app.request(three)).status).toBe(200);
    expect((await app.request(three)).status).toBe(200);
    const refused = await app.request(`${JOURNEY_RELIABILITY_PATH}?train=hsr~600&train=hsr~601`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
  });

  it("answers 503 stats_unavailable with Retry-After while the process-wide reads are taken", async () => {
    const reads = readGate(1);
    reads.tryEnter();
    const { app, lines } = appWith(okSource, 60, reads);
    const response = await app.request(`${JOURNEY_RELIABILITY_PATH}?train=hsr~597`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "stats_unavailable" });
    expect(lines).toEqual([]);
    reads.leave();
    expect((await app.request(`${JOURNEY_RELIABILITY_PATH}?train=hsr~597`)).status).toBe(200);
  });

  it("is mounted by the app and answers not_configured there without statistics", async () => {
    const app = createApp({
      logger: { error: () => undefined },
    });
    const response = await app.request(`${JOURNEY_RELIABILITY_PATH}?train=hsr~597`);
    expect(response.status).toBe(503);
  });
});
