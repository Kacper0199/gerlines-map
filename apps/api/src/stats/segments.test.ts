import type { SegmentLegTotals, SegmentRow } from "@gerlines/db";
import {
  STATS_GAIN_BINS,
  STATS_MAX_SEGMENTS,
  STATS_SEGMENT_MIN_RUNS,
  STATS_SEGMENT_NOTE,
  STATS_SPEED_BINS,
  StatsTrainSegments,
} from "@gerlines/schema/stats";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import { readGate, STATS_READ_QUERIES } from "./reads.ts";
import { registerStatsRoutes } from "./routes.ts";
import { segmentFigures } from "./segments.ts";
import { StatsService } from "./service.ts";
import { GoldenReader } from "./test-data.ts";

const NOW = Date.parse("2026-11-08T05:00:00Z");
const A = "4eda9b92-2ddf-5610-b59b-ed665a8b2610";
const B = "5eda9b92-2ddf-5610-b59b-ed665a8b2610";
const C = "6eda9b92-2ddf-5610-b59b-ed665a8b2610";

const cells = (bins: readonly unknown[], counts: Record<number, number>) => [
  0,
  ...bins.map((_, bin) => counts[bin] ?? 0),
  0,
];

function legs(
  runs: number,
  gains: Record<number, number>,
  extra: Partial<SegmentLegTotals> = {},
): SegmentLegTotals {
  const n = Object.values(gains).reduce((sum, count) => sum + count, 0);
  return {
    n_runs: runs,
    n_legs: n,
    sum_gain_s: 0,
    gain_hist: cells(STATS_GAIN_BINS, gains),
    n_speed: 0,
    sum_distance_m: null,
    sum_run_act_s: null,
    speed_hist: null,
    ...extra,
  };
}

function row(from: string, to: string, routeIndex: number | null, train: SegmentLegTotals) {
  return {
    from_stop_place_id: from,
    to_stop_place_id: to,
    from_name: from === A ? "Hamburg Hbf" : null,
    to_name: "Berlin Hbf",
    route_index: routeIndex,
    train,
    all: legs(400, { 7: 300, 8: 100 }),
  } satisfies SegmentRow;
}

describe("segmentFigures", () => {
  it("reads median and p80 from the gain bins and the mean from the sums", () => {
    const figures = segmentFigures(legs(10, { 7: 5, 8: 5 }, { sum_gain_s: 450 }));
    expect(figures).toMatchObject({
      status: "known",
      runs: 10,
      medianGainS: 0,
      p80GainS: 60,
      meanGainS: 45,
    });
    if (figures.status !== "known") throw new Error("known expected");
    expect(figures.gainCounts).toHaveLength(STATS_GAIN_BINS.length);
    expect(figures.gainCounts[7]).toBe(5);
    expect(figures.gainCounts.reduce((sum, count) => sum + count, 0)).toBe(10);
  });

  it("keeps a gain of exactly 0 at 0 when half the legs gained nothing", () => {
    const gains = [...Array(12).fill(0), -60, -60, 60, 60, 120, 120, 180, 240, 300, 360, 480, 660];
    const figures = segmentFigures(sampleLegs(gains));
    expect(figures).toMatchObject({ medianGainS: 0, p80GainS: 240 });
  });

  it("gives the exact median and p80 of a whole-minute sample from the gain bins", () => {
    const samples = [
      [0, 0, 0, 0, 0, 0, 0, 0, 60, 60, 60, 120, 180, 240, 300],
      [-240, -120, -60, -60, 0, 0, 0, 60, 120, 120, 180, 420, 540],
      [0, 60, 60, 60, 120, 120, 120, 180, 180, 240, 240, 300, 360, 480, 600],
      [-300, -180, -60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 60, 120, 180, 540],
    ];
    for (const gains of samples) {
      expect(segmentFigures(sampleLegs(gains)), gains.join(" ")).toMatchObject({
        medianGainS: percentileDisc(gains, 0.5),
        p80GainS: percentileDisc(gains, 0.8),
      });
    }
  });

  it("gives the bound of an open-ended bin and negative gains below zero", () => {
    expect(segmentFigures(legs(6, { 0: 6 }))).toMatchObject({
      medianGainS: -600,
      p80GainS: -600,
    });
    expect(segmentFigures(legs(6, { 20: 6 }))).toMatchObject({ medianGainS: 3600 });
    expect(segmentFigures(legs(6, { 6: 6 }, { sum_gain_s: -180 }))).toMatchObject({
      medianGainS: -60,
      meanGainS: -30,
    });
  });

  it("is missing below the minimum runs and when nothing ran, with the count", () => {
    expect(segmentFigures(legs(STATS_SEGMENT_MIN_RUNS - 1, { 7: 4 }))).toEqual({
      status: "missing",
      runs: STATS_SEGMENT_MIN_RUNS - 1,
      reason: "too_few_runs",
    });
    expect(segmentFigures(null)).toEqual({ status: "missing", runs: 0, reason: "no_runs" });
    expect(segmentFigures(legs(0, {}))).toEqual({ status: "missing", runs: 0, reason: "no_runs" });
    expect(segmentFigures(legs(6, {}))).toEqual({ status: "missing", runs: 6, reason: "no_gains" });
  });

  it("shows speed only where legs had a distance, from distance over actual run time", () => {
    expect(segmentFigures(legs(8, { 7: 8 }))).toMatchObject({
      speed: { status: "missing", legs: 0, reason: "no_distance" },
    });
    expect(
      segmentFigures(legs(8, { 7: 8 }, { n_speed: 3, sum_distance_m: 30_000, sum_run_act_s: 900 })),
    ).toMatchObject({ speed: { status: "missing", legs: 3, reason: "too_few_runs" } });
    const speed = segmentFigures(
      legs(
        8,
        { 7: 8 },
        {
          n_speed: 8,
          sum_distance_m: 80_000,
          sum_run_act_s: 2_400,
          speed_hist: cells(STATS_SPEED_BINS, { 11: 4, 12: 4 }),
        },
      ),
    );
    expect(speed).toMatchObject({
      speed: { status: "known", legs: 8, meanKmh: 120, medianKmh: 120 },
    });
  });
});

const range = { from: "2025-11-01", to: "2025-11-30" };

function profileReader() {
  const reader = new GoldenReader({});
  reader.segments = {
    runs: 24,
    patternRuns: 18,
    pairs: 3,
    groups: [
      {
        category_code: "hsr",
        operator_id: "db-fernverkehr-ag",
        operator_name: "DB Fernverkehr AG",
        runs: 24,
      },
      { category_code: "reg", operator_id: null, operator_name: null, runs: 11 },
      { category_code: "tram", operator_id: "x-unknown", operator_name: null, runs: 3 },
    ],
    rows: [
      row(A, B, 0, legs(24, { 7: 20, 9: 4 }, { sum_gain_s: 960 })),
      row(B, C, 1, legs(24, { 6: 24 }, { sum_gain_s: -720 })),
      { ...row(A, C, null, legs(2, { 8: 2 })), all: null },
    ],
  };
  return reader;
}

describe("StatsService.trainSegments", () => {
  it("orders the route first, then the other legs, with this number against every train", async () => {
    const reader = profileReader();
    const answer = StatsTrainSegments.parse(
      await new StatsService(reader, () => NOW).trainSegments("596", null, {
        ...range,
        categories: ["hsr"],
      }),
    );
    expect(reader.segmentCalls).toEqual([
      {
        trainNumber: "596",
        from: "2025-11-01",
        to: "2025-11-30",
        categories: ["hsr"],
        limit: STATS_MAX_SEGMENTS,
      },
    ]);
    expect(answer).toMatchObject({
      kind: "trainSegments",
      number: "596",
      operatorId: null,
      categories: ["hsr"],
      route: { runs: 24, patternRuns: 18 },
      minRuns: 5,
      note: STATS_SEGMENT_NOTE,
      gainBins: STATS_GAIN_BINS.map(([fromS, toS]) => ({ fromS, toS })),
      truncated: false,
      period: { from: "2025-11-01", to: "2025-11-30", days: 30 },
    });
    expect(
      answer.segments.map((segment) => [segment.position, segment.onRoute, segment.from.id]),
    ).toEqual([
      [0, true, A],
      [1, true, B],
      [2, false, A],
    ]);
    expect(answer.groups).toEqual([
      {
        category: "hsr",
        operator: { id: "db-fernverkehr-ag", name: "DB Fernverkehr AG" },
        runs: 24,
        shown: true,
      },
      { category: "reg", operator: null, runs: 11, shown: false },
      { category: null, operator: { id: "x-unknown", name: null }, runs: 3, shown: false },
    ]);
    expect(answer.segments[0]?.from).toEqual({ id: A, name: "Hamburg Hbf" });
    expect(answer.segments[1]?.from).toEqual({ id: B, name: null });
    expect(answer.segments[0]?.train).toMatchObject({ status: "known", runs: 24, meanGainS: 40 });
    expect(answer.segments[0]?.all).toMatchObject({ status: "known", runs: 400 });
    expect(answer.segments[2]?.train).toEqual({
      status: "missing",
      runs: 2,
      reason: "too_few_runs",
    });
    expect(answer.segments[2]?.all).toEqual({ status: "missing", runs: 0, reason: "no_runs" });
  });

  it("passes the operator, marks a cut list and answers an empty route when nothing ran", async () => {
    const reader = profileReader();
    reader.segments = { ...reader.segments, pairs: 140 };
    const service = new StatsService(reader, () => NOW);
    const cut = await service.trainSegments("596", "db-fernverkehr-ag", range);
    expect(reader.segmentCalls[0]?.operatorId).toBe("db-fernverkehr-ag");
    expect(cut.truncated).toBe(true);
    reader.segments = { runs: 0, patternRuns: 0, pairs: 0, groups: [], rows: [] };
    const empty = StatsTrainSegments.parse(await service.trainSegments("9999", null, range));
    expect(empty).toMatchObject({ route: { runs: 0, patternRuns: 0 }, segments: [] });
  });
});

describe("GET /api/v1/stats/trains/{number}/segments", () => {
  const appWith = (reader: GoldenReader | undefined, reads = readGate()) => {
    const app = new Hono();
    registerStatsRoutes(app, {
      service: reader && new StatsService(reader, () => NOW),
      logger: { error: () => undefined },
      now: () => NOW,
      reads,
      limiter: fixedWindowLimiter({ limit: 60, windowMs: 60_000, now: () => NOW }),
      longLimiter: fixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => NOW }),
      peerAddress: () => "203.0.113.9",
    });
    return app;
  };

  it("answers the profile, cached an hour for settled days, and reads it once", async () => {
    const reader = profileReader();
    const app = appWith(reader);
    const url = "/api/v1/stats/trains/596/segments?from=2025-11-01&to=2025-11-30&category=hsr";
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = StatsTrainSegments.parse(await response.json());
    expect(body.segments).toHaveLength(3);
    expect((await app.request(url)).status).toBe(200);
    expect(reader.segmentCalls).toHaveLength(1);
    const other = await app.request("/api/v1/stats/trains/596?from=2025-11-01&to=2025-11-30");
    expect(other.status).toBe(200);
    expect(reader.segmentCalls).toHaveLength(1);
  });

  it("keeps a missing operator apart from an operator named null in the cache", async () => {
    const reader = profileReader();
    const app = appWith(reader);
    const base = "/api/v1/stats/trains/596/segments?from=2025-11-01&to=2025-11-30";
    expect((await app.request(base)).status).toBe(200);
    expect((await app.request(`${base}&operator=null`)).status).toBe(200);
    expect(reader.segmentCalls.map((call) => call.operatorId)).toEqual([undefined, "null"]);
    const train = "/api/v1/stats/trains/596?from=2025-11-01&to=2025-11-30";
    expect((await app.request(train)).status).toBe(200);
    expect((await app.request(`${train}&operator=null`)).status).toBe(200);
    const trainCalls = reader.calls.filter((call) => call.source === "train_day");
    expect(new Set(trainCalls.map((call) => call.filter.operatorId))).toEqual(
      new Set([undefined, "null"]),
    );
  });

  it.each([
    ["/api/v1/stats/trains/ICE%20596/segments", "number"],
    ["/api/v1/stats/trains/596/segments?category=tram", "category.0"],
    ["/api/v1/stats/trains/596/segments?from=2025-11-30&to=2025-11-01", "from"],
    ["/api/v1/stats/trains/596/segments?operator=DB%20AG", "operator"],
    ["/api/v1/stats/trains/596/segments?from=2024-01-01&to=2025-11-30", "to"],
  ])("refuses %s on %s", async (url, path) => {
    const response = await appWith(profileReader()).request(url);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((issue) => issue.path)).toContain(path);
  });

  it("counts periods over 31 days against the long limit and answers 503 when not configured", async () => {
    const app = appWith(profileReader());
    const long = "/api/v1/stats/trains/596/segments?from=2025-11-01&to=2026-01-31";
    expect((await app.request(long)).status).toBe(200);
    expect((await app.request(long)).status).toBe(200);
    const other = await app.request(
      "/api/v1/stats/trains/597/segments?from=2025-11-01&to=2026-01-31",
    );
    expect(other.status).toBe(429);
    const unconfigured = await appWith(undefined).request("/api/v1/stats/trains/596/segments");
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: "not_configured" });
  });

  it("takes its queries from the read gate and answers 503 when they do not fit", async () => {
    const reads = readGate(6);
    reads.tryEnter(6 - STATS_READ_QUERIES.segments + 1);
    const busy = await appWith(profileReader(), reads).request("/api/v1/stats/trains/596/segments");
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    reads.leave(1);
    const fits = await appWith(profileReader(), reads).request("/api/v1/stats/trains/596/segments");
    expect(fits.status).toBe(200);
    expect(reads.inFlight()).toBe(6 - STATS_READ_QUERIES.segments);
  });
});

function gainBin(gain: number): number {
  return STATS_GAIN_BINS.findIndex(
    ([lower, upper]) => (lower === null || gain >= lower) && (upper === null || gain < upper),
  );
}

function sampleLegs(gains: readonly number[]): SegmentLegTotals {
  const counts: Record<number, number> = {};
  for (const gain of gains) counts[gainBin(gain)] = (counts[gainBin(gain)] ?? 0) + 1;
  return legs(gains.length, counts, { sum_gain_s: gains.reduce((sum, gain) => sum + gain, 0) });
}

function percentileDisc(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;
}
