import { describe, expect, it } from "vitest";
import {
  readFormation,
  seriesByNumber,
  seriesNumbersOf,
  VehicleSequenceAnswer,
} from "./formation.ts";

const SERIES = seriesByNumber([
  { seriesId: "db-412", br: "412" },
  { seriesId: "db-442", br: "442" },
  { seriesId: "db-1440", br: "1440" },
  { seriesId: "db-146-5", br: "146.5" },
  { seriesId: "db-146", br: "146" },
  { seriesId: "db-intercity-2", br: null },
  { seriesId: "stadler-flirt", br: "427, 428, 429" },
  { seriesId: "db-428", br: "428" },
]);

function car(vehicleID: string, start: number, category = "PASSENGERCARRIAGE_ECONOMY_CLASS") {
  return { vehicleID, type: { category }, platformPosition: { start, end: start + 25 } };
}

describe("seriesNumbersOf", () => {
  it("reads high-speed units by their powered family, locomotives and regional units by series", () => {
    expect(seriesNumbersOf("938024128796")).toEqual(["412"]);
    expect(seriesNumbersOf("938058120792")).toEqual([]);
    expect(seriesNumbersOf("948004421012")).toEqual(["442"]);
    expect(seriesNumbersOf("948014400012")).toEqual(["1440"]);
    expect(seriesNumbersOf("918061465551")).toEqual(["146.5", "146"]);
    expect(seriesNumbersOf("508026001234")).toEqual([]);
    expect(seriesNumbersOf("12345")).toEqual([]);
  });

  it("maps series numbers to catalogue rows, a single number before a shared one", () => {
    expect(SERIES.get("428")).toBe("db-428");
    expect(SERIES.get("427")).toBe("stadler-flirt");
  });
});

describe("readFormation", () => {
  it("counts units of the dominant series, cars and the length along the platform", () => {
    const answer = VehicleSequenceAnswer.parse({
      sequenceStatus: "MATCHES_SCHEDULE",
      groups: [
        {
          name: "ICE9479",
          transport: { category: "ICE" },
          vehicles: [car("938058120792", 10), car("938024128796", 35)],
        },
        {
          name: "ICE9480",
          transport: { category: "ICE" },
          vehicles: [car("938024128801", 60), car("938058120801", 85)],
        },
      ],
    });
    expect(readFormation(answer, SERIES)).toEqual({
      seriesId: "db-412",
      units: 2,
      cars: 4,
      lengthMetres: 100,
      unitNames: ["ICE9479", "ICE9480"],
      sequenceStatus: "MATCHES_SCHEDULE",
    });
  });

  it("reads a loco-hauled double-deck Intercity as Intercity 2", () => {
    const answer = VehicleSequenceAnswer.parse({
      groups: [
        {
          name: "IC2xxx",
          transport: { category: "IC" },
          vehicles: [
            car("918061465551", 0, "LOCOMOTIVE"),
            car("508026001234", 20, "DOUBLEDECK_ECONOMY_CLASS"),
          ],
        },
      ],
    });
    expect(readFormation(answer, SERIES)).toMatchObject({
      seriesId: "db-intercity-2",
      units: 1,
      cars: 2,
    });
  });

  it("gives null when no vehicle number maps to the catalogue", () => {
    const answer = VehicleSequenceAnswer.parse({
      groups: [{ name: "X", vehicles: [car("508026001234", 0)] }],
    });
    expect(readFormation(answer, SERIES)).toBeNull();
  });
});
