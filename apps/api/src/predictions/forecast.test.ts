import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { TrainDetail } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { predictionsFromEnv, readPredictionTable } from "./config.ts";
import { forecastOf } from "./forecast.ts";
import { PredictionTable, type PredictionTableFile } from "./table.ts";

const fixtures = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "services",
  "live",
  "src",
  "detail",
  "fixtures",
);
const ICE: TrainDetail = JSON.parse(
  readFileSync(join(fixtures, "ice-619-realtime.json"), "utf8"),
).detail;

const ULM = 8000170;
const GUENZBURG = 8000142;
const AUGSBURG = 8000013;
const MUENCHEN = 8000261;
const EVA: Record<string, number> = {
  "Ulm Hauptbahnhof": ULM,
  "Günzburg, Bahnhof": GUENZBURG,
  "Augsburg Hbf": AUGSBURG,
  "München Hbf": MUENCHEN,
};
const evaByPlace = new Map(ICE.stops.map((stop) => [stop.stopPlaceId, EVA[stop.name] ?? null]));
const evaOf = (id: string) => evaByPlace.get(id) ?? null;

function withoutFeed(detail: TrainDetail, indexes?: readonly number[]): TrainDetail {
  const from = detail.progress.lastPassedIndex ?? -1;
  return {
    ...detail,
    stops: detail.stops.map((stop) =>
      stop.index > from && (indexes === undefined || indexes.includes(stop.index))
        ? { ...stop, predictedArrival: null, arrivalDelaySeconds: null, prediction: null }
        : stop,
    ),
  };
}

const KEY = {
  categories: ["hsr", "ld", "night", "rfast", "reg", "sbahn"],
  evaBase: 8_000_000,
  fields: {
    category: [45, 3] as [number, number],
    train_number: [21, 24] as [number, number],
    eva: [4, 17] as [number, number],
    band: [2, 2] as [number, number],
    horizon: [0, 2] as [number, number],
  },
  levels: {
    train: ["category", "train_number", "eva", "band", "horizon"] as const,
    stop: ["category", "eva", "band", "horizon"] as const,
    category: ["category", "band", "horizon"] as const,
  },
};

type Row = {
  category: string;
  train?: number;
  eva?: number;
  band: number;
  horizon: number;
  runs: number;
  median: number;
  p80: number;
};

function packed(row: Row): number {
  const values = {
    category: KEY.categories.indexOf(row.category),
    train_number: row.train ?? 0,
    eva: row.eva === undefined ? 0 : row.eva - KEY.evaBase,
    band: row.band,
    horizon: row.horizon,
  };
  return Object.entries(KEY.fields).reduce(
    (sum, [name, [shift]]) => sum + values[name as keyof typeof values] * 2 ** shift,
    0,
  );
}

function columns(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => packed(a) - packed(b));
  return {
    key: sorted.map(packed),
    runs: sorted.map((row) => row.runs),
    median: sorted.map((row) => row.median),
    p80: sorted.map((row) => row.p80),
  };
}

function file(
  overrides: Partial<PredictionTableFile["meta"]> = {},
  rows: { train?: Row[]; stop?: Row[]; category?: Row[] } = {},
): PredictionTableFile {
  return {
    format: 2,
    meta: {
      method: "b1-change",
      variant: "change",
      trainedFrom: "2026-08",
      trainedTo: "2026-10",
      minRuns: 20,
      maxAhead: 30,
      shippedAhead: [1, 2, 3, 4],
      bandUpperMinutes: [0, 5, 15],
      horizonUpperStops: [1, 3, 7],
      key: {
        ...KEY,
        levels: {
          train: [...KEY.levels.train],
          stop: [...KEY.levels.stop],
          category: [...KEY.levels.category],
        },
      },
      source: {
        id: "piebro-deutsche-bahn-data",
        name: "piebro/deutsche-bahn-data",
        url: "https://huggingface.co/datasets/piebro/deutsche-bahn-data",
        licence: "CC-BY-4.0",
        attribution:
          "Deutsche Bahn train data, collected and processed by piebro, data from Deutsche Bahn",
      },
      ...overrides,
    },
    train: columns(
      rows.train ?? [
        { category: "hsr", train: 619, eva: ULM, band: 1, horizon: 0, runs: 61, median: 1, p80: 4 },
      ],
    ),
    stop: columns(
      rows.stop ?? [
        { category: "hsr", eva: GUENZBURG, band: 1, horizon: 1, runs: 340, median: 0, p80: 3 },
      ],
    ),
    category: columns(
      rows.category ?? [
        { category: "hsr", band: 1, horizon: 1, runs: 90_000, median: -1, p80: 2 },
        { category: "hsr", band: 1, horizon: 2, runs: 80_000, median: -1, p80: 3 },
      ],
    ),
  };
}

describe("forecastOf", () => {
  it("anchors on the feed's predicted arrival and adds B1's spread for the bound", () => {
    const forecast = forecastOf(ICE, new PredictionTable(file()), evaOf);
    expect(forecast?.fromIndex).toBe(17);
    expect(forecast?.fromDelayMinutes).toBe(2);
    expect(forecast?.stops).toEqual([
      {
        index: 18,
        stopsAhead: 1,
        expectedDelayMinutes: 10,
        upperDelayMinutes: 13,
        level: "train",
        runs: 61,
        basis: "feed_plus_spread",
      },
      {
        index: 19,
        stopsAhead: 2,
        expectedDelayMinutes: 9,
        upperDelayMinutes: 12,
        level: "stop",
        runs: 340,
        basis: "feed_plus_spread",
      },
      {
        index: 20,
        stopsAhead: 3,
        expectedDelayMinutes: 2,
        upperDelayMinutes: 5,
        level: "category",
        runs: 90_000,
        basis: "feed_plus_spread",
      },
      {
        index: 21,
        stopsAhead: 4,
        expectedDelayMinutes: 0,
        upperDelayMinutes: 4,
        level: "category",
        runs: 80_000,
        basis: "feed_plus_spread",
      },
    ]);
    expect(TrainDetail.safeParse({ ...ICE, forecast }).success).toBe(true);
  });

  it("uses B1 for the stops where the feed has no predicted arrival", () => {
    const table = new PredictionTable(file());
    const mixed = forecastOf(withoutFeed(ICE, [19, 21]), table, evaOf);
    expect(
      mixed?.stops.map((stop) => [
        stop.index,
        stop.basis,
        stop.expectedDelayMinutes,
        stop.upperDelayMinutes,
      ]),
    ).toEqual([
      [18, "feed_plus_spread", 10, 13],
      [19, "b1", 2, 5],
      [20, "feed_plus_spread", 2, 5],
      [21, "b1", 1, 5],
    ]);
    const delayOnly = ICE.stops.map((stop) =>
      stop.index === 18 ? { ...stop, predictedArrival: null } : stop,
    );
    expect(forecastOf({ ...ICE, stops: delayOnly }, table, evaOf)?.stops[0]?.basis).toBe("b1");
    const timetable = { ...ICE, provenance: { ...ICE.provenance, kind: "timetable" as const } };
    expect(forecastOf(timetable, table, evaOf)?.stops.map((stop) => stop.basis)).toEqual([
      "b1",
      "b1",
      "b1",
      "b1",
    ]);
  });

  it("rounds the feed's delay down to whole minutes", () => {
    const early = ICE.stops.map((stop) =>
      stop.index === 18 ? { ...stop, arrivalDelaySeconds: -30 } : stop,
    );
    const forecast = forecastOf({ ...ICE, stops: early }, new PredictionTable(file()), evaOf);
    expect(forecast?.stops[0]).toMatchObject({
      expectedDelayMinutes: -1,
      upperDelayMinutes: 2,
      basis: "feed_plus_spread",
    });
  });

  it("starts from the departure delay at the last passed stop and adds the change quantiles", () => {
    const forecast = forecastOf(withoutFeed(ICE), new PredictionTable(file()), evaOf);
    expect(forecast).not.toBeNull();
    expect(forecast?.fromIndex).toBe(17);
    expect(forecast?.fromDelayMinutes).toBe(2);
    expect(forecast?.stops).toEqual([
      {
        index: 18,
        stopsAhead: 1,
        expectedDelayMinutes: 3,
        upperDelayMinutes: 6,
        level: "train",
        runs: 61,
        basis: "b1",
      },
      {
        index: 19,
        stopsAhead: 2,
        expectedDelayMinutes: 2,
        upperDelayMinutes: 5,
        level: "stop",
        runs: 340,
        basis: "b1",
      },
      {
        index: 20,
        stopsAhead: 3,
        expectedDelayMinutes: 1,
        upperDelayMinutes: 4,
        level: "category",
        runs: 90_000,
        basis: "b1",
      },
      {
        index: 21,
        stopsAhead: 4,
        expectedDelayMinutes: 1,
        upperDelayMinutes: 5,
        level: "category",
        runs: 80_000,
        basis: "b1",
      },
    ]);
    expect(forecast?.licence).toEqual({
      id: "CC-BY-4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
    });
    expect(TrainDetail.safeParse({ ...ICE, forecast }).success).toBe(true);
  });

  it("leaves out horizons where B1 did not ship and stops without an EVA number", () => {
    const table = new PredictionTable(file({ shippedAhead: [2, 3] }));
    const noAugsburg = (id: string) =>
      EVA[ICE.stops.find((s) => s.stopPlaceId === id)?.name ?? ""] === AUGSBURG ? null : evaOf(id);
    expect(forecastOf(ICE, table, noAugsburg)?.stops.map((stop) => stop.index)).toEqual([19]);
  });

  it("counts served stops ahead past a cancelled stop", () => {
    const stops = ICE.stops.map((stop) =>
      stop.index === 18 ? { ...stop, cancelled: true } : stop,
    );
    const forecast = forecastOf({ ...ICE, stops }, new PredictionTable(file()), evaOf);
    expect(forecast?.stops.map((stop) => [stop.index, stop.stopsAhead])).toEqual([
      [20, 2],
      [21, 3],
    ]);
  });

  it("uses the level variant without adding the current delay", () => {
    const forecast = forecastOf(
      withoutFeed(ICE),
      new PredictionTable(file({ variant: "level", method: "b1-level" })),
      evaOf,
    );
    expect(forecast?.stops[0]).toMatchObject({ expectedDelayMinutes: 1, upperDelayMinutes: 4 });
  });

  it("is null without a passed stop, a delay there, a numeric train number or a known category", () => {
    const table = new PredictionTable(file());
    expect(
      forecastOf({ ...ICE, progress: { lastPassedIndex: null, nextIndex: 0 } }, table, evaOf),
    ).toBeNull();
    const silent = ICE.stops.map((stop) =>
      stop.index === 17
        ? { ...stop, arrivalDelaySeconds: null, departureDelaySeconds: null }
        : stop,
    );
    expect(forecastOf({ ...ICE, stops: silent }, table, evaOf)).toBeNull();
    expect(forecastOf({ ...ICE, trainNumber: "ICE 619" }, table, evaOf)).toBeNull();
    expect(forecastOf({ ...ICE, category: "bus" }, table, evaOf)).toBeNull();
  });

  it("rounds a negative delay down to whole minutes and bands it as on time", () => {
    const early = ICE.stops.map((stop) =>
      stop.index === 17 ? { ...stop, departureDelaySeconds: -30 } : stop,
    );
    const table = new PredictionTable(
      file(
        {},
        {
          train: [],
          stop: [],
          category: [{ category: "hsr", band: 0, horizon: 0, runs: 500, median: 1, p80: 3 }],
        },
      ),
    );
    const forecast = forecastOf(withoutFeed({ ...ICE, stops: early }), table, evaOf);
    expect(forecast?.fromDelayMinutes).toBe(-1);
    expect(forecast?.stops).toHaveLength(1);
    expect(forecast?.stops[0]).toMatchObject({
      index: 18,
      expectedDelayMinutes: 0,
      upperDelayMinutes: 2,
    });
  });
});

describe("PredictionTable", () => {
  it("bands delays and buckets horizons like the builder", () => {
    const table = new PredictionTable(file());
    expect([-3, 0, 1, 5, 6, 15, 16].map((m) => table.band(m))).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect([1, 2, 3, 4, 7, 8, 30].map((k) => table.horizon(k))).toEqual([0, 1, 1, 2, 2, 3, 3]);
    expect(table.ships(4)).toBe(true);
    expect(table.ships(5)).toBe(false);
    expect(table.size).toBe(4);
  });

  it("refuses a file of another format or with a broken row", () => {
    expect(() => PredictionTable.parse({ ...file(), format: 1 })).toThrow();
    const pairCounted = { ...file(), train: { ...file().train, n: file().train.runs } };
    delete (pairCounted.train as { runs?: number[] }).runs;
    expect(() => PredictionTable.parse(pairCounted)).toThrow();
    expect(() =>
      PredictionTable.parse({ ...file(), train: [["hsr", 619, ULM, 9, 0, 61, 1, 4]] }),
    ).toThrow();
  });
});

describe("predictionsFromEnv", () => {
  const dir = mkdtempSync(join(tmpdir(), "gerlines-predict-"));
  const path = join(dir, "b1.json.gz");
  writeFileSync(path, gzipSync(JSON.stringify(file())));

  it("is off without PREDICTION_TABLE and refuses a relative path", () => {
    expect(predictionsFromEnv({}, () => evaOf)).toBeUndefined();
    expect(() => predictionsFromEnv({ PREDICTION_TABLE: "b1.json.gz" }, () => evaOf)).toThrow(
      /absolute/,
    );
  });

  it("reads the gzipped table and answers null until stations are known", () => {
    expect(readPredictionTable(path).size).toBe(4);
    let lookup: typeof evaOf | null = null;
    const forecaster = predictionsFromEnv({ PREDICTION_TABLE: path }, () => lookup);
    expect(forecaster?.forecast(ICE)).toBeNull();
    lookup = evaOf;
    expect(forecaster?.forecast(ICE)?.stops).toHaveLength(4);
  });
});

describe("the recorded table sample", () => {
  const sample = join(import.meta.dirname, "..", "..", "test", "fixtures", "b1-table-sample.json");
  const table = readPredictionTable(sample);
  const REAL: Record<string, number> = {
    "Ulm Hauptbahnhof": 8000170,
    "Günzburg, Bahnhof": 8000139,
    "Augsburg Hbf": 8000013,
    "München Hbf": 8000261,
  };
  const realEva = (id: string) =>
    REAL[ICE.stops.find((stop) => stop.stopPlaceId === id)?.name ?? ""] ?? null;

  it("forecasts ICE 619 from Stuttgart with the quantiles of 2026-08 to 2026-10", () => {
    expect(table.meta.method).toBe("b1-change");
    expect(table.meta.shippedAhead).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const forecast = forecastOf(withoutFeed(ICE), table, realEva);
    expect(forecast?.trainedFrom).toBe("2026-08");
    expect(forecast?.stops.map((stop) => [stop.index, stop.stopsAhead])).toEqual([
      [18, 1],
      [19, 2],
      [20, 3],
      [21, 4],
    ]);
    expect(forecast?.stops).toMatchSnapshot();
    expect(TrainDetail.safeParse({ ...ICE, forecast }).success).toBe(true);
  });

  it("anchors ICE 619 on the feed's predicted arrivals with the sample's spreads", () => {
    const b1 = forecastOf(withoutFeed(ICE), table, realEva)?.stops ?? [];
    const anchored = forecastOf(ICE, table, realEva)?.stops ?? [];
    const feedMinutes = new Map(
      ICE.stops.map((stop) => [stop.index, Math.floor((stop.arrivalDelaySeconds ?? 0) / 60)]),
    );
    expect(anchored.map((stop) => [stop.index, stop.expectedDelayMinutes])).toEqual([
      [18, 10],
      [19, 9],
      [20, 2],
      [21, 0],
    ]);
    anchored.forEach((stop, i) => {
      const own = b1[i];
      expect(stop.basis).toBe("feed_plus_spread");
      expect(stop.expectedDelayMinutes).toBe(feedMinutes.get(stop.index));
      expect(stop.upperDelayMinutes - stop.expectedDelayMinutes).toBe(
        (own?.upperDelayMinutes ?? 0) - (own?.expectedDelayMinutes ?? 0),
      );
      expect([stop.level, stop.runs]).toEqual([own?.level, own?.runs]);
    });
  });
});
