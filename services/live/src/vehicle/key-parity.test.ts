import {
  exactOf,
  type FleetRuleRow,
  majorityOf,
  type ObservedFormation,
  resolveIdentity,
  trainKeyOfDetail,
} from "@gerlines/schema/vehicle-resolver";
import { describe, expect, it } from "vitest";
import { buildTrainDetail } from "../detail/build.ts";
import type { DetailInput, InstanceRow, OperatorRow } from "../detail/model.ts";
import type { StaticRun } from "../model.ts";
import { type FleetCatalogue, runKeyOf, VehicleIdentities } from "./identities.ts";

const INSTANCE = "07a1535f-17cf-5e2b-b9b2-de13d923ef94";
const DAY = "2026-10-26";
const T = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`);
const A = "07d45fba-4bcb-58e1-8162-11a19164dbac";
const B = "17d45fba-4bcb-58e1-8162-11a19164dbac";

const OPERATORS: OperatorRow[] = [
  { operatorId: "db-regio-ag-nrw", name: "DB Regio NRW", brandName: null, wikidataQid: null },
  { operatorId: "national-express", name: "National Express", brandName: null, wikidataQid: null },
  { operatorId: "nameless", name: " ", brandName: "", wikidataQid: null },
];

const RULES: FleetRuleRow[] = [
  {
    ruleId: "nrw-s1",
    scope: "line",
    operatorId: "db-regio-ag-nrw",
    categoryCode: "sbahn",
    lineKeys: ["S1"],
    seriesIds: ["db-422"],
    modelId: null,
    modelName: null,
    units: 2,
    fleetCount: null,
    fleetTotal: null,
    validFrom: null,
    validTo: null,
    sourceId: "vrr-fleet",
  },
];

const SERIES = new Map(
  [
    { seriesId: "db-422", name: "DB Class 422", unitLengthMetres: 69.1 },
    { seriesId: "stadler-flirt-3", name: "Stadler FLIRT 3", unitLengthMetres: 74 },
    { seriesId: "db-1440", name: "Coradia Continental", unitLengthMetres: 70 },
  ].map((row) => [row.seriesId, row]),
);

function seen(overrides: Partial<ObservedFormation>): ObservedFormation {
  return {
    serviceDate: DAY,
    trainNumber: "30123",
    operatorId: "db-regio-ag-nrw",
    seriesId: "db-422",
    units: 1,
    cars: null,
    lengthMetres: null,
    sourceId: "bahn-vehicle-sequence",
    observedAt: T("05:00"),
    ...overrides,
  };
}

const OBSERVATIONS: ObservedFormation[] = [
  seen({ trainNumber: "0", operatorId: "national-express", seriesId: "stadler-flirt-3" }),
  seen({ trainNumber: "30123", operatorId: "national-express", seriesId: "db-1440" }),
  seen({ trainNumber: "0", operatorId: "db-regio-ag-nrw", seriesId: "db-422", units: 3 }),
];

function detailInput(instance: InstanceRow | null): DetailInput {
  return {
    ref: {
      tripInstanceId: INSTANCE,
      serviceDate: DAY,
      feedVersionId: 1,
      tripKey: "t1",
      frameKey: null,
    },
    asOf: T("10:00"),
    timetableVersion: "1",
    version: 1,
    trip: {
      feedVersionId: 1,
      tripKey: "t1",
      categoryCode: "sbahn",
      isForeign: false,
      line: " S1 ",
      tripShortName: "030123",
      headsign: null,
      operatorId: "db-regio-ag-nrw",
      product: "S",
      shapeQaStatus: "pass",
    },
    staticStops: [
      {
        index: 0,
        stopPlaceId: A,
        scheduledArrival: T("09:50"),
        scheduledDeparture: T("09:50"),
        platform: null,
        passenger: true,
      },
      {
        index: 1,
        stopPlaceId: B,
        scheduledArrival: T("10:20"),
        scheduledDeparture: T("10:20"),
        platform: null,
        passenger: true,
      },
    ],
    instance,
    events: [],
    activity: [],
    places: new Map([
      [A, { name: "Solingen Hbf", displayName: null, location: null }],
      [B, { name: "Dortmund Hbf", displayName: null, location: null }],
    ]),
    operators: new Map(OPERATORS.map((row) => [row.operatorId, row])),
    sources: new Map(),
    feedObservedAt: new Map(),
    tick: null,
  };
}

const run: StaticRun = {
  instanceId: INSTANCE,
  serviceDate: DAY,
  feedVersionId: 1,
  tripKey: "t1",
  category: "sbahn",
  categoryCode: "sbahn",
  foreign: false,
  line: "S1",
  trainNumber: 30_123,
  shortName: "030123",
  operatorId: "db-regio-ag-nrw",
  patternId: "p",
  stopPlaces: [A, B],
  arrivals: [T("09:50") / 1000, T("10:20") / 1000],
  departures: [T("09:50") / 1000, T("10:20") / 1000],
  passThrough: [0, 0],
  shape: null,
  gap: null,
};

/** The train card's path: the detail the API serves, keyed and resolved as the API does. */
function cardVehicle(input: DetailInput) {
  const built = buildTrainDetail(input);
  if (!built.ok) throw new Error(built.reason);
  const key = trainKeyOfDetail(built.detail);
  const rows = OBSERVATIONS.filter((row) => row.trainNumber === key.trainNumber);
  const query = {
    serviceDate: DAY,
    trainNumber: key.trainNumber ?? "",
    operatorId: key.operatorId,
  };
  const identity = resolveIdentity(key, {
    rules: RULES,
    series: SERIES,
    exact: key.trainNumber === null ? null : exactOf(rows, query),
    majority: key.trainNumber === null ? null : majorityOf(rows, query),
  });
  return {
    key,
    vehicle: {
      series: identity && identity.layer !== "L4" ? identity.seriesId : null,
      operator: key.operatorId,
      units: identity && identity.layer !== "L4" ? identity.units : null,
    },
  };
}

/** The live engine's path for the same trip, with the instance ingest recorded. */
async function engineVehicle(instance: InstanceRow | null) {
  const catalogue: FleetCatalogue = {
    rules: RULES,
    series: SERIES,
    observations: OBSERVATIONS,
    instances: new Map(
      instance
        ? [
            [
              instance.tripInstanceId,
              { operatorId: instance.operatorId, trainNumber: instance.trainNumber },
            ],
          ]
        : [],
    ),
    namedOperators: new Set(["db-regio-ag-nrw", "national-express"]),
  };
  const identities = new VehicleIdentities({ load: async () => catalogue });
  await identities.refresh(T("10:00") / 1000, [DAY]);
  identities.apply();
  return { key: runKeyOf(run, catalogue), vehicle: identities.of(run) };
}

const instance = (fields: Partial<InstanceRow>): InstanceRow => ({
  tripInstanceId: INSTANCE,
  serviceDate: DAY,
  isAdded: false,
  trainNumber: null,
  categoryCode: "sbahn",
  operatorId: null,
  ...fields,
});

describe("the live engine and the train card key a train the same way", () => {
  const cases: [
    string,
    InstanceRow | null,
    { series: string | null; operator: string | null; units: number | null },
  ][] = [
    [
      "no instance: the trip's operator and short name",
      null,
      { series: "db-422", operator: "db-regio-ag-nrw", units: 2 },
    ],
    [
      "the instance's operator and number before the trip's (number 0 included)",
      instance({ operatorId: "national-express", trainNumber: "0" }),
      { series: "stadler-flirt-3", operator: "national-express", units: 1 },
    ],
    [
      "the instance's operator with the trip's number",
      instance({ operatorId: "national-express" }),
      { series: "db-1440", operator: "national-express", units: 1 },
    ],
    [
      "an operator the catalogue has no name for keys on none",
      instance({ operatorId: "nameless", trainNumber: "0" }),
      { series: "stadler-flirt-3", operator: null, units: 1 },
    ],
  ];
  it.each(cases)("%s", async (_, fixture, expected) => {
    const card = cardVehicle(detailInput(fixture));
    const engine = await engineVehicle(fixture);
    expect(engine.key).toEqual(card.key);
    expect(card.vehicle).toEqual(expected);
    expect(engine.vehicle).toEqual(expected);
  });
});
