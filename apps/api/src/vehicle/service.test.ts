import type { FormationObservation, TrainDetail } from "@gerlines/schema";
import type { ExactFormation, FleetRuleRow, Majority } from "@gerlines/schema/vehicle-resolver";
import { describe, expect, it } from "vitest";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import type { CatalogueSeries, CatalogueSource, IdentityStore } from "./repository.ts";
import { IDENTITY_CACHE_MS, SEQUENCE_SHARE_PER_HOUR, VehicleIdentityService } from "./service.ts";
import { sequenceUrl, VehicleSequenceClient } from "./vehicle-sequence.ts";

const ANSWER = {
  sequenceStatus: "MATCHES_SCHEDULE",
  groups: [
    {
      name: "ICE9479",
      transport: { category: "ICE" },
      vehicles: [
        { vehicleID: "938024128796", platformPosition: { start: 10, end: 38 } },
        { vehicleID: "938058120792", platformPosition: { start: 38, end: 66 } },
      ],
    },
  ],
};

const RULES: FleetRuleRow[] = [
  {
    ruleId: "ice-line-3",
    scope: "line",
    operatorId: "db-fernverkehr-ag",
    categoryCode: "hsr",
    lineKeys: ["3"],
    seriesIds: ["db-401", "db-402"],
    modelId: null,
    modelName: null,
    units: null,
    fleetCount: null,
    fleetTotal: null,
    validFrom: "2025-12-14",
    validTo: "2026-12-12",
    sourceId: "wikipedia-de-ice-linien",
  },
];

const SERIES: CatalogueSeries[] = [
  { seriesId: "db-401", name: "ICE 1", br: "401", unitLengthMetres: 358 },
  { seriesId: "db-402", name: "ICE 2", br: "402", unitLengthMetres: 205.4 },
  { seriesId: "db-412", name: "ICE 4", br: "412", unitLengthMetres: 346 },
];

const SOURCES: CatalogueSource[] = [
  {
    sourceId: "wikipedia-de-ice-linien",
    name: "Wikipedia (de), Liste der Intercity-Express-Linien",
  },
  {
    sourceId: "bahn-vehicle-sequence",
    name: "bahn.de vehicle sequence (Wagenreihung), unofficial",
  },
];

class FakeStore implements IdentityStore {
  saved: FormationObservation[] = [];
  majorityRow: Majority | null = null;
  sourceRows: CatalogueSource[] = SOURCES;
  async rules() {
    return RULES;
  }
  async sources() {
    return this.sourceRows;
  }
  async series() {
    return SERIES;
  }
  async exact(serviceDate: string, trainNumber: string): Promise<ExactFormation | null> {
    const row = this.saved.find(
      (o) => o.serviceDate === serviceDate && o.trainNumber === trainNumber,
    );
    return row ? { ...row } : null;
  }
  async majority() {
    return this.majorityRow;
  }
  async evaOf() {
    return 8000284;
  }
  async save(observation: FormationObservation) {
    this.saved.push(observation);
  }
}

const DETAIL = {
  serviceDate: "2026-11-07",
  category: "hsr",
  productName: "ICE",
  line: "3",
  trainNumber: "586",
  operator: { id: "db-fernverkehr-ag", name: "DB Fernverkehr", wikidataQid: null },
  stops: [
    {
      stopPlaceId: "6f1c3c43-7a0c-5b7e-9f43-0a3c2b1d4e5f",
      scheduledDeparture: "2026-11-07T15:32:00.000Z",
    },
  ],
  vehicle: null,
} as unknown as TrainDetail;

function fakeFetch(status: number, body: unknown = ANSWER) {
  const seen: { url: string; userAgent: string | null }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url, userAgent: new Headers(init?.headers).get("User-Agent") });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

function client(fetcher: typeof fetch, clock = { t: 0 }) {
  return new VehicleSequenceClient({
    userAgent: "gerlines-test/0.0.0 (+https://example.org)",
    fetch: fetcher,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    minIntervalMs: 3_000,
  });
}

const QUERY = {
  category: "ICE",
  trainNumber: "586",
  serviceDate: "2026-11-07",
  eva: 8000284,
  departure: "2026-11-07T15:32:00.000Z",
};

describe("VehicleSequenceClient", () => {
  it("asks once per train and day with the project user agent", async () => {
    const { fetcher, seen } = fakeFetch(200);
    const sequence = client(fetcher);
    const [first, second] = await Promise.all([sequence.get(QUERY), sequence.get(QUERY)]);
    expect(first.status).toBe("ok");
    expect(second).toBe(first);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.userAgent).toBe("gerlines-test/0.0.0 (+https://example.org)");
    expect(seen[0]?.url).toBe(sequenceUrl(QUERY));
    expect(seen[0]?.url).toContain("evaNumber=8000284&number=586");
  });

  it("keeps the interval between calls and stops after a 429", async () => {
    const clock = { t: 0 };
    let status = 200;
    const calls: number[] = [];
    const fetcher = (async () => {
      calls.push(clock.t);
      return new Response(JSON.stringify(ANSWER), { status });
    }) as unknown as typeof fetch;
    const sequence = client(fetcher, clock);
    await sequence.get(QUERY);
    status = 429;
    expect((await sequence.get({ ...QUERY, trainNumber: "587" })).status).toBe("blocked");
    expect((await sequence.get({ ...QUERY, trainNumber: "588" })).status).toBe("blocked");
    expect(calls).toEqual([0, 3_000]);
    expect(sequence.blocked).toBe(true);
  });

  it("answers missing for 404 and failed for an unexpected structure", async () => {
    expect((await client(fakeFetch(404).fetcher).get(QUERY)).status).toBe("missing");
    expect((await client(fakeFetch(200, { nope: 1 }).fetcher).get(QUERY)).status).toBe("failed");
  });
});

describe("VehicleIdentityService", () => {
  it("answers from the rules first and shows the exact formation once it is stored", async () => {
    const store = new FakeStore();
    const { fetcher } = fakeFetch(200);
    const service = new VehicleIdentityService({
      store,
      sequence: client(fetcher),
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    const first = await service.resolve(DETAIL, (work) => pending.push(work));
    expect(first).toMatchObject({ layer: "L2", seriesId: "db-401" });
    await Promise.all(pending);
    expect(store.saved[0]).toMatchObject({
      seriesId: "db-412",
      units: 1,
      cars: 2,
      lengthMetres: 56,
      trainNumber: "586",
    });
    expect(await service.identify(DETAIL)).toEqual({
      seriesId: "db-412",
      seriesName: "ICE 4",
      br: "412",
      variant: null,
      units: 1,
      cars: 2,
      lengthMetres: 56,
      layer: "L0",
      confidence: 0.97,
      source: "bahn-vehicle-sequence",
      sourceName: "bahn.de vehicle sequence (Wagenreihung), unofficial",
    });
  });

  it("names the source by its catalogue display name and gives null, never the id, when the catalogue has none", async () => {
    const store = new FakeStore();
    const service = new VehicleIdentityService({ store, logger: { error: () => {} } });
    expect(await service.identify(DETAIL)).toMatchObject({
      layer: "L2",
      source: "wikipedia-de-ice-linien",
      sourceName: "Wikipedia (de), Liste der Intercity-Express-Linien",
    });
    store.sourceRows = [];
    const unnamed = new VehicleIdentityService({ store, logger: { error: () => {} } });
    expect(await unnamed.identify(DETAIL)).toMatchObject({
      source: "wikipedia-de-ice-linien",
      sourceName: null,
    });
  });

  it("never asks bahn.de for operators outside DB or without a sequence source", async () => {
    const store = new FakeStore();
    const { fetcher, seen } = fakeFetch(200);
    const service = new VehicleIdentityService({
      store,
      sequence: client(fetcher),
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    const other = {
      ...DETAIL,
      operator: { id: "hessische-landesbahn-gmbh", name: "HLB", wikidataQid: null },
    } as TrainDetail;
    await service.resolve(other, (work) => pending.push(work));
    expect(pending).toHaveLength(0);
    expect(seen).toHaveLength(0);
    const without = new VehicleIdentityService({ store, logger: { error: () => {} } });
    expect(await without.identify(DETAIL)).toMatchObject({ layer: "L2" });
  });
});

describe("VehicleIdentityService catalogue failures", () => {
  it("rejects overlapping requests while the database is down at the first load", async () => {
    const store = new FakeStore();
    store.rules = () => new Promise((_, reject) => setTimeout(() => reject(new Error("down")), 20));
    const service = new VehicleIdentityService({ store, logger: { error: () => {} } });
    const outcomes = await Promise.allSettled([service.identify(DETAIL), service.identify(DETAIL)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("still identifies, without source names, when the source names cannot be read", async () => {
    const store = new FakeStore();
    store.sources = async () => {
      throw new Error("down");
    };
    const lines: string[] = [];
    const service = new VehicleIdentityService({
      store,
      logger: { error: (line) => lines.push(line) },
    });
    expect(await service.identify(DETAIL)).toMatchObject({
      layer: "L2",
      source: "wikipedia-de-ice-linien",
      sourceName: null,
    });
    expect(lines).toEqual(["vehicle source names failed: Error"]);
  });

  it("keeps the old catalogue and logs when a refresh fails", async () => {
    const clock = { t: 0 };
    const store = new FakeStore();
    const lines: string[] = [];
    const service = new VehicleIdentityService({
      store,
      logger: { error: (line) => lines.push(line) },
      now: () => clock.t,
      catalogueTtlMs: 1_000,
    });
    expect(await service.identify(DETAIL)).toMatchObject({ layer: "L2" });
    store.rules = async () => {
      throw new Error("down");
    };
    clock.t = 5_000;
    expect(await service.identify(DETAIL)).toMatchObject({ layer: "L2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await service.identify(DETAIL)).toMatchObject({ layer: "L2" });
    expect(lines).toEqual(["vehicle catalogue refresh failed: Error"]);
  });
});

describe("VehicleIdentityService identity cache", () => {
  it("asks the database once per train and day within the detail lifetime", async () => {
    const clock = { t: 0 };
    const store = new FakeStore();
    let reads = 0;
    const exact = store.exact.bind(store);
    store.exact = (day, number) => {
      reads += 1;
      return exact(day, number);
    };
    const service = new VehicleIdentityService({
      store,
      logger: { error: () => {} },
      now: () => clock.t,
    });
    await Promise.all([service.identify(DETAIL), service.identify(DETAIL)]);
    clock.t = IDENTITY_CACHE_MS - 1;
    await service.identify(DETAIL);
    expect(reads).toBe(1);
    await service.identify({ ...DETAIL, trainNumber: "587" } as TrainDetail);
    expect(reads).toBe(2);
    clock.t = IDENTITY_CACHE_MS + 1;
    await service.identify(DETAIL);
    expect(reads).toBe(3);
  });

  it("does not keep a failed answer", async () => {
    const store = new FakeStore();
    let fail = true;
    const majority = store.majority.bind(store);
    store.majority = async () => {
      if (fail) throw new Error("down");
      return majority();
    };
    const service = new VehicleIdentityService({ store, logger: { error: () => {} } });
    await expect(service.identify(DETAIL)).rejects.toThrow("down");
    fail = false;
    expect(await service.identify(DETAIL)).toMatchObject({ layer: "L2" });
  });
});

describe("VehicleIdentityService coach sequence load", () => {
  it("looks up the origin and asks bahn.de once per train and day, however many reads", async () => {
    const store = new FakeStore();
    let lookups = 0;
    store.evaOf = async () => {
      lookups += 1;
      return 8000284;
    };
    const { fetcher, seen } = fakeFetch(404);
    const service = new VehicleIdentityService({
      store,
      sequence: client(fetcher),
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    await Promise.all([1, 2, 3].map(() => service.resolve(DETAIL, (work) => pending.push(work))));
    await Promise.all(pending);
    await service.resolve(DETAIL, (work) => pending.push(work));
    expect(pending).toHaveLength(1);
    expect(lookups).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("gives each client a share of the hourly bahn.de budget, so one client cannot use it up", async () => {
    expect(SEQUENCE_SHARE_PER_HOUR).toBe(30);
    const { fetcher, seen } = fakeFetch(404);
    const service = new VehicleIdentityService({
      store: new FakeStore(),
      sequence: client(fetcher),
      sequenceShare: fixedWindowLimiter({ limit: 2, windowMs: 3_600_000, now: () => 0 }),
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    const train = (trainNumber: string) => ({ ...DETAIL, trainNumber }) as TrainDetail;
    for (const number of ["586", "587", "588", "589"]) {
      await service.resolve(train(number), (work) => pending.push(work), "203.0.113.1");
    }
    await service.resolve(train("590"), (work) => pending.push(work), "203.0.113.2");
    await service.resolve(train("591"), (work) => pending.push(work));
    await Promise.all(pending);
    expect(seen.map((call) => new URL(call.url).searchParams.get("number"))).toEqual([
      "586",
      "587",
      "590",
      "591",
    ]);
  });

  it("charges the share of every /64 of one /48 together, so a home /56 cannot multiply it", async () => {
    const { fetcher, seen } = fakeFetch(404);
    const service = new VehicleIdentityService({
      store: new FakeStore(),
      sequence: client(fetcher),
      sequenceShare: fixedWindowLimiter({ limit: 2, windowMs: 3_600_000, now: () => 0 }),
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    const train = (trainNumber: string) => ({ ...DETAIL, trainNumber }) as TrainDetail;
    const home = ["2001:db8:1:10::/64", "2001:db8:1:11::/64", "2001:db8:1:12::/64"];
    for (const [index, key] of home.entries()) {
      await service.resolve(train(String(600 + index)), (work) => pending.push(work), key);
    }
    await service.resolve(train("700"), (work) => pending.push(work), "2001:db8:2:10::/64");
    await Promise.all(pending);
    expect(seen.map((call) => new URL(call.url).searchParams.get("number"))).toEqual([
      "600",
      "601",
      "700",
    ]);
  });

  it("charges a client's share only for a train it actually queues", async () => {
    const { fetcher, seen } = fakeFetch(404);
    const service = new VehicleIdentityService({
      store: new FakeStore(),
      sequence: client(fetcher),
      sequenceShare: fixedWindowLimiter({ limit: 1, windowMs: 3_600_000, now: () => 0 }),
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    const outside = { ...DETAIL, operator: { id: "erixx", name: "erixx", wikidataQid: null } };
    await service.resolve(outside as TrainDetail, (work) => pending.push(work), "203.0.113.1");
    await service.resolve(DETAIL, (work) => pending.push(work), "203.0.113.1");
    await Promise.all(pending);
    await service.resolve(DETAIL, (work) => pending.push(work), "203.0.113.1");
    expect(seen).toHaveLength(1);
  });

  it("asks again after a busy answer once the hourly budget has room", async () => {
    const clock = { t: 0 };
    const { fetcher, seen } = fakeFetch(200);
    const sequence = new VehicleSequenceClient({
      userAgent: "gerlines-test/0.0.0 (+https://example.org)",
      fetch: fetcher,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      minIntervalMs: 3_000,
      maxCallsPerHour: 1,
    });
    await sequence.get({ ...QUERY, trainNumber: "999" });
    const store = new FakeStore();
    const service = new VehicleIdentityService({
      store,
      sequence,
      now: () => clock.t,
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    await service.resolve(DETAIL, (work) => pending.push(work));
    await Promise.all(pending);
    expect(seen).toHaveLength(1);
    clock.t += 3_600_000;
    await service.resolve(DETAIL, (work) => pending.push(work));
    await Promise.all(pending);
    expect(pending).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(store.saved).toHaveLength(1);
  });

  it("asks again after a failed answer once its backoff has passed", async () => {
    const clock = { t: 0 };
    const { fetcher, seen } = fakeFetch(500);
    const service = new VehicleIdentityService({
      store: new FakeStore(),
      sequence: client(fetcher, clock),
      now: () => clock.t,
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    await service.resolve(DETAIL, (work) => pending.push(work));
    await Promise.all(pending);
    await service.resolve(DETAIL, (work) => pending.push(work));
    expect(seen).toHaveLength(1);
    clock.t += 300_000;
    await service.resolve(DETAIL, (work) => pending.push(work));
    await Promise.all(pending);
    expect(seen).toHaveLength(2);
  });

  it("keeps no train in flight once its calls have settled", async () => {
    const { fetcher } = fakeFetch(404);
    const service = new VehicleIdentityService({
      store: new FakeStore(),
      sequence: client(fetcher),
      logger: { error: () => {} },
    });
    const pending: Promise<void>[] = [];
    const inFlight = (service as unknown as { observing: Set<string> }).observing;
    await Promise.all(
      ["586", "587", "588"].map((trainNumber) =>
        service.resolve({ ...DETAIL, trainNumber }, (work) => pending.push(work)),
      ),
    );
    expect(inFlight.size).toBe(3);
    await Promise.all(pending);
    expect(inFlight.size).toBe(0);
  });

  it("stores no formation outside the table's ranges", async () => {
    const store = new FakeStore();
    const lines: string[] = [];
    const group = ANSWER.groups[0];
    const long = {
      ...ANSWER,
      groups: Array.from({ length: 9 }, (_, i) => ({ ...group, name: `ICE${i}` })),
    };
    const service = new VehicleIdentityService({
      store,
      sequence: client(fakeFetch(200, long).fetcher),
      logger: { error: (line) => lines.push(line) },
    });
    const pending: Promise<void>[] = [];
    await service.resolve(DETAIL, (work) => pending.push(work));
    await Promise.all(pending);
    expect(store.saved).toHaveLength(0);
    expect(lines).toEqual(["vehicle sequence for 586 out of range, not stored"]);
  });
});
