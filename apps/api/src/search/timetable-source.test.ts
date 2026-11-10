import { describe, expect, it } from "vitest";
import { canonicalTrains, type TrainRow, tripRunsOf } from "./timetable-source.ts";

const ROW: TrainRow = {
  trip_key: "3448680724",
  service_date: "2026-10-25",
  short_name: "000603",
  category_code: "hsr",
  is_foreign: false,
  line: "28",
  product: "ICE",
  operator_id: "db-fernverkehr-ag",
  operator_name: "DB Fernverkehr AG",
  first_departure_s: 51_480,
  last_arrival_s: 70_000,
  origin_id: "4eda9b92-2ddf-5610-b59b-ed665a8b2610",
  origin_name: "Hamburg-Altona",
  destination_id: "17d45fba-4bcb-58e1-8162-11a19164dbac",
  destination_name: "München Hbf",
};

describe("tripRunsOf", () => {
  it("maps every trip key of a day to the record of its run, a train filed twice included", () => {
    const twin = { ...ROW, trip_key: "3448680720" };
    const rows = [
      ROW,
      twin,
      { ...ROW, trip_key: "9", short_name: null, line: null, product: null },
    ];
    const [train] = canonicalTrains(rows);
    expect(tripRunsOf(rows)).toEqual([
      { serviceDate: "2026-10-25", tripKey: "3448680724", trainId: train?.id },
      { serviceDate: "2026-10-25", tripKey: "3448680720", trainId: train?.id },
    ]);
  });
});
