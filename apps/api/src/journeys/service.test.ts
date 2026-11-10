import { JourneysResponse } from "@gerlines/schema/journeys";
import { describe, expect, it } from "vitest";
import {
  fixtureClient,
  loadPlanFixture,
  pagedClient,
  type RecordingClient,
} from "../router/fixtures.ts";
import {
  createRouterClient,
  limitPlansInFlight,
  type MotisLeg,
  type PlanRequest,
  type PlanResponse,
  RouterBusyError,
  type RouterClient,
  RouterRejectedError,
  RouterUnavailableError,
} from "../router/motis.ts";
import type { TripRunMatch } from "../search/records.ts";
import { encodePolyline } from "./geometry.ts";
import { type JourneyQueryInput, journeyQuerySchema } from "./query.ts";
import {
  FILL_BUDGET_MS,
  FILL_PAGE_MIN_TIMEOUT_MS,
  MAX_ROUTER_CALLS,
  searchJourneys,
} from "./service.ts";

const BERLIN = "de:11000:900003201";
const MUENCHEN = "de:09162:100";
const NOW = Date.parse("2026-10-27T05:59:00Z");

function query(input: Partial<JourneyQueryInput> = {}) {
  return journeyQuerySchema.parse({
    from: BERLIN,
    to: MUENCHEN,
    time: "2026-10-27T07:00:00+01:00",
    ...input,
  });
}

function search(input: Partial<JourneyQueryInput>, fixture = "motis-plan-berlin-muenchen.json") {
  const client = fixtureClient(loadPlanFixture(fixture));
  const result = searchJourneys(query(input), { client, datasetTag: "de-DELFI", now: () => NOW });
  return { client, result };
}

describe("searchJourneys stop the router does not hold", () => {
  const SYNTHESISED_FROM = "de:07233:30669";
  const SYNTHESISED_TO = "de:03159:33817";
  const routable = new Map([
    [SYNTHESISED_FROM, "de:07233:30669:2:2_G"],
    [SYNTHESISED_TO, "de:03159:33817::10"],
  ]);
  const routableStop = (stopId: string) => routable.get(stopId) ?? null;

  function holding(
    unknown: readonly string[],
    message = (place: string) => `Could not find timetable location "${place}"`,
  ): RecordingClient {
    const answer = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const requests: PlanRequest[] = [];
    return {
      requests,
      plan: async (request) => {
        requests.push(request);
        const missing = [request.fromPlace, request.toPlace].find((place) =>
          unknown.includes(place),
        );
        if (missing !== undefined) throw new RouterRejectedError(404, message(missing));
        return answer;
      },
      health: async () => ({ ok: true, latencyMs: 3 }),
    };
  }

  const context = (client: RouterClient) => ({
    client,
    datasetTag: "de-DELFI",
    now: () => NOW,
    routableStop,
  });

  it("asks again with a stops.txt row of the place when the router does not hold the origin", async () => {
    const client = holding([`de-DELFI_${SYNTHESISED_FROM}`]);
    const answer = await searchJourneys(query({ from: SYNTHESISED_FROM }), context(client));
    expect(client.requests.map((request) => request.fromPlace)).toEqual([
      `de-DELFI_${SYNTHESISED_FROM}`,
      "de-DELFI_de:07233:30669:2:2_G",
    ]);
    expect(answer.journeys.length).toBeGreaterThan(0);
    expect(answer.query.from).toBe(SYNTHESISED_FROM);
    expect(answer.routerCalls).toBe(2);
  });

  it("replaces the destination, and then the origin, each once, as the router names them", async () => {
    const client = holding([`de-DELFI_${SYNTHESISED_FROM}`, `de-DELFI_${SYNTHESISED_TO}`]);
    const answer = await searchJourneys(
      query({ from: SYNTHESISED_FROM, to: SYNTHESISED_TO }),
      context(client),
    );
    expect(client.requests.map((request) => [request.fromPlace, request.toPlace])).toEqual([
      [`de-DELFI_${SYNTHESISED_FROM}`, `de-DELFI_${SYNTHESISED_TO}`],
      ["de-DELFI_de:07233:30669:2:2_G", `de-DELFI_${SYNTHESISED_TO}`],
      ["de-DELFI_de:07233:30669:2:2_G", "de-DELFI_de:03159:33817::10"],
    ]);
    expect(answer.query).toMatchObject({ from: SYNTHESISED_FROM, to: SYNTHESISED_TO });
  });

  it("keeps later pages on the replaced stop", async () => {
    const first = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const requests: PlanRequest[] = [];
    const client: RouterClient = {
      plan: async (request) => {
        requests.push(request);
        if (request.fromPlace === `de-DELFI_${SYNTHESISED_FROM}`) {
          throw new RouterRejectedError(
            404,
            `Could not find timetable location "${request.fromPlace}"`,
          );
        }
        return {
          ...first,
          itineraries: [],
          nextPageCursor: request.pageCursor ? undefined : "LATER|1",
        };
      },
      health: async () => ({ ok: true, latencyMs: 3 }),
    };
    await searchJourneys(query({ from: SYNTHESISED_FROM }), context(client));
    expect(requests.length).toBeGreaterThan(2);
    expect(
      requests.slice(1).every((request) => request.fromPlace === "de-DELFI_de:07233:30669:2:2_G"),
    ).toBe(true);
  });

  it("does not ask again when the 404 names no place (an answer that is not MOTIS's)", async () => {
    const client = holding([`de-DELFI_${SYNTHESISED_FROM}`], () => "MOTIS answered 404");
    await expect(
      searchJourneys(query({ from: SYNTHESISED_FROM }), context(client)),
    ).rejects.toMatchObject({ status: 404 });
    expect(client.requests).toHaveLength(1);
  });

  function shortPages(unknown: readonly string[]): RecordingClient {
    const answer = loadPlanFixture("motis-plan-berlin-muenchen.json");
    const requests: PlanRequest[] = [];
    return {
      requests,
      plan: async (request) => {
        requests.push(request);
        const missing = [request.fromPlace, request.toPlace].find((place) =>
          unknown.includes(place),
        );
        if (missing !== undefined) {
          throw new RouterRejectedError(404, `Could not find timetable location "${missing}"`);
        }
        return { ...answer, nextPageCursor: `LATER|${requests.length}` };
      },
      health: async () => ({ ok: true, latencyMs: 3 }),
    };
  }

  it.each([
    ["the origin", [`de-DELFI_${SYNTHESISED_FROM}`]],
    ["both sides", [`de-DELFI_${SYNTHESISED_FROM}`, `de-DELFI_${SYNTHESISED_TO}`]],
  ])(
    "counts the asks again for %s within the router call cap when filters leave the page short",
    async (_side, unknown) => {
      const client = shortPages(unknown);
      const answer = await searchJourneys(
        query({ from: SYNTHESISED_FROM, to: SYNTHESISED_TO, operators: "Nobody", results: "5" }),
        context(client),
      );
      expect(answer.journeys).toHaveLength(0);
      expect(client.requests.length).toBeLessThanOrEqual(MAX_ROUTER_CALLS);
      expect(answer.routerCalls).toBe(client.requests.length);
      expect(answer.routerCalls).toBe(MAX_ROUTER_CALLS);
    },
  );

  it("fails as before when the place has no row to ask with, and asks once for a stop the router holds", async () => {
    const lost = holding([`de-DELFI_${BERLIN}`]);
    await expect(searchJourneys(query({}), context(lost))).rejects.toMatchObject({ status: 404 });
    expect(lost.requests).toHaveLength(1);
    const held = holding([]);
    await searchJourneys(query({}), context(held));
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]).toMatchObject({
      fromPlace: `de-DELFI_${BERLIN}`,
      toPlace: `de-DELFI_${MUENCHEN}`,
    });
  });

  it("fails as before when the replacement is not held either", async () => {
    const client = holding([`de-DELFI_${SYNTHESISED_FROM}`, "de-DELFI_de:07233:30669:2:2_G"]);
    await expect(
      searchJourneys(query({ from: SYNTHESISED_FROM }), context(client)),
    ).rejects.toBeInstanceOf(RouterRejectedError);
    expect(client.requests).toHaveLength(2);
  });
});

describe("searchJourneys stop names", () => {
  it("names each stop by its station's display name where the stop id is known, else as MOTIS does", async () => {
    const client = fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json"));
    const names = new Map([
      ["de:11000:900003200", "Berlin Hbf"],
      ["de:11000:900003201", "Berlin Hbf"],
      ["de:11000:900058101", "Berlin Südkreuz"],
    ]);
    const { journeys } = await searchJourneys(query({}), {
      client,
      datasetTag: "de-DELFI",
      now: () => NOW,
      stopName: (stopId) => names.get(stopId.split(":").slice(0, 3).join(":")) ?? null,
    });
    const stops = journeys.flatMap((journey) => journey.legs.flatMap((leg) => [leg.from, leg.to]));
    const named = (stopId: string) => stops.find((stop) => stop.stopId === stopId)?.name;
    expect(named("de:11000:900003200:2:53")).toBe("Berlin Hbf");
    expect(named("de:11000:900058101:2:52")).toBe("Berlin Südkreuz");
    expect(named("de:09162:100:22:22")).toBe("München Hbf");
    expect(stops.some((stop) => stop.name === "S+U Berlin Hauptbahnhof")).toBe(false);
  });

  it("names a headsign that is a stop of its own leg by that stop's display name, any other by the trip's last stop", async () => {
    const plan = structuredClone(loadPlanFixture("motis-plan-berlin-muenchen.json"));
    const subway = plan.itineraries
      .flatMap((itinerary) => itinerary.legs)
      .find((leg) => leg.mode === "SUBWAY");
    if (subway) subway.headsign = "S Südkreuz Bhf (Berlin)";
    const names = new Map([
      ["de:09162:100:22:22", "München Hauptbahnhof"],
      ["de:09162:100:16:20", "München Hauptbahnhof"],
      ["de:11000:900058101:2:52", "Berlin Südkreuz"],
      ["de:11000:900058101:3:54", "Südkreuz"],
    ]);
    const { journeys } = await searchJourneys(query({}), {
      client: fixtureClient(plan),
      datasetTag: "de-DELFI",
      now: () => NOW,
      stopName: (stopId) => names.get(stopId) ?? null,
    });
    const headsigns = new Map(
      journeys.flatMap((journey) =>
        journey.legs.flatMap((leg) =>
          leg.kind === "transit" ? [[leg.motisMode, leg.headsign]] : [],
        ),
      ),
    );
    expect(headsigns.get("HIGHSPEED_RAIL")).toBe("München Hauptbahnhof");
    expect(headsigns.get("REGIONAL_RAIL")).toBe("Flughafen BER");
    expect(headsigns.get("SUBWAY")).toBe("U Kaulsdorf-Nord (Berlin)");
  });

  describe("a headsign that is no stop of the answer", () => {
    async function headsignsOf(
      edit: (legs: MotisLeg[]) => void,
      names: Map<string, string> = new Map(),
    ) {
      const plan = structuredClone(loadPlanFixture("motis-plan-berlin-muenchen.json"));
      edit(plan.itineraries.flatMap((itinerary) => itinerary.legs));
      const { journeys } = await searchJourneys(query({}), {
        client: fixtureClient(plan),
        datasetTag: "de-DELFI",
        now: () => NOW,
        stopName: (stopId) => names.get(stopId) ?? null,
      });
      return new Map(
        journeys.flatMap((journey) =>
          journey.legs.flatMap((leg) =>
            leg.kind === "transit" ? [[leg.motisMode, leg.headsign] as const] : [],
          ),
        ),
      );
    }

    it("reads as the display name of the trip's last stop, as the train card does", async () => {
      const headsigns = await headsignsOf(
        (legs) => {
          for (const leg of legs) {
            if (leg.mode === "HIGHSPEED_RAIL") leg.headsign = "Hauptbahnhof";
          }
        },
        new Map([
          ["de:09162:100:22:22", "München Hauptbahnhof"],
          ["de:09162:100:16:20", "München Hauptbahnhof"],
        ]),
      );
      expect(headsigns.get("HIGHSPEED_RAIL")).toBe("München Hauptbahnhof");
    });

    it("reads as the trip's last stop as MOTIS names it where the stop has no display name", async () => {
      const headsigns = await headsignsOf((legs) => {
        for (const leg of legs) {
          if (leg.mode === "HIGHSPEED_RAIL") leg.headsign = "Hauptbahnhof";
        }
      });
      expect(headsigns.get("HIGHSPEED_RAIL")).toBe("München Hbf");
    });

    it("names the last stop of a trip whose headsign is missing", async () => {
      const headsigns = await headsignsOf((legs) => {
        for (const leg of legs) {
          if (leg.mode === "HIGHSPEED_RAIL") delete leg.headsign;
        }
      });
      expect(headsigns.get("HIGHSPEED_RAIL")).toBe("München Hbf");
    });

    it("does not take a stop of another leg of the answer for the headsign", async () => {
      const headsigns = await headsignsOf((legs) => {
        for (const leg of legs) {
          if (leg.mode === "HIGHSPEED_RAIL") leg.headsign = "S Südkreuz Bhf (Berlin)";
        }
      });
      expect(headsigns.get("HIGHSPEED_RAIL")).toBe("München Hbf");
    });

    it("keeps the headsign of a trip that names no last stop", async () => {
      const headsigns = await headsignsOf((legs) => {
        for (const leg of legs) {
          if (leg.mode === "HIGHSPEED_RAIL") {
            leg.headsign = "Hauptbahnhof";
            delete leg.tripTo;
          }
        }
      });
      expect(headsigns.get("HIGHSPEED_RAIL")).toBe("Hauptbahnhof");
    });
  });

  it("gives each stop's track without the word the card prints and keeps a change's planned track", async () => {
    const plan = structuredClone(loadPlanFixture("motis-plan-berlin-muenchen.json"));
    const legs = plan.itineraries.flatMap((itinerary) => itinerary.legs);
    const [first, second] = legs.filter((leg) => leg.mode === "HIGHSPEED_RAIL");
    if (!first || !second) throw new Error("the fixture has two long-distance legs");
    first.from = { ...first.from, track: "Gl. 5", scheduledTrack: "Gleis 4" };
    first.to = { ...first.to, track: "Pos. 3", scheduledTrack: "Pos. 3" };
    second.from = { ...second.from, track: "DB", scheduledTrack: "1 (U2)" };
    const { journeys } = await searchJourneys(query({}), {
      client: fixtureClient(plan),
      datasetTag: "de-DELFI",
      now: () => NOW,
    });
    const stops = journeys
      .flatMap((journey) => journey.legs)
      .flatMap((leg) => (leg.kind === "transit" ? [leg.from, leg.to] : []));
    expect(stops).toContainEqual(expect.objectContaining({ track: "5", scheduledTrack: "4" }));
    expect(stops).toContainEqual(expect.objectContaining({ track: "3", scheduledTrack: "3" }));
    expect(stops).toContainEqual(expect.objectContaining({ track: null, scheduledTrack: "1" }));
  });

  it("gives no track where the stop's district numbers its stop points (Köln Hbf 87)", async () => {
    const plan = structuredClone(loadPlanFixture("motis-plan-berlin-muenchen.json"));
    const legs = plan.itineraries.flatMap((itinerary) => itinerary.legs);
    const [first] = legs.filter((leg) => leg.mode === "HIGHSPEED_RAIL");
    if (!first) throw new Error("the fixture has a long-distance leg");
    first.from = {
      ...first.from,
      stopId: "de-DELFI_de:05315:11201:7:75",
      track: "87",
      scheduledTrack: "87",
    };
    const { journeys } = await searchJourneys(query({}), {
      client: fixtureClient(plan),
      datasetTag: "de-DELFI",
      now: () => NOW,
    });
    const from = journeys
      .flatMap((journey) => journey.legs)
      .flatMap((leg) => (leg.kind === "transit" ? [leg.from] : []))
      .find((stop) => stop.stopId === "de:05315:11201:7:75");
    expect(from).toMatchObject({ track: null, scheduledTrack: null });
  });
});

describe("searchJourneys train runs", () => {
  const RUN = {
    tripInstanceId: "05b180df-12b5-5062-93a3-0a1c50b4e115",
    departure: "2026-10-27T06:36:00.000Z",
    arrival: "2026-10-27T07:40:00.000Z",
  };
  const MATCH: TripRunMatch = { ...RUN, trainNumber: "57118" };
  const runs = async (match: TripRunMatch, legStart?: string) => {
    const plan = structuredClone(loadPlanFixture("motis-plan-muenchen-augsburg-regional.json"));
    for (const leg of plan.itineraries.flatMap((itinerary) => itinerary.legs)) {
      if (legStart && leg.tripId?.endsWith("3448805636")) leg.scheduledStartTime = legStart;
    }
    const { journeys } = await searchJourneys(query({}), {
      client: fixtureClient(plan),
      datasetTag: "de-DELFI",
      now: () => NOW,
      trainRun: (_, tripKey) => (tripKey === "3448805636" ? match : null),
    });
    return journeys
      .flatMap((journey) => journey.legs)
      .find((leg) => leg.kind === "transit" && leg.tripId?.endsWith("3448805636"));
  };

  it("gives a leg the run of its train from the trip id's service date and trip key", async () => {
    const asked: string[] = [];
    const { journeys } = await searchJourneys(query({}), {
      client: fixtureClient(loadPlanFixture("motis-plan-muenchen-augsburg-regional.json")),
      datasetTag: "de-DELFI",
      now: () => NOW,
      trainRun: (serviceDate, tripKey) => {
        asked.push(`${serviceDate} ${tripKey}`);
        return tripKey === "3448805636" ? MATCH : null;
      },
    });
    const legs = journeys.flatMap((journey) => journey.legs);
    const ridden = legs.find((leg) => leg.kind === "transit" && leg.tripId?.endsWith("3448805636"));
    expect(ridden).toMatchObject({ run: RUN });
    expect(asked).toContain("2026-10-27 3448805636");
    const others = legs.filter((leg) => leg.kind === "transit" && leg !== ridden);
    expect(others.every((leg) => leg.kind === "transit" && leg.run === null)).toBe(true);
  });

  it("gives no run when the trip key names another train in the index", async () => {
    expect(await runs({ ...MATCH, departure: "2026-10-27T06:41:00.000Z" })).toMatchObject({
      run: null,
    });
    expect(await runs(MATCH, "2026-10-27T07:45:00Z")).toMatchObject({ run: null });
    expect(await runs({ ...MATCH, trainNumber: "57120" })).toMatchObject({ run: null });
    expect(await runs({ ...MATCH, trainNumber: null })).toMatchObject({ run: RUN });
  });

  it("gives no run without a lookup or for a trip id of another shape", async () => {
    const plan = structuredClone(loadPlanFixture("motis-plan-muenchen-augsburg-regional.json"));
    const legs = plan.itineraries.flatMap((itinerary) => itinerary.legs);
    for (const leg of legs) if (leg.tripId) leg.tripId = "other-dataset_3448805636";
    const { journeys } = await searchJourneys(query({}), {
      client: fixtureClient(plan),
      datasetTag: "de-DELFI",
      now: () => NOW,
      trainRun: () => MATCH,
    });
    const transit = journeys.flatMap((journey) => journey.legs).filter((l) => l.kind === "transit");
    expect(transit.length).toBeGreaterThan(0);
    expect(transit.every((leg) => leg.kind === "transit" && leg.run === null)).toBe(true);
  });
});

describe("journeyQuerySchema", () => {
  it("accepts a plain query and fills the defaults", () => {
    const parsed = journeyQuerySchema.parse({ from: BERLIN, to: MUENCHEN });
    expect(parsed).toEqual({
      from: BERLIN,
      to: MUENCHEN,
      arriveBy: false,
      exclude: [],
      operators: [],
      avoidOperators: [],
      results: 5,
      geometry: false,
    });
  });

  it("reads comma lists and drops duplicates", () => {
    const parsed = query({ categories: "hsr,ld,hsr", exclude: "flx" });
    expect(parsed.categories).toEqual(["hsr", "ld"]);
    expect(parsed.exclude).toEqual(["flx"]);
  });

  it.each([
    [{ from: "" }, "from"],
    [{ from: "de:1 1" }, "from"],
    [{ to: BERLIN }, "to"],
    [{ time: "tomorrow" }, "time"],
    [{ time: "2026-10-27T07:00:00" }, "time"],
    [{ arriveBy: "yes" }, "arriveBy"],
    [{ categories: "ice" }, "categories"],
    [{ categories: "" }, "categories"],
    [{ exclude: "ice" }, "exclude"],
    [{ cursor: "x" }, "cursor"],
    [{ cursor: "LATER|" }, "cursor"],
    [{ cursor: "NEXT|1793087040" }, "cursor"],
    [{ cursor: "later|1793087040" }, "cursor"],
    [{ cursor: "LATER|1793087040&numItineraries=500" }, "cursor"],
    [{ cursor: "EARLIER|1234567890123" }, "cursor"],
  ])("rejects %j at %s", (input, path) => {
    const parsed = journeyQuerySchema.safeParse({ from: BERLIN, to: MUENCHEN, ...input });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path[0])).toContain(path);
  });
});

describe("searchJourneys", () => {
  it("asks MOTIS with the dataset tag, UTC time and no mode restriction by default", async () => {
    const { client, result } = search({});
    await result;
    expect(client.requests).toEqual([
      {
        fromPlace: `de-DELFI_${BERLIN}`,
        toPlace: `de-DELFI_${MUENCHEN}`,
        time: "2026-10-27T06:00:00.000Z",
        arriveBy: false,
        transitModes: undefined,
        numItineraries: 5,
        pageCursor: undefined,
        detailedLegs: false,
      },
    ]);
  });

  it.each(["ch:1:sloid:10", "000008400058", "pl:unknown:EVANR-5100057", "at:45:50002"])(
    "routes from a station abroad by the feed stop id the search answers, %s",
    async (stopId) => {
      const { client, result } = search({ from: stopId });
      await result;
      expect(client.requests[0]?.fromPlace).toBe(`de-DELFI_${stopId}`);
    },
  );

  it("accepts the cursors MOTIS hands out", () => {
    expect(query({ cursor: "EARLIER|1793080000" }).cursor).toBe("EARLIER|1793080000");
    expect(query({ cursor: "LATER|1793087040" }).cursor).toBe("LATER|1793087040");
  });

  it("uses the clock when no time is given and passes arrive-by and the cursor", async () => {
    const { client, result } = search({ time: undefined, arriveBy: "true", cursor: "LATER|1" });
    const { query: echoed } = await result;
    expect(client.requests[0]).toMatchObject({
      time: new Date(NOW).toISOString(),
      arriveBy: true,
      pageCursor: "LATER|1",
    });
    expect(echoed.time).toBeNull();
  });

  it("echoes the asked time without a cursor", async () => {
    const { result } = search({});
    expect((await result).query.time).toBe("2026-10-27T06:00:00.000Z");
  });

  it("maps legs to our categories and strips the dataset tag from stop ids", async () => {
    const { result } = search({});
    const { journeys, removedByFilter, laterCursor } = await result;
    expect(removedByFilter).toBe(0);
    expect(laterCursor).toBe("LATER|1793087040");
    expect(journeys.map((journey) => journey.categories)).toEqual([
      ["hsr"],
      ["urban", "sbahn", "hsr"],
      ["rfast", "hsr"],
      ["hsr"],
      ["hsr"],
    ]);
    const first = journeys[0];
    const ice = first?.legs.find((leg) => leg.kind === "transit");
    expect(ice).toMatchObject({
      kind: "transit",
      category: "hsr",
      motisMode: "HIGHSPEED_RAIL",
      line: "29",
      operator: "DB Fernverkehr AG",
      from: { stopId: expect.stringMatching(/^de:11000:/), name: expect.any(String) },
      to: { stopId: expect.stringMatching(/^de:09162:/) },
    });
    expect(first?.durationS).toBe(14760);
  });

  it("asks MOTIS for a wider set and removes journeys with a leg outside the chosen categories", async () => {
    const { client, result } = search({ categories: "hsr,ld,night,reg,sbahn" });
    const { journeys, removedByFilter } = await result;
    expect(client.requests[0]?.transitModes).toEqual([
      "HIGHSPEED_RAIL",
      "LONG_DISTANCE",
      "NIGHT_RAIL",
      "REGIONAL_RAIL",
      "SUBURBAN",
    ]);
    expect(client.requests[0]?.numItineraries).toBe(12);
    expect(removedByFilter).toBe(2);
    expect(journeys.map((journey) => journey.categories)).toEqual([["hsr"], ["hsr"], ["hsr"]]);
  });

  it.each([
    ["ld,night,rfast,reg,sbahn,urban,bus,other", "", 5],
    ["hsr,ld,night,rfast,reg,sbahn", "", 5],
    ["hsr,ld,rfast", "", 12],
    ["hsr,ld,reg", "", 12],
    [undefined, "flx", 12],
    ["hsr,ld,night,sbahn", "ic", 12],
    ["hsr,night,sbahn", "flx", 5],
    ["hsr,night,rfast,reg,sbahn", "ic,flx", 5],
  ])(
    "with categories %s and exclude %s asks for %i itineraries",
    async (categories, exclude, count) => {
      const { client, result } = search({ categories, exclude });
      await result;
      expect(client.requests[0]?.numItineraries).toBe(count);
    },
  );

  it("removes a night train that MOTIS labels long distance inside a mixed block", async () => {
    const { result } = search(
      { from: "nl:4:18038", to: "ch:1:sloid:10", categories: "hsr,ld,rfast,reg,sbahn" },
      "motis-plan-arnhem-basel-ld.json",
    );
    const { journeys, removedByFilter } = await result;
    expect(removedByFilter).toBe(12);
    expect(journeys).toEqual([]);
  });

  it("keeps the night train when night trains are chosen", async () => {
    const { result } = search(
      { from: "nl:4:18038", to: "ch:1:sloid:10", categories: "night" },
      "motis-plan-arnhem-basel-ld.json",
    );
    const { journeys } = await result;
    expect(journeys).toHaveLength(12);
    expect(journeys[0]?.legs.find((leg) => leg.kind === "transit")).toMatchObject({
      category: "night",
      motisMode: "LONG_DISTANCE",
      line: "43N",
    });
  });

  it("drops a night train ridden stay-seated after an IC when night trains are off", async () => {
    const { result } = search(
      { from: "000008400058", to: "ch:1:sloid:10", categories: "hsr,ld,rfast,reg,sbahn" },
      "motis-plan-amsterdam-basel-interlined.json",
    );
    const { journeys, removedByFilter } = await result;
    expect(removedByFilter).toBe(2);
    expect(journeys).toHaveLength(10);
    const lines = journeys.flatMap((journey) =>
      journey.legs.flatMap((leg) => (leg.kind === "transit" ? [leg.line] : [])),
    );
    expect(lines).not.toContain("43N");
    expect(journeys.every((journey) => !journey.categories.includes("night"))).toBe(true);
  });

  it("keeps the IC and 43N block as two legs, the 43N stay-seated, when night trains are on", async () => {
    const { result } = search(
      { from: "000008400058", to: "ch:1:sloid:10", categories: "hsr,ld,night,rfast,reg,sbahn" },
      "motis-plan-amsterdam-basel-interlined.json",
    );
    const { journeys, removedByFilter } = await result;
    expect(removedByFilter).toBe(0);
    const block = journeys[0]?.legs.filter((leg) => leg.kind === "transit");
    expect(block).toMatchObject([
      { line: "IC", category: "ld", motisMode: "LONG_DISTANCE", staySeated: false },
      { line: "43N", category: "night", motisMode: "LONG_DISTANCE", staySeated: true },
    ]);
    expect(journeys[0]?.categories).toEqual(["ld", "night"]);
  });

  describe("IC against FlixTrain on Hamburg Hbf to Köln Hbf without high-speed trains", () => {
    const NO_HSR = "ld,night,rfast,reg,sbahn,urban,bus,other";
    const hamburgKoeln = (exclude: string) =>
      search(
        { from: "de:02000:10950", to: "de:05315:11201", categories: NO_HSR, exclude },
        "motis-plan-hamburg-koeln-no-hsr.json",
      ).result;
    const ldLines = (journey: { legs: readonly { kind: string }[] }) =>
      journey.legs.flatMap((leg) =>
        "category" in leg && leg.category === "ld" && "line" in leg ? [leg.line] : [],
      );

    it("keeps every journey when no product is excluded", async () => {
      const { journeys, removedByFilter } = await hamburgKoeln("");
      expect(removedByFilter).toBe(0);
      expect(journeys).toHaveLength(12);
      expect(journeys.map(ldLines)).toContainEqual(["20", "FLX30"]);
    });

    it("removes the journey with FLX30 when FlixTrain is excluded", async () => {
      const { journeys, removedByFilter } = await hamburgKoeln("flx");
      expect(removedByFilter).toBe(1);
      expect(journeys.flatMap(ldLines)).not.toContain("FLX30");
    });

    it("removes every journey with a DB IC when IC is excluded", async () => {
      const { journeys, removedByFilter } = await hamburgKoeln("ic");
      expect(removedByFilter).toBe(10);
      expect(journeys.map(ldLines)).toEqual([[], []]);
    });
  });
});

describe("searchJourneys fills up across pages (alternatives, earlier and later)", () => {
  const HAMBURG = "de:02000:10950";
  const FIRST = loadPlanFixture("motis-plan-berlin-hamburg.json");
  const LATER = loadPlanFixture("motis-plan-berlin-hamburg-later.json");
  const LATER_2 = loadPlanFixture("motis-plan-berlin-hamburg-later-2.json");
  const EARLIER = loadPlanFixture("motis-plan-berlin-hamburg-earlier.json");
  const EARLIER_2 = loadPlanFixture("motis-plan-berlin-hamburg-earlier-2.json");
  const PAGES: Record<string, PlanResponse> = {
    first: FIRST,
    "LATER|1793106600": LATER,
    "LATER|1793128200": LATER_2,
    "EARLIER|1793080800": EARLIER,
    "EARLIER|1793051100": EARLIER_2,
  };
  const hamburg = (input: Partial<JourneyQueryInput>) =>
    journeyQuerySchema.parse({
      from: BERLIN,
      to: HAMBURG,
      time: "2026-10-27T07:00:00+01:00",
      ...input,
    });
  const context = (client: RouterClient, elapsed?: () => number) => ({
    client,
    datasetTag: "de-DELFI",
    now: () => NOW,
    ...(elapsed ? { elapsed } : {}),
  });
  const flxDepartures = (result: JourneysResponse) =>
    result.journeys.map((journey) => journey.departure.slice(0, 16));

  it("treats results as a minimum and answers every journey of the page that passes the filters", async () => {
    const client = pagedClient(PAGES);
    const result = await searchJourneys(hamburg({ results: "1" }), context(client));
    expect(client.requests).toHaveLength(1);
    expect(result.query.results).toBe(1);
    expect(result.journeys.length).toBeGreaterThan(1);
  });

  it("makes one router call when the first page holds enough journeys", async () => {
    const client = pagedClient(PAGES);
    const result = await searchJourneys(hamburg({}), context(client));
    expect(client.requests).toHaveLength(1);
    expect(result).toMatchObject({
      routerCalls: 1,
      partial: false,
      earlierCursor: "EARLIER|1793080800",
      laterCursor: "LATER|1793106600",
    });
    expect(result.journeys).toHaveLength(12);
  });

  it("follows the later pages, at most three calls, to find FlixTrain journeys", async () => {
    const client = pagedClient(PAGES);
    const result = await searchJourneys(hamburg({ operators: "Flix" }), context(client));
    expect(client.requests.map((request) => request.pageCursor)).toEqual([
      undefined,
      "LATER|1793106600",
      "LATER|1793128200",
    ]);
    expect(MAX_ROUTER_CALLS).toBe(3);
    expect(client.requests.every((request) => request.numItineraries === 12)).toBe(true);
    expect(new Set(client.requests.map((request) => request.time))).toEqual(
      new Set(["2026-10-27T06:00:00.000Z"]),
    );
    expect(flxDepartures(result)).toEqual([
      "2026-10-27T09:18",
      "2026-10-27T13:18",
      "2026-10-27T17:18",
    ]);
    expect(result).toMatchObject({
      routerCalls: 3,
      partial: false,
      earlierCursor: "EARLIER|1793080800",
      laterCursor: "LATER|1793161680",
    });
    expect(result.removedBy.operator).toBe(33);
    expect(JourneysResponse.parse(result)).toEqual(result);
  });

  it("stops as soon as enough journeys remain", async () => {
    const client = pagedClient(PAGES);
    const result = await searchJourneys(
      hamburg({ operators: "Flix", results: "2" }),
      context(client),
    );
    expect(result.routerCalls).toBe(2);
    expect(result.journeys).toHaveLength(3);
    expect(result.laterCursor).toBe("LATER|1793128200");
  });

  it("pages earlier from an earlier cursor and keeps the later cursor of the first page", async () => {
    const client = pagedClient({ first: FIRST, ...PAGES, "EARLIER|1793080800": EARLIER });
    const result = await searchJourneys(
      hamburg({ operators: "Flix", cursor: "EARLIER|1793080800" }),
      context(client),
    );
    expect(client.requests.map((request) => request.pageCursor)).toEqual([
      "EARLIER|1793080800",
      "EARLIER|1793051100",
      "EARLIER|1793023740",
    ]);
    expect(result.query.time).toBeNull();
    expect(result.laterCursor).toBe("LATER|1793080800");
    expect(result.partial).toBe(true);
  });

  it("pages earlier for an arrive-by search", async () => {
    const plan = loadPlanFixture("motis-plan-berlin-hamburg-arrive-by.json");
    const client = pagedClient({ first: plan });
    const result = await searchJourneys(
      hamburg({ arriveBy: "true", operators: "metronom" }),
      context(client),
    );
    expect(client.requests[1]?.pageCursor).toBe("EARLIER|1793085060");
    expect(result.laterCursor).toBe("LATER|1793095260");
    expect(result.journeys).toEqual([]);
  });

  it("drops journeys it has already seen on another page and stops when a page adds nothing", async () => {
    const client = pagedClient({ first: FIRST, "LATER|1793106600": FIRST });
    const result = await searchJourneys(hamburg({ operators: "Flix" }), context(client));
    expect(client.requests).toHaveLength(2);
    expect(result.journeys).toHaveLength(1);
    expect(result.removedByFilter).toBe(11);
    expect(new Set(result.journeys.map((journey) => journey.id)).size).toBe(1);
  });

  it.each([
    new RouterBusyError("six in flight"),
    new RouterUnavailableError("down"),
    new RouterRejectedError(400, "query time is outside of loaded timetable window"),
  ])("answers what it found, partial, when a later page fails with %s", async (error) => {
    const client: RouterClient = {
      plan: async (request) => {
        if (request.pageCursor) {
          throw error;
        }
        return FIRST;
      },
      health: async () => ({ ok: true, latencyMs: 1 }),
    };
    const result = await searchJourneys(hamburg({ operators: "Flix" }), context(client));
    expect(result).toMatchObject({
      partial: true,
      routerCalls: 1,
      laterCursor: "LATER|1793106600",
    });
    expect(result.journeys).toHaveLength(1);
  });

  it("passes an error of the first call on", async () => {
    const client: RouterClient = {
      plan: async () => Promise.reject(new RouterBusyError("six in flight")),
      health: async () => ({ ok: true, latencyMs: 1 }),
    };
    await expect(searchJourneys(hamburg({}), context(client))).rejects.toBeInstanceOf(
      RouterBusyError,
    );
  });

  it("passes on a programming error of a later page", async () => {
    const client: RouterClient = {
      plan: async (request) => {
        if (request.pageCursor) {
          throw new TypeError("bug");
        }
        return FIRST;
      },
      health: async () => ({ ok: true, latencyMs: 1 }),
    };
    await expect(
      searchJourneys(hamburg({ operators: "Flix" }), context(client)),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("starts no further page once the fill budget is spent", async () => {
    const client = pagedClient(PAGES);
    const clock = [0, FILL_BUDGET_MS + 1];
    const result = await searchJourneys(
      hamburg({ operators: "Flix" }),
      context(client, () => clock.shift() ?? FILL_BUDGET_MS + 1),
    );
    expect(result).toMatchObject({ routerCalls: 1, partial: true });
  });

  it("gives each fill-up page the rest of the budget as its timeout, at least the floor", async () => {
    const client = pagedClient(PAGES);
    const clock = [0, 1_500, FILL_BUDGET_MS - 300];
    const result = await searchJourneys(
      hamburg({ operators: "Flix" }),
      context(client, () => clock.shift() ?? FILL_BUDGET_MS),
    );
    expect(client.requests.map((request) => request.timeoutMs)).toEqual([
      undefined,
      FILL_BUDGET_MS - 1_500,
      FILL_PAGE_MIN_TIMEOUT_MS,
    ]);
    expect(FILL_PAGE_MIN_TIMEOUT_MS).toBe(1_000);
    expect(result).toMatchObject({ routerCalls: 3, partial: false });
  });

  it("answers what it found, partial, when a fill-up page runs out of time", async () => {
    const client: RouterClient = {
      plan: async (request) => {
        if (request.timeoutMs !== undefined) {
          throw new RouterUnavailableError("MOTIS did not answer: TimeoutError");
        }
        return FIRST;
      },
      health: async () => ({ ok: true, latencyMs: 1 }),
    };
    const clock = [0, 3_900];
    const result = await searchJourneys(
      hamburg({ operators: "Flix" }),
      context(client, () => clock.shift() ?? FILL_BUDGET_MS),
    );
    expect(result).toMatchObject({ partial: true, routerCalls: 1 });
    expect(result.journeys).toHaveLength(1);
  });

  it("frees the router slot of a fill-up page that hangs once the rest of the budget is spent", async () => {
    const hangingLaterPages = (async (input: URL | Request | string, init?: RequestInit) => {
      if (new URL(String(input)).searchParams.has("pageCursor")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return new Response(JSON.stringify(FIRST), { status: 200 });
    }) as typeof fetch;
    const client = limitPlansInFlight(
      createRouterClient({
        baseUrl: "http://127.0.0.1:8092",
        userAgent: "gerlines/0.0.0",
        fetch: hangingLaterPages,
      }),
      1,
    );
    const clock = [0, FILL_BUDGET_MS - 100];
    const started = performance.now();
    const result = await searchJourneys(
      hamburg({ operators: "Flix" }),
      context(client, () => clock.shift() ?? FILL_BUDGET_MS),
    );
    const tookMs = performance.now() - started;
    expect(result).toMatchObject({ partial: true, routerCalls: 1 });
    expect(result.journeys).toHaveLength(1);
    expect(tookMs).toBeGreaterThanOrEqual(FILL_PAGE_MIN_TIMEOUT_MS - 50);
    expect(tookMs).toBeLessThan(FILL_PAGE_MIN_TIMEOUT_MS + 1_500);
    await expect(searchJourneys(hamburg({}), context(client))).resolves.toMatchObject({
      routerCalls: 1,
    });
  });

  it("passes maxChanges to MOTIS as maxTransfers and echoes it", async () => {
    const client = pagedClient(PAGES);
    const result = await searchJourneys(hamburg({ maxChanges: "0" }), context(client));
    expect(client.requests[0]?.maxTransfers).toBe(0);
    expect(result.query.maxChanges).toBe(0);
  });

  it("asks MOTIS for as many itineraries as journeys wanted", async () => {
    const client = pagedClient(PAGES);
    await searchJourneys(hamburg({ results: "10" }), context(client));
    expect(client.requests[0]?.numItineraries).toBe(10);
  });

  it("gives every journey a stable id from its trips and times", async () => {
    const first = await searchJourneys(hamburg({}), context(pagedClient(PAGES)));
    const again = await searchJourneys(hamburg({ sort: "fastest" }), context(pagedClient(PAGES)));
    expect(new Set(first.journeys.map((journey) => journey.id)).size).toBe(12);
    expect(new Set(again.journeys.map((journey) => journey.id))).toEqual(
      new Set(first.journeys.map((journey) => journey.id)),
    );
  });
});

describe("searchJourneys leg geometry", () => {
  const straight = Array.from({ length: 120 }, (_, i) => [52.5 + i * 0.001, 13.37] as const);

  function planWithGeometry(): PlanResponse {
    const plan = loadPlanFixture("motis-plan-berlin-muenchen.json");
    return {
      ...plan,
      itineraries: plan.itineraries.map((itinerary) => ({
        ...itinerary,
        legs: itinerary.legs.map((leg) => ({
          ...leg,
          legGeometry: { points: encodePolyline(straight, 6), precision: 6, length: 120 },
        })),
      })),
    };
  }

  it("asks MOTIS for detailed legs and answers simplified lines", async () => {
    const client = fixtureClient(planWithGeometry());
    const answer = await searchJourneys(query({ geometry: "true" }), {
      client,
      datasetTag: "de-DELFI",
      now: () => NOW,
    });
    expect(client.requests[0]?.detailedLegs).toBe(true);
    expect(JourneysResponse.parse(answer).query.geometry).toBe(true);
    const legs = answer.journeys.flatMap((journey) => journey.legs);
    const transit = legs.filter((leg) => leg.kind === "transit");
    expect(transit.length).toBeGreaterThan(0);
    for (const leg of transit) {
      expect(leg.geometry).toMatchObject({ precision: 5, points: 2 });
    }
  });

  it("answers null for a leg MOTIS drew no line for", async () => {
    const client = fixtureClient(loadPlanFixture("motis-plan-berlin-muenchen.json"));
    const answer = await searchJourneys(query({ geometry: "true" }), {
      client,
      datasetTag: "de-DELFI",
      now: () => NOW,
    });
    const transit = answer.journeys.flatMap((journey) =>
      journey.legs.filter((leg) => leg.kind === "transit"),
    );
    expect(transit.every((leg) => leg.geometry === null)).toBe(true);
  });

  it("leaves geometry out and asks for plain legs by default", async () => {
    const client = fixtureClient(planWithGeometry());
    const answer = await searchJourneys(query(), {
      client,
      datasetTag: "de-DELFI",
      now: () => NOW,
    });
    expect(client.requests[0]?.detailedLegs).toBe(false);
    expect(answer.query.geometry).toBe(false);
    const transit = answer.journeys.flatMap((journey) =>
      journey.legs.filter((leg) => leg.kind === "transit"),
    );
    expect(transit.every((leg) => !("geometry" in leg))).toBe(true);
  });

  it("keeps the journey id whether or not lines were asked for", async () => {
    const plain = await searchJourneys(query(), {
      client: fixtureClient(planWithGeometry()),
      datasetTag: "de-DELFI",
      now: () => NOW,
    });
    const detailed = await searchJourneys(query({ geometry: "true" }), {
      client: fixtureClient(planWithGeometry()),
      datasetTag: "de-DELFI",
      now: () => NOW,
    });
    expect(detailed.journeys.map((journey) => journey.id)).toEqual(
      plain.journeys.map((journey) => journey.id),
    );
  });
});
