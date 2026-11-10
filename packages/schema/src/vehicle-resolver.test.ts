import { describe, expect, it } from "vitest";
import { VehicleResolution } from "./vehicle-identity.ts";
import {
  type FleetRuleRow,
  lineKey,
  resolveIdentity,
  type SeriesFacts,
  type TrainKey,
} from "./vehicle-resolver.ts";

const SERIES = new Map<string, SeriesFacts>(
  [
    { seriesId: "db-412", name: "ICE 4", br: "412", unitLengthMetres: 346 },
    { seriesId: "db-401", name: "ICE 1", unitLengthMetres: null },
    { seriesId: "db-402", name: "ICE 2", unitLengthMetres: 205.4 },
    { seriesId: "db-422", name: "DB Class 422", br: "422", unitLengthMetres: 69.1 },
    { seriesId: "db-481", name: "DB Class 481", unitLengthMetres: null },
  ].map((row) => [row.seriesId, row]),
);

function rule(
  overrides: Partial<FleetRuleRow> & Pick<FleetRuleRow, "ruleId" | "scope">,
): FleetRuleRow {
  return {
    operatorId: null,
    categoryCode: null,
    lineKeys: [],
    seriesIds: [],
    modelId: null,
    modelName: null,
    units: null,
    fleetCount: null,
    fleetTotal: null,
    validFrom: "2025-12-14",
    validTo: "2026-12-12",
    sourceId: "wikipedia-de-ice-linien",
    ...overrides,
  };
}

const RULES: FleetRuleRow[] = [
  rule({
    ruleId: "ice-line-12",
    scope: "line",
    operatorId: "db-fernverkehr-ag",
    categoryCode: "hsr",
    lineKeys: ["12"],
    seriesIds: ["db-412"],
  }),
  rule({
    ruleId: "ice-line-10",
    scope: "line",
    operatorId: "db-fernverkehr-ag",
    categoryCode: "hsr",
    lineKeys: ["10"],
    seriesIds: ["db-402", "db-412"],
  }),
  rule({
    ruleId: "ice-line-3",
    scope: "line",
    operatorId: "db-fernverkehr-ag",
    categoryCode: "hsr",
    lineKeys: ["3"],
    seriesIds: ["db-401", "db-402"],
  }),
  rule({
    ruleId: "nrw-s1",
    scope: "line",
    operatorId: "db-regio-ag-nrw",
    categoryCode: "sbahn",
    lineKeys: ["S1"],
    seriesIds: ["db-422"],
    units: 2,
    sourceId: "wikipedia-de-s-bahn-rhein-ruhr",
  }),
  rule({
    ruleId: "operator-db-fernverkehr-hsr",
    scope: "operator",
    operatorId: "db-fernverkehr-ag",
    categoryCode: "hsr",
    seriesIds: ["db-412"],
    fleetCount: 137,
    fleetTotal: 408,
    sourceId: "wikipedia-de-intercity-express-fleet",
  }),
  rule({
    ruleId: "operator-s-bahn-berlin",
    scope: "operator",
    operatorId: "s-bahn-berlin-gmbh",
    seriesIds: ["db-481"],
    fleetCount: 500,
    fleetTotal: 756,
    sourceId: "wikipedia-de-s-bahn-berlin",
  }),
  rule({
    ruleId: "generic-hsr",
    scope: "category",
    categoryCode: "hsr",
    modelId: "generic-hsr",
    modelName: "Generic high speed train",
    validFrom: null,
    validTo: null,
    sourceId: "gerlines",
  }),
  rule({
    ruleId: "generic-sbahn",
    scope: "category",
    categoryCode: "sbahn",
    modelId: "generic-sbahn",
    modelName: "Generic S-Bahn",
    validFrom: null,
    validTo: null,
    sourceId: "gerlines",
  }),
];

const ICE: TrainKey = {
  serviceDate: "2026-11-07",
  operatorId: "db-fernverkehr-ag",
  category: "hsr",
  line: "12",
  trainNumber: "379",
};

function resolve(key: Partial<TrainKey>, extra: object = {}) {
  const result = resolveIdentity({ ...ICE, ...key }, { rules: RULES, series: SERIES, ...extra });
  if (result) VehicleResolution.parse(result);
  return result;
}

describe("resolveIdentity", () => {
  it("answers a line with one series at layer L2 with the cited source", () => {
    expect(resolve({})).toMatchObject({
      seriesId: "db-412",
      seriesName: "ICE 4",
      layer: "L2",
      confidence: 0.8,
      source: "wikipedia-de-ice-linien",
      ruleId: "ice-line-12",
      alternatives: [],
    });
  });

  it("carries the series' Baureihe number, or null where the catalogue has none", () => {
    expect(resolve({})).toMatchObject({ seriesId: "db-412", br: "412" });
    expect(
      resolve({ operatorId: "s-bahn-berlin-gmbh", category: "sbahn", line: "S7" }),
    ).toMatchObject({ seriesId: "db-481", br: null });
    expect(resolve({ operatorId: "some-operator", line: "12" })).toMatchObject({ br: null });
  });

  it("takes the operator's dominant series when a line allows several and it is among them", () => {
    expect(resolve({ line: "10" })).toMatchObject({
      seriesId: "db-412",
      layer: "L2",
      confidence: 0.5,
      alternatives: ["db-402"],
    });
  });

  it("takes the first listed series at a lower confidence when the dominant one is not allowed", () => {
    expect(resolve({ line: "3" })).toMatchObject({
      seriesId: "db-401",
      layer: "L2",
      confidence: 0.45,
      alternatives: ["db-402"],
    });
  });

  it("keeps a line rule below the operator's confidence when it excludes the operator's series", () => {
    const line47 = rule({
      ruleId: "ice-line-47",
      scope: "line",
      operatorId: "db-fernverkehr-ag",
      categoryCode: "hsr",
      lineKeys: ["47"],
      seriesIds: ["db-401", "db-402", "db-422"],
    });
    const operator = resolve({ line: "99" });
    const result = resolve({ line: "47" }, { rules: [...RULES, line47] });
    expect(result).toMatchObject({
      seriesId: "db-401",
      layer: "L2",
      confidence: 0.3,
      alternatives: ["db-402", "db-422"],
    });
    expect(operator?.confidence).toBeGreaterThan(result?.confidence ?? 1);
    expect(line47.seriesIds).not.toContain(operator?.seriesId);
  });

  it("never answers a line below the operator's confidence with a series the operator rule names", () => {
    for (const line of ["10", "12"]) {
      const result = resolve({ line });
      expect(result?.layer).toBe("L2");
      expect(result?.confidence).toBeGreaterThanOrEqual(resolve({ line: "99" })?.confidence ?? 1);
    }
  });

  it("derives the length from the units a rule states and compares lines without case or spaces", () => {
    const result = resolve({ operatorId: "db-regio-ag-nrw", category: "sbahn", line: "s 1" });
    expect(result).toMatchObject({
      seriesId: "db-422",
      units: 2,
      lengthMetres: 138.2,
      layer: "L2",
    });
  });

  it("falls to the operator's dominant series at L3 for an unknown line", () => {
    expect(resolve({ line: "99" })).toMatchObject({
      seriesId: "db-412",
      layer: "L3",
      confidence: 0.37,
      units: null,
      lengthMetres: null,
    });
    expect(
      resolve({ operatorId: "s-bahn-berlin-gmbh", category: "sbahn", line: "S7" }),
    ).toMatchObject({ seriesId: "db-481", layer: "L3", confidence: 0.43 });
  });

  it("falls to the generic model of the category at L4", () => {
    expect(resolve({ operatorId: "some-operator", line: "12" })).toMatchObject({
      seriesId: "generic-hsr",
      seriesName: "Generic high speed train",
      layer: "L4",
      confidence: 0.1,
      source: "gerlines",
    });
  });

  it("ignores rules outside their validity", () => {
    expect(resolve({ serviceDate: "2026-12-13" })).toMatchObject({ layer: "L4" });
  });

  it("keeps a line rule of another category out (ICE line 20 is not IC line 20)", () => {
    expect(resolve({ category: "ld", line: "12" })).toBeNull();
  });

  it("prefers the exact formation (L0), then a strict majority of at least two (L1)", () => {
    const exact = {
      seriesId: "db-412",
      units: 2,
      cars: 14,
      lengthMetres: 401.5,
      sourceId: "bahn-vehicle-sequence",
    };
    expect(resolve({ line: "3" }, { exact })).toMatchObject({
      layer: "L0",
      confidence: 0.97,
      units: 2,
      cars: 14,
      lengthMetres: 401.5,
    });
    const majority = {
      seriesId: "db-402",
      units: 1,
      count: 4,
      total: 5,
      sourceId: "bahn-vehicle-sequence",
    };
    expect(resolve({}, { majority })).toMatchObject({
      seriesId: "db-402",
      layer: "L1",
      confidence: 0.74,
      units: 1,
      lengthMetres: 205.4,
    });
    expect(resolve({}, { majority: { ...majority, count: 1, total: 1 } })).toMatchObject({
      layer: "L2",
    });
    expect(resolve({}, { majority: { ...majority, count: 2, total: 4 } })).toMatchObject({
      layer: "L2",
    });
  });

  it("skips a layer whose series the catalogue does not know", () => {
    const exact = {
      seriesId: "db-999",
      units: 1,
      cars: 1,
      lengthMetres: null,
      sourceId: "bahn-vehicle-sequence",
    };
    expect(resolve({}, { exact })).toMatchObject({ layer: "L2" });
  });

  it("normalises line keys like the catalogue loader", () => {
    expect(lineKey(" re 10a ")).toBe("RE10A");
  });
});
