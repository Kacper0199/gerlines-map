import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { TripObservation } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { adaptIris, IrisChanges, type IrisEndpoint, IrisPlans } from "./iris.ts";

const FIXTURES = new URL("../../test/fixtures/db-apis/", import.meta.url);
const GOLDEN = new URL("golden/", FIXTURES);
const PLAN_AT = Date.parse("2026-10-25T22:00:00Z");
const CHANGE_AT = Date.parse("2026-10-25T23:00:00Z");

interface Fixture {
  readonly name: string;
  readonly endpoint: IrisEndpoint;
  readonly eva: number;
}

const fixtures: Fixture[] = readdirSync(FIXTURES)
  .map((name) => /^iris-(plan|fchg|rchg)-(\d{7})\.xml$/.exec(name))
  .filter((match): match is RegExpExecArray => match !== null)
  .map((match) => ({
    name: match[0].replace(/\.xml$/, ""),
    endpoint: match[1] as IrisEndpoint,
    eva: Number(match[2]),
  }));

const read = (name: string) => readFileSync(new URL(`${name}.xml`, FIXTURES));

/** The fixture's observations, folded after the station's plan fixture when there is one. */
function observe(fixture: Fixture): TripObservation[] {
  const state = { plans: new IrisPlans(), changes: new IrisChanges() };
  const plan = fixtures.find((other) => other.endpoint === "plan" && other.eva === fixture.eva);
  if (plan && plan !== fixture) adaptIris(read(plan.name), "plan", plan.eva, PLAN_AT, state);
  const at = fixture.endpoint === "plan" ? PLAN_AT : CHANGE_AT;
  const result = adaptIris(read(fixture.name), fixture.endpoint, fixture.eva, at, state);
  if (!result.ok) throw new Error(result.failure.error);
  return result.events as TripObservation[];
}

function matchesGolden(name: string, value: unknown): void {
  const file = new URL(`${name}.json`, GOLDEN);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  expect(JSON.parse(JSON.stringify(value))).toEqual(JSON.parse(readFileSync(file, "utf8")));
}

describe("IRIS observations contract", () => {
  it("covers every recorded endpoint", () => {
    expect(new Set(fixtures.map((fixture) => fixture.endpoint))).toEqual(
      new Set(["plan", "fchg", "rchg"]),
    );
  });

  it.each(fixtures)("$name adapts to its golden observations", (fixture) => {
    matchesGolden(fixture.name.replace(/^iris-/, "iris-observations-"), observe(fixture));
  });

  it.each(fixtures)("$name keeps the canonical invariants", (fixture) => {
    for (const trip of observe(fixture)) {
      expect(trip.source).toBe("db-iris");
      expect(trip.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(trip.stops.length).toBeGreaterThan(0);
      expect(trip.stops.some((stop) => stop.relationship !== "no_data")).toBe(true);
      for (const stop of trip.stops) {
        expect(stop.stop?.kind).toBe("uic");
        for (const time of [stop.arrival, stop.departure]) {
          if (!time) continue;
          expect(Number.isInteger(time.time)).toBe(true);
          expect(Math.abs((time.time ?? 0) * 1000 - CHANGE_AT)).toBeLessThan(2 * 86_400_000);
        }
      }
    }
  });

  it("finds every change of the Frankfurt answers, with the delay where the plan names the stop", () => {
    const frankfurt = observe(fixtures.find((f) => f.name === "iris-fchg-8000105") as Fixture);
    const ice520 = frankfurt.find((trip) => trip.trainNumber === "520");
    expect(ice520?.stops[0]?.arrival?.delaySeconds).toBe(-120);
    expect(ice520?.stops[0]?.platform).toEqual({ scheduled: "7", actual: "8" });
    const ice2851 = frankfurt.find((trip) => trip.trainNumber === "2851");
    expect(ice2851?.stops[0]?.arrival?.delaySeconds).toBe(0);
    const aachen = observe(fixtures.find((f) => f.name === "iris-fchg-8000001") as Fixture);
    expect(aachen.some((trip) => trip.stops.some((stop) => stop.relationship === "skipped"))).toBe(
      true,
    );
  });
});
