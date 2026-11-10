import type { StopTimeObservation, TripObservation } from "@gerlines/schema";
import { serviceInstant } from "@gerlines/schema/service-day";
import { describe, expect, it } from "vitest";
import { predictStops, SourceFold } from "./fold.ts";
import { IRIS_SOURCE } from "./iris.ts";
import { type MatchedTrip, Matcher } from "./matcher.ts";
import { emptyBatch } from "./rows.ts";
import { Timetable } from "./timetable.ts";

const PLACES = [
  "00000000-0000-5000-8000-00000000000a",
  "00000000-0000-5000-8000-00000000000b",
  "00000000-0000-5000-8000-00000000000c",
];
const POINTS = [
  "00000000-0000-5000-8000-0000000000a1",
  "00000000-0000-5000-8000-0000000000b1",
  "00000000-0000-5000-8000-0000000000c1",
];
const DATE = "2026-10-25";

function timetable(): Timetable {
  return new Timetable({
    feedVersionId: 1,
    feedVersion: "test",
    trips: [
      {
        tripKey: "T1",
        routeKey: "R1_106",
        serviceKey: "S1",
        operatorId: "test-op",
        trainNumber: "4711",
        categoryCode: "reg",
        isForeign: false,
        stopPoints: POINTS,
        stopPlaces: PLACES,
        stopSequences: Int32Array.from([0, 5, 9]),
        arrivals: Int32Array.from([43200, 43800, 44400]),
        departures: Int32Array.from([43200, 43860, 44400]),
      },
    ],
    calendars: new Map([
      [
        "S1",
        {
          weekdays: 64,
          startDate: "2026-10-01",
          endDate: "2026-12-01",
          added: new Set(),
          removed: new Set(),
        },
      ],
    ]),
    routes: new Map([["R1_106", { operatorId: "test-op", categoryCode: "reg" }]]),
    stopPoints: new Map(
      POINTS.map((point, index) => [point, { stopPlaceId: PLACES[index] ?? "", platform: "1" }]),
    ),
    stopPlaces: new Map(
      PLACES.map((place) => [
        place,
        { name: place, eva: null, uic: null, lon: null, lat: null, countryCode: "DE", dhid: null },
      ]),
    ),
    delfiStopPoints: new Map([
      ["de:1:a:1", POINTS[0] ?? ""],
      ["de:1:b:1", POINTS[1] ?? ""],
      ["de:1:c:1", POINTS[2] ?? ""],
    ]),
    delfiStopPlaces: new Map(),
  });
}

function stop(
  sequence: number,
  delay: number | null,
  relationship: StopTimeObservation["relationship"] = "scheduled",
): StopTimeObservation {
  const time =
    delay === null ? null : { delaySeconds: delay, time: null, uncertaintySeconds: null };
  return {
    stopSequence: sequence,
    stop: null,
    arrival: time,
    departure: time,
    relationship,
    assignedStop: null,
  };
}

function observation(overrides: Partial<TripObservation>): TripObservation {
  return {
    kind: "trip",
    source: "delfi-gtfs-rt",
    entityId: "T1|20261025",
    observedAt: serviceInstant(DATE, 42000),
    feedTimestamp: null,
    updateTimestamp: null,
    sourceTripId: "T1",
    routeId: "R1_106",
    directionId: null,
    startDate: DATE,
    startTime: null,
    trainNumber: null,
    relationship: "scheduled",
    vehicleId: null,
    vehicleLabel: null,
    delaySeconds: null,
    stops: [stop(0, 60)],
    ...overrides,
  };
}

describe("predictStops", () => {
  const stops = [
    { schedArr: null, schedDep: 100 },
    { schedArr: 200, schedDep: 210 },
    { schedArr: 300, schedDep: 310 },
    { schedArr: 400, schedDep: null },
  ];
  const placed = (index: number, observed: StopTimeObservation) => ({
    index,
    observed,
    actualStopPointId: null,
  });

  it("carries the last delay to later stops and predicts nothing before the first named stop", () => {
    const predictions = predictStops(stops, [placed(1, stop(5, 120))], null);
    expect(predictions.map((p) => [p.arrDelay, p.depDelay, p.kind])).toEqual([
      [null, null, null],
      [120, 120, "explicit"],
      [120, 120, "propagated"],
      [120, null, "propagated"],
    ]);
  });

  it("carries a positive first delay back to the stops before it when asked (IRIS)", () => {
    const predictions = predictStops(stops, [placed(2, stop(9, 300))], null, true);
    expect(predictions.map((p) => [p.arrDelay, p.depDelay, p.kind])).toEqual([
      [null, 300, "propagated"],
      [300, 300, "propagated"],
      [300, 300, "explicit"],
      [300, null, "propagated"],
    ]);
    const early = predictStops(stops, [placed(2, stop(9, -60))], null, true);
    expect(early.slice(0, 2).map((p) => [p.arrDelay, p.depDelay, p.kind])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
    const skippedFirst = predictStops(
      stops,
      [placed(1, stop(5, null, "skipped")), placed(2, stop(9, 240))],
      null,
      true,
    );
    expect(skippedFirst.map((p) => [p.depDelay, p.cancelled])).toEqual([
      [240, false],
      [null, true],
      [240, false],
      [null, false],
    ]);
  });

  it("cancels skipped stops and stops carrying after a stop without data", () => {
    const predictions = predictStops(
      stops,
      [
        placed(0, stop(0, 60)),
        placed(1, stop(5, null, "skipped")),
        placed(2, stop(9, null, "no_data")),
      ],
      null,
    );
    expect(predictions.map((p) => [p.depDelay, p.cancelled])).toEqual([
      [60, false],
      [null, true],
      [null, false],
      [null, false],
    ]);
  });

  it("applies a trip delay when no stop is named", () => {
    expect(predictStops(stops, [], 90).every((p) => p.depDelay === 90 || p.arrDelay === 90)).toBe(
      true,
    );
  });

  it("reads a delay earlier than 30 minutes as no data and marks it", () => {
    const predictions = predictStops(
      stops,
      [placed(0, stop(0, 60)), placed(1, stop(5, -10_800))],
      null,
    );
    expect(predictions.map((p) => [p.arrDelay, p.depDelay, p.kind, p.implausible])).toEqual([
      [null, 60, "explicit", false],
      [null, null, null, true],
      [null, null, null, false],
      [null, null, null, false],
    ]);
    const early = { delaySeconds: null, time: 200 - 7200, uncertaintySeconds: null };
    const byTime = predictStops(stops, [placed(1, { ...stop(5, null), arrival: early })], null);
    expect(byTime[1]).toMatchObject({ arrDelay: null, implausible: true });
    expect(
      predictStops(stops, [], -3600).every((p) => p.arrDelay === null && p.depDelay === null),
    ).toBe(true);
    expect(predictStops(stops, [placed(1, stop(5, -1800))], null)[1]).toMatchObject({
      arrDelay: -1800,
      implausible: false,
    });
  });
});

describe("Matcher and SourceFold", () => {
  it("matches DELFI by trip id and places stops by stop sequence", () => {
    const matcher = new Matcher(timetable());
    const match = matcher.match(observation({ stops: [stop(5, 30), stop(9, 30)] }));
    expect(match.kind).toBe("matched");
    expect((match as MatchedTrip).placements.map((p) => p.index)).toEqual([1, 2]);
    expect(matcher.match(observation({ sourceTripId: "X", routeId: "R9_3" }))).toEqual({
      kind: "out_of_scope",
      reason: "not_rail",
    });
    expect(matcher.match(observation({ startDate: "2026-10-26" }))).toMatchObject({
      kind: "unmatched",
      reason: "service_not_active",
    });
  });

  it("writes forecasts only on change, finals when time passes, and one leg per pair", () => {
    const table = timetable();
    const matcher = new Matcher(table);
    const fold = new SourceFold("delfi-gtfs-rt", table);
    const at = (seconds: number) => serviceInstant(DATE, seconds);
    const run = (seconds: number, delay: number) => {
      const obs = observation({ observedAt: at(seconds), stops: [stop(0, delay)] });
      const batch = emptyBatch();
      fold.apply(matcher.match(obs) as MatchedTrip, obs, obs.observedAt, `raw-${seconds}`, batch);
      fold.advance(obs.observedAt, `raw-${seconds}`, batch);
      return batch;
    };
    const first = run(42000, 60);
    expect(first.forecasts).toHaveLength(3);
    expect(first.stopEvents).toHaveLength(3);
    const same = run(42060, 60);
    expect(same.forecasts).toHaveLength(0);
    expect(same.stopEvents).toHaveLength(0);
    const later = run(43300, 60);
    expect(later.forecasts).toHaveLength(0);
    expect(later.stopEvents.map((row) => row.stopIndex)).toEqual([0]);
    expect(later.stopEvents[0]?.finalDeparture).toBe(at(43260) / 1000);
    const end = run(44500, 60);
    expect(
      end.segments.map((leg) => [leg.fromIndex, leg.toIndex, leg.depDelayFrom, leg.arrDelayTo]),
    ).toEqual([
      [0, 1, 60, 60],
      [1, 2, 60, 60],
    ]);
    expect(run(44600, 60).segments).toHaveLength(0);
  });

  it("emits one TripCancelled event and keeps the cancelled trip in memory", () => {
    const table = timetable();
    const matcher = new Matcher(table);
    const fold = new SourceFold("delfi-gtfs-rt", table);
    const events: string[] = [];
    for (const seconds of [42000, 42060, 42120]) {
      const obs = observation({
        observedAt: serviceInstant(DATE, seconds),
        relationship: "cancelled",
        stops: [],
      });
      const batch = emptyBatch();
      fold.apply(matcher.match(obs) as MatchedTrip, obs, obs.observedAt, "raw", batch);
      fold.advance(obs.observedAt, "raw", batch);
      events.push(...batch.events.map((event) => event.eventType));
      if (seconds > 42000) expect(batch.forecasts).toHaveLength(0);
    }
    expect(events).toEqual(["TripCancelled"]);
    expect(fold.activeInstances).toBe(1);
  });

  it("keeps predicted times in order along the run and counts the times it moved", () => {
    const table = timetable();
    const matcher = new Matcher(table);
    const fold = new SourceFold("delfi-gtfs-rt", table);
    const obs = observation({ stops: [stop(0, 600), stop(5, -300)] });
    const batch = emptyBatch();
    const result = fold.apply(matcher.match(obs) as MatchedTrip, obs, obs.observedAt, "raw", batch);
    const at = (seconds: number) => serviceInstant(DATE, seconds) / 1000;
    expect(
      batch.forecasts.map((row) => [row.stopIndex, row.predictedArrival, row.predictedDeparture]),
    ).toEqual([
      [0, at(43800), at(43800)],
      [1, at(43800), at(43800)],
      [2, at(44100), at(44100)],
    ]);
    expect(batch.forecasts[1]).toMatchObject({ arrivalDelay: 0, departureDelay: -60 });
    expect(result).toEqual({ implausibleDelays: 0, reordered: 2 });
  });

  it("never writes a leg whose actual run time is negative", () => {
    const table = timetable();
    const matcher = new Matcher(table);
    const fold = new SourceFold("delfi-gtfs-rt", table);
    const run = (seconds: number, stops: StopTimeObservation[]) => {
      const obs = observation({ observedAt: serviceInstant(DATE, seconds), stops });
      const batch = emptyBatch();
      fold.apply(matcher.match(obs) as MatchedTrip, obs, obs.observedAt, `raw-${seconds}`, batch);
      fold.advance(obs.observedAt, `raw-${seconds}`, batch);
      return batch;
    };
    run(43500, [stop(0, 600)]);
    run(43900, [stop(0, 600)]);
    const legs = run(44000, [stop(5, -120)]).segments;
    expect(legs.map((leg) => [leg.fromIndex, leg.toIndex, leg.runAct])).toEqual([[0, 1, 0]]);
    const ahead = run(44300, [stop(9, -10_800)]);
    expect(ahead.stopEvents.find((row) => row.stopIndex === 2)).toMatchObject({
      predictedArrival: null,
      finalArrival: null,
    });
    expect(ahead.segments).toHaveLength(0);
  });

  it("never lets a stop be left after the next stop was reached", () => {
    const table = timetable();
    const matcher = new Matcher(table);
    const fold = new SourceFold("delfi-gtfs-rt", table);
    const run = (seconds: number, stops: StopTimeObservation[]) => {
      const obs = observation({ observedAt: serviceInstant(DATE, seconds), stops });
      const batch = emptyBatch();
      fold.apply(matcher.match(obs) as MatchedTrip, obs, obs.observedAt, `raw-${seconds}`, batch);
      fold.advance(obs.observedAt, `raw-${seconds}`, batch);
      return batch;
    };
    run(43000, [stop(5, 0)]);
    run(43900, [stop(5, 0)]);
    const late = run(43950, [stop(0, 900), stop(5, 0)]);
    const at = (seconds: number) => serviceInstant(DATE, seconds) / 1000;
    expect(late.forecasts.find((row) => row.stopIndex === 0)?.predictedDeparture).toBe(at(43800));
    expect(late.segments.map((leg) => [leg.fromIndex, leg.toIndex, leg.runAct])).toEqual([
      [0, 1, 0],
    ]);
  });

  it("keeps a final time in the order even when the source then calls that stop skipped", () => {
    const table = timetable();
    const matcher = new Matcher(table);
    const fold = new SourceFold("delfi-gtfs-rt", table);
    const run = (seconds: number, stops: StopTimeObservation[]) => {
      const obs = observation({ observedAt: serviceInstant(DATE, seconds), stops });
      const batch = emptyBatch();
      fold.apply(matcher.match(obs) as MatchedTrip, obs, obs.observedAt, `raw-${seconds}`, batch);
      fold.advance(obs.observedAt, `raw-${seconds}`, batch);
      return batch;
    };
    run(43000, [stop(5, 0)]);
    run(43900, [stop(5, 0)]);
    const early = run(43950, [stop(5, null, "skipped"), stop(9, -600)]);
    const at = (seconds: number) => serviceInstant(DATE, seconds) / 1000;
    expect(early.forecasts.find((row) => row.stopIndex === 2)?.predictedArrival).toBe(at(43860));
  });

  it("places a later version's stops on the instance by place when its stop list changed", () => {
    const older = timetable();
    const base = older.data.trips[0];
    if (!base) throw new Error("fixture trip missing");
    const shorter = {
      ...base,
      tripKey: "T2",
      stopPoints: [POINTS[0] ?? "", POINTS[2] ?? ""],
      stopPlaces: [PLACES[0] ?? "", PLACES[2] ?? ""],
      stopSequences: Int32Array.from([0, 1]),
      arrivals: Int32Array.from([43200, 44400]),
      departures: Int32Array.from([43200, 44400]),
    };
    const newer = new Timetable({
      ...older.data,
      feedVersionId: 2,
      feedVersion: "next",
      publishedOn: "2026-10-26",
      trips: [shorter],
    });
    const matcher = new Matcher([older, newer]);
    const fold = new SourceFold("delfi-gtfs-rt", newer);
    const apply = (obs: TripObservation, version: string) => {
      const match = matcher.match(obs, version) as MatchedTrip;
      const batch = emptyBatch();
      fold.apply(match, obs, obs.observedAt, "raw", batch);
      return { match, batch };
    };
    const first = apply(observation({ stops: [stop(0, 60)] }), "test");
    const second = apply(
      observation({
        sourceTripId: "T2",
        stops: [stop(1, 120)],
        observedAt: serviceInstant(DATE, 42060),
      }),
      "next",
    );
    expect(second.match.run.instanceId).toBe(first.match.run.instanceId);
    expect(second.batch.forecasts.map((row) => [row.stopIndex, row.arrivalDelay])).toEqual([
      [0, null],
      [1, null],
      [2, 120],
    ]);
  });

  it("keeps a stop a written leg passed over as cancelled when the source later serves it", () => {
    const table = timetable();
    const matcher = new Matcher(table);
    const fold = new SourceFold("delfi-gtfs-rt", table);
    const run = (seconds: number, middle: StopTimeObservation) => {
      const obs = observation({
        observedAt: serviceInstant(DATE, seconds),
        stops: [stop(0, 60), middle, stop(9, 60)],
      });
      const batch = emptyBatch();
      fold.apply(matcher.match(obs) as MatchedTrip, obs, obs.observedAt, `raw-${seconds}`, batch);
      fold.advance(obs.observedAt, `raw-${seconds}`, batch);
      return batch;
    };
    run(42000, stop(5, null, "skipped"));
    const passed = run(44500, stop(5, null, "skipped"));
    expect(passed.segments.map((leg) => [leg.fromIndex, leg.toIndex])).toEqual([[0, 2]]);
    const served = run(44600, stop(5, 60));
    expect(served.segments).toHaveLength(0);
    expect(served.forecasts.filter((row) => row.stopIndex === 1)).toHaveLength(0);
    expect(served.stopEvents.filter((row) => row.stopIndex === 1)).toHaveLength(0);
  });
});

describe("SourceFold platform changes where the feed codes are stop numbers", () => {
  const KOELN = "de:05315:11201";
  const BIELEFELD = "de:05711:5500";
  const STUTTGART = "de:08111:6115";
  const SPARE = "00000000-0000-5000-8000-0000000000a2";

  /** Stop A carries the DHID and the two stop point codes under test; B and C have plain tracks. */
  function districtTable(dhid: string | null, planned: string, spare: string): Timetable {
    const base = timetable().data;
    return new Timetable({
      ...base,
      stopPoints: new Map([
        [POINTS[0] ?? "", { stopPlaceId: PLACES[0] ?? "", platform: planned }],
        [SPARE, { stopPlaceId: PLACES[0] ?? "", platform: spare }],
        [POINTS[1] ?? "", { stopPlaceId: PLACES[1] ?? "", platform: "4" }],
        [POINTS[2] ?? "", { stopPlaceId: PLACES[2] ?? "", platform: "1" }],
      ]),
      stopPlaces: new Map(
        PLACES.map((place, index) => [
          place,
          {
            name: place,
            eva: null,
            uic: null,
            lon: null,
            lat: null,
            countryCode: "DE",
            dhid: index === 0 ? dhid : null,
          },
        ]),
      ),
      delfiStopPoints: new Map([...base.delfiStopPoints, ["de:1:a:2", SPARE]]),
    });
  }

  /** Folds observations of stop A in turn on one fold of the given source. */
  function foldAll(table: Timetable, source: string, stops: StopTimeObservation[]) {
    const matcher = new Matcher(table);
    const fold = new SourceFold(source, table);
    return stops.map((first, turn) => {
      const seconds = 42000 + 60 * turn;
      const obs = observation({ observedAt: serviceInstant(DATE, seconds), stops: [first] });
      const batch = emptyBatch();
      const match = matcher.match(obs) as MatchedTrip;
      fold.apply(match, { ...obs, source }, obs.observedAt, `raw-${turn}`, batch);
      fold.advance(obs.observedAt, `raw-${turn}`, batch);
      return {
        changes: batch.events.filter((event) => event.eventType === "PlatformChanged"),
        actual: batch.stopEvents.find((row) => row.stopIndex === 0)?.platformActual,
      };
    });
  }

  const assigned: StopTimeObservation = {
    ...stop(0, 60),
    assignedStop: { kind: "source", id: "de:1:a:2" },
  };
  const named = (scheduled: string | null, actual: string | null): StopTimeObservation => ({
    ...stop(0, 60),
    platform: { scheduled, actual },
  });

  it.each([
    ["VRS", KOELN, "85", "86", null],
    ["VRS", KOELN, "5", "6", "6"],
    ["VRS", KOELN, "5", "86", null],
    ["VRS", KOELN, "86", "5", null],
    ["OWL", BIELEFELD, "91", "98", null],
    ["OWL", BIELEFELD, "91", "913", null],
    ["OWL", BIELEFELD, "1", "2", "2"],
    ["no DHID", null, "85", "86", "86"],
    ["plain tracks", STUTTGART, "85", "86", "86"],
    ["plain tracks", STUTTGART, "4", "5", "5"],
  ] as const)(
    "a DELFI stop point change in %s (%s) from %j to %j reports %j",
    (_district, dhid, planned, spare, expected) => {
      const [result] = foldAll(districtTable(dhid, planned, spare), "delfi-gtfs-rt", [assigned]);
      expect(result?.actual).toBe(expected);
      expect(result?.changes).toHaveLength(expected === null ? 0 : 1);
    },
  );

  it.each([
    ["VRS", KOELN, "85", "4", null, null],
    ["VRS", KOELN, "85", null, "4", null],
    ["VRS", KOELN, "85", "4", "5", "5"],
    ["VRS", KOELN, "5", null, "5", null],
    ["VRS", KOELN, "5", null, "6", "6"],
    ["OWL", BIELEFELD, "91", null, "1", null],
    ["OWL", BIELEFELD, "913", "1", "2", "2"],
    ["no DHID", null, "85", null, "4", "4"],
    ["plain tracks", STUTTGART, "4", null, "4", null],
    ["plain tracks", STUTTGART, "4", null, "5", "5"],
  ] as const)(
    "an IRIS track in %s (%s) with DELFI %j, IRIS planned %j and changed %j reports %j",
    (_district, dhid, planned, irisPlanned, irisChanged, expected) => {
      const table = districtTable(dhid, planned, "0");
      const [result] = foldAll(table, IRIS_SOURCE, [named(irisPlanned, irisChanged)]);
      expect(result?.actual).toBe(expected);
      expect(result?.changes).toHaveLength(expected === null ? 0 : 1);
    },
  );

  it("reports an IRIS change at Köln once its plan arrives, keeping the raw planned code", () => {
    const table = districtTable(KOELN, "85", "86");
    const [before, after] = foldAll(table, IRIS_SOURCE, [named(null, "5"), named("4", "5")]);
    expect(before?.changes).toHaveLength(0);
    expect(after?.actual).toBe("5");
    expect(after?.changes.map((event) => [event.stopIndex, event.sourceId, event.payload])).toEqual(
      [[0, IRIS_SOURCE, { serviceDate: DATE, scheduled: "85", actual: "5" }]],
    );
  });
});
