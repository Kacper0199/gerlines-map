import type { TripRecord } from "@gerlines/live-frame";
import { describe, expect, it } from "vitest";
import { matchTrips, rowOf } from "../scripts/find-trips.ts";

const trip = (key: number, extra: Partial<TripRecord>): TripRecord =>
  ({
    key,
    shapeId: 1,
    category: "reg",
    realtime: false,
    cancelled: false,
    foreign: false,
    delay: null,
    line: null,
    trainNumber: null,
    firstStop: 0,
    stops: [],
    ...extra,
  }) as TripRecord;

const TRIPS = [
  trip(1, {
    line: "S1",
    series: "db-422",
    operator: "db-regio-ag-nrw",
    units: 2,
    category: "sbahn",
  }),
  trip(2, { line: "RE1", series: "db-1428", operator: "db-regio-ag-nrw" }),
  trip(3, { line: "S1", series: "db-422", operator: "db-regio-ag-nrw", cancelled: true }),
  trip(4, { line: "RB16", series: null, operator: "vias-rail-gmbh" }),
];

describe("matchTrips", () => {
  it("filters by series, operator and line as case-insensitive expressions and skips cancelled trips", () => {
    expect(matchTrips(TRIPS, { series: "422" }).map((t) => t.key)).toEqual([1]);
    expect(matchTrips(TRIPS, { operator: "NRW" }).map((t) => t.key)).toEqual([1, 2]);
    expect(matchTrips(TRIPS, { line: "^S" }).map((t) => t.key)).toEqual([1]);
    expect(matchTrips(TRIPS, {}).map((t) => t.key)).toEqual([1, 2, 4]);
    expect(matchTrips(TRIPS, { series: "^$" }).map((t) => t.key)).toEqual([4]);
  });

  it("writes one tab separated row with a dash for what is unknown", () => {
    expect(rowOf(TRIPS[0] as TripRecord)).toBe("1\tS1\t-\tdb-422\tdb-regio-ag-nrw\t2\tsbahn");
    expect(rowOf(TRIPS[3] as TripRecord)).toBe("4\tRB16\t-\t-\tvias-rail-gmbh\t-\treg");
  });
});
