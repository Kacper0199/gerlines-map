import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFacilities } from "./fasta.ts";
import { parseIrisTimetable, stopChanged } from "./iris.ts";
import { parseStadaStations } from "./stada.ts";

const FIXTURES = new URL("../../test/fixtures/db-apis/", import.meta.url);
const GOLDEN = new URL("golden/", FIXTURES);

function fixture(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURES));
}

function matchesGolden(name: string, value: unknown): void {
  const file = new URL(`${name}.json`, GOLDEN);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  expect(JSON.parse(JSON.stringify(value))).toEqual(JSON.parse(readFileSync(file, "utf8")));
}

const fixtureNames = readdirSync(FIXTURES).filter((name) => /\.(xml|json)$/.test(name));

describe("DB Timetables (IRIS) contract", () => {
  const irisFixtures = fixtureNames.filter((name) => name.startsWith("iris-"));

  it("has a fixture of each endpoint", () => {
    for (const endpoint of ["plan", "fchg", "rchg"]) {
      expect(
        irisFixtures.some((name) => name.startsWith(`iris-${endpoint}-`)),
        endpoint,
      ).toBe(true);
    }
  });

  it.each(irisFixtures)("%s parses to its golden output", (name) => {
    const eva = Number(/-(\d{7})\.xml$/.exec(name)?.[1]);
    matchesGolden(name.replace(/\.xml$/, ""), parseIrisTimetable(fixture(name), eva));
  });

  it("reads a plan: times in UTC, platform, path, trip label, EVA from the request", () => {
    const plan = parseIrisTimetable(fixture("iris-plan-8000105.xml"), 8000105);
    expect(plan.station).toBe("Frankfurt(Main)Hbf");
    expect(plan.eva).toBe(8000105);
    const ice = plan.stops.find((stop) => stop.tripLabel?.number === "990");
    expect(ice?.tripLabel).toEqual({
      category: "ICE",
      number: "990",
      owner: "80",
      filter: "F",
      tripType: "p",
    });
    expect(ice?.arrival?.plannedTime).toBe("2026-10-25T23:09:00.000Z");
    expect(ice?.arrival?.plannedPlatform).toBe("9");
    expect(ice?.arrival?.plannedPath?.at(-1)).toBe("Mannheim Hbf");
    expect(plan.stops.every((stop) => !stopChanged(stop))).toBe(true);
  });

  it("reads changes: delay, platform change, cancellation, messages, wings, replacements, added trips", () => {
    const frankfurt = parseIrisTimetable(fixture("iris-fchg-8000105.xml"));
    const aachen = parseIrisTimetable(fixture("iris-fchg-8000001.xml"));
    const hannover = parseIrisTimetable(fixture("iris-fchg-8000152.xml"));
    const all = [...frankfurt.stops, ...aachen.stops, ...hannover.stops];
    const events = all.flatMap((stop) => [stop.arrival, stop.departure]).filter((e) => e !== null);
    expect(events.some((e) => e.delayMinutes !== null && e.delayMinutes > 0)).toBe(true);
    expect(events.some((e) => e.changedPlatform !== null)).toBe(true);
    expect(events.some((e) => e.changedStatus === "cancelled" && e.cancellationTime !== null)).toBe(
      true,
    );
    expect(events.some((e) => e.wings.length > 0)).toBe(true);
    expect(events.some((e) => e.plannedStatus === "added")).toBe(true);
    expect(events.some((e) => e.messages.some((m) => m.type === "d" && m.code !== null))).toBe(
      true,
    );
    expect(
      all.some((stop) => stop.messages.some((m) => m.type === "h" && m.validTo !== null)),
    ).toBe(true);
    const replacement = aachen.stops.find((stop) => stop.references.length > 0);
    expect(replacement?.tripLabel?.tripType).toBe("e");
    expect(replacement?.references[0]?.tripLabel?.tripType).toBe("p");
    expect(frankfurt.eva).toBe(8000105);
  });
});

describe("StaDa contract", () => {
  it("parses its fixture to the golden output", () => {
    matchesGolden("stada-stations", parseStadaStations(fixture("stada-stations.json")));
  });

  it("keeps EVA, DS100, Land, category and IFOPT for the join", () => {
    const { stations } = parseStadaStations(fixture("stada-stations.json"));
    const frankfurt = stations.find((station) => station.stationNumber === 1866);
    expect(frankfurt).toMatchObject({
      name: "Frankfurt (Main) Hbf",
      mainEva: 8000105,
      mainRil100: "FF",
      federalStateCode: "DE-HE",
      category: 1,
      ifopt: "de:06412:10",
    });
    expect(stations.some((station) => station.mainEva === null)).toBe(true);
  });

  it("refuses a first page that does not hold every station", () => {
    expect(() => parseStadaStations('{"offset":0,"limit":1,"total":2,"result":[]}')).toThrow(
      /0 of 2/,
    );
  });
});

describe("FaSta contract", () => {
  it("parses its fixture to the golden output", () => {
    matchesGolden("fasta-facilities", parseFacilities(fixture("fasta-facilities.json")));
  });

  it("keeps type, state and station number, and refuses an unknown state", () => {
    const facilities = parseFacilities(fixture("fasta-facilities.json"));
    expect(new Set(facilities.map((f) => f.state))).toEqual(
      new Set(["ACTIVE", "INACTIVE", "UNKNOWN"]),
    );
    expect(() =>
      parseFacilities(
        '[{"equipmentnumber":1,"stationnumber":2,"type":"ELEVATOR","state":"BROKEN"}]',
      ),
    ).toThrow(/state/);
  });
});
