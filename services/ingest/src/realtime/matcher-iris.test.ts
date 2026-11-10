import type { StopTimeObservation, TripObservation } from "@gerlines/schema";
import { serviceInstant } from "@gerlines/schema/service-day";
import { describe, expect, it } from "vitest";
import { type MatchedTrip, Matcher } from "./matcher.ts";
import { type StaticTrip, Timetable } from "./timetable.ts";

const DATE = "2026-10-25";
const H = 3600;
const place = (eva: number) => `00000000-0000-5000-8000-${String(eva).padStart(12, "0")}`;
const FRANKFURT = 8000105;
const MANNHEIM = 8000244;
const STUTTGART = 8000096;
const BERLIN = 8011160;

function trip(
  tripKey: string,
  evas: number[],
  times: number[],
  extra: Partial<StaticTrip> = {},
): StaticTrip {
  return {
    tripKey,
    routeKey: "R",
    serviceKey: "S",
    operatorId: "op",
    trainNumber: null,
    categoryCode: "hsr",
    isForeign: false,
    stopPoints: evas.map((eva) => `p${eva}`),
    stopPlaces: evas.map(place),
    stopSequences: Int32Array.from(evas, (_, index) => index),
    arrivals: Int32Array.from(times),
    departures: Int32Array.from(times, (time) => time + 120),
    ...extra,
  };
}

function timetable(trips: StaticTrip[]): Timetable {
  const evas = [FRANKFURT, MANNHEIM, STUTTGART, BERLIN];
  return new Timetable({
    feedVersionId: 1,
    feedVersion: "v1",
    publishedOn: "2026-10-19",
    trips,
    calendars: new Map([
      [
        "S",
        {
          weekdays: 127,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          added: new Set(),
          removed: new Set(),
        },
      ],
    ]),
    routes: new Map(),
    stopPoints: new Map(
      evas.map((eva) => [`p${eva}`, { stopPlaceId: place(eva), platform: null }]),
    ),
    stopPlaces: new Map(
      evas.map((eva) => [
        place(eva),
        { name: String(eva), eva, uic: null, lon: null, lat: null, countryCode: "DE", dhid: null },
      ]),
    ),
    delfiStopPoints: new Map(),
    delfiStopPlaces: new Map(),
  });
}

const at = (seconds: number) => serviceInstant(DATE, seconds) / 1000;

function stop(eva: number, arrival: number | null, departure: number | null): StopTimeObservation {
  return {
    stopSequence: null,
    stop: { kind: "uic", code: eva },
    arrival:
      arrival === null
        ? null
        : { time: at(arrival) + 300, delaySeconds: 300, uncertaintySeconds: null },
    departure: null,
    relationship: "scheduled",
    assignedStop: null,
    scheduled: {
      arrival: arrival === null ? null : at(arrival),
      departure: departure === null ? null : at(departure),
    },
  };
}

function iris(
  trainNumber: string | null,
  stops: StopTimeObservation[],
  longDistance: boolean | null = true,
): TripObservation {
  return {
    kind: "trip",
    source: "db-iris",
    entityId: "1-2610251800",
    observedAt: serviceInstant(DATE, 20 * H),
    feedTimestamp: null,
    updateTimestamp: null,
    sourceTripId: "1-2610251800",
    routeId: null,
    directionId: null,
    startDate: DATE,
    startTime: "18:00:00",
    trainNumber,
    categoryLabel: longDistance ? "ICE" : "RE",
    longDistance,
    relationship: "scheduled",
    vehicleId: null,
    vehicleLabel: null,
    delaySeconds: null,
    stops,
  };
}

const ICE = trip("ICE990", [STUTTGART, MANNHEIM, FRANKFURT], [21 * H, 22 * H, 23 * H], {
  trainNumber: "990",
});

describe("Matcher for IRIS trips", () => {
  it("matches by train number and the planned time at one station", () => {
    const match = new Matcher(timetable([ICE])).match(iris("990", [stop(FRANKFURT, 23 * H, null)]));
    expect(match).toMatchObject({ kind: "matched", method: "train_number" });
    const placed = match as MatchedTrip;
    expect(placed.run.trip.tripKey).toBe("ICE990");
    expect(placed.placements.map((placement) => placement.index)).toEqual([2]);
    expect(placed.unplacedStops).toBe(0);
  });

  it("reads leading zeros of a number as the same train", () => {
    const match = new Matcher(timetable([ICE])).match(
      iris("0990", [stop(FRANKFURT, 23 * H, null)]),
    );
    expect(match.kind).toBe("matched");
  });

  it("does not take a train of the same number at another time", () => {
    const match = new Matcher(timetable([ICE])).match(
      iris("990", [stop(FRANKFURT, 23 * H + 600, null)]),
    );
    expect(match).toMatchObject({ kind: "unmatched", reason: "train_number_times_differ" });
  });

  it("places a stop at a meta EVA on its main station", () => {
    const berlin = trip("ICE1", [BERLIN, FRANKFURT], [18 * H, 23 * H], { trainNumber: "1" });
    const match = new Matcher(timetable([berlin])).match(
      iris("1", [stop(8098160, null, 18 * H + 120), stop(FRANKFURT, 23 * H, null)]),
    );
    expect(match).toMatchObject({ kind: "matched", method: "train_number" });
    expect((match as MatchedTrip).placements.map((placement) => placement.index)).toEqual([0, 1]);
  });

  it("matches a train without a number by planned stops and times", () => {
    const flix = trip("FLX", [STUTTGART, MANNHEIM, FRANKFURT], [20 * H, 21 * H, 22 * H], {
      categoryCode: "ld",
    });
    const match = new Matcher(timetable([flix, ICE])).match(
      iris(null, [stop(MANNHEIM, 21 * H, null), stop(FRANKFURT, 22 * H, null)]),
    );
    expect(match).toMatchObject({ kind: "matched", method: "stops_and_times" });
    expect((match as MatchedTrip).run.trip.tripKey).toBe("FLX");
  });

  it("matches one known station by kind and planned time only when one run of that kind calls then", () => {
    const flix = trip("FLX", [STUTTGART, FRANKFURT], [20 * H, 23 * H], { categoryCode: "ld" });
    const regional = trip("RE", [MANNHEIM, FRANKFURT], [22 * H, 23 * H], { categoryCode: "reg" });
    const matcher = new Matcher(timetable([flix, regional]));
    const single = matcher.match(iris(null, [stop(FRANKFURT, 23 * H, null)]));
    expect((single as MatchedTrip).run?.trip.tripKey).toBe("FLX");
    const unknownKind = matcher.match(iris(null, [stop(FRANKFURT, 23 * H, null)], null));
    expect(unknownKind).toMatchObject({ kind: "unmatched", reason: "no_timetable_candidate" });
  });

  it("never takes a run that carries another number by stops and times", () => {
    const other = trip("ICE2", [MANNHEIM, FRANKFURT], [22 * H, 23 * H], { trainNumber: "2" });
    const match = new Matcher(timetable([other])).match(
      iris("990", [stop(MANNHEIM, 22 * H, null), stop(FRANKFURT, 23 * H, null)]),
    );
    expect(match).toMatchObject({ kind: "unmatched", reason: "train_number_not_in_timetable" });
  });

  it("prefers the run of the kind IRIS names when two runs share a number and time", () => {
    const regional = trip("RB990", [MANNHEIM, FRANKFURT], [22 * H, 23 * H], {
      trainNumber: "990",
      categoryCode: "reg",
    });
    const match = new Matcher(timetable([ICE, regional])).match(
      iris("990", [stop(FRANKFURT, 23 * H, null)]),
    );
    expect((match as MatchedTrip).run.trip.tripKey).toBe("ICE990");
  });

  it("stays ambiguous between two trains of the same number, kind and time", () => {
    const twin = trip("ICE990b", [MANNHEIM, FRANKFURT], [22 * H + 600, 23 * H], {
      trainNumber: "990",
      operatorId: "other",
    });
    const match = new Matcher(timetable([ICE, twin])).match(
      iris("990", [stop(FRANKFURT, 23 * H, null)]),
    );
    expect(match).toMatchObject({ kind: "unmatched", reason: "ambiguous_train_number" });
  });

  it("reports a trip whose stations are all unknown", () => {
    const match = new Matcher(timetable([ICE])).match(iris("990", [stop(8500010, 23 * H, null)]));
    expect(match).toMatchObject({ kind: "unmatched", reason: "no_planned_stop_known" });
  });

  it("leaves IRIS trips of regional runs out of scope (D-041)", () => {
    const regional = trip("RE4543", [MANNHEIM, FRANKFURT], [22 * H, 23 * H], {
      trainNumber: "4543",
      categoryCode: "rfast",
    });
    const match = new Matcher(timetable([regional])).match(
      iris("4543", [stop(MANNHEIM, 22 * H, null), stop(FRANKFURT, 23 * H, null)], false),
    );
    expect(match).toMatchObject({ kind: "out_of_scope", reason: "iris_not_long_distance" });
    const night = trip("NJ403", [MANNHEIM, FRANKFURT], [22 * H, 23 * H], {
      trainNumber: "403",
      categoryCode: "night",
    });
    const nightMatch = new Matcher(timetable([night])).match(
      iris("403", [stop(FRANKFURT, 23 * H, null)]),
    );
    expect(nightMatch).toMatchObject({ kind: "matched", method: "train_number" });
  });

  it("does not take an unnumbered run for a numbered extra train at one station", () => {
    const flix = trip("FLX", [STUTTGART, FRANKFURT], [20 * H, 23 * H], { categoryCode: "ld" });
    const regional = trip("RB", [MANNHEIM, FRANKFURT], [22 * H, 23 * H], { categoryCode: "reg" });
    const matcher = new Matcher(timetable([flix, regional]));
    const extra = matcher.match(iris("70388", [stop(FRANKFURT, 23 * H, null)], false));
    expect(extra).toMatchObject({ kind: "unmatched", reason: "train_number_not_in_timetable" });
    const special = matcher.match({
      ...iris("2851", [stop(FRANKFURT, 23 * H, null)]),
      categoryLabel: "ICE",
    });
    expect(special).toMatchObject({ kind: "unmatched", reason: "train_number_not_in_timetable" });
    const flixByCategory = matcher.match({
      ...iris("1247", [stop(FRANKFURT, 23 * H, null)]),
      categoryLabel: "FLX",
    });
    expect((flixByCategory as MatchedTrip).run?.trip.tripKey).toBe("FLX");
    const twoStops = trip("FLX2", [MANNHEIM, FRANKFURT], [21 * H, 22 * H], { categoryCode: "ld" });
    const byTwo = new Matcher(timetable([twoStops])).match({
      ...iris("2851", [stop(MANNHEIM, 21 * H, null), stop(FRANKFURT, 22 * H, null)]),
      categoryLabel: "ICE",
    });
    expect(byTwo).toMatchObject({ kind: "matched", method: "stops_and_times" });
  });

  it("places a stop at a station the run calls at twice by its planned time", () => {
    const loop = trip("ICE5", [FRANKFURT, MANNHEIM, FRANKFURT], [20 * H, 21 * H, 22 * H], {
      trainNumber: "5",
    });
    const match = new Matcher(timetable([loop])).match(iris("5", [stop(FRANKFURT, 22 * H, null)]));
    expect(match).toMatchObject({ kind: "matched", method: "train_number" });
    expect((match as MatchedTrip).placements.map((placement) => placement.index)).toEqual([2]);
    const both = new Matcher(timetable([loop])).match(
      iris("5", [stop(FRANKFURT, null, 20 * H + 120), stop(FRANKFURT, 22 * H, null)]),
    );
    expect((both as MatchedTrip).placements.map((placement) => placement.index)).toEqual([0, 2]);
  });

  it("needs the start date IRIS gives in its stop ids", () => {
    const match = new Matcher(timetable([ICE])).match({
      ...iris("990", [stop(FRANKFURT, 23 * H, null)]),
      startDate: null,
    });
    expect(match).toMatchObject({ kind: "unmatched", reason: "no_start_date" });
  });
});
