import { describe, expect, it } from "vitest";
import { fixtureClient, loadPlanFixture } from "../router/fixtures.ts";
import { foldName, operatorMatcher } from "./filters.ts";
import { type JourneyQueryInput, journeyQuerySchema } from "./query.ts";
import { searchJourneys } from "./service.ts";

const NOW = Date.parse("2026-10-27T05:00:00Z");

async function run(fixture: string, input: Partial<JourneyQueryInput>) {
  const client = fixtureClient(loadPlanFixture(fixture));
  const query = journeyQuerySchema.parse({
    from: "de:11000:900003201",
    to: "de:02000:10950",
    time: "2026-10-27T06:00:00Z",
    results: "1",
    ...input,
  });
  const result = await searchJourneys(query, { client, datasetTag: "de-DELFI", now: () => NOW });
  return { client, result };
}

function lines(journey: { legs: readonly { kind: string; line?: string | null }[] }): string[] {
  return journey.legs.flatMap((leg) => (leg.kind === "transit" ? [leg.line ?? "?"] : []));
}

function operators(journey: { legs: readonly { kind: string; operator?: string | null }[] }) {
  return journey.legs.flatMap((leg) => (leg.kind === "transit" ? [leg.operator] : []));
}

describe("operator names", () => {
  it("folds case, accents and sharp s", () => {
    expect(foldName("Österreichische Bundesbahnen")).toBe("osterreichische bundesbahnen");
    expect(foldName("Länderbahn GmbH DLB")).toBe("landerbahn gmbh dlb");
    expect(foldName("Großraum")).toBe("grossraum");
    expect(foldName("GROẞRAUM")).toBe("grossraum");
  });

  it.each([
    ["DB", "DB Fernverkehr AG", true],
    ["db", "DB Regio AG Bayern", true],
    ["DB Regio", "DB Regio AG S-Bahn München", true],
    ["DB Regio", "DB Fernverkehr AG", false],
    ["DB", "ODEG Ostdeutsche Eisenbahn GmbH", false],
    ["DB", "trilex-express - Die Länderbahn GmbH DLB", false],
    ["Flix", "FlixTrain-de", true],
    ["flix", "FlixBus-de", true],
    ["Train", "FlixTrain-de", false],
    ["express", "trilex-express - Die Länderbahn GmbH DLB", true],
    ["Osterreichische", "Österreichische Bundesbahnen", true],
    ["Österreichische", "Osterreichische Bundesbahnen", true],
    ["a.b", "axb", false],
    ["metronom", undefined, false],
  ])("%s matches %s: %s", (term, operator, expected) => {
    expect(operatorMatcher([term])(operator)).toBe(expected);
  });
});

describe("category filter on Berlin Hbf to Hamburg Hbf, all categories asked of MOTIS", () => {
  const FIXTURE = "motis-plan-berlin-hamburg.json";

  it("keeps all twelve journeys when every category is chosen", async () => {
    const { result } = await run(FIXTURE, {});
    expect(result.journeys).toHaveLength(12);
    expect(result.removedBy).toEqual({ category: 0, product: 0, operator: 0 });
  });

  it("removes every journey with an ICE leg when hsr is left out", async () => {
    const { client, result } = await run(FIXTURE, {
      categories: "ld,night,rfast,reg,sbahn,urban,bus,other",
    });
    expect(client.requests[0]?.transitModes).not.toContain("HIGHSPEED_RAIL");
    expect(result.removedBy.category).toBe(8);
    expect(result.journeys.map(lines)).toEqual([["27"], ["FLX10"], ["27"], ["27"]]);
    expect(result.journeys.every((journey) => !journey.categories.includes("hsr"))).toBe(true);
  });

  it("removes the journey with an S-Bahn feeder when sbahn is left out", async () => {
    const { result } = await run(FIXTURE, { categories: "hsr,ld" });
    expect(result.removedBy.category).toBe(1);
    expect(result.journeys.flatMap(lines)).not.toContain("S15");
  });
});

describe("product filter, IC against FlixTrain, on Berlin Hbf to Hamburg Hbf", () => {
  const FIXTURE = "motis-plan-berlin-hamburg.json";

  it("removes FLX10 when flx is excluded and asks MOTIS for twelve", async () => {
    const { client, result } = await run(FIXTURE, { exclude: "flx" });
    expect(client.requests[0]?.numItineraries).toBe(12);
    expect(result.removedBy).toEqual({ category: 0, product: 1, operator: 0 });
    expect(result.journeys.flatMap(lines)).not.toContain("FLX10");
  });

  it("removes the three DB IC 27 journeys when ic is excluded", async () => {
    const { result } = await run(FIXTURE, { exclude: "ic" });
    expect(result.removedBy.product).toBe(3);
    expect(result.journeys.flatMap(lines)).not.toContain("27");
    expect(result.journeys.flatMap(lines)).toContain("FLX10");
  });

  it("counts a journey once, by its category, when both filters remove it", async () => {
    const { result } = await run(FIXTURE, { categories: "hsr,sbahn", exclude: "ic,flx" });
    expect(result.removedBy).toEqual({ category: 4, product: 0, operator: 0 });
    expect(result.removedByFilter).toBe(4);
  });
});

describe("RE against RB on Bremen Hbf to Hamburg Hbf, regional trains asked of MOTIS", () => {
  const FIXTURE = "motis-plan-bremen-hamburg-regional.json";
  const BREMEN = { from: "de:04011:13927" };

  it("keeps both metronom lines with rfast and reg", async () => {
    const { client, result } = await run(FIXTURE, { ...BREMEN, categories: "rfast,reg,sbahn" });
    expect(client.requests[0]?.numItineraries).toBe(5);
    expect(new Set(result.journeys.flatMap(lines))).toEqual(new Set(["RE4", "RB41"]));
  });

  it("keeps RE4 and removes RB41 with rfast only, over a wider search", async () => {
    const { client, result } = await run(FIXTURE, { ...BREMEN, categories: "rfast" });
    expect(client.requests[0]).toMatchObject({
      transitModes: ["REGIONAL_RAIL"],
      numItineraries: 12,
    });
    expect(result.removedBy.category).toBe(6);
    expect(result.journeys.flatMap(lines)).toEqual(Array(6).fill("RE4"));
    expect(result.journeys.every((journey) => journey.categories.join() === "rfast")).toBe(true);
  });

  it("keeps RB41 and removes RE4 with reg only", async () => {
    const { result } = await run(FIXTURE, { ...BREMEN, categories: "reg" });
    expect(result.removedBy.category).toBe(6);
    expect(result.journeys.flatMap(lines)).toEqual(Array(6).fill("RB41"));
  });
});

describe("operator filter on München Hbf to Augsburg Hbf, regional and long-distance trains", () => {
  const FIXTURE = "motis-plan-muenchen-augsburg-regional.json";
  const MUENCHEN = { from: "de:09162:100", to: "de:09761:100" };

  it("keeps only Arverio journeys and asks MOTIS for twelve", async () => {
    const { client, result } = await run(FIXTURE, { ...MUENCHEN, operators: "Arverio" });
    expect(client.requests[0]?.numItineraries).toBe(12);
    expect(result.removedBy).toEqual({ category: 0, product: 0, operator: 2 });
    expect(result.journeys).toHaveLength(10);
    expect(new Set(result.journeys.flatMap(operators))).toEqual(new Set(["Arverio Bayern GmbH"]));
  });

  it("keeps a journey whose every leg runs with one of several operators", async () => {
    const { result } = await run(FIXTURE, { ...MUENCHEN, operators: "arverio,westbahn" });
    expect(result.journeys).toHaveLength(11);
    expect(result.journeys.map(lines)).toContainEqual(["RE72", "DRF"]);
    expect(result.journeys.flatMap(lines)).not.toContain("S7");
  });

  it("removes the two journeys with a WESTbahn leg when WESTbahn is avoided", async () => {
    const { result } = await run(FIXTURE, { ...MUENCHEN, avoidOperators: "WESTbahn" });
    expect(result.removedBy.operator).toBe(2);
    expect(result.journeys.flatMap(lines)).not.toContain("DRF");
  });

  it("removes the S-Bahn journey when DB is avoided and keeps the rest", async () => {
    const { result } = await run(FIXTURE, { ...MUENCHEN, avoidOperators: "DB" });
    expect(result.removedBy.operator).toBe(1);
    expect(result.journeys).toHaveLength(11);
  });

  it("removes every journey when only an operator that does not run here is chosen", async () => {
    const { result } = await run(FIXTURE, { ...MUENCHEN, operators: "metronom" });
    expect(result.journeys).toEqual([]);
    expect(result.removedBy.operator).toBe(12);
  });
});

describe("operator matcher with a capital sharp s", () => {
  it("matches the same operator whichever sharp s the term or the name uses", () => {
    expect(operatorMatcher(["GROẞ"])("Großraumverkehr Nord")).toBe(true);
    expect(operatorMatcher(["groß"])("GROẞRAUMVERKEHR NORD")).toBe(true);
  });
});

describe("operator filter with accents on Frankfurt Hbf to Dresden Hbf without high-speed trains", () => {
  const FIXTURE = "motis-plan-frankfurt-dresden-no-hsr.json";
  const FRANKFURT = { from: "de:06412:10", to: "de:14612:28" };

  it("avoids the ÖBB night train written without the umlaut", async () => {
    const { result } = await run(FIXTURE, {
      ...FRANKFURT,
      categories: "ld,night,rfast,reg,sbahn",
      avoidOperators: "Osterreichische",
    });
    expect(result.removedBy.operator).toBe(2);
    expect(result.journeys.flatMap(lines)).not.toContain("12N");
  });
});
