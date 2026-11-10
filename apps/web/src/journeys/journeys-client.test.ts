import type { TransitLeg } from "@gerlines/schema/journeys";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures.ts";
import {
  fetchJourneys,
  fetchReliability,
  journeysUrl,
  reliabilityKeyOf,
  reliabilityUrl,
} from "./journeys-client.ts";

const SEARCH = {
  from: "de:04011:13927",
  to: "de:02000:10950",
  time: "2026-11-10T06:00:00.000Z",
  arriveBy: false,
  categories: null,
  operator: null,
} as const;

function answering(status: number, body: unknown) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { urls, fetch };
}

describe("journeysUrl", () => {
  it("asks for five journeys with their route lines", () => {
    expect(journeysUrl(SEARCH)).toBe(
      "/api/v1/journeys?from=de%3A04011%3A13927&to=de%3A02000%3A10950&time=2026-11-10T06%3A00%3A00.000Z&results=5&geometry=true",
    );
  });

  it("passes arrive by, categories and the operator, and a cursor instead of the time", () => {
    const url = new URL(
      journeysUrl({
        ...SEARCH,
        arriveBy: true,
        categories: ["rfast", "reg"],
        operator: "metronom",
        cursor: "LATER|1794298680",
      }),
      "http://x",
    );
    expect(url.searchParams.get("time")).toBeNull();
    expect(url.searchParams.get("cursor")).toBe("LATER|1794298680");
    expect(url.searchParams.get("arriveBy")).toBe("true");
    expect(url.searchParams.get("categories")).toBe("rfast,reg");
    expect(url.searchParams.get("operators")).toBe("metronom");
  });
});

describe("fetchJourneys", () => {
  it("answers the parsed journeys", async () => {
    const { fetch } = answering(200, FIXTURES.bremenHamburg);
    const answer = await fetchJourneys(SEARCH, { fetch });
    expect(answer.kind === "ok" && answer.response.journeys).toHaveLength(5);
  });

  it.each([
    [503, { error: "router_busy" }, "busy"],
    [503, { error: "router_unavailable" }, "unavailable"],
    [404, { error: "stop_not_found" }, "stop"],
    [422, { error: "router_rejected" }, "rejected"],
    [429, { error: "rate_limited" }, "limited"],
    [400, { error: "invalid_request" }, "invalid"],
    [200, { journeys: "no" }, "unavailable"],
  ])("maps %i %j to %s", async (status, body, error) => {
    const { fetch } = answering(status, body);
    expect(await fetchJourneys(SEARCH, { fetch })).toEqual({ kind: "error", error });
  });

  it("answers unavailable when the network fails", async () => {
    const fetch = async () => Promise.reject(new TypeError("offline"));
    expect(await fetchJourneys(SEARCH, { fetch })).toEqual({ kind: "error", error: "unavailable" });
  });
});

describe("reliability", () => {
  const leg = FIXTURES.bremenHamburg.journeys[0]?.legs.find(
    (candidate): candidate is TransitLeg => candidate.kind === "transit",
  ) as TransitLeg;

  it("keys a leg by category, number and operator", () => {
    expect(reliabilityKeyOf(leg)).toBe("hsr~001028~DB Fernverkehr AG");
    expect(reliabilityKeyOf({ ...leg, operator: null })).toBe("hsr~001028");
    expect(reliabilityKeyOf({ ...leg, tripNumber: null })).toBeNull();
    expect(reliabilityKeyOf({ ...leg, tripNumber: "RE 4" })).toBeNull();
  });

  it("asks for at most 30 trains in one request", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `reg~${i + 1}`);
    expect(new URL(reliabilityUrl(keys), "http://x").searchParams.getAll("train")).toHaveLength(30);
  });

  it("answers the parsed reliability or an error", async () => {
    const ok = answering(200, FIXTURES.reliabilityBremenHamburg);
    const answer = await fetchReliability(["hsr~001028"], { fetch: ok.fetch });
    expect(answer.kind === "ok" && answer.response.trains[0]?.status).toBe("known");
    const failing = answering(503, { error: "not_configured" });
    expect(await fetchReliability(["hsr~1"], { fetch: failing.fetch })).toEqual({ kind: "error" });
  });
});
