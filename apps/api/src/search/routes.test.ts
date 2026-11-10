import { SearchResponse, SearchStation } from "@gerlines/schema/search";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { readTrustedProxies } from "./client-address.ts";
import { OPENAPI_PATH } from "./openapi.ts";
import { fixedWindowLimiter } from "./rate-limit.ts";
import { SearchService } from "./service.ts";
import { ICE_693, KOELN_HBF, SEARCH_NOW_MS, SZCZECIN_GLOWNY, testData } from "./test-data.ts";

const silent = { error: () => undefined };

async function readyService(now = () => SEARCH_NOW_MS) {
  const { places, ...timetable } = testData();
  const service = new SearchService({
    timetable: { load: async () => timetable },
    places: async () => places,
    now,
    logger: silent,
  });
  await service.ready();
  return service;
}

async function appWith(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    search: await readyService(),
    logger: silent,
    now: () => SEARCH_NOW_MS,
    ...options,
  });
}

describe("GET /api/v1/search", () => {
  it("answers ranked results in the shared contract, cached for a minute", async () => {
    const app = await appWith();
    const response = await app.request("/api/v1/search?q=ICE%20693");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = SearchResponse.parse(await response.json());
    expect(body.results[0]?.id).toBe(ICE_693.id);
    expect(body).toMatchObject({ query: "ICE 693", serviceDate: "2026-11-07" });
  });

  it("names places in the asked language and keeps to the asked kinds", async () => {
    const app = await appWith();
    const response = await app.request("/api/v1/search?q=bayern&lang=pl&kinds=place");
    const body = SearchResponse.parse(await response.json());
    expect(body.results).toEqual([expect.objectContaining({ kind: "place", name: "Bawaria" })]);
  });

  it.each([
    ["no query", ""],
    ["an empty query", "?q=%20%20"],
    ["a query of control characters only", "?q=%00%07"],
    ["a query over 80 characters", `?q=${"a".repeat(81)}`],
    ["a limit over 20", "?q=koeln&limit=21"],
    ["an unknown kind", "?q=koeln&kinds=bus"],
    ["an unknown language", "?q=koeln&lang=fr"],
  ])("refuses %s with 400 and the issues", async (_name, search) => {
    const app = await appWith();
    const response = await app.request(`/api/v1/search${search}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("answers a query of SQL and markup characters as plain text with no match", async () => {
    const app = await appWith();
    const response = await app.request(
      `/api/v1/search?q=${encodeURIComponent("'; DROP TABLE trip; --<script>")}`,
    );
    expect(response.status).toBe(200);
    expect(SearchResponse.parse(await response.json()).results).toEqual([]);
  });

  it("answers 503 not_configured without a search database", async () => {
    const app = await appWith({ search: undefined });
    const response = await app.request("/api/v1/search?q=koeln");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it("answers 503 with Retry-After while the index is not loaded", async () => {
    const service = new SearchService({
      timetable: { load: () => Promise.reject(new Error("database down")) },
      places: async () => [],
      now: () => SEARCH_NOW_MS,
      logger: silent,
    });
    await service.ready();
    const app = await appWith({ search: service });
    const response = await app.request("/api/v1/search?q=koeln");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({ error: "search_unavailable" });
  });

  it("limits each client and says when to come back", async () => {
    let now = SEARCH_NOW_MS;
    const app = await appWith({
      searchLimiter: fixedWindowLimiter({ limit: 2, windowMs: 60_000, now: () => now }),
    });
    expect((await app.request("/api/v1/search?q=a")).status).toBe(200);
    expect((await app.request("/api/v1/search?q=b")).status).toBe(200);
    const limited = await app.request("/api/v1/search?q=c");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    now += 60_000;
    expect((await app.request("/api/v1/search?q=d")).status).toBe(200);
  });

  it("keys the limit by the visitor behind a trusted proxy, not by the proxy", async () => {
    const options = {
      searchLimiter: fixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => SEARCH_NOW_MS }),
      trustedProxies: readTrustedProxies({
        API_TRUSTED_PROXIES: "127.0.0.1,::1",
        API_CLOUDFLARE_RANGES: "173.245.48.0/20",
      }),
      peerAddress: () => "127.0.0.1",
    };
    const app = await appWith(options);
    const from = (headers: Record<string, string>) =>
      app.request("/api/v1/search?q=koeln", { headers });
    const viaCloudflare = (client: string) => ({
      "cf-connecting-ip": client,
      "x-forwarded-for": "173.245.48.10",
    });
    expect((await from(viaCloudflare("203.0.113.1"))).status).toBe(200);
    expect((await from(viaCloudflare("203.0.113.2"))).status).toBe(200);
    expect((await from(viaCloudflare("203.0.113.1"))).status).toBe(429);
    expect((await from({ "x-forwarded-for": "6.6.6.6, 2001:db8:1:2::1" })).status).toBe(200);
    expect((await from({ "x-forwarded-for": "7.7.7.7, 2001:db8:1:2::99" })).status).toBe(429);
  });

  it("holds the limit when a trusted proxy passes rotating CF-Connecting-IP values without a Cloudflare hop", async () => {
    const app = await appWith({
      searchLimiter: fixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => SEARCH_NOW_MS }),
      trustedProxies: readTrustedProxies({
        API_TRUSTED_PROXIES: "127.0.0.1,::1",
        API_CLOUDFLARE_RANGES: "173.245.48.0/20",
      }),
      peerAddress: () => "127.0.0.1",
    });
    const statuses: number[] = [];
    for (const forged of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "2001:db8::4"]) {
      const response = await app.request("/api/v1/search?q=koeln", {
        headers: { "cf-connecting-ip": forged, "x-forwarded-for": "198.51.100.9" },
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 429, 429, 429]);
  });

  it("keeps serving other visitors after cheap invalid requests from many /64s of one /48 fill the table", async () => {
    let peer = "";
    const app = await appWith({
      searchLimiter: fixedWindowLimiter({
        limit: 2,
        windowMs: 60_000,
        now: () => SEARCH_NOW_MS,
        maxKeys: 50,
        overflowLimit: 5,
      }),
      peerAddress: () => peer,
    });
    const flood: number[] = [];
    for (let index = 0; index < 80; index += 1) {
      peer = `2001:db8:1:${index.toString(16)}::1`;
      flood.push((await app.request("/api/v1/search?q=")).status);
    }
    expect(flood.slice(0, 55).every((status) => status === 400)).toBe(true);
    expect(flood.slice(55).every((status) => status === 429)).toBe(true);
    peer = "203.0.113.20";
    expect((await app.request("/api/v1/search?q=koeln")).status).toBe(200);
    peer = "2001:db8:2:1::1";
    expect((await app.request("/api/v1/search?q=koeln")).status).toBe(200);
  });

  it("ignores forwarding headers from a peer that is not a trusted proxy", async () => {
    const app = await appWith({
      searchLimiter: fixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => SEARCH_NOW_MS }),
      trustedProxies: readTrustedProxies({}),
      peerAddress: () => "198.51.100.9",
    });
    const forged = (ip: string) =>
      app.request("/api/v1/search?q=koeln", { headers: { "cf-connecting-ip": ip } });
    expect((await forged("203.0.113.1")).status).toBe(200);
    expect((await forged("203.0.113.2")).status).toBe(429);
  });
});

describe("GET /api/v1/stations/{id}", () => {
  it("answers one station of the index for a link that names it", async () => {
    const app = await appWith();
    const response = await app.request(`/api/v1/stations/${KOELN_HBF.toUpperCase()}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(SearchStation.parse(await response.json())).toMatchObject({ name: "Köln Hbf" });
  });

  it("names the station's DELFI stop id, which journeys take, or null without one", async () => {
    const app = await appWith();
    const koeln = await (await app.request(`/api/v1/stations/${KOELN_HBF}`)).json();
    expect(SearchStation.parse(koeln).dhid).toBe("de:05315:11201");
    const search = await (await app.request("/api/v1/search?q=messe&kinds=station")).json();
    const messe = SearchResponse.parse(search).results[0];
    expect(messe).toMatchObject({ kind: "station", name: "Köln Messe/Deutz", dhid: null });
  });

  it("answers the feed stop id journeys take for a station abroad without a DHID", async () => {
    const app = await appWith();
    const linked = await (await app.request(`/api/v1/stations/${SZCZECIN_GLOWNY}`)).json();
    expect(SearchStation.parse(linked)).toMatchObject({
      dhid: null,
      stopId: "pl:unknown:EVANR-5100057",
    });
    const search = await (await app.request("/api/v1/search?q=szczecin&kinds=station")).json();
    expect(SearchResponse.parse(search).results[0]).toMatchObject({
      name: "Szczecin Glowny",
      stopId: "pl:unknown:EVANR-5100057",
    });
    const koeln = await (await app.request(`/api/v1/stations/${KOELN_HBF}`)).json();
    expect(SearchStation.parse(koeln).stopId).toBe("de:05315:11201");
  });

  it("answers 404 for an unknown station and 400 for an id that is not a UUID", async () => {
    const app = await appWith();
    expect((await app.request(`/api/v1/stations/${ICE_693.id}`)).status).toBe(404);
    expect((await app.request("/api/v1/stations/koeln")).status).toBe(400);
  });
});

describe("SearchService", () => {
  it("reloads in the background on a new Berlin day and answers from the old day meanwhile", async () => {
    let now = Date.parse("2026-11-07T22:00:00Z");
    const load = vi.fn(async (serviceDate: string) => ({ ...testData(), serviceDate }));
    const service = new SearchService({
      timetable: { load },
      places: async () => [],
      now: () => now,
      logger: silent,
    });
    await service.ready();
    expect(service.current()?.serviceDate).toBe("2026-11-07");
    now = Date.parse("2026-11-07T23:30:00Z");
    expect(service.current()?.serviceDate).toBe("2026-11-07");
    await vi.waitFor(() => expect(service.current()?.serviceDate).toBe("2026-11-08"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries a failed load after a minute, not on every request", async () => {
    let now = SEARCH_NOW_MS;
    const errors: string[] = [];
    const load = vi.fn().mockRejectedValue(new Error("database down"));
    const service = new SearchService({
      timetable: { load },
      places: async () => [],
      now: () => now,
      logger: { error: (line) => errors.push(line) },
    });
    await service.ready();
    service.current();
    service.current();
    expect(load).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(["search index for 2026-11-07 failed: Error: database down"]);
    now += 60_000;
    service.current();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("describes the search route with its parameters and answers", async () => {
    const app = await appWith();
    const document = (await (await app.request(OPENAPI_PATH)).json()) as {
      openapi: string;
      paths: Record<string, { get: { parameters: { name: string; required: boolean }[] } }>;
    };
    expect(document.openapi).toBe("3.1.0");
    const search = document.paths["/api/v1/search"]?.get;
    expect(search?.parameters.map((parameter) => [parameter.name, parameter.required])).toEqual([
      ["q", true],
      ["limit", false],
      ["kinds", false],
      ["lang", false],
    ]);
  });

  it("describes the station's DELFI stop id in the station answer", async () => {
    const app = await appWith();
    const document = (await (await app.request(OPENAPI_PATH)).json()) as {
      paths: Record<
        string,
        {
          get: {
            responses: Record<
              string,
              {
                content: {
                  "application/json": { schema: { properties: Record<string, unknown> } };
                };
              }
            >;
          };
        }
      >;
    };
    const station = document.paths["/api/v1/stations/{id}"]?.get.responses["200"];
    expect(station?.content["application/json"].schema.properties.dhid).toMatchObject({
      anyOf: expect.arrayContaining([expect.objectContaining({ type: "string" })]),
      description: expect.stringContaining("journeys"),
    });
    expect(station?.content["application/json"].schema.properties.stopId).toMatchObject({
      anyOf: expect.arrayContaining([expect.objectContaining({ type: "string" })]),
      description: expect.stringContaining("/api/v1/journeys"),
    });
  });
});
