import { WEB_MERCATOR_RADIUS } from "@gerlines/geo";
import { describe, expect, it } from "vitest";
import { type NearestEntry, type NearestFleet, nearestTrains } from "./nearest-trains.ts";

const RAD = Math.PI / 180;

function mercatorX(lon: number): number {
  return lon * RAD * WEB_MERCATOR_RADIUS;
}

function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) * WEB_MERCATOR_RADIUS;
}

interface Spot {
  readonly key: number;
  readonly lon: number;
  readonly lat: number;
  readonly category?: NearestEntry["category"];
  readonly alive?: boolean;
  readonly alpha?: number;
  readonly line?: string | null;
  readonly delay?: number | null;
}

function build(spots: readonly Spot[]): { entries: NearestEntry[]; fleet: NearestFleet } {
  const fleet = {
    x: Float64Array.from(spots.map((spot) => mercatorX(spot.lon))),
    y: Float64Array.from(spots.map((spot) => mercatorY(spot.lat))),
    alive: Uint8Array.from(spots.map((spot) => (spot.alive === false ? 0 : 1))),
    alpha: Float32Array.from(spots.map((spot) => spot.alpha ?? 1)),
  };
  const entries = spots.map(
    (spot, slot): NearestEntry => ({
      key: spot.key,
      slot,
      category: spot.category ?? "reg",
      trip: {
        line: spot.line === undefined ? "RE1" : spot.line,
        trainNumber: 4000 + spot.key,
        foreign: false,
        delay: spot.delay === undefined ? 60 : spot.delay,
      },
    }),
  );
  return { entries, fleet };
}

const CENTRE = { lon: 8.0, lat: 50.0 };
const ALL = () => true;
const SQUARE = [
  [7.5, 49.8],
  [8.5, 49.8],
  [8.5, 50.3],
  [7.5, 50.3],
] as const;

describe("nearestTrains", () => {
  it("lists the closest trains first and stops at the count", () => {
    const { entries, fleet } = build([
      { key: 1, lon: 8.3, lat: 50.0 },
      { key: 2, lon: 8.01, lat: 50.0 },
      { key: 3, lon: 8.0, lat: 50.1 },
      { key: 4, lon: 8.002, lat: 50.0 },
    ]);
    const result = nearestTrains(entries, fleet, { ...CENTRE, count: 3 }, ALL);
    expect(result.trains.map((train) => train.key)).toEqual([4, 2, 3]);
    expect(result.trains[0]?.distanceM).toBeLessThan(result.trains[1]?.distanceM as number);
  });

  it("measures distance on the ground, not in map units", () => {
    const { entries, fleet } = build([{ key: 1, lon: 8.0, lat: 50.1 }]);
    const near = nearestTrains(entries, fleet, { ...CENTRE, count: 1 }, ALL).trains[0];
    expect(near?.distanceM).toBeGreaterThan(11_000);
    expect(near?.distanceM).toBeLessThan(11_250);
  });

  it("breaks ties by frame key so the list does not reshuffle", () => {
    const { entries, fleet } = build([
      { key: 9, lon: 8.01, lat: 50.0 },
      { key: 3, lon: 8.01, lat: 50.0 },
    ]);
    expect(
      nearestTrains(entries, fleet, { ...CENTRE, count: 2 }, ALL).trains.map((t) => t.key),
    ).toEqual([3, 9]);
  });

  it("skips trains that are hidden, gone or faded out", () => {
    const { entries, fleet } = build([
      { key: 1, lon: 8.001, lat: 50.0, category: "foreign" },
      { key: 2, lon: 8.002, lat: 50.0, alive: false },
      { key: 3, lon: 8.003, lat: 50.0, alpha: 0 },
      { key: 4, lon: 8.1, lat: 50.0 },
    ]);
    const result = nearestTrains(
      entries,
      fleet,
      { ...CENTRE, count: 5 },
      (entry) => entry.category !== "foreign",
    );
    expect(result.trains.map((train) => train.key)).toEqual([4]);
    expect(result.inView).toBe(1);
  });

  it("counts every shown train inside the bounds, not only the listed ones", () => {
    const { entries, fleet } = build([
      { key: 1, lon: 8.0, lat: 50.0 },
      { key: 2, lon: 8.2, lat: 50.0 },
      { key: 3, lon: 9.5, lat: 50.0 },
      { key: 4, lon: 7.9, lat: 50.2 },
    ]);
    const result = nearestTrains(entries, fleet, { ...CENTRE, count: 1, area: SQUARE }, ALL);
    expect(result.trains).toHaveLength(1);
    expect(result.inView).toBe(3);
  });

  it("counts all shown trains when no bounds are given", () => {
    const { entries, fleet } = build([
      { key: 1, lon: 8.0, lat: 50.0 },
      { key: 2, lon: 12.0, lat: 52.0 },
    ]);
    expect(nearestTrains(entries, fleet, { ...CENTRE, count: 20 }, ALL).inView).toBe(2);
  });

  it("carries what the list shows and the id the card opens", () => {
    const { entries, fleet } = build([
      { key: 7, lon: 8.0, lat: 50.0, line: null, delay: null, category: "sbahn" },
    ]);
    const [train] = nearestTrains(entries, fleet, { ...CENTRE, count: 1 }, ALL).trains;
    expect(train).toMatchObject({
      key: 7,
      id: "live:7",
      line: null,
      trainNumber: 4007,
      category: "sbahn",
      foreign: false,
      delaySeconds: null,
    });
    expect(train?.lon).toBeCloseTo(8.0, 5);
    expect(train?.lat).toBeCloseTo(50.0, 5);
  });

  it("returns an empty list for an empty fleet", () => {
    expect(nearestTrains([], build([]).fleet, { ...CENTRE, count: 20 }, ALL)).toEqual({
      inView: 0,
      trains: [],
    });
  });

  it("counts inside the screen quad of a turned or tilted map, not inside its north aligned box", () => {
    const { entries, fleet } = build([
      { key: 1, lon: 8.0, lat: 50.0 },
      { key: 2, lon: 8.45, lat: 50.25 },
      { key: 3, lon: 7.55, lat: 49.85 },
    ]);
    const diamond = [
      [8.0, 49.7],
      [8.5, 50.0],
      [8.0, 50.3],
      [7.5, 50.0],
    ] as const;
    const result = nearestTrains(entries, fleet, { ...CENTRE, count: 20, area: diamond }, ALL);
    expect(result.inView).toBe(1);
    expect(result.trains.map((train) => train.key)).toEqual([1]);
  });
});
