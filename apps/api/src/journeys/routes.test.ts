import { JourneysResponse } from "@gerlines/schema/journeys";
import { describe, expect, it } from "vitest";
import { createApp, JOURNEYS_PATH, ROUTER_HEALTH_PATH } from "../app.ts";
import { fixtureClient, loadPlanFixture } from "../router/fixtures.ts";
import {
  type PlanResponse,
  type RouterClient,
  RouterRejectedError,
  RouterUnavailableError,
} from "../router/motis.ts";
import { OPENAPI_PATH } from "../search/openapi.ts";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import { SearchService } from "../search/service.ts";
import { BERLIN_HBF, testData } from "../search/test-data.ts";
import { journeyQuerySchema } from "./query.ts";

const QUERY = "from=de:11000:900003201&to=de:09162:100&time=2026-10-27T06:00:00Z";

function silentLogger() {
  const lines: string[] = [];
  return { lines, error: (line: string) => void lines.push(line) };
}

function appWith(
  client: RouterClient | undefined,
  logger = silentLogger(),
  maxInFlight?: number,
  journeyLimiter?: ReturnType<typeof fixedWindowLimiter>,
) {
  return createApp({
    router: client && { client, datasetTag: "de-DELFI", maxInFlight },
    logger,
    now: () => Date.parse("2026-10-27T05:00:00Z"),
    ...(journeyLimiter ? { journeyLimiter } : {}),
  });
}

function failingClient(error: Error): RouterClient {
  return {
    plan: async () => Promise.reject(error),
    health: async () => ({ ok: false, latencyMs: 1 }),
  };
}

describe(`GET ${JOURNEYS_PATH}`, () => {
  it("answers journeys from the router", async () => {
    const app = appWith(fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json")));

    const response = await app.request(`${JOURNEYS_PATH}?${QUERY}&categories=hsr,ld`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { journeys: unknown[]; removedByFilter: number };
    expect(body.journeys).toHaveLength(3);
    expect(body.removedByFilter).toBe(2);
  });

  it("names the stops by the display names of the search index", async () => {
    const { places, ...timetable } = testData();
    const search = new SearchService({
      timetable: {
        load: async () => ({
          ...timetable,
          stopIds: [{ stopId: "de:11000:900003201::10", stationId: BERLIN_HBF }],
        }),
      },
      places: async () => places,
      now: () => Date.parse("2026-11-07T12:00:00Z"),
      logger: silentLogger(),
    });
    await search.ready();
    const app = createApp({
      router: {
        client: fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json")),
        datasetTag: "de-DELFI",
      },
      search,
      logger: silentLogger(),
      now: () => Date.parse("2026-11-07T12:00:00Z"),
    });

    const response = await app.request(`${JOURNEYS_PATH}?${QUERY}`);

    const body = JourneysResponse.parse(await response.json());
    const stops = body.journeys.flatMap((journey) =>
      journey.legs.flatMap((leg) => [leg.from, leg.to]),
    );
    expect(stops.find((stop) => stop.stopId === "de:11000:900003201::10")?.name).toBe("Berlin Hbf");
    expect(stops.find((stop) => stop.stopId === "de:09162:100:22:22")?.name).toBe("München Hbf");
  });

  it("asks again with a stops.txt row of the search index when the router lacks a station", async () => {
    const { places, ...timetable } = testData();
    const search = new SearchService({
      timetable: {
        load: async () => ({
          ...timetable,
          stopIds: [
            { stopId: "de:11000:900003201", stationId: BERLIN_HBF, stopPoint: false, seenMs: 1 },
            { stopId: "de:11000:900003201::10", stationId: BERLIN_HBF, stopPoint: true, seenMs: 1 },
          ],
        }),
      },
      places: async () => places,
      now: () => Date.parse("2026-11-07T12:00:00Z"),
      logger: silentLogger(),
    });
    await search.ready();
    const answer = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const asked: string[] = [];
    const client: RouterClient = {
      plan: async (request) => {
        asked.push(request.fromPlace);
        if (request.fromPlace === "de-DELFI_de:11000:900003201") {
          throw new RouterRejectedError(
            404,
            `Could not find timetable location "${request.fromPlace}"`,
          );
        }
        return answer;
      },
      health: async () => ({ ok: true, latencyMs: 1 }),
    };
    const app = createApp({
      router: { client, datasetTag: "de-DELFI" },
      search,
      logger: silentLogger(),
      now: () => Date.parse("2026-11-07T12:00:00Z"),
    });

    const response = await app.request(`${JOURNEYS_PATH}?${QUERY}`);

    expect(response.status).toBe(200);
    expect(asked).toEqual(["de-DELFI_de:11000:900003201", "de-DELFI_de:11000:900003201::10"]);
    expect(JourneysResponse.parse(await response.json()).query.from).toBe("de:11000:900003201");
  });

  it("answers in the shared contract", async () => {
    const app = appWith(fixtureClient(loadPlanFixture("motis-plan-berlin-hamburg.json")));
    const response = await app.request(
      `${JOURNEYS_PATH}?from=de:11000:900003201&to=de:02000:10950&time=2026-10-27T06:00:00Z&exclude=flx&sort=fastest`,
    );
    expect(response.status).toBe(200);
    const body = JourneysResponse.parse(await response.json());
    expect(body.query).toMatchObject({ sort: "fastest", exclude: ["flx"], results: 5 });
    expect(body.journeys[0]?.tags).toContain("fastest");
  });

  it("answers 429 with Retry-After once a client has used its budget", async () => {
    let now = 0;
    const limiter = fixedWindowLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    const app = appWith(
      fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json")),
      silentLogger(),
      undefined,
      limiter,
    );
    expect((await app.request(`${JOURNEYS_PATH}?${QUERY}`)).status).toBe(200);
    expect((await app.request(`${JOURNEYS_PATH}?from=x`)).status).toBe(400);
    const refused = await app.request(`${JOURNEYS_PATH}?${QUERY}`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    now = 60_000;
    expect((await app.request(`${JOURNEYS_PATH}?${QUERY}`)).status).toBe(200);
  });

  describe("budgets per client behind a trusted proxy", () => {
    const PROXY = "10.0.0.1";
    const EDGE = "173.245.48.10";
    const proxiedApp = (peer: string) =>
      createApp({
        router: {
          client: fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json")),
          datasetTag: "de-DELFI",
        },
        logger: silentLogger(),
        now: () => Date.parse("2026-10-27T05:00:00Z"),
        journeyLimiter: fixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => 0 }),
        trustedProxies: {
          has: (address) => address === PROXY,
          isCloudflareEdge: (address) => address === EDGE,
        },
        peerAddress: () => peer,
      });
    const from = async (app: ReturnType<typeof proxiedApp>, client: string, hop = EDGE) => {
      const response = await app.request(`${JOURNEYS_PATH}?${QUERY}`, {
        headers: { "cf-connecting-ip": client, "x-forwarded-for": hop },
      });
      return response.status;
    };

    it("gives each cf-connecting-ip its own budget", async () => {
      const app = proxiedApp(PROXY);
      expect(await from(app, "203.0.113.7")).toBe(200);
      expect(await from(app, "198.51.100.9")).toBe(200);
      expect(await from(app, "203.0.113.7")).toBe(429);
      expect(await from(app, "198.51.100.9")).toBe(429);
    });

    it("ignores rotating cf-connecting-ip values that did not come through a Cloudflare edge", async () => {
      const app = proxiedApp(PROXY);
      expect(await from(app, "203.0.113.7", "192.0.2.50")).toBe(200);
      expect(await from(app, "198.51.100.9", "192.0.2.50")).toBe(429);
      expect(await from(app, "198.51.100.10", "192.0.2.50")).toBe(429);
    });

    it("ignores cf-connecting-ip from a peer that is not a trusted proxy", async () => {
      const app = proxiedApp("192.0.2.50");
      expect(await from(app, "203.0.113.7")).toBe(200);
      expect(await from(app, "198.51.100.9")).toBe(429);
    });

    const forwarded = async (app: ReturnType<typeof proxiedApp>, forwardedFor: string) =>
      (
        await app.request(`${JOURNEYS_PATH}?${QUERY}`, {
          headers: { "x-forwarded-for": forwardedFor },
        })
      ).status;

    it("gives each X-Forwarded-For client its own budget behind the proxy alone, whatever is forged left of it", async () => {
      const app = proxiedApp(PROXY);
      expect(await forwarded(app, "192.0.2.1, 203.0.113.7")).toBe(200);
      expect(await forwarded(app, "192.0.2.1, 198.51.100.9")).toBe(200);
      expect(await forwarded(app, "192.0.2.2, 203.0.113.7")).toBe(429);
      expect(await forwarded(app, "203.0.113.7")).toBe(429);
    });

    it("counts IPv6 clients of one /64 against one budget", async () => {
      const app = proxiedApp(PROXY);
      expect(await forwarded(app, "2001:db8:1:2::1")).toBe(200);
      expect(await forwarded(app, "2001:db8:1:2::99")).toBe(429);
      expect(await forwarded(app, "2001:db8:1:3::1")).toBe(200);
    });
  });

  it("is described in the OpenAPI document with every query parameter", async () => {
    const response = await appWith(undefined).request(OPENAPI_PATH);
    const document = (await response.json()) as {
      paths: Record<string, { get: { parameters?: { name: string; required: boolean }[] } }>;
    };
    const parameters = document.paths[JOURNEYS_PATH]?.get.parameters ?? [];
    expect(parameters.map((parameter) => parameter.name).sort()).toEqual(
      [
        "arriveBy",
        "avoidOperators",
        "categories",
        "cursor",
        "exclude",
        "from",
        "geometry",
        "maxChanges",
        "operators",
        "results",
        "sort",
        "time",
        "to",
      ].sort(),
    );
    expect(
      parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    ).toEqual(["from", "to"]);
    expect(document.paths[ROUTER_HEALTH_PATH]).toBeDefined();
    expect(document.paths["/api/v1/journeys/reliability"]?.get.parameters?.[0]).toMatchObject({
      name: "train",
      required: true,
    });
  });

  it.each([
    ["a plus sent unencoded", "2026-10-27T07:00:00+01:00"],
    ["a plus encoded as %2B", "2026-10-27T07:00:00%2B01:00"],
    ["Z", "2026-10-27T06:00:00Z"],
  ])("reads a time with %s", async (_label, time) => {
    const client = fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json"));
    const response = await appWith(client).request(
      `${JOURNEYS_PATH}?from=de:11000:900003201&to=de:09162:100&time=${time}`,
    );
    expect(response.status).toBe(200);
    expect(client.requests[0]?.time).toBe("2026-10-27T06:00:00.000Z");
  });

  it("gives the defaults of the optional parameters in the OpenAPI document", async () => {
    const response = await appWith(undefined).request(OPENAPI_PATH);
    const document = (await response.json()) as {
      paths: Record<
        string,
        { get: { parameters?: { name: string; schema: { default?: unknown } }[] } }
      >;
    };
    const defaults = Object.fromEntries(
      (document.paths[JOURNEYS_PATH]?.get.parameters ?? []).map((parameter) => [
        parameter.name,
        parameter.schema.default,
      ]),
    );
    expect(defaults).toMatchObject({
      arriveBy: "false",
      exclude: "",
      operators: "",
      avoidOperators: "",
      results: "5",
    });
    expect(defaults.from).toBeUndefined();
    expect(defaults.time).toBeUndefined();
  });

  it("gives every default of the query schema in the OpenAPI document as text that parses to it", async () => {
    const response = await appWith(undefined).request(OPENAPI_PATH);
    const document = (await response.json()) as {
      paths: Record<
        string,
        { get: { parameters?: { name: string; schema: { default?: string } }[] } }
      >;
    };
    const documented = Object.fromEntries(
      (document.paths[JOURNEYS_PATH]?.get.parameters ?? []).flatMap((parameter) =>
        parameter.schema.default === undefined ? [] : [[parameter.name, parameter.schema.default]],
      ),
    );
    const required = { from: "de:11000:900003201", to: "de:09162:100" };
    const { from: _from, to: _to, ...schemaDefaults } = journeyQuerySchema.parse(required);
    expect(Object.keys(documented).sort()).toEqual(Object.keys(schemaDefaults).sort());
    for (const [name, value] of Object.entries(schemaDefaults)) {
      const parsed = journeyQuerySchema.parse({ ...required, [name]: documented[name] });
      expect(parsed[name as keyof typeof parsed], name).toEqual(value);
    }
  });

  it("answers 400 with every issue for an invalid query", async () => {
    const app = appWith(fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json")));

    const response = await app.request(`${JOURNEYS_PATH}?from=x&to=x&categories=ice&arriveBy=1`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((issue) => issue.path).sort()).toEqual(["arriveBy", "categories.0"]);
  });

  it("answers 400 before anything else when from and to are missing", async () => {
    const response = await appWith(undefined).request(JOURNEYS_PATH);
    expect(response.status).toBe(400);
  });

  it("answers 503 not_configured without a router", async () => {
    const response = await appWith(undefined).request(`${JOURNEYS_PATH}?${QUERY}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it.each([
    [
      new RouterRejectedError(404, 'Could not find timetable location "de-DELFI_de:1:x"'),
      404,
      "stop_not_found",
    ],
    [
      new RouterRejectedError(400, "query time is outside of loaded timetable window"),
      422,
      "router_rejected",
    ],
    [new RouterUnavailableError("down"), 503, "router_unavailable"],
    [new Error("bug"), 500, "internal_error"],
  ])("maps %s to %i and keeps the router's text in the server log", async (error, status, code) => {
    const logger = silentLogger();
    const response = await appWith(failingClient(error), logger).request(
      `${JOURNEYS_PATH}?${QUERY}`,
    );
    expect(response.status).toBe(status);
    const text = await response.text();
    expect((JSON.parse(text) as { error: string }).error).toBe(code);
    expect(text).not.toContain(error.message);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain(error.message);
  });

  it("answers a fixed message per rejection code", async () => {
    const answers = await Promise.all(
      [
        new RouterRejectedError(404, "Could not find timetable location a"),
        new RouterRejectedError(404, "Could not find timetable location b"),
        new RouterRejectedError(400, "x"),
        new RouterRejectedError(400, "y"),
      ].map(async (error) => {
        const response = await appWith(failingClient(error)).request(`${JOURNEYS_PATH}?${QUERY}`);
        return (await response.json()) as { error: string; message: string };
      }),
    );
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[2]).toEqual(answers[3]);
    expect(answers[0]?.message).toEqual(expect.any(String));
    expect(answers[2]?.message).toEqual(expect.any(String));
  });
});

describe(`GET ${JOURNEYS_PATH} and the client`, () => {
  it("hands the request's signal to the router so a closed request frees its MOTIS call", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const client: RouterClient = {
      plan: async (request) => {
        signals.push(request.signal);
        return loadPlanFixture("motis-plan-berlin-muenchen.json");
      },
      health: async () => ({ ok: true, latencyMs: 1 }),
    };
    const caller = new AbortController();
    const response = await appWith(client).request(`${JOURNEYS_PATH}?${QUERY}`, {
      signal: caller.signal,
    });
    expect(response.status).toBe(200);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});

describe(`GET ${JOURNEYS_PATH} under load`, () => {
  function heldClient() {
    const plan = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const waiting: ((answer: PlanResponse | Error) => void)[] = [];
    const client: RouterClient = {
      plan: () =>
        new Promise<PlanResponse>((resolve, reject) => {
          waiting.push((answer) => (answer instanceof Error ? reject(answer) : resolve(answer)));
        }),
      health: async () => ({ ok: true, latencyMs: 1 }),
    };
    return { client, waiting, plan };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("keeps at most six MOTIS calls in flight by default and answers 503 with Retry-After above", async () => {
    const { client, waiting, plan } = heldClient();
    const logger = silentLogger();
    const app = appWith(client, logger);
    const held = Array.from({ length: 6 }, () => app.request(`${JOURNEYS_PATH}?${QUERY}`));
    await settle();
    expect(waiting).toHaveLength(6);

    const refused = await app.request(`${JOURNEYS_PATH}?${QUERY}`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(((await refused.json()) as { error: string }).error).toBe("router_busy");
    expect(waiting).toHaveLength(6);

    for (const answer of waiting.splice(0)) {
      answer(plan);
    }
    expect((await Promise.all(held)).map((response) => response.status)).toEqual(
      Array(6).fill(200),
    );

    const after = app.request(`${JOURNEYS_PATH}?${QUERY}`);
    await settle();
    waiting.splice(0).forEach((answer) => void answer(plan));
    expect((await after).status).toBe(200);
  });

  it("frees the slot when MOTIS fails", async () => {
    const { client, waiting, plan } = heldClient();
    const app = appWith(client, silentLogger(), 1);
    const failing = app.request(`${JOURNEYS_PATH}?${QUERY}`);
    await settle();
    expect((await app.request(`${JOURNEYS_PATH}?${QUERY}`)).status).toBe(503);
    waiting.splice(0).forEach((answer) => void answer(new RouterUnavailableError("down")));
    expect((await failing).status).toBe(503);

    const next = app.request(`${JOURNEYS_PATH}?${QUERY}`);
    await settle();
    waiting.splice(0).forEach((answer) => void answer(plan));
    expect((await next).status).toBe(200);
  });
});

describe(`GET ${ROUTER_HEALTH_PATH}`, () => {
  it("reports a healthy router", async () => {
    const response = await appWith(
      fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json")),
    ).request(ROUTER_HEALTH_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", latencyMs: 3 });
  });

  it("asks the router once for requests within five seconds", async () => {
    let healthCalls = 0;
    const client: RouterClient = {
      plan: async () => Promise.reject(new Error("unused")),
      health: async () => {
        healthCalls += 1;
        return { ok: true, latencyMs: 2 };
      },
    };
    const app = appWith(client);
    const statuses = await Promise.all(
      Array.from({ length: 20 }, async () => (await app.request(ROUTER_HEALTH_PATH)).status),
    );
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect((await app.request(ROUTER_HEALTH_PATH)).status).toBe(200);
    expect(healthCalls).toBe(1);
  });

  it("reports a router whose health call throws as unavailable and logs it", async () => {
    const logger = silentLogger();
    const client: RouterClient = {
      plan: async () => Promise.reject(new Error("unused")),
      health: async () => Promise.reject(new TypeError("broken health")),
    };
    const response = await appWith(client, logger).request(ROUTER_HEALTH_PATH);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "unavailable" });
    expect(logger.lines).toEqual(["router health failed: TypeError: broken health"]);
  });

  it("reports an unhealthy or missing router as 503", async () => {
    const down = await appWith(failingClient(new Error("x"))).request(ROUTER_HEALTH_PATH);
    expect(down.status).toBe(503);
    expect(((await down.json()) as { status: string }).status).toBe("unavailable");
    const missing = await appWith(undefined).request(ROUTER_HEALTH_PATH);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ status: "not_configured" });
  });
});
