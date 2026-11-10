import type { TripObservation } from "@gerlines/schema";
import { serviceInstant } from "@gerlines/schema/service-day";
import { describe, expect, it } from "vitest";
import type { ForeignTimetable, ForeignTrip } from "./foreign-timetable.ts";
import { type MatchedTrip, Matcher } from "./matcher.ts";
import { NO_TIME, type StaticTrip, Timetable } from "./timetable.ts";

const DATE = "2026-10-25";
const place = (n: number) => `00000000-0000-5000-8000-${String(n).padStart(12, "0")}`;
const point = (n: number) => `00000000-0000-5000-9000-${String(n).padStart(12, "0")}`;

function trip(
  tripKey: string,
  places: number[],
  times: number[],
  extra: Partial<StaticTrip> = {},
): StaticTrip {
  return {
    tripKey,
    routeKey: "R_106",
    serviceKey: "S",
    operatorId: "op-a",
    trainNumber: tripKey.replace(/\D/g, "") || null,
    categoryCode: "reg",
    isForeign: false,
    stopPoints: places.map(point),
    stopPlaces: places.map(place),
    stopSequences: Int32Array.from(places, (_, index) => index),
    arrivals: Int32Array.from(times),
    departures: Int32Array.from(times),
    ...extra,
  };
}

function timetable(
  trips: StaticTrip[],
  version: { feedVersionId: number; feedVersion: string; publishedOn: string } = {
    feedVersionId: 1,
    feedVersion: "2026-10-17T14:46:34",
    publishedOn: "2026-10-19",
  },
): Timetable {
  const places = [...new Set(trips.flatMap((t) => t.stopPlaces))];
  return new Timetable({
    ...version,
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
    routes: new Map([["R_106", { operatorId: "op-a", categoryCode: "reg" }]]),
    stopPoints: new Map(
      trips.flatMap((t) =>
        t.stopPoints.map((p, i): [string, { stopPlaceId: string; platform: null }] => [
          p,
          { stopPlaceId: t.stopPlaces[i] ?? "", platform: null },
        ]),
      ),
    ),
    stopPlaces: new Map(
      places.map((id) => [
        id,
        {
          name: id,
          eva: null,
          uic: null,
          lon: null,
          lat: null,
          countryCode: Number(id.slice(-12)) >= 900 ? "CZ" : "DE",
          dhid: null,
        },
      ]),
    ),
    delfiStopPoints: new Map(
      trips.flatMap((t) => t.stopPoints.map((p): [string, string] => [dhid(p), p])),
    ),
    delfiStopPlaces: new Map(),
  });
}

const dhid = (stopPoint: string) => `de:11000:${Number(stopPoint.slice(-12))}::1`;

/** A foreign timetable whose stop ids are `s<n>` for place n. */
function foreign(trips: Record<string, { places: number[]; times: number[] }>): ForeignTimetable {
  const byId = new Map<string, ForeignTrip>(
    Object.entries(trips).map(([tripId, value]) => [
      tripId,
      {
        tripId,
        routeShortName: null,
        stopIds: value.places.map((n) => `s${n}`),
        times: Int32Array.from(value.places, (_, i) => value.times[i] ?? NO_TIME),
      },
    ]),
  );
  return {
    trip: (tripId) => byId.get(tripId),
    placeOfStop: (stopId) => (/^s\d+$/.test(stopId) ? place(Number(stopId.slice(1))) : undefined),
  };
}

function observation(source: string, sourceTripId: string): TripObservation {
  return {
    kind: "trip",
    source,
    entityId: sourceTripId,
    observedAt: serviceInstant(DATE, 40_000),
    feedTimestamp: null,
    updateTimestamp: null,
    sourceTripId,
    routeId: "R_106",
    directionId: null,
    startDate: DATE,
    startTime: null,
    trainNumber: null,
    relationship: "scheduled",
    vehicleId: null,
    vehicleLabel: null,
    delaySeconds: null,
    stops: [],
  };
}

const H = 3600;

describe("Matcher by stops and times", () => {
  it("prefers the run with no stops left over when two runs fit every reported stop", () => {
    const table = timetable([
      trip(
        "B86978",
        [10, 11, 12, 1, 2, 3],
        [11 * H, 11 * H + 600, 11 * H + 1200, 12 * H, 12 * H + 600, 12 * H + 1200],
      ),
      trip("A86878", [1, 2, 3], [12 * H, 12 * H + 600, 12 * H + 1200]),
    ]);
    const matcher = new Matcher(
      table,
      new Map([
        [
          "gtfsde-rt",
          foreign({ g1: { places: [1, 2, 3], times: [12 * H, 12 * H + 600, 12 * H + 1200] } }),
        ],
      ]),
    );
    const match = matcher.match(observation("gtfsde-rt", "g1"));
    expect(match).toMatchObject({ kind: "matched", method: "stops_and_times" });
    expect((match as MatchedTrip).run.trip.tripKey).toBe("A86878");
  });

  it("prefers exact minutes over a minute off when fits and stops left over are level", () => {
    const table = timetable([
      trip("A1", [1, 2, 3], [12 * H + 60, 12 * H + 660, 12 * H + 1260]),
      trip("B2", [1, 2, 3], [12 * H, 12 * H + 600, 12 * H + 1200]),
    ]);
    const matcher = new Matcher(
      table,
      new Map([
        [
          "gtfsde-rt",
          foreign({ g1: { places: [1, 2, 3], times: [12 * H, 12 * H + 600, 12 * H + 1200] } }),
        ],
      ]),
    );
    expect((matcher.match(observation("gtfsde-rt", "g1")) as MatchedTrip).run.trip.tripKey).toBe(
      "B2",
    );
  });

  it("takes the smallest trip key when two runs share every place and time", () => {
    const times = [12 * H, 12 * H + 600, 12 * H + 1200];
    const table = timetable([
      trip("Z5001", [1, 2, 3], times, { operatorId: "op-b" }),
      trip("M1330008", [1, 2, 3], times),
    ]);
    const matcher = new Matcher(
      table,
      new Map([["gtfsde-rt", foreign({ g1: { places: [1, 2, 3], times } })]]),
    );
    expect((matcher.match(observation("gtfsde-rt", "g1")) as MatchedTrip).run.trip.tripKey).toBe(
      "M1330008",
    );
  });

  it("stays ambiguous when two different runs fit equally well", () => {
    const table = timetable([
      trip("A1", [1, 2, 3, 4], [12 * H, 12 * H + 600, 12 * H + 1200, 12 * H + 1800]),
      trip("B2", [1, 2, 3, 5], [12 * H, 12 * H + 600, 12 * H + 1200, 12 * H + 2400]),
    ]);
    const matcher = new Matcher(
      table,
      new Map([
        [
          "gtfsde-rt",
          foreign({ g1: { places: [1, 2, 3], times: [12 * H, 12 * H + 600, 12 * H + 1200] } }),
        ],
      ]),
    );
    expect(matcher.match(observation("gtfsde-rt", "g1"))).toMatchObject({
      kind: "unmatched",
      reason: "ambiguous_candidates",
    });
  });
});

describe("Matcher by stops and times around local midnight", () => {
  const gtfsde = (times: number[]) =>
    new Map([["gtfsde-rt", foreign({ g1: { places: [1, 2], times } })]]);
  const on = (date: string): TripObservation => ({
    ...observation("gtfsde-rt", "g1"),
    startDate: date,
    observedAt: serviceInstant(date, 600),
  });
  const cases: [string, string, number][] = [
    ["00:30 CET", "2026-10-26", 30 * 60],
    ["01:30 CEST", "2026-10-24", 90 * 60],
    ["00:30 on the day clocks go back", "2026-10-25", 30 * 60],
    ["01:30 on the day clocks go back", "2026-10-25", 90 * 60],
    ["00:30 on the day clocks go forward", "2026-03-29", 30 * 60],
    ["23:50 the evening before", "2026-10-25", 23 * H + 50 * 60],
    ["00:20 past midnight as 24:20", "2026-10-25", 24 * H + 20 * 60],
  ];
  for (const [label, date, start] of cases) {
    it(`matches a trip leaving at ${label} (${date})`, () => {
      const times = [start, start + 600];
      const matcher = new Matcher(timetable([trip("N1", [1, 2], times)]), gtfsde(times));
      const match = matcher.match(on(date));
      expect(match).toMatchObject({ kind: "matched", method: "stops_and_times" });
      expect((match as MatchedTrip).run.serviceDate).toBe(date);
    });
  }

  it("finds a neighbour's train past midnight by number on the day before", () => {
    const night = trip("K40", [901, 1, 2], [23 * H, 26 * H, 27 * H]);
    const time = (seconds: number) => ({
      delaySeconds: 0,
      time: serviceInstant("2026-10-26", seconds) / 1000,
      uncertaintySeconds: null,
    });
    const stop = (seconds: number) => ({
      stopSequence: null,
      stop: { kind: "source" as const, id: "cz:x" },
      arrival: time(seconds),
      departure: time(seconds),
      relationship: "scheduled" as const,
      assignedStop: null,
    });
    const match = new Matcher(timetable([night])).match({
      ...observation("cz-czptt-gtfs-rt", "cz-40"),
      startDate: null,
      trainNumber: "40",
      observedAt: Date.parse("2026-10-27T01:30:00Z"),
      stops: [stop(23 * H), stop(26 * H), stop(27 * H)],
    });
    expect(match).toMatchObject({ kind: "matched", method: "train_number" });
    expect((match as MatchedTrip).run.serviceDate).toBe("2026-10-26");
  });
});

describe("Matcher ties and unknown places", () => {
  it("stays ambiguous when a third run fits as well as the best two", () => {
    const times = [12 * H, 12 * H + 600, 12 * H + 1200];
    const table = timetable([
      trip("A1", [1, 2, 3], times),
      trip("A2", [1, 2, 3], times),
      trip("B3", [1, 2, 3], [12 * H, 12 * H + 600, 12 * H + 1220]),
    ]);
    const matcher = new Matcher(
      table,
      new Map([["gtfsde-rt", foreign({ g1: { places: [1, 2, 3], times } })]]),
    );
    expect(matcher.match(observation("gtfsde-rt", "g1"))).toMatchObject({
      kind: "unmatched",
      reason: "ambiguous_candidates",
    });
  });

  it("leaves an added trip unmatched when a stop point has no stop place", () => {
    const table = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])]);
    const orphan = "00000000-0000-5000-9000-000000000099";
    const data = {
      ...table.data,
      delfiStopPoints: new Map([...table.data.delfiStopPoints, ["de:orphan", orphan]]),
    };
    const time = (i: number) => ({
      delaySeconds: 0,
      time: serviceInstant(DATE, 12 * H + i * 600) / 1000,
      uncertaintySeconds: null,
    });
    const match = new Matcher(new Timetable(data)).match({
      ...observation("delfi-gtfs-rt", "added-2"),
      relationship: "added",
      stops: [dhid(point(1)), "de:orphan"].map((id, i) => ({
        stopSequence: i,
        stop: { kind: "source" as const, id },
        arrival: time(i),
        departure: time(i),
        relationship: "scheduled" as const,
        assignedStop: null,
      })),
    });
    expect(match).toMatchObject({ kind: "unmatched", reason: "added_stops_unknown" });
  });
});

describe("Matcher feed versions", () => {
  const OLD = { feedVersionId: 1, feedVersion: "2026-10-17T14:46:34", publishedOn: "2026-10-19" };
  const NEW = { feedVersionId: 2, feedVersion: "2026-10-24T14:58:08", publishedOn: "2026-10-26" };
  const table = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])]);
  const reportedStops = (date: string, places: number[], times: number[]) =>
    places.map((n, i) => {
      const time = {
        delaySeconds: 60,
        time: serviceInstant(date, times[i] ?? 0) / 1000 + 60,
        uncertaintySeconds: null,
      };
      return {
        stopSequence: i,
        stop: { kind: "source" as const, id: dhid(point(n)) },
        arrival: time,
        departure: time,
        relationship: "scheduled" as const,
        assignedStop: null,
      };
    });
  const delfi = (tripId: string, date: string, stops: TripObservation["stops"] = []) => ({
    ...observation("delfi-gtfs-rt", tripId),
    startDate: date,
    observedAt: serviceInstant(date, 11 * H),
    stops,
  });

  it("reads DELFI trip ids against the payload's feed version only", () => {
    const matcher = new Matcher(table);
    expect(matcher.match(observation("delfi-gtfs-rt", "T1"), OLD.feedVersion)).toMatchObject({
      kind: "matched",
      method: "trip_id",
    });
    expect(matcher.match(observation("delfi-gtfs-rt", "T1"), "2026-10-24T15:00:00")).toMatchObject({
      kind: "unmatched",
      reason: "feed_version_not_loaded",
      detail: { feedVersion: "2026-10-24T15:00:00", loaded: OLD.feedVersion },
    });
  });

  it("matches as before when the payload names no feed version", () => {
    expect(new Matcher(table).match(observation("delfi-gtfs-rt", "T1"))).toMatchObject({
      kind: "matched",
    });
  });

  it("reads a trip id reused by the next version as the train of the payload's version", () => {
    const older = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])], OLD);
    const newer = timetable([trip("T1", [3, 4], [15 * H, 15 * H + 600])], NEW);
    const matcher = new Matcher([older, newer]);
    const before = matcher.match(delfi("T1", "2026-10-26"), OLD.feedVersion) as MatchedTrip;
    const after = matcher.match(delfi("T1", "2026-10-27"), NEW.feedVersion) as MatchedTrip;
    expect(before.run.trip.stopPlaces).toEqual([place(1), place(2)]);
    expect(before.run.feedVersionId).toBe(1);
    expect(after.run.trip.stopPlaces).toEqual([place(3), place(4)]);
    expect(after.run.feedVersionId).toBe(2);
  });

  it("reads an id the payload's version lacks in the other loaded version when its stops agree", () => {
    const older = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])], OLD);
    const newer = timetable([trip("N7", [3, 4], [15 * H, 15 * H + 600])], NEW);
    const matcher = new Matcher([older, newer]);
    const agreeing = reportedStops("2026-10-27", [1, 2], [12 * H, 12 * H + 600]);
    const match = matcher.match(delfi("T1", "2026-10-27", agreeing), NEW.feedVersion);
    expect(match).toMatchObject({ kind: "matched", method: "trip_id_other_version" });
    expect((match as MatchedTrip).run.feedVersionId).toBe(1);
    expect((match as MatchedTrip).placements.map((p) => p.index)).toEqual([0, 1]);
    expect(matcher.match(delfi("T1", "2026-10-27"), NEW.feedVersion)).toMatchObject({
      method: "trip_id_other_version",
    });
    const elsewhere = reportedStops("2026-10-27", [3, 4], [12 * H, 12 * H + 600]);
    expect(matcher.match(delfi("T1", "2026-10-27", elsewhere), NEW.feedVersion)).toMatchObject({
      kind: "unmatched",
      reason: "trip_not_in_timetable",
    });
  });

  it("gives an unchanged train the same instance in both versions", () => {
    const older = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])], OLD);
    const newer = timetable(
      [trip("X9", [1, 2], [12 * H, 12 * H + 600], { trainNumber: "1" })],
      NEW,
    );
    const matcher = new Matcher([older, newer]);
    const a = matcher.match(delfi("T1", "2026-10-27"), OLD.feedVersion) as MatchedTrip;
    const b = matcher.match(delfi("X9", "2026-10-27"), NEW.feedVersion) as MatchedTrip;
    expect(a.run.instanceId).toBe(b.run.instanceId);
    expect([a.run.feedVersionId, b.run.feedVersionId]).toEqual([1, 2]);
  });

  it("matches a version not loaded yet by stops and times against the newest loaded one", () => {
    const older = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])], OLD);
    const matcher = new Matcher([older]);
    const stops = reportedStops("2026-10-27", [1, 2], [12 * H, 12 * H + 600]);
    const match = matcher.match(delfi("NEW-ID", "2026-10-27", stops), NEW.feedVersion);
    expect(match).toMatchObject({ kind: "matched", method: "stops_and_times" });
    expect((match as MatchedTrip).placements.map((p) => p.index)).toEqual([0, 1]);
    expect(matcher.match(delfi("NEW-ID", "2026-10-27"), NEW.feedVersion)).toMatchObject({
      kind: "unmatched",
      reason: "feed_version_not_loaded",
      detail: { feedVersion: NEW.feedVersion },
    });
  });

  it("matches other sources against the version published before the service day", () => {
    const older = timetable([trip("A100", [1, 2], [12 * H, 12 * H + 600])], OLD);
    const newer = timetable([trip("B200", [1, 2], [12 * H, 12 * H + 600])], NEW);
    const times = [12 * H, 12 * H + 600];
    const matcher = new Matcher(
      [older, newer],
      new Map([["gtfsde-rt", foreign({ g1: { places: [1, 2], times } })]]),
    );
    const on = (date: string) =>
      matcher.match({ ...observation("gtfsde-rt", "g1"), startDate: date }) as MatchedTrip;
    expect(on("2026-10-26").run.trip.tripKey).toBe("A100");
    expect(on("2026-10-27").run.trip.tripKey).toBe("B200");
    expect(on("2026-10-27").run.feedVersionId).toBe(2);
  });

  it("reads the de-incremented feed, which names no version, by the service day's version", () => {
    const older = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])], OLD);
    const newer = timetable([trip("T1", [3, 4], [15 * H, 15 * H + 600])], NEW);
    const matcher = new Matcher([older, newer]);
    const deincr = (date: string) =>
      matcher.match({ ...delfi("T1", date), source: "delfi-gtfs-rt-deincr" }) as MatchedTrip;
    expect(deincr("2026-10-26").run.feedVersionId).toBe(1);
    expect(deincr("2026-10-27").run.feedVersionId).toBe(2);
  });

  it("keeps at most two versions and forgets cached outcomes when one is added", () => {
    const older = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])], OLD);
    const newer = timetable([trip("T1", [3, 4], [15 * H, 15 * H + 600])], NEW);
    const third = timetable([trip("T1", [5, 6], [9 * H, 9 * H + 600])], {
      feedVersionId: 3,
      feedVersion: "2026-10-31T10:00:00",
      publishedOn: "2026-11-02",
    });
    const matcher = new Matcher([older]);
    const third_ = "2026-10-31T10:00:00";
    expect(matcher.match(delfi("T1", "2026-11-03"), third_)).toMatchObject({ kind: "unmatched" });
    matcher.addTimetable(newer);
    matcher.addTimetable(third);
    expect(matcher.versions()).toEqual([NEW.feedVersion, third_]);
    expect(matcher.match(delfi("T1", "2026-11-03"), third_)).toMatchObject({
      kind: "matched",
      method: "trip_id",
    });
  });
});

describe("Matcher by train number", () => {
  const reported = (seconds: number, delay: number, stopId: string) => {
    const time = {
      delaySeconds: delay,
      time: serviceInstant(DATE, seconds) / 1000 + delay,
      uncertaintySeconds: null,
    };
    return {
      stopSequence: null,
      stop: { kind: "source" as const, id: stopId },
      arrival: time,
      departure: time,
      relationship: "scheduled" as const,
      assignedStop: null,
    };
  };
  const czech = (stops: TripObservation["stops"]): TripObservation => ({
    ...observation("cz-czptt-gtfs-rt", "cz-1"),
    trainNumber: "20832",
    stops,
  });
  const through = trip("K20832", [901, 1, 2], [12 * H, 12 * H + 900, 12 * H + 1800]);

  it("matches a cross-border train whose times agree and places its stops by time", () => {
    const matcher = new Matcher(timetable([through]));
    const match = matcher.match(
      czech([
        reported(11 * H, 120, "cz:a"),
        reported(12 * H, 120, "cz:b"),
        reported(12 * H + 900, 180, "cz:c"),
      ]),
    );
    expect(match).toMatchObject({ kind: "matched", method: "train_number", unplacedStops: 1 });
    expect((match as MatchedTrip).placements.map((p) => p.index)).toEqual([0, 1]);
  });

  it("judges every observation of a neighbour trip on its own times, whatever came first", () => {
    const matcher = new Matcher(timetable([through]));
    expect(
      matcher.match(czech([reported(15 * H, 0, "cz:a"), reported(15 * H + 900, 0, "cz:b")])),
    ).toMatchObject({ kind: "unmatched", reason: "train_number_times_differ" });
    expect(
      matcher.match(czech([reported(12 * H, 60, "cz:b"), reported(12 * H + 900, 60, "cz:c")])),
    ).toMatchObject({ kind: "matched", method: "train_number" });
  });

  it("rejects a train of the same number whose times differ", () => {
    const other = trip("K20832", [901, 1, 2], [15 * H, 15 * H + 900, 15 * H + 1800]);
    const matcher = new Matcher(timetable([other]));
    expect(
      matcher.match(czech([reported(15 * H + 300, 0, "cz:a"), reported(15 * H + 1200, 0, "cz:b")])),
    ).toMatchObject({ kind: "unmatched", reason: "train_number_times_differ" });
  });

  it("picks the one train of a number whose times agree", () => {
    const late = trip("L20832", [901, 3, 4], [18 * H, 18 * H + 900, 18 * H + 1800]);
    const matcher = new Matcher(timetable([through, late]));
    const match = matcher.match(
      czech([reported(18 * H, 60, "cz:a"), reported(18 * H + 900, 60, "cz:b")]),
    );
    expect((match as MatchedTrip).run.trip.tripKey).toBe("L20832");
  });

  it("lines up predicted times by the source's stop sequence with a steady delay", () => {
    const predicted = (seconds: number, stopSequence: number | null) => {
      const time = {
        delaySeconds: null,
        time: serviceInstant(DATE, seconds) / 1000,
        uncertaintySeconds: null,
      };
      return {
        ...reported(seconds, 0, "cz:x"),
        stop: null,
        stopSequence,
        arrival: time,
        departure: time,
      };
    };
    const matched = new Matcher(timetable([through])).match(
      czech([
        predicted(12 * H + 420, 5),
        predicted(12 * H + 900 + 540, 6),
        predicted(12 * H + 1800 + 720, 7),
      ]),
    );
    expect(matched).toMatchObject({ kind: "matched", method: "train_number" });
    expect((matched as MatchedTrip).placements.map((p) => p.index)).toEqual([0, 1, 2]);
    const unsteady = new Matcher(timetable([through])).match(
      czech([predicted(12 * H + 300, 1), predicted(12 * H + 3000, 2), predicted(14 * H + 600, 3)]),
    );
    expect(unsteady).toMatchObject({ kind: "unmatched", reason: "train_number_times_differ" });
    const unnumbered = new Matcher(timetable([through])).match(
      czech([predicted(12 * H + 60, null), predicted(12 * H + 960, null)]),
    );
    expect(unnumbered).toMatchObject({ kind: "unmatched", reason: "train_number_times_differ" });
  });
});

describe("Matcher for VBB", () => {
  const times = [12 * H, 12 * H + 600, 12 * H + 1200];
  const table = timetable([trip("R1", [1, 2, 3], times)]);
  const vbb = (routeId: string, tripId: string): TripObservation => ({
    ...observation("vbb-gtfs-rt", tripId),
    routeId,
    stops: [1, 2, 3].map((n, i) => {
      const time = {
        delaySeconds: 60,
        time: serviceInstant(DATE, times[i] ?? 0) / 1000 + 60,
        uncertaintySeconds: null,
      };
      return {
        stopSequence: i,
        stop: { kind: "source" as const, id: dhid(point(n)) },
        arrival: time,
        departure: time,
        relationship: "scheduled" as const,
        assignedStop: null,
      };
    }),
  });

  it("matches rail trips by their DHID stops and times and leaves buses out of scope", () => {
    const matcher = new Matcher(table);
    const match = matcher.match(vbb("10676_106", "308775416"));
    expect(match).toMatchObject({ kind: "matched", method: "stops_and_times" });
    expect((match as MatchedTrip).placements.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(matcher.match(vbb("5252_3", "308395529"))).toEqual({
      kind: "out_of_scope",
      reason: "not_rail",
    });
  });
});

describe("Matcher for trips DELFI adds", () => {
  it("judges every observation of an added trip on its own stops", () => {
    const table = timetable([trip("T1", [1, 2], [12 * H, 12 * H + 600])]);
    const added = (stopIds: string[]): TripObservation => ({
      ...observation("delfi-gtfs-rt", "added-1"),
      relationship: "added",
      stops: stopIds.map((id, i) => {
        const time = {
          delaySeconds: 0,
          time: serviceInstant(DATE, 12 * H + i * 600) / 1000,
          uncertaintySeconds: null,
        };
        return {
          stopSequence: i,
          stop: { kind: "source" as const, id },
          arrival: time,
          departure: time,
          relationship: "scheduled" as const,
          assignedStop: null,
        };
      }),
    });
    const matcher = new Matcher(table);
    const known = [dhid(point(1)), dhid(point(2))];
    expect(matcher.match(added([...known, "de:0:unknown"]))).toMatchObject({
      kind: "unmatched",
      reason: "added_stops_unknown",
    });
    expect(matcher.match(added(known))).toMatchObject({ kind: "matched", method: "added" });
  });
});
