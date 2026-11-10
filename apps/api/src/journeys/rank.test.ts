import { JOURNEY_SORTS, Journey } from "@gerlines/schema/journeys";
import { describe, expect, it } from "vitest";
import { fixtureClient, loadPlanFixture } from "../router/fixtures.ts";
import { journeyQuerySchema } from "./query.ts";
import { defaultSort, RANKINGS, rankJourneys } from "./rank.ts";
import { searchJourneys } from "./service.ts";

async function frankfurtDresden(sort?: string, arriveBy = "false") {
  const client = fixtureClient(loadPlanFixture("motis-plan-frankfurt-dresden-no-hsr.json"));
  const query = journeyQuerySchema.parse({
    from: "de:06412:10",
    to: "de:14612:28",
    time: "2026-10-27T06:00:00Z",
    categories: "ld,night,rfast,reg,sbahn",
    arriveBy,
    ...(sort ? { sort } : {}),
  });
  return searchJourneys(query, { client, datasetTag: "de-DELFI", now: () => 0 });
}

const summary = (journey: Journey) =>
  `${journey.departure.slice(11, 16)} ${Math.round(journey.durationS / 60)} min ${journey.transfers}`;

describe("ranking on Frankfurt Hbf to Dresden Hbf without high-speed trains", () => {
  it.each(JOURNEY_SORTS)("orders the twelve journeys by %s", async (sort) => {
    const { journeys, query } = await frankfurtDresden(sort);
    expect(query.sort).toBe(sort);
    expect(journeys).toHaveLength(12);
    for (let index = 1; index < journeys.length; index += 1) {
      const [before, after] = [journeys[index - 1], journeys[index]] as [Journey, Journey];
      expect(RANKINGS[sort](before, after)).toBeLessThan(0);
    }
  });

  it("puts the fastest journey first: 300 min with RB51, FLX10 and IC 55, arriving first", async () => {
    const { journeys } = await frankfurtDresden("fastest");
    expect(journeys.slice(0, 2).map(summary)).toEqual(["08:50 300 min 2", "14:50 300 min 2"]);
  });

  it("puts the journey with one change first: RE54 and the 12N night train", async () => {
    const { journeys } = await frankfurtDresden("fewestChanges");
    expect(summary(journeys[0] as Journey)).toBe("23:30 396 min 1");
  });

  it("ranks the latest departure first and breaks the tie by the earlier arrival", async () => {
    const { journeys } = await frankfurtDresden("latestDeparture");
    expect(journeys.slice(0, 2).map(summary)).toEqual(["23:30 364 min 2", "23:30 396 min 1"]);
  });

  it("tags the best journey of each criterion once", async () => {
    const { journeys } = await frankfurtDresden();
    const tagged = journeys.flatMap((journey) =>
      journey.tags.map((tag) => [tag, summary(journey)]),
    );
    expect(Object.fromEntries(tagged)).toEqual({
      fastest: "08:50 300 min 2",
      earliestArrival: "08:50 300 min 2",
      fewestChanges: "23:30 396 min 1",
      latestDeparture: "23:30 364 min 2",
    });
    expect(tagged).toHaveLength(4);
  });

  it("sorts by earliest arrival by default and by latest departure for arrive-by", async () => {
    expect((await frankfurtDresden()).query.sort).toBe("earliestArrival");
    expect((await frankfurtDresden(undefined, "true")).query.sort).toBe("latestDeparture");
    expect(defaultSort(false)).toBe("earliestArrival");
    expect(defaultSort(true)).toBe("latestDeparture");
  });

  it("answers in the shared contract", async () => {
    const { journeys } = await frankfurtDresden();
    for (const journey of journeys) {
      expect(Journey.parse(journey)).toEqual(journey);
    }
  });
});

describe("rankJourneys", () => {
  const journey = (id: string, departure: string, arrival: string, transfers: number) => ({
    id,
    departure: `2026-10-27T${departure}:00Z`,
    arrival: `2026-10-27T${arrival}:00Z`,
    durationS:
      (Date.parse(`2026-10-27T${arrival}:00Z`) - Date.parse(`2026-10-27T${departure}:00Z`)) / 1000,
    transfers,
  });

  it("is a total order: equal journeys keep a fixed order by id", () => {
    const a = journey("b", "08:00", "10:00", 1);
    const b = journey("a", "08:00", "10:00", 1);
    for (const sort of JOURNEY_SORTS) {
      expect(rankJourneys([a, b], sort).map((item) => item.id)).toEqual(["a", "b"]);
      expect(rankJourneys([b, a], sort).map((item) => item.id)).toEqual(["a", "b"]);
    }
  });

  it("answers an empty list without tags", () => {
    expect(rankJourneys([], "fastest")).toEqual([]);
  });

  it("does not change the input", () => {
    const input = [journey("x", "09:00", "10:00", 0), journey("y", "08:00", "09:30", 2)];
    const copy = structuredClone(input);
    rankJourneys(input, "fastest");
    expect(input).toEqual(copy);
  });
});
