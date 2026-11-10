import { describe, expect, it } from "vitest";
import { exactOf, majorityOf, type ObservedFormation } from "./vehicle-resolver.ts";

function observed(overrides: Partial<ObservedFormation>): ObservedFormation {
  return {
    serviceDate: "2026-10-20",
    trainNumber: "586",
    operatorId: "db-fernverkehr-ag",
    seriesId: "db-412",
    units: 1,
    cars: 12,
    lengthMetres: 346,
    sourceId: "bahn-vehicle-sequence",
    observedAt: Date.parse("2026-10-20T06:00:00Z"),
    ...overrides,
  };
}

const QUERY = {
  serviceDate: "2026-10-20",
  trainNumber: "586",
  operatorId: "db-fernverkehr-ag",
} as const;

describe("exactOf", () => {
  it("answers with the newest observation of the train on its service day", () => {
    const rows = [
      observed({ seriesId: "db-403", observedAt: Date.parse("2026-10-20T05:00:00Z") }),
      observed({ seriesId: "db-412", units: 2, observedAt: Date.parse("2026-10-20T07:00:00Z") }),
      observed({ serviceDate: "2026-10-19", seriesId: "db-401" }),
      observed({ trainNumber: "587", seriesId: "db-401" }),
    ];
    expect(exactOf(rows, QUERY)).toEqual({
      seriesId: "db-412",
      units: 2,
      cars: 12,
      lengthMetres: 346,
      sourceId: "bahn-vehicle-sequence",
    });
  });

  it("leaves out another operator's observations unless the operator is unknown", () => {
    const rows = [observed({ operatorId: "db-regio-ag-nrw" }), observed({ operatorId: null })];
    expect(exactOf(rows, QUERY)).toBeNull();
    expect(exactOf(rows, { ...QUERY, operatorId: null })).not.toBeNull();
  });
});

describe("majorityOf", () => {
  function day(date: string, seriesId: string, units: number | null = 1, sourceId?: string) {
    return observed({ serviceDate: date, seriesId, units, ...(sourceId ? { sourceId } : {}) });
  }

  it("counts the 14 days before the service day, not the day itself", () => {
    const rows = [
      day("2026-10-06", "db-412"),
      day("2026-10-07", "db-412"),
      day("2026-10-08", "db-412"),
      day("2026-10-19", "db-403"),
      day("2026-10-05", "db-403"),
      day("2026-10-20", "db-403"),
    ];
    expect(majorityOf(rows, QUERY)).toEqual({
      seriesId: "db-412",
      units: 1,
      count: 3,
      total: 4,
      sourceId: "bahn-vehicle-sequence",
    });
  });

  it("breaks a tie in count by series id and takes the most frequent units, the smaller on a tie", () => {
    const rows = [
      day("2026-10-10", "db-412", 2),
      day("2026-10-11", "db-412", 1),
      day("2026-10-12", "db-412", 2),
      day("2026-10-13", "db-412", 1),
      day("2026-10-14", "db-412", null),
      day("2026-10-15", "db-403", 1),
      day("2026-10-16", "db-403", 1),
      day("2026-10-17", "db-403", 2),
      day("2026-10-18", "db-403", 2),
      day("2026-10-19", "db-403", 2),
    ];
    expect(majorityOf(rows, QUERY)).toMatchObject({
      seriesId: "db-403",
      units: 2,
      count: 5,
      total: 10,
    });
    expect(majorityOf(rows.slice(0, 5), QUERY)).toMatchObject({ seriesId: "db-412", units: 1 });
  });

  it("takes the smallest source id of the chosen series and null units when none is known", () => {
    const rows = [
      day("2026-10-18", "db-412", null, "z-source"),
      day("2026-10-19", "db-412", null, "a-source"),
    ];
    expect(majorityOf(rows, QUERY)).toMatchObject({ units: null, sourceId: "a-source" });
  });

  it("answers null without observations of the train", () => {
    expect(majorityOf([day("2026-10-19", "db-412")], { ...QUERY, trainNumber: "1" })).toBeNull();
  });
});
