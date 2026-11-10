import {
  STATS_LAG_NOTE,
  StatsLand,
  StatsLine,
  StatsNetwork,
  StatsStation,
  StatsTrain,
} from "@gerlines/schema/stats";
import { describe, expect, it } from "vitest";
import { STATS_READ_QUERIES } from "./reads.ts";
import { daysIn, STATS_MAX_RUN_GROUPS, StatsService } from "./service.ts";
import { GoldenReader, STATION_A, totals } from "./test-data.ts";

const NOW = Date.parse("2026-11-07T14:30:00Z");
const range = { from: "2026-11-06", to: "2026-11-07" };

const network = new GoldenReader({
  "land_category_day:germany/": [
    {
      key: {},
      ...totals(
        {
          n_stops: 100,
          n_cancelled: 4,
          n_observed: 90,
          n_observed_arr: 80,
          n_lt_6min_arr: 70,
          n_lt_16min_arr: 78,
          sum_delay_s: 9000,
          max_delay_s: 3000,
        },
        { 2: 50, 3: 20, 9: 20 },
      ),
    },
  ],
  "land_category_day:germany/category_code": [
    {
      key: { category_code: "hsr" },
      ...totals({ n_stops: 10, n_observed_arr: 8, n_lt_6min_arr: 5 }),
    },
    {
      key: { category_code: "reg" },
      ...totals({ n_stops: 88, n_observed_arr: 72, n_lt_6min_arr: 65 }),
    },
    { key: { category_code: null }, ...totals({ n_stops: 2 }) },
  ],
  "land_category_day:germany/day": [
    {
      key: { day: "2026-11-06" },
      ...totals({ n_stops: 60, n_observed_arr: 50, n_lt_6min_arr: 45 }),
    },
    {
      key: { day: "2026-11-07" },
      ...totals({ n_stops: 40, n_observed_arr: 30, n_lt_6min_arr: 25 }),
    },
  ],
  "land_category_day/land_code": [
    {
      key: { land_code: "DE-BY" },
      ...totals({ n_stops: 70, n_observed_arr: 60, n_lt_6min_arr: 55 }),
    },
    {
      key: { land_code: "DE-NW" },
      ...totals({ n_stops: 30, n_observed_arr: 20, n_lt_6min_arr: 15 }),
    },
    { key: { land_code: "foreign" }, ...totals({ n_stops: 12 }) },
    { key: { land_code: null }, ...totals({ n_stops: 3 }) },
  ],
  "land_category_hour:germany/local_hour": [
    { key: { local_hour: 7 }, ...totals({ n_stops: 100, n_observed_arr: 80, n_lt_6min_arr: 70 }) },
    { key: { local_hour: null }, ...totals({ n_stops: 1 }) },
  ],
});

describe("StatsService.network", () => {
  it("answers Germany from the Land views and counts stops abroad and without a Land apart", async () => {
    const body = await new StatsService(network, () => NOW).network({
      ...range,
      categories: ["hsr", "reg"],
    });
    expect(StatsNetwork.parse(body)).toEqual(body);
    expect(body.period).toEqual({ from: "2026-11-06", to: "2026-11-07", days: 2 });
    expect(body.freshness).toEqual({
      refreshedAt: "2026-11-07T14:05:00.000Z",
      maxLagMinutes: 40,
      note: STATS_LAG_NOTE,
    });
    expect(body.generatedAt).toBe("2026-11-07T14:30:00.000Z");
    expect(body.summary.punctual6).toBe(0.875);
    expect(body.summary.punctual16).toBe(0.975);
    expect(body.summary.meanDelayS).toBe(100);
    expect(body.summary.medianDelayS).toBe(0);
    expect(body.byCategory.map((row) => [row.category, row.summary.stops])).toEqual([
      ["hsr", 10],
      ["reg", 88],
      [null, 2],
    ]);
    expect(body.byDay.map((day) => [day.day, day.punctual6])).toEqual([
      ["2026-11-06", 0.9],
      ["2026-11-07", 0.8333],
    ]);
    expect(body.byLand.map((land) => [land.landCode, land.name, land.summary.stops])).toEqual([
      ["DE-BY", "Bayern", 70],
      ["DE-NW", "Nordrhein-Westfalen", 30],
    ]);
    expect(body.byHour).toHaveLength(1);
    expect(body.outsideGermany).toEqual({ foreignStops: 12, unassignedStops: 3 });
    expect(network.calls.every((call) => call.filter.categories?.join() === "hsr,reg")).toBe(true);
    expect(new Set(network.calls.map((call) => call.source))).toEqual(
      new Set(["land_category_day", "land_category_hour"]),
    );
    const histogramGroupings = network.calls
      .filter((call) => call.histogram)
      .map((call) => call.groupBy.join(","));
    expect(histogramGroupings.sort()).toEqual(["", "category_code", "land_code"]);
  });

  it("reads the histogram only where a summary needs it, never by day or hour", async () => {
    const reader = new GoldenReader({});
    const service = new StatsService(reader, () => NOW);
    await service.network(range);
    await service.land("DE-BY", range);
    await service.station(STATION_A, range);
    await service.train("1001", null, range);
    const withHistogram = reader.calls.filter((call) => call.histogram);
    expect(withHistogram.length).toBeGreaterThan(0);
    expect(
      withHistogram.some(
        (call) => call.groupBy.includes("day") || call.groupBy.includes("local_hour"),
      ),
    ).toBe(false);
  });

  it("answers zeros and missing shares when no rollup row matches", async () => {
    const body = await new StatsService(new GoldenReader({}), () => NOW).network(range);
    expect(body.summary.stops).toBe(0);
    expect(body.summary.punctual6).toBeNull();
    expect(body.byDay).toEqual([]);
    expect(body.categories).toBeNull();
  });
});

describe("StatsService.station and land", () => {
  const reader = new GoldenReader({
    "station_day/": [
      {
        key: {},
        ...totals({
          n_stops: 5,
          n_observed_arr: 4,
          n_lt_6min_arr: 2,
          n_dep_observed: 4,
          n_dep_lt_6min: 3,
        }),
      },
    ],
    "station_day/operator_id": [
      { key: { operator_id: "db-fernverkehr-ag" }, ...totals({ n_stops: 3 }) },
      { key: { operator_id: "unknown-op" }, ...totals({ n_stops: 2 }) },
    ],
    "station_hour/local_hour": [{ key: { local_hour: 23 }, ...totals({ n_stops: 5 }) }],
    "land_category_day:DE-BY/": [{ key: {}, ...totals({ n_stops: 70 }) }],
  });

  it("names the station and its operators and reports departures apart", async () => {
    const body = await new StatsService(reader, () => NOW).station(STATION_A, range);
    expect(body && StatsStation.parse(body)).toEqual(body);
    expect(body?.station).toEqual({ id: STATION_A, name: "Köln Hbf", landCode: "DE-NW" });
    expect(body?.departures).toEqual({ observed: 4, punctual6: 0.75 });
    expect(body?.byOperator.map((row) => row.operator)).toEqual([
      { id: "db-fernverkehr-ag", name: "DB Fernverkehr AG" },
      { id: "unknown-op", name: null },
    ]);
    expect(body?.byHour.map((hour) => hour.hour)).toEqual([23]);
    expect(
      reader.calls
        .filter((call) => call.source.startsWith("station"))
        .every((call) => call.filter.stopPlaceId === STATION_A),
    ).toBe(true);
  });

  it("answers null for an unknown station", async () => {
    expect(
      await new StatsService(reader, () => NOW).station(
        "00000000-0000-4000-8000-000000000000",
        range,
      ),
    ).toBeNull();
  });

  it("reads a Land from its own rows of the Land views", async () => {
    const body = await new StatsService(reader, () => NOW).land("DE-BY", range);
    expect(StatsLand.parse(body)).toEqual(body);
    expect(body.land).toEqual({ code: "DE-BY", name: "Bayern" });
    expect(body.summary.stops).toBe(70);
  });
});

describe("StatsService.train and line", () => {
  const groupKey = { operator_id: "db-fernverkehr-ag", category_code: "hsr", line_name: null };
  const reader = new GoldenReader({
    "train_day/operator_id,category_code,line_name": [
      {
        key: groupKey,
        ...totals({ n_runs: 2, n_stops: 24, n_observed_arr: 22, n_lt_6min_arr: 11 }),
      },
      {
        key: { operator_id: "oebb", category_code: "hsr", line_name: "RJX" },
        ...totals({ n_runs: 1, n_stops: 9 }),
      },
    ],
    "train_day/operator_id,category_code,line_name,day": [
      { key: { ...groupKey, day: "2026-11-06" }, ...totals({ n_runs: 1, n_stops: 12 }) },
      { key: { ...groupKey, day: "2026-11-07" }, ...totals({ n_runs: 1, n_stops: 12 }) },
      {
        key: { operator_id: "oebb", category_code: "hsr", line_name: "RJX", day: "2026-11-07" },
        ...totals({ n_runs: 1, n_stops: 9 }),
      },
    ],
    "line_day/operator_id,category_code,line_name": [
      {
        key: { operator_id: "db-regio-ag-nrw", category_code: "rfast", line_name: "RE5" },
        ...totals({ n_runs: 40 }),
      },
    ],
  });

  it("splits one train number per operator, category and line with days and runs", async () => {
    const body = await new StatsService(reader, () => NOW).train("1001", null, range);
    expect(StatsTrain.parse(body)).toEqual(body);
    expect(
      body.groups.map((group) => [group.operator?.id, group.line, group.runs, group.byDay.length]),
    ).toEqual([
      ["db-fernverkehr-ag", null, 2, 2],
      ["oebb", "RJX", 1, 1],
    ]);
    expect(body.groups[0]?.summary.punctual6).toBe(0.5);
    expect(body.groups[0]?.byDay.map((day) => day.runs)).toEqual([1, 1]);
  });

  it("passes the operator filter and the line name to the line rollup", async () => {
    const body = await new StatsService(reader, () => NOW).line("RE5", "db-regio-ag-nrw", range);
    expect(StatsLine.parse(body)).toEqual(body);
    expect(body.groups[0]?.runs).toBe(40);
    const call = reader.calls.find((entry) => entry.source === "line_day");
    expect(call?.filter).toMatchObject({ lineName: "RE5", operatorId: "db-regio-ag-nrw" });
  });

  it("keeps the busiest run groups up to the cap", async () => {
    const many = Array.from({ length: STATS_MAX_RUN_GROUPS + 5 }, (_, index) => ({
      key: { operator_id: `op-${index}`, category_code: "bus", line_name: "1" },
      ...totals({ n_stops: index + 1 }),
    }));
    const body = await new StatsService(
      new GoldenReader({ "line_day/operator_id,category_code,line_name": many }),
      () => NOW,
    ).line("1", null, range);
    expect(body.groups).toHaveLength(STATS_MAX_RUN_GROUPS);
    expect(body.groups[0]?.summary.stops).toBe(STATS_MAX_RUN_GROUPS + 5);
    expect(body.groups.at(-1)?.summary.stops).toBe(6);
  });

  it("asks the database for the busiest run groups and the days of those groups only", async () => {
    reader.calls.length = 0;
    const body = await new StatsService(reader, () => NOW).train("1001", null, range);
    const dimensions = ["operator_id", "category_code", "line_name"];
    const ranked = reader.calls.find((call) => call.groupBy.join() === dimensions.join());
    const days = reader.calls.find((call) => call.groupBy.join() === [...dimensions, "day"].join());
    expect(ranked?.limit).toBe(STATS_MAX_RUN_GROUPS);
    expect(days?.filter.top).toEqual({ by: dimensions, limit: STATS_MAX_RUN_GROUPS });
    expect(body.groups[0]?.byDay.length).toBeGreaterThan(0);
  });

  it("keeps every group and its days when there are fewer groups than the cap", async () => {
    const few = Array.from({ length: 3 }, (_, index) => ({
      key: { operator_id: `op-${index}`, category_code: "bus", line_name: "1" },
      ...totals({ n_stops: index + 1, n_runs: 1 }),
    }));
    const days = few.map((row) => ({
      key: { ...row.key, day: "2026-11-01" },
      ...totals({ n_stops: row.n_stops, n_runs: 1 }),
    }));
    const body = await new StatsService(
      new GoldenReader({
        "line_day/operator_id,category_code,line_name": few,
        "line_day/operator_id,category_code,line_name,day": days,
      }),
      () => NOW,
    ).line("1", null, range);
    expect(body.groups.map((group) => [group.operator?.id, group.summary.stops])).toEqual([
      ["op-2", 3],
      ["op-1", 2],
      ["op-0", 1],
    ]);
    expect(body.groups.map((group) => group.byDay.map((day) => day.stops))).toEqual([
      [3],
      [2],
      [1],
    ]);
  });

  it("counts periods inclusively", () => {
    expect(daysIn("2026-11-07", "2026-11-07")).toBe(1);
    expect(daysIn("2026-03-28", "2026-03-30")).toBe(3);
    expect(daysIn("2025-01-01", "2025-12-31")).toBe(365);
  });
});

describe("STATS_READ_QUERIES", () => {
  const counted = () => {
    const reader = new GoldenReader({});
    let running = 0;
    let peak = 0;
    const counting = new Proxy(reader, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          running += 1;
          peak = Math.max(peak, running);
          try {
            await new Promise((resolve) => setImmediate(resolve));
            return await value.apply(target, args);
          } finally {
            running -= 1;
          }
        };
      },
    });
    const service = new StatsService(counting, () => NOW);
    return { service, peak: () => peak };
  };

  it.each([
    ["network", (stats: StatsService) => stats.network(range)],
    ["land", (stats: StatsService) => stats.land("DE-BY", range)],
    ["station", (stats: StatsService) => stats.station(STATION_A, range)],
    ["train", (stats: StatsService) => stats.train("596", null, range)],
    ["line", (stats: StatsService) => stats.line("RE 5", null, range)],
    ["segments", (stats: StatsService) => stats.trainSegments("596", null, range)],
  ] as const)("names the most queries a %s read runs at once", async (kind, read) => {
    const { service, peak } = counted();
    await read(service);
    expect(peak()).toBe(STATS_READ_QUERIES[kind]);
  });
});
