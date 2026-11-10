import { describe, expect, it } from "vitest";
import { GtfsdeTimetable } from "./foreign-timetable.ts";
import { NO_TIME, Timetable } from "./timetable.ts";
import { zip } from "./zip.test-support.ts";
import { ZipArchive } from "./zip.ts";

const PLACE_A = "00000000-0000-5000-8000-000000000001";
const PLACE_B = "00000000-0000-5000-8000-000000000002";

const timetable = new Timetable({
  feedVersionId: 1,
  feedVersion: "v1",
  trips: [],
  calendars: new Map(),
  routes: new Map(),
  stopPoints: new Map(),
  stopPlaces: new Map([
    [
      PLACE_A,
      { name: "A", eva: null, uic: null, lat: 52.5, lon: 13.4, countryCode: "DE", dhid: null },
    ],
    [
      PLACE_B,
      { name: "B", eva: null, uic: null, lat: 48.1, lon: 11.6, countryCode: "DE", dhid: null },
    ],
  ]),
  delfiStopPoints: new Map(),
  delfiStopPlaces: new Map(),
});

const archive = (stopTimes: string) =>
  ZipArchive.fromBytes(
    zip([
      {
        name: "stops.txt",
        data: Buffer.from(
          [
            "stop_id,stop_name,stop_lat,stop_lon,parent_station",
            "de:11000:900100001,A,52.5001,13.4001,",
            "de:11000:900100001::4,A 4,52.5002,13.4002,de:11000:900100001",
            "de:09162:6118,B,48.1001,11.6001,",
            "far-away-stop-0001,X,50.0,8.0,",
          ].join("\n"),
        ),
      },
      {
        name: "routes.txt",
        data: Buffer.from("route_id,route_short_name\nr1,RE 1\n"),
      },
      { name: "trips.txt", data: Buffer.from("route_id,trip_id\nr1,trip-000000000001\n") },
      { name: "stop_times.txt", data: Buffer.from(stopTimes) },
    ]),
  );

describe("GtfsdeTimetable", () => {
  it("keeps each trip's stops in sequence order with the departure, else the arrival", () => {
    const table = GtfsdeTimetable.fromArchives(
      [
        archive(
          [
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
            "trip-000000000001,25:10:00,,de:09162:6118,7",
            "trip-000000000001,08:00:00,08:02:00,de:11000:900100001::4,2",
            "trip-000000000001,,,far-away-stop-0001,5",
          ].join("\n"),
        ),
      ],
      timetable,
    );
    const trip = table.trip("trip-000000000001");
    expect(trip?.routeShortName).toBe("RE 1");
    expect(trip?.stopIds).toEqual(["de:11000:900100001::4", "far-away-stop-0001", "de:09162:6118"]);
    expect([...(trip?.times ?? [])]).toEqual([8 * 3600 + 120, NO_TIME, 25 * 3600 + 600]);
    expect(table.placeOfStop("de:11000:900100001::4")).toBe(PLACE_A);
    expect(table.placeOfStop("de:09162:6118")).toBe(PLACE_B);
    expect(table.placeOfStop("far-away-stop-0001")).toBeUndefined();
    expect(table.tripCount).toBe(1);
  });

  it("reuses the stops.txt string of each stop id in every trip", () => {
    const table = GtfsdeTimetable.fromArchives(
      [
        archive(
          [
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
            "trip-000000000001,08:00:00,08:00:00,de:09162:6118,1",
            "trip-000000000002,09:00:00,09:00:00,de:09162:6118,1",
          ].join("\n"),
        ),
      ],
      timetable,
    );
    expect(table.trip("trip-000000000002")?.stopIds).toEqual(["de:09162:6118"]);
    expect(table.distinctStopIds).toBe(3);
  });
});
