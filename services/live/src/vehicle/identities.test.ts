import type { FleetRuleRow, ObservedFormation } from "@gerlines/schema/vehicle-resolver";
import { describe, expect, it } from "vitest";
import type { StaticRun } from "../model.ts";
import {
  type FleetCatalogue,
  type FleetSource,
  type FleetWindow,
  observationWindow,
  VehicleIdentities,
  VehicleReadTimeout,
} from "./identities.ts";

function rule(overrides: Partial<FleetRuleRow> & Pick<FleetRuleRow, "ruleId" | "scope">) {
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
  } satisfies FleetRuleRow;
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
    ruleId: "nrw-s1",
    scope: "line",
    operatorId: "db-regio-ag-nrw",
    categoryCode: "sbahn",
    lineKeys: ["S1"],
    seriesIds: ["db-422"],
    units: 2,
  }),
  rule({
    ruleId: "generic-reg",
    scope: "category",
    categoryCode: "reg",
    modelId: "generic-reg-emu",
    modelName: "Generic regional",
    sourceId: "gerlines",
  }),
];

const NAMED = new Set(["db-fernverkehr-ag", "db-regio-ag-nrw", "abellio"]);

const SERIES = new Map(
  [
    { seriesId: "db-412", name: "ICE 4", unitLengthMetres: 346 },
    { seriesId: "db-403", name: "ICE 3", unitLengthMetres: 200 },
    { seriesId: "db-422", name: "DB Class 422", unitLengthMetres: 69.1 },
  ].map((row) => [row.seriesId, row]),
);

function observation(overrides: Partial<ObservedFormation>): ObservedFormation {
  return {
    serviceDate: "2026-10-25",
    trainNumber: "586",
    operatorId: "db-fernverkehr-ag",
    seriesId: "db-403",
    units: 2,
    cars: 16,
    lengthMetres: 400,
    sourceId: "bahn-vehicle-sequence",
    observedAt: Date.parse("2026-10-25T05:00:00Z"),
    ...overrides,
  };
}

function run(extra: Partial<StaticRun> = {}): StaticRun {
  const trainNumber = extra.trainNumber === undefined ? 586 : extra.trainNumber;
  return {
    instanceId: "00000000-0000-5000-8000-000000000001",
    serviceDate: "2026-10-25",
    feedVersionId: 1,
    tripKey: "t1",
    category: "hsr",
    categoryCode: "hsr",
    foreign: false,
    line: "12",
    trainNumber,
    shortName: trainNumber === null ? null : String(trainNumber),
    operatorId: "db-fernverkehr-ag",
    patternId: "p",
    stopPlaces: ["a", "b"],
    arrivals: [0, 600],
    departures: [0, 600],
    passThrough: [0, 0],
    shape: null,
    gap: null,
    ...extra,
  };
}

class FakeSource implements FleetSource {
  readonly calls: { from: string; to: string }[] = [];
  readonly windows: FleetWindow[] = [];
  private next: Promise<FleetCatalogue>[] = [];
  private resolvers: ((catalogue: FleetCatalogue) => void)[] = [];
  private rejecters: ((error: Error) => void)[] = [];

  load(window: FleetWindow): Promise<FleetCatalogue> {
    this.calls.push({ from: window.from, to: window.to });
    this.windows.push(window);
    const pending = new Promise<FleetCatalogue>((resolve, reject) => {
      this.resolvers.push(resolve);
      this.rejecters.push(reject);
    });
    this.next.push(pending);
    return pending;
  }

  answer(catalogue: Partial<FleetCatalogue> = {}): void {
    this.resolvers.shift()?.({
      rules: RULES,
      series: SERIES,
      observations: [],
      instances: new Map(),
      namedOperators: NAMED,
      ...catalogue,
    });
    this.rejecters.shift();
  }

  fail(): void {
    this.resolvers.shift();
    this.rejecters.shift()?.(new Error("database gone"));
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const T = Date.parse("2026-10-25T10:00:00Z") / 1000;

describe("observationWindow", () => {
  it("reaches 14 days before the earliest service day and ends at the latest", () => {
    expect(observationWindow(["2026-10-25", "2026-10-24", "2026-10-26"])).toEqual({
      from: "2026-10-10",
      to: "2026-10-26",
    });
  });
});

describe("VehicleIdentities", () => {
  it("knows only the operator until its first load applies, without blocking the caller", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source);
    identities.refresh(T, ["2026-10-25"]);
    expect(identities.apply()).toBe(false);
    expect(identities.of(run())).toEqual({
      series: null,
      operator: "db-fernverkehr-ag",
      units: null,
    });
    source.answer();
    await settle();
    expect(identities.apply()).toBe(true);
    expect(identities.of(run())).toEqual({
      series: "db-412",
      operator: "db-fernverkehr-ag",
      units: null,
    });
  });

  it("resolves with the API's layers: the exact formation of the day before the line rule", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source);
    const ready = identities.refresh(T, ["2026-10-25"]);
    source.answer({ observations: [observation({})] });
    await ready;
    identities.apply();
    expect(identities.of(run())).toEqual({
      series: "db-403",
      operator: "db-fernverkehr-ag",
      units: 2,
    });
    expect(identities.of(run({ instanceId: "other", trainNumber: 587 })).series).toBe("db-412");
  });

  it("carries a line rule's units and leaves the generic layer L4 without a series", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source);
    const ready = identities.refresh(T, ["2026-10-25"]);
    source.answer();
    await ready;
    identities.apply();
    const sbahn = run({
      instanceId: "s1",
      category: "sbahn",
      categoryCode: "sbahn",
      operatorId: "db-regio-ag-nrw",
      line: "S 1",
      trainNumber: 30_123,
    });
    expect(identities.of(sbahn)).toEqual({
      series: "db-422",
      operator: "db-regio-ag-nrw",
      units: 2,
    });
    const regional = run({
      instanceId: "rb",
      category: "reg",
      categoryCode: "reg",
      operatorId: "abellio",
      line: "RB 40",
      trainNumber: null,
    });
    expect(identities.of(regional)).toEqual({ series: null, operator: "abellio", units: null });
  });

  it("loads again only after its refresh interval, one load at a time, and keeps the old catalogue on a failure", async () => {
    const errors: unknown[] = [];
    const source = new FakeSource();
    const identities = new VehicleIdentities(source, {
      refreshS: 600,
      onError: (error) => errors.push(error),
    });
    identities.refresh(T, ["2026-10-25"]);
    identities.refresh(T + 1, ["2026-10-25"]);
    expect(source.calls).toHaveLength(1);
    source.answer();
    await settle();
    identities.apply();
    identities.refresh(T + 599, ["2026-10-25"]);
    expect(source.calls).toHaveLength(1);
    identities.refresh(T + 600, ["2026-10-25", "2026-10-26"]);
    expect(source.calls).toEqual([
      { from: "2026-10-11", to: "2026-10-25" },
      { from: "2026-10-11", to: "2026-10-26" },
    ]);
    source.fail();
    await settle();
    expect(errors).toHaveLength(1);
    expect(identities.apply()).toBe(false);
    expect(identities.of(run()).series).toBe("db-412");
  });

  it("loads again at once when a new service day appears", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source, { refreshS: 600 });
    identities.refresh(T, ["2026-10-25"]);
    source.answer();
    await settle();
    identities.refresh(T + 10, ["2026-10-25", "2026-10-26"]);
    expect(source.calls).toHaveLength(2);
  });

  it("answers from a new catalogue only after it applies, and counts generations", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source, { refreshS: 1 });
    identities.refresh(T, ["2026-10-25"]);
    source.answer();
    await settle();
    identities.apply();
    expect(identities.generation).toBe(1);
    identities.refresh(T + 1, ["2026-10-25"]);
    source.answer({ observations: [observation({})] });
    await settle();
    expect(identities.of(run()).series).toBe("db-412");
    expect(identities.apply()).toBe(true);
    expect(identities.generation).toBe(2);
    expect(identities.of(run()).series).toBe("db-403");
  });

  it("reads the service days themselves beside the observation window", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source);
    identities.refresh(T, ["2026-10-26", "2026-10-25"]);
    expect(source.windows).toEqual([
      { from: "2026-10-11", to: "2026-10-26", days: ["2026-10-25", "2026-10-26"] },
    ]);
  });

  it("keys on the operator and train number ingest recorded for the instance", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source);
    const ready = identities.refresh(T, ["2026-10-25"]);
    source.answer({
      observations: [observation({ trainNumber: "0", operatorId: "db-regio-ag-nrw" })],
      instances: new Map([[run().instanceId, { operatorId: "db-regio-ag-nrw", trainNumber: "0" }]]),
    });
    await ready;
    identities.apply();
    expect(identities.of(run())).toEqual({
      series: "db-403",
      operator: "db-regio-ag-nrw",
      units: 2,
    });
  });

  it("sends no operator the catalogue has no name for", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source);
    const ready = identities.refresh(T, ["2026-10-25"]);
    source.answer({ namedOperators: new Set() });
    await ready;
    identities.apply();
    expect(identities.of(run()).operator).toBeNull();
  });

  it("gives up on a read that never answers, reports it and reads again at the next interval", async () => {
    const errors: unknown[] = [];
    const source = new FakeSource();
    const identities = new VehicleIdentities(source, {
      refreshS: 600,
      readTimeoutMs: 20,
      onError: (error) => errors.push(error),
    });
    const hung = identities.refresh(T, ["2026-10-25"]);
    await hung;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(VehicleReadTimeout);
    expect(identities.apply()).toBe(false);
    expect(identities.refresh(T + 599, ["2026-10-25"])).toBeUndefined();
    const next = identities.refresh(T + 600, ["2026-10-25"]);
    expect(next).toBeDefined();
    source.answer();
    source.answer();
    await next;
    expect(identities.apply()).toBe(true);
    expect(identities.of(run()).series).toBe("db-412");
  });

  it("drops the late answer of a read that timed out", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source, { readTimeoutMs: 20 });
    await identities.refresh(T, ["2026-10-25"]);
    source.answer();
    await settle();
    expect(identities.apply()).toBe(false);
    expect(identities.empty).toBe(true);
  });

  it("resolves a run of a new timetable afresh, though its instance id is the same", async () => {
    const source = new FakeSource();
    const identities = new VehicleIdentities(source);
    const ready = identities.refresh(T, ["2026-10-25"]);
    source.answer();
    await ready;
    identities.apply();
    expect(identities.of(run()).series).toBe("db-412");
    const switched = run({ feedVersionId: 2, line: "99" });
    expect(identities.of(switched).series).toBeNull();
    expect(identities.of(run()).series).toBe("db-412");
  });
});
