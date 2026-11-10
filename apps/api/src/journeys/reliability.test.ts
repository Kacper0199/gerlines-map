import { JourneyReliabilityResponse } from "@gerlines/schema/journeys";
import type { StatsRunGroup, StatsSummary, StatsTrain } from "@gerlines/schema/stats";
import { describe, expect, it } from "vitest";
import { StatsCache } from "../stats/cache.ts";
import {
  parseReliabilityQuery,
  RELIABILITY_CACHE_MS,
  type ReliabilitySource,
  readGate,
  reliabilityRange,
  StatsBusyError,
  trainReliability,
  uncachedTrains,
} from "./reliability.ts";

const NOW = Date.parse("2026-11-08T09:00:00Z");

function summary(observedArrivals: number, punctual6: number | null): StatsSummary {
  return {
    stops: observedArrivals,
    cancelled: 0,
    additional: 0,
    noData: 0,
    observed: observedArrivals,
    observedArrivals,
    punctual6,
    punctual16: punctual6,
    cancelledShare: 0,
    meanDelayS: 60,
    medianDelayS: 30,
    p90DelayS: 300,
    maxDelayS: 900,
    platformChanged: 0,
    observedCarried: 0,
    observedPropagated: 0,
  };
}

function group(
  operator: { id: string; name: string | null } | null,
  category: StatsRunGroup["category"],
  runs: number,
  observedArrivals: number,
  punctual6: number | null,
  line: string | null = null,
): StatsRunGroup {
  return {
    operator,
    category,
    line,
    runs,
    summary: summary(observedArrivals, punctual6),
    byDay: [],
    delayHistogram: [],
  };
}

const FERNVERKEHR = { id: "db-fernverkehr-ag", name: "DB Fernverkehr AG" };
const REGIO_BAYERN = { id: "db-regio-bayern", name: "DB Regio AG Bayern" };
const ARVERIO = { id: "arverio-bayern", name: "Arverio Bayern" };

function source(groups: Record<string, StatsRunGroup[]>, refreshedAt: string | null = null) {
  const calls: { number: string; from: string; to: string }[] = [];
  const reader: ReliabilitySource = {
    async train(number, _operator, range): Promise<StatsTrain> {
      calls.push({ number, from: range.from, to: range.to });
      return {
        kind: "train",
        period: { from: range.from, to: range.to, days: 30 },
        freshness: { refreshedAt, maxLagMinutes: 40, note: "lag" },
        generatedAt: new Date(NOW).toISOString(),
        number,
        operatorId: null,
        groups: groups[number] ?? [],
      };
    },
  };
  return { calls, reader };
}

describe("reliabilityRange", () => {
  it("covers the 30 Berlin service days up to today", () => {
    expect(reliabilityRange(NOW)).toEqual({ from: "2026-10-10", to: "2026-11-08" });
  });

  it("uses the Berlin day after midnight in Berlin", () => {
    expect(reliabilityRange(Date.parse("2026-11-08T23:30:00Z")).to).toBe("2026-11-09");
  });
});

describe("parseReliabilityQuery", () => {
  it("reads category, number and an optional operator per train", () => {
    expect(parseReliabilityQuery(["hsr~597~DB Fernverkehr AG", "reg~59123"])).toEqual({
      ok: true,
      trains: [
        { category: "hsr", number: "597", operator: "DB Fernverkehr AG" },
        { category: "reg", number: "59123", operator: null },
      ],
    });
  });

  it.each([
    [[]],
    [["597"]],
    [["ice~597"]],
    [["hsr~5 97"]],
    [["hsr~1234567890123"]],
    [["hsr~597~"]],
    [[`hsr~597~${"x".repeat(81)}`]],
    [Array.from({ length: 31 }, (_, i) => `reg~${i + 1}`)],
  ])("refuses %j", (values) => {
    expect(parseReliabilityQuery(values).ok).toBe(false);
  });
});

describe("trainReliability", () => {
  it("answers the punctuality of the matching category over 30 days", async () => {
    const { reader, calls } = source(
      {
        "597": [group(FERNVERKEHR, "hsr", 28, 400, 0.75)],
      },
      "2026-11-08T08:50:00.000Z",
    );
    const answer = await trainReliability(
      [{ category: "hsr", number: "597", operator: "DB Fernverkehr AG" }],
      { source: reader, now: () => NOW },
    );
    expect(JourneyReliabilityResponse.parse(answer)).toEqual({
      period: { from: "2026-10-10", to: "2026-11-08", days: 30 },
      refreshedAt: "2026-11-08T08:50:00.000Z",
      trains: [
        {
          status: "known",
          category: "hsr",
          number: "597",
          operator: "DB Fernverkehr AG",
          punctual6: 0.75,
          observedArrivals: 400,
          runs: 28,
          firstDay: null,
        },
      ],
    });
    expect(calls).toEqual([{ number: "597", from: "2026-10-10", to: "2026-11-08" }]);
  });

  it("sums the line groups of one operator and category", async () => {
    const { reader } = source({
      "597": [
        group(FERNVERKEHR, "hsr", 20, 300, 0.8, "ICE 29"),
        group(FERNVERKEHR, "hsr", 10, 100, 0.6, null),
      ],
    });
    const [train] = (
      await trainReliability([{ category: "hsr", number: "597", operator: null }], {
        source: reader,
        now: () => NOW,
      })
    ).trains;
    expect(train).toMatchObject({ status: "known", observedArrivals: 400, runs: 30 });
    expect(train?.status === "known" && train.punctual6).toBeCloseTo(0.75, 6);
  });

  it("leaves out the groups of another category with the same number", async () => {
    const { reader } = source({
      "4711": [group(FERNVERKEHR, "hsr", 5, 50, 0.9), group(REGIO_BAYERN, "reg", 30, 600, 0.95)],
    });
    const [train] = (
      await trainReliability(
        [{ category: "reg", number: "4711", operator: "DB Regio AG Bayern" }],
        {
          source: reader,
          now: () => NOW,
        },
      )
    ).trains;
    expect(train).toMatchObject({ status: "known", punctual6: 0.95, observedArrivals: 600 });
  });

  it("picks the operator the leg names when several run the number", async () => {
    const { reader } = source({
      "100": [group(ARVERIO, "reg", 30, 300, 0.7), group(REGIO_BAYERN, "reg", 30, 300, 0.9)],
    });
    const [train] = (
      await trainReliability(
        [{ category: "reg", number: "100", operator: "Arverio Bayern GmbH" }],
        {
          source: reader,
          now: () => NOW,
        },
      )
    ).trains;
    expect(train).toMatchObject({ status: "known", punctual6: 0.7 });
  });

  it("matches the leg's operator ignoring case, accents and a capital sharp s", async () => {
    const GROSSRAUM = { id: "grossraum-verkehr", name: "Großraum-Verkehr Hannover GmbH" };
    const { reader } = source({
      "100": [group(GROSSRAUM, "reg", 30, 300, 0.7), group(REGIO_BAYERN, "reg", 30, 300, 0.9)],
    });
    const [train] = (
      await trainReliability([{ category: "reg", number: "100", operator: "GROẞRAUM-VERKEHR" }], {
        source: reader,
        now: () => NOW,
      })
    ).trains;
    expect(train).toMatchObject({ status: "known", punctual6: 0.7 });
  });

  it("says ambiguous when several operators run it and the leg names none of them", async () => {
    const { reader } = source({
      "100": [group(ARVERIO, "reg", 30, 300, 0.7), group(REGIO_BAYERN, "reg", 30, 300, 0.9)],
    });
    for (const operator of [null, "Go-Ahead Bayern GmbH"]) {
      const [train] = (
        await trainReliability([{ category: "reg", number: "100", operator }], {
          source: reader,
          now: () => NOW,
        })
      ).trains;
      expect(train).toMatchObject({ status: "missing", reason: "ambiguous" });
    }
  });

  it("does not take a shared legal form or region for the operator", async () => {
    const { reader } = source({
      "100": [group(ARVERIO, "reg", 30, 300, 0.7), group(REGIO_BAYERN, "reg", 30, 300, 0.9)],
    });
    const [train] = (
      await trainReliability([{ category: "reg", number: "100", operator: "Agilis Bayern AG" }], {
        source: reader,
        now: () => NOW,
      })
    ).trains;
    expect(train).toMatchObject({ status: "missing", reason: "ambiguous" });
  });

  it("says no observations when nothing was observed, never a share of nothing", async () => {
    const { reader } = source({
      "597": [group(FERNVERKEHR, "hsr", 3, 0, null)],
    });
    const answer = await trainReliability(
      [
        { category: "hsr", number: "597", operator: null },
        { category: "hsr", number: "999", operator: null },
      ],
      { source: reader, now: () => NOW },
    );
    expect(answer.trains.map((train) => train.status === "missing" && train.reason)).toEqual([
      "no_observations",
      "no_observations",
    ]);
  });

  it("reads a zero padded DELFI trip number as the number the rollups hold", async () => {
    const { reader, calls } = source({ "1028": [group(FERNVERKEHR, "hsr", 2, 12, 10 / 12)] });
    const [train] = (
      await trainReliability(
        [
          { category: "hsr", number: "001028", operator: null },
          { category: "hsr", number: "1028", operator: null },
        ],
        { source: reader, now: () => NOW },
      )
    ).trains;
    expect(train).toMatchObject({ status: "known", number: "001028", observedArrivals: 12 });
    expect(calls.map((call) => call.number)).toEqual(["1028"]);
  });

  it("asks each number once and keeps the answers in the asked order", async () => {
    const { reader, calls } = source({
      "597": [group(FERNVERKEHR, "hsr", 28, 400, 0.75)],
      "4711": [group(REGIO_BAYERN, "reg", 30, 600, 0.95)],
    });
    const answer = await trainReliability(
      [
        { category: "reg", number: "4711", operator: null },
        { category: "hsr", number: "597", operator: null },
        { category: "reg", number: "4711", operator: null },
      ],
      { source: reader, now: () => NOW },
    );
    expect(answer.trains.map((train) => train.number)).toEqual(["4711", "597", "4711"]);
    expect(calls.map((call) => call.number).sort()).toEqual(["4711", "597"]);
  });

  it("serves a number from the cache within its time and asks again after it", async () => {
    const { reader, calls } = source({ "597": [group(FERNVERKEHR, "hsr", 28, 400, 0.75)] });
    let now = NOW;
    const cache = new StatsCache({ now: () => now });
    const ask = () =>
      trainReliability([{ category: "hsr", number: "597", operator: null }], {
        source: reader,
        now: () => now,
        cache,
      });
    await ask();
    now += RELIABILITY_CACHE_MS - 1;
    await ask();
    expect(calls).toHaveLength(1);
    now += 2;
    await ask();
    expect(calls).toHaveLength(2);
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const cache = new StatsCache();
    const reader: ReliabilitySource = {
      async train(number, operatorId, range) {
        if (fail) throw new Error("db down");
        return source({ "597": [group(FERNVERKEHR, "hsr", 1, 10, 1)] }).reader.train(
          number,
          operatorId,
          range,
        );
      },
    };
    const ask = () =>
      trainReliability([{ category: "hsr", number: "597", operator: null }], {
        source: reader,
        now: () => NOW,
        cache,
      });
    await expect(ask()).rejects.toThrow("db down");
    fail = false;
    expect((await ask()).trains[0]?.status).toBe("known");
  });

  it("leaves out a group without a punctuality share instead of counting it as late", async () => {
    const { reader } = source({
      "597": [group(FERNVERKEHR, "hsr", 10, 100, null), group(FERNVERKEHR, "hsr", 20, 300, 0.8)],
      "598": [group(FERNVERKEHR, "hsr", 10, 100, null)],
    });
    const answer = await trainReliability(
      [
        { category: "hsr", number: "597", operator: null },
        { category: "hsr", number: "598", operator: null },
      ],
      { source: reader, now: () => NOW },
    );
    expect(answer.trains[0]).toMatchObject({
      status: "known",
      punctual6: 0.8,
      observedArrivals: 300,
      runs: 20,
    });
    expect(answer.trains[1]).toMatchObject({ status: "missing", reason: "no_observations" });
  });

  it("names the first day with an observed arrival, so a short record never reads as 30 days", async () => {
    const days = (list: [string, number][]) =>
      list.map(([day, observedArrivals]) => ({
        day,
        runs: 1,
        stops: observedArrivals,
        cancelled: 0,
        observedArrivals,
        punctual6: 1,
        punctual16: 1,
        meanDelayS: 0,
      }));
    const first = group(FERNVERKEHR, "hsr", 2, 8, 1);
    const second = group(FERNVERKEHR, "hsr", 1, 4, 1, "ICE 42");
    const { reader } = source({
      "597": [
        {
          ...first,
          byDay: days([
            ["2026-10-28", 4],
            ["2026-10-27", 4],
            ["2026-10-25", 0],
          ]),
        },
        { ...second, byDay: days([["2026-10-26", 4]]) },
      ],
    });
    const answer = await trainReliability([{ category: "hsr", number: "597", operator: null }], {
      source: reader,
      now: () => NOW,
    });
    expect(answer.trains[0]).toMatchObject({ status: "known", firstDay: "2026-10-26", runs: 3 });
  });

  it("shares one read between requests that ask for the same number at once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { reader, calls } = source({ "597": [group(FERNVERKEHR, "hsr", 28, 400, 0.75)] });
    const slow: ReliabilitySource = {
      async train(number, operatorId, range) {
        await gate;
        return reader.train(number, operatorId, range);
      },
    };
    const cache = new StatsCache();
    const ask = () =>
      trainReliability([{ category: "hsr", number: "597", operator: null }], {
        source: slow,
        now: () => NOW,
        cache,
      });
    const both = Promise.all([ask(), ask()]);
    release();
    const [one, two] = await both;
    expect(calls).toHaveLength(1);
    expect(one).toEqual(two);
  });

  it("keeps a bounded number of train numbers, the oldest out first", async () => {
    const { reader, calls } = source({});
    const cache = new StatsCache({ maxEntries: 2 });
    const ask = (number: string) =>
      trainReliability([{ category: "hsr", number, operator: null }], {
        source: reader,
        now: () => NOW,
        cache,
      });
    for (const number of ["1", "2", "3"]) await ask(number);
    expect(cache.size).toBe(2);
    await ask("1");
    expect(calls.map((call) => call.number)).toEqual(["1", "2", "3", "1"]);
  });

  it("refuses with StatsBusyError when the process-wide reads are taken, and keeps nothing", async () => {
    const { reader, calls } = source({ "597": [group(FERNVERKEHR, "hsr", 28, 400, 0.75)] });
    const reads = readGate(1);
    expect(reads.tryEnter()).toBe(true);
    const cache = new StatsCache();
    const ask = () =>
      trainReliability([{ category: "hsr", number: "597", operator: null }], {
        source: reader,
        now: () => NOW,
        cache,
        reads,
      });
    await expect(ask()).rejects.toBeInstanceOf(StatsBusyError);
    expect(calls).toHaveLength(0);
    reads.leave();
    expect((await ask()).trains[0]?.status).toBe("known");
    expect(reads.inFlight()).toBe(0);
  });

  it("holds at most three of the six statistics queries for one request", async () => {
    const { reader } = source({});
    const reads = readGate(6);
    let peak = 0;
    const slow: ReliabilitySource = {
      async train(number, operator, range) {
        peak = Math.max(peak, reads.inFlight());
        await new Promise((resolve) => setImmediate(resolve));
        return reader.train(number, operator, range);
      },
    };
    const keys = ["1", "2", "3", "4", "5", "6"].map((number) => ({
      category: "reg" as const,
      number,
      operator: null,
    }));
    const answer = await trainReliability(keys, { source: slow, now: () => NOW, reads });
    expect(answer.trains).toHaveLength(6);
    expect(peak).toBe(3);
    expect(reads.inFlight()).toBe(0);
  });

  it("counts the numbers a request would read, padded numbers as one", async () => {
    const { reader } = source({});
    const cache = new StatsCache();
    await trainReliability([{ category: "hsr", number: "597", operator: null }], {
      source: reader,
      now: () => NOW,
      cache,
    });
    const asked = [
      { category: "hsr", number: "000597", operator: null },
      { category: "hsr", number: "598", operator: null },
      { category: "reg", number: "0598", operator: null },
      { category: "reg", number: "4711", operator: null },
    ] as const;
    expect(uncachedTrains(asked, cache, NOW)).toBe(2);
  });
});
