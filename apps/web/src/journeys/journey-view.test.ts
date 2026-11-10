import type { Journey, TrainReliability, TransitLeg } from "@gerlines/schema/journeys";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures.ts";
import {
  delayMinutes,
  detailItems,
  displayNumber,
  durationParts,
  journeyBounds,
  journeyReliability,
  legName,
  liveRunOf,
  mergeJourneys,
  RELIABILITY_MIN_RUNS,
  type ReliabilityEntry,
  transitLegs,
} from "./journey-view.ts";
import { reliabilityKeyOf } from "./journeys-client.ts";

const COPY = {
  trainNumber: (number: string) => `Train ${number}`,
  line: (line: string) => `Line ${line}`,
};

const [ice, metronom] = FIXTURES.bremenHamburg.journeys as [Journey, Journey];

function entriesOf(trains: readonly TrainReliability[]): Map<string, ReliabilityEntry> {
  return new Map(
    trains.map((train) => [
      `${train.category}~${train.number}${train.operator ? `~${train.operator}` : ""}`,
      train,
    ]),
  );
}

function twoLegJourney(): Journey {
  const [first] = transitLegs(ice);
  const [second] = transitLegs(metronom);
  return { ...ice, legs: [first as TransitLeg, second as TransitLeg] };
}

describe("legName", () => {
  it("names an ICE by its number with the bare line under it", () => {
    expect(legName(transitLegs(ice)[0] as TransitLeg, COPY, "High speed")).toEqual({
      title: "Train 1028",
      detail: "Line 42",
    });
  });

  it("names a regional train by its line with the number under it", () => {
    expect(legName(transitLegs(metronom)[0] as TransitLeg, COPY, "Regional")).toEqual({
      title: "RE4",
      detail: "Train 82012",
    });
  });

  it("never shows a bare number and falls back to the category", () => {
    expect(legName({ line: "42", tripNumber: null }, COPY, "High speed")).toEqual({
      title: "Line 42",
      detail: null,
    });
    expect(legName({ line: null, tripNumber: null }, COPY, "High speed")).toEqual({
      title: "High speed",
      detail: null,
    });
  });
});

describe("numbers and times", () => {
  it("drops padding zeros only in front of digits", () => {
    expect(displayNumber("001028")).toBe("1028");
    expect(displayNumber("0")).toBe("0");
    expect(displayNumber("RE4")).toBe("RE4");
  });

  it("splits a duration into hours and minutes", () => {
    expect(durationParts(3360)).toEqual({ hours: 0, minutes: 56 });
    expect(durationParts(17_000)).toEqual({ hours: 4, minutes: 43 });
    expect(durationParts(10_800)).toEqual({ hours: 3, minutes: 0 });
  });

  it("gives whole minutes of delay, nothing on the minute or without realtime", () => {
    expect(delayMinutes("2026-11-10T06:28:00Z", "2026-11-10T06:22:00Z")).toBe(6);
    expect(delayMinutes("2026-11-10T06:20:00Z", "2026-11-10T06:22:00Z")).toBe(-2);
    expect(delayMinutes("2026-11-10T06:22:00Z", "2026-11-10T06:22:00Z")).toBeNull();
    expect(delayMinutes(null, "2026-11-10T06:22:00Z")).toBeNull();
  });
});

describe("journeyReliability", () => {
  const recorded = entriesOf(FIXTURES.reliabilityBremenHamburg.trains);
  const rated = entriesOf(
    FIXTURES.reliabilityBremenHamburg.trains.map((train) =>
      train.status === "known" ? { ...train, runs: train.runs + 10 } : train,
    ),
  );

  it("reads the share of a one train journey since its first recorded day", () => {
    expect(journeyReliability(ice, rated)).toEqual({
      kind: "known",
      share: 10 / 12,
      runs: 12,
      firstDay: "2026-10-27",
      weakest: null,
      missing: 0,
      unrated: 0,
    });
  });

  it("gives no share for a train with fewer than 5 recorded runs", () => {
    expect(RELIABILITY_MIN_RUNS).toBe(5);
    expect(journeyReliability(ice, recorded)).toEqual({
      kind: "thin",
      runs: 2,
      leg: null,
      missing: 0,
    });
  });

  it("names the thinnest train when no train of the journey can be rated", () => {
    const answer = journeyReliability(twoLegJourney(), recorded);
    expect(answer).toMatchObject({ kind: "thin", runs: 1 });
    expect(answer.kind === "thin" && answer.leg?.tripNumber).toBe("082012");
  });

  it("rates by the trains with enough runs and counts the others apart", () => {
    const journey = twoLegJourney();
    const key = reliabilityKeyOf(transitLegs(journey)[1] as TransitLeg) as string;
    const mixed = new Map(rated);
    mixed.set(key, recorded.get(key) as ReliabilityEntry);
    expect(journeyReliability(journey, mixed)).toMatchObject({
      kind: "known",
      share: 10 / 12,
      missing: 0,
      unrated: 1,
    });
  });

  it("is as reliable as the weakest train and names it", () => {
    const journey = twoLegJourney();
    const answer = journeyReliability(journey, rated);
    expect(answer).toMatchObject({ kind: "known", share: 10 / 12, missing: 0 });
    expect(answer.kind === "known" && answer.weakest?.tripNumber).toBe("001028");
  });

  it("counts the trains without history", () => {
    const journey = twoLegJourney();
    const key = reliabilityKeyOf(transitLegs(journey)[1] as TransitLeg) as string;
    const partial = new Map(rated);
    partial.set(key, {
      status: "missing",
      category: "rfast",
      number: "082012",
      operator: "metronom",
      reason: "no_observations",
    });
    expect(journeyReliability(journey, partial)).toMatchObject({ kind: "known", missing: 1 });
  });

  it("waits while a train is loading", () => {
    expect(journeyReliability(ice, new Map())).toEqual({ kind: "loading" });
  });

  it("is missing with the reason when no train has history", () => {
    const key = reliabilityKeyOf(transitLegs(ice)[0] as TransitLeg) as string;
    const none = new Map<string, ReliabilityEntry>([
      [
        key,
        {
          status: "missing",
          category: "hsr",
          number: "001028",
          operator: null,
          reason: "ambiguous",
        },
      ],
    ]);
    expect(journeyReliability(ice, none)).toEqual({ kind: "missing", reason: "ambiguous" });
    const noNumber = {
      ...ice,
      legs: ice.legs.map((leg) => (leg.kind === "transit" ? { ...leg, tripNumber: null } : leg)),
    };
    expect(journeyReliability(noNumber, new Map())).toEqual({
      kind: "missing",
      reason: "no_number",
    });
  });
});

describe("detailItems", () => {
  const [first] = transitLegs(ice) as [TransitLeg];
  const [second] = transitLegs(metronom) as [TransitLeg];
  const walk = {
    kind: "walk" as const,
    from: first.to,
    to: second.from,
    departure: first.arrival,
    arrival: second.departure,
    durationS: 240,
  };

  it("shows a one train journey with both ends", () => {
    expect(detailItems(ice.legs)).toEqual([{ kind: "transit", leg: first, from: true, to: true }]);
  });

  it("joins the arrival and the next departure into one change, a walk between included", () => {
    expect(detailItems([first, second])).toEqual([
      { kind: "transit", leg: first, from: true, to: false },
      { kind: "change", arrive: first, depart: second, walk: null },
      { kind: "transit", leg: second, from: false, to: true },
    ]);
    expect(detailItems([first, walk, second])[1]).toEqual({
      kind: "change",
      arrive: first,
      depart: second,
      walk,
    });
    expect(detailItems([first, walk, second])).toHaveLength(3);
  });

  it("keeps a walk at either end as its own row", () => {
    expect(detailItems([walk, first]).map((item) => item.kind)).toEqual(["walk", "transit"]);
  });
});

describe("mergeJourneys and bounds", () => {
  it("adds a later page once, in departure order", () => {
    const merged = mergeJourneys(FIXTURES.bremenHamburg.journeys, [
      ...FIXTURES.bremenHamburgLater.journeys,
      ice,
    ]);
    const ids = merged.map((journey) => journey.id);
    expect(new Set(ids).size).toBe(ids.length);
    const departures = merged.map((journey) => Date.parse(journey.departure));
    expect(departures).toEqual([...departures].sort((a, b) => a - b));
  });

  it("boxes the stops and the route line", () => {
    const box = journeyBounds(ice, () => [[8.5, 53.9]]);
    expect(box[0]).toBeLessThan(8.82);
    expect(box[3]).toBe(53.9);
    expect(box[2]).toBeGreaterThan(9.9);
  });
});

describe("liveRunOf", () => {
  const leg = transitLegs(ice)[0] as TransitLeg;
  const run = {
    tripInstanceId: "05b180df-12b5-5062-93a3-0a1c50b4e115",
    departure: "2026-11-10T05:00:00Z",
    arrival: "2026-11-10T07:30:00Z",
  };
  const at = (iso: string) => Date.parse(iso);

  it("links a leg whose train runs now, from its first departure to its last arrival", () => {
    const riding = { ...leg, run };
    expect(liveRunOf(riding, at("2026-11-10T05:00:00Z"))).toBe(run);
    expect(liveRunOf(riding, at("2026-11-10T07:30:00Z"))).toBe(run);
    expect(liveRunOf(riding, at("2026-11-10T04:59:00Z"))).toBeNull();
    expect(liveRunOf(riding, at("2026-11-10T07:31:00Z"))).toBeNull();
  });

  it("keeps the link while the leg's arrival delay lasts", () => {
    const late = {
      ...leg,
      run,
      scheduledArrival: "2026-11-10T07:18:00Z",
      arrival: "2026-11-10T07:30:00Z",
    };
    expect(liveRunOf(late, at("2026-11-10T07:41:00Z"))).toBe(run);
    expect(liveRunOf(late, at("2026-11-10T07:43:00Z"))).toBeNull();
  });

  it("gives no link without a run or for a cancelled leg", () => {
    expect(liveRunOf({ ...leg, run: null }, at("2026-11-10T06:00:00Z"))).toBeNull();
    expect(liveRunOf({ ...leg, run: undefined }, at("2026-11-10T06:00:00Z"))).toBeNull();
    expect(liveRunOf({ ...leg, run, cancelled: true }, at("2026-11-10T06:00:00Z"))).toBeNull();
  });
});
