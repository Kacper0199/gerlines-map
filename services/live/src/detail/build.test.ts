import { TrainDetail } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import type { StaticRun } from "../model.ts";
import { placesWithin } from "../plan/place-rows.ts";
import { expectedTimes } from "../plan/trip-plan.ts";
import type { SourceView } from "../realtime/store.ts";
import { buildTrainDetail } from "./build.ts";
import type {
  DetailInput,
  SourceRow,
  StaticStopRow,
  StaticTripRow,
  StopEventRow,
} from "./model.ts";

const INSTANCE = "07a1535f-17cf-5e2b-b9b2-de13d923ef94";
const PLACE = {
  altona: "07d45fba-4bcb-58e1-8162-11a19164dbac",
  hbf: "17d45fba-4bcb-58e1-8162-11a19164dbac",
  solingen: "27d45fba-4bcb-58e1-8162-11a19164dbac",
  stuttgart: "37d45fba-4bcb-58e1-8162-11a19164dbac",
  munich: "47d45fba-4bcb-58e1-8162-11a19164dbac",
};
const T = (hhmm: string) => Date.parse(`2026-10-26T${hhmm}:00Z`);
const AT = {
  altona: { lon: 9.9346, lat: 53.552 },
  hbf: { lon: 10.0069, lat: 53.553 },
  solingen: { lon: 7.0043, lat: 51.1617 },
  munich: { lon: 11.5583, lat: 48.1402 },
};

const staticStops: StaticStopRow[] = [
  {
    index: 0,
    stopPlaceId: PLACE.altona,
    scheduledArrival: T("18:25"),
    scheduledDeparture: T("18:25"),
    platform: null,
    passenger: true,
  },
  {
    index: 1,
    stopPlaceId: PLACE.hbf,
    scheduledArrival: T("18:37"),
    scheduledDeparture: T("18:44"),
    platform: "8",
    passenger: true,
  },
  {
    index: 2,
    stopPlaceId: PLACE.solingen,
    scheduledArrival: T("22:27"),
    scheduledDeparture: T("22:28"),
    platform: "Gl. 1",
    passenger: true,
  },
  {
    index: 3,
    stopPlaceId: PLACE.stuttgart,
    scheduledArrival: T("23:27"),
    scheduledDeparture: T("23:39"),
    platform: "16",
    passenger: true,
  },
  {
    index: 4,
    stopPlaceId: PLACE.munich,
    scheduledArrival: T("23:59"),
    scheduledDeparture: T("23:59"),
    platform: "18",
    passenger: true,
  },
];

function event(
  sourceId: string,
  index: number,
  overrides: Partial<StopEventRow> = {},
): StopEventRow {
  const stop = staticStops[index];
  return {
    sourceId,
    index,
    stopPlaceId: stop?.stopPlaceId ?? PLACE.altona,
    scheduledArrival: stop?.scheduledArrival ?? null,
    scheduledDeparture: stop?.scheduledDeparture ?? null,
    predictedArrival: null,
    predictedDeparture: null,
    arrivalDelaySeconds: null,
    departureDelaySeconds: null,
    predictionKind: null,
    platformScheduled: null,
    platformActual: null,
    cancelled: false,
    observedAt: T("21:00"),
    ...overrides,
  };
}

function delayed(sourceId: string, index: number, seconds: number, observedAt = T("21:00")) {
  const stop = staticStops[index];
  return event(sourceId, index, {
    predictedArrival: (stop?.scheduledArrival ?? 0) + seconds * 1000,
    predictedDeparture: (stop?.scheduledDeparture ?? 0) + seconds * 1000,
    arrivalDelaySeconds: seconds,
    departureDelaySeconds: seconds,
    predictionKind: "explicit",
    observedAt,
  });
}

const sources: SourceRow[] = [
  {
    sourceId: "delfi-gtfs",
    name: "DELFI national GTFS timetable",
    attribution: "DELFI e.V.",
    licence: "CC-BY-4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    holders: [{ name: "DELFI e.V.", role: "publisher", url: "https://www.delfi.de/" }],
  },
  {
    sourceId: "gtfsde-rt",
    name: "gtfs.de realtime (free, beta)",
    attribution: "DELFI e.V. and GTFS.de",
    licence: "CC-BY-SA-4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    holders: [
      { name: "DELFI e.V.", role: "publisher", url: "https://www.delfi.de/" },
      { name: "GTFS.de", role: "aggregator", url: "https://gtfs.de/" },
    ],
  },
  {
    sourceId: "delfi-gtfs-rt",
    name: "DELFI GTFS-RT via the traines.eu community mirror",
    attribution: "DELFI e.V., mirrored by traines.eu",
    licence: "LicenseRef-dcat-ap-de-cc-by-sa",
    licenceUrl: "http://dcat-ap.de/def/licenses/cc-by-sa",
    holders: [
      { name: "DELFI e.V.", role: "publisher", url: "https://www.delfi.de/" },
      { name: "traines.eu", role: "mirror", url: "https://mirror.traines.eu/" },
    ],
  },
];

const baseTrip: StaticTripRow = {
  feedVersionId: 1,
  tripKey: "3448684827",
  categoryCode: "hsr",
  isForeign: false,
  line: "42",
  tripShortName: "000619",
  headsign: "München Hbf",
  operatorId: "db-fernverkehr-ag",
  product: "ICE",
  shapeQaStatus: "pass",
};

function input(overrides: Partial<DetailInput> = {}): DetailInput {
  return {
    ref: {
      tripInstanceId: INSTANCE,
      serviceDate: "2026-10-26",
      feedVersionId: 1,
      tripKey: "3448684827",
      frameKey: null,
    },
    asOf: T("22:00"),
    timetableVersion: "1",
    version: 7,
    trip: baseTrip,
    staticStops,
    instance: null,
    events: [],
    activity: [],
    places: new Map([
      [PLACE.altona, { name: "Hamburg-Altona", displayName: null, location: AT.altona }],
      [PLACE.hbf, { name: "Hamburg Hbf", displayName: null, location: AT.hbf }],
      [
        PLACE.solingen,
        { name: "Solingen, Hauptbahnhof", displayName: null, location: AT.solingen },
      ],
      [PLACE.stuttgart, { name: "Hauptbahnhof", displayName: "Stuttgart Hbf", location: null }],
      [PLACE.munich, { name: "München Hbf", displayName: null, location: AT.munich }],
    ]),
    operators: new Map([
      [
        "db-fernverkehr-ag",
        {
          operatorId: "db-fernverkehr-ag",
          name: "DB Fernverkehr AG",
          brandName: "DB Fernverkehr",
          wikidataQid: "Q896765",
        },
      ],
    ]),
    sources: new Map(sources.map((source) => [source.sourceId, source])),
    feedObservedAt: new Map([
      ["gtfsde-rt", T("21:59")],
      ["delfi-gtfs-rt", T("21:58")],
    ]),
    tick: null,
    ...overrides,
  };
}

const realtime = (overrides: Partial<DetailInput> = {}) =>
  input({
    instance: {
      tripInstanceId: INSTANCE,
      serviceDate: "2026-10-26",
      isAdded: false,
      trainNumber: "619",
      categoryCode: "hsr",
      operatorId: "db-fernverkehr-ag",
    },
    events: [
      delayed("gtfsde-rt", 1, 420),
      delayed("gtfsde-rt", 2, 1260, T("21:30")),
      event("gtfsde-rt", 3, { platformActual: "Gl. 15" }),
      delayed("delfi-gtfs-rt", 4, 60),
    ],
    activity: [
      { sourceId: "gtfsde-rt", firstSeen: T("20:00"), lastSeen: T("21:30") },
      { sourceId: "delfi-gtfs-rt", firstSeen: T("19:00"), lastSeen: T("21:00") },
    ],
    ...overrides,
  });

function built(value: DetailInput): TrainDetail {
  const result = buildTrainDetail(value);
  if (!result.ok) throw new Error(`build failed: ${result.reason}`);
  return TrainDetail.parse(result.detail);
}

describe("buildTrainDetail, timetable only", () => {
  const detail = built(input());

  it("names the product, the line and the number apart, so the card never shows the number alone", () => {
    expect(detail.productName).toBe("ICE");
    expect(detail.line).toBe("42");
    expect(detail.trainNumber).toBe("619");
  });

  it("invents no realtime: no predictions, no delays, timetable provenance", () => {
    expect(detail.delaySeconds).toBeNull();
    expect(detail.stops.every((stop) => stop.predictedArrival === null)).toBe(true);
    expect(detail.stops.every((stop) => stop.arrivalDelaySeconds === null)).toBe(true);
    expect(detail.provenance).toMatchObject({
      kind: "timetable",
      sourceId: "delfi-gtfs",
      predictionChangedAt: null,
      feedObservedAt: null,
      holders: [{ name: "DELFI e.V.", role: "publisher", url: "https://www.delfi.de/" }],
      licence: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    });
  });

  it("names stops with their town and reads platforms as on the sign", () => {
    expect(detail.stops.map((stop) => stop.name)).toContain("Stuttgart Hbf");
    expect(detail.stops[2]?.platformScheduled).toBe("1");
    expect(detail.stops[0]?.platformScheduled).toBeNull();
  });

  it("has no arrival at the origin and no departure at the destination", () => {
    expect(detail.stops[0]?.scheduledArrival).toBeNull();
    expect(detail.stops[4]?.scheduledDeparture).toBeNull();
  });

  it("places the train between the stops of the timetable", () => {
    expect(detail.progress).toEqual({ lastPassedIndex: 1, nextIndex: 2 });
  });

  it("takes the operator's brand and Wikidata item and the destination's display name", () => {
    expect(detail.operator).toEqual({
      id: "db-fernverkehr-ag",
      name: "DB Fernverkehr",
      wikidataQid: "Q896765",
    });
    expect(detail.destination).toEqual({ stopPlaceId: PLACE.munich, name: "München Hbf" });
  });
});

describe("buildTrainDetail, realtime", () => {
  it("follows the best ranked source for the category and never mixes sources per stop", () => {
    const detail = built(realtime());
    expect(detail.provenance.sourceId).toBe("gtfsde-rt");
    expect(detail.stops[4]?.predictedArrival).toBeNull();
    expect(detail.stops[2]).toMatchObject({
      predictedArrival: "2026-10-26T22:48:00.000Z",
      arrivalDelaySeconds: 1260,
      prediction: "explicit",
    });
  });

  it("gives the delay of the next stop and the provenance times of the chosen source", () => {
    const detail = built(realtime());
    expect(detail.delaySeconds).toBe(1260);
    expect(detail.provenance).toMatchObject({
      kind: "realtime",
      predictionChangedAt: "2026-10-26T21:30:00.000Z",
      feedObservedAt: "2026-10-26T21:59:00.000Z",
      holders: [
        { name: "DELFI e.V.", role: "publisher" },
        { name: "GTFS.de", role: "aggregator" },
      ],
    });
  });

  it("shows no data, not zero, when the next stop has no prediction", () => {
    const detail = built(realtime({ asOf: T("22:50") }));
    expect(detail.progress).toEqual({ lastPassedIndex: 2, nextIndex: 3 });
    expect(detail.delaySeconds).toBeNull();
    expect(detail.stops[3]?.platformActual).toBe("15");
    expect(detail.stops[3]?.platformScheduled).toBe("16");
  });

  it("takes the departure delay while the train stands at a stop", () => {
    const events = [
      delayed("gtfsde-rt", 1, 420),
      event("gtfsde-rt", 2, {
        predictedArrival: T("22:40"),
        predictedDeparture: T("22:52"),
        arrivalDelaySeconds: 780,
        departureDelaySeconds: 1440,
        predictionKind: "explicit",
      }),
    ];
    const detail = built(realtime({ events, asOf: T("22:45") }));
    expect(detail.progress).toEqual({ lastPassedIndex: 2, nextIndex: 3 });
    expect(detail.delaySeconds).toBe(1440);
  });

  it("shows no track where the feed gives a VRS stop number (Köln Hbf 87)", () => {
    const places = new Map(input().places);
    places.set(PLACE.hbf, {
      name: "Köln Hbf",
      displayName: null,
      location: AT.hbf,
      dhid: "de:05315:11201",
    });
    const stops = staticStops.map((stop) =>
      stop.index === 1 ? { ...stop, platform: "87" } : stop,
    );
    const events = [
      event("gtfsde-rt", 1, { platformScheduled: "87", platformActual: "84" }),
      delayed("gtfsde-rt", 2, 60),
    ];
    const detail = built(realtime({ places, staticStops: stops, events }));
    expect(detail.stops[1]).toMatchObject({ platformScheduled: null, platformActual: null });
    const timetable = built(input({ places, staticStops: stops }));
    expect(timetable.stops[1]?.platformScheduled).toBeNull();
    expect(built(input({ staticStops: stops })).stops[1]?.platformScheduled).toBe("87");
  });

  it("drops a link to a licence that is not served over https", () => {
    const only = [delayed("delfi-gtfs-rt", 2, 120)];
    const detail = built(
      realtime({
        events: only,
        activity: [{ sourceId: "delfi-gtfs-rt", firstSeen: T("19:00"), lastSeen: T("21:00") }],
      }),
    );
    expect(detail.provenance.licence).toEqual({ id: "LicenseRef-dcat-ap-de-cc-by-sa", url: null });
    expect(detail.provenance.holders?.map((holder) => holder.role)).toEqual([
      "publisher",
      "mirror",
    ]);
  });

  it("ignores a source row whose stop place disagrees with the timetable and counts it", () => {
    const wrong = event("gtfsde-rt", 2, { stopPlaceId: PLACE.munich, arrivalDelaySeconds: 99 });
    const result = buildTrainDetail(realtime({ events: [delayed("gtfsde-rt", 1, 60), wrong] }));
    expect(result.ok && result.placeMismatches).toBe(1);
    expect(result.ok && result.detail.stops[2]?.arrivalDelaySeconds).toBeNull();
  });

  it("marks a train cancelled when every stop is cancelled", () => {
    const events = staticStops.map((stop) => event("gtfsde-rt", stop.index, { cancelled: true }));
    const detail = built(realtime({ events }));
    expect(detail.cancelled).toBe(true);
    expect(detail.progress).toEqual({ lastPassedIndex: null, nextIndex: null });
  });

  it("lets the live tick decide source, geometry, delay and progress", () => {
    const detail = built(
      realtime({
        tick: {
          sourceId: "delfi-gtfs-rt",
          geometry: { available: false, reason: "low_quality" },
          delaySeconds: 60,
          cancelled: false,
          lastPassedIndex: 3,
          nextIndex: 4,
        },
      }),
    );
    expect(detail.provenance.sourceId).toBe("delfi-gtfs-rt");
    expect(detail.geometry).toEqual({ available: false, reason: "low_quality" });
    expect(detail.delaySeconds).toBe(60);
    expect(detail.progress).toEqual({ lastPassedIndex: 3, nextIndex: 4 });
  });

  it("takes the head delay from the next stop's prediction over the tick's (S3 35348)", () => {
    const tick = {
      sourceId: "gtfsde-rt",
      geometry: { available: true, reason: null },
      delaySeconds: 60,
      cancelled: false,
      lastPassedIndex: 1,
      nextIndex: 2,
    } as const;
    const events = [delayed("gtfsde-rt", 1, 60), delayed("gtfsde-rt", 2, 300)];
    const detail = built(realtime({ events, tick }));
    expect(detail.delaySeconds).toBe(300);
    expect(detail.delayBasis).toBe("stop");
    expect(detail.stops[2]?.arrivalDelaySeconds).toBe(detail.delaySeconds);
  });

  it("labels the tick's delay as the current one when the next stop has no prediction", () => {
    const tick = {
      sourceId: "gtfsde-rt",
      geometry: { available: true, reason: null },
      delaySeconds: 60,
      cancelled: false,
      lastPassedIndex: 1,
      nextIndex: 2,
    } as const;
    const detail = built(realtime({ events: [delayed("gtfsde-rt", 1, 60)], tick }));
    expect(detail.delaySeconds).toBe(60);
    expect(detail.delayBasis).toBe("current");
  });

  describe("head delay with a live tick", () => {
    const tick = {
      sourceId: "gtfsde-rt",
      geometry: { available: true, reason: null },
      delaySeconds: 60,
      cancelled: false,
      lastPassedIndex: 1,
      nextIndex: 2,
    } as const;
    const head = (detail: TrainDetail) => [detail.delaySeconds, detail.delayBasis];

    it("takes the departure delay of the stop the train stands at", () => {
      const standing = event("gtfsde-rt", 1, {
        predictedArrival: T("18:41"),
        predictedDeparture: T("18:51"),
        arrivalDelaySeconds: 240,
        departureDelaySeconds: 420,
        predictionKind: "explicit",
      });
      const events = [standing, delayed("gtfsde-rt", 2, 300)];
      const detail = built(realtime({ events, tick, asOf: T("18:45") }));
      expect(head(detail)).toEqual([420, "stop"]);
    });

    it("takes the next served stop when the next one is cancelled", () => {
      const events = [
        delayed("gtfsde-rt", 1, 60),
        event("gtfsde-rt", 2, { cancelled: true }),
        delayed("gtfsde-rt", 3, 300),
      ];
      const detail = built(realtime({ events, tick }));
      expect(detail.progress.nextIndex).toBe(3);
      expect(head(detail)).toEqual([300, "stop"]);
    });

    it("keeps a negative delay as the stop's", () => {
      const events = [delayed("gtfsde-rt", 1, 60), delayed("gtfsde-rt", 2, -120)];
      expect(head(built(realtime({ events, tick })))).toEqual([-120, "stop"]);
    });

    it("takes the last stop's arrival delay at the end of the run", () => {
      const events = [delayed("gtfsde-rt", 3, 60), delayed("gtfsde-rt", 4, 180)];
      const end = { ...tick, lastPassedIndex: 4, nextIndex: null };
      const detail = built(realtime({ events, tick: end, asOf: T("23:59") }));
      expect(head(detail)).toEqual([180, "stop"]);
    });

    it("keeps a delay of zero rather than falling through to the tick", () => {
      const events = [delayed("gtfsde-rt", 1, 60), delayed("gtfsde-rt", 2, 0)];
      expect(head(built(realtime({ events, tick })))).toEqual([0, "stop"]);
    });

    it("stores the tick's delay for the served head's fallback", () => {
      const events = [delayed("gtfsde-rt", 1, 60), delayed("gtfsde-rt", 2, 300)];
      expect(built(realtime({ events, tick })).currentDelaySeconds).toBe(60);
      expect(built(realtime()).currentDelaySeconds).toBeNull();
    });
  });

  it("has no delay basis without a delay", () => {
    expect(built(input()).delayBasis).toBeNull();
    expect(built(realtime({ asOf: T("22:50") })).delayBasis).toBeNull();
    expect(built(realtime()).delayBasis).toBe("stop");
  });

  it("never names a stop the source cancelled as the tick's next stop", () => {
    const tick = {
      sourceId: "gtfsde-rt",
      geometry: { available: true, reason: null },
      delaySeconds: 60,
      cancelled: false,
      lastPassedIndex: 1,
      nextIndex: 2,
    } as const;
    const events = [
      delayed("gtfsde-rt", 1, 60),
      event("gtfsde-rt", 2, { cancelled: true }),
      event("gtfsde-rt", 3, { cancelled: true }),
      event("gtfsde-rt", 4, { cancelled: true }),
    ];
    expect(built(realtime({ events, tick })).progress).toEqual({
      lastPassedIndex: 1,
      nextIndex: null,
    });
    const skipped = [delayed("gtfsde-rt", 1, 60), event("gtfsde-rt", 2, { cancelled: true })];
    expect(built(realtime({ events: skipped, tick })).progress).toEqual({
      lastPassedIndex: 1,
      nextIndex: 3,
    });
  });

  it("keeps the source's delay when the tick has none for an undrawn train", () => {
    const own = built(realtime());
    const detail = built(
      realtime({
        tick: {
          sourceId: "gtfsde-rt",
          geometry: { available: false, reason: "low_quality" },
          delaySeconds: null,
          cancelled: false,
          lastPassedIndex: 1,
          nextIndex: 2,
        },
      }),
    );
    expect(own.delaySeconds).not.toBeNull();
    expect(detail.delaySeconds).toBe(own.delaySeconds);
  });

  it("shows the timetable when the tick's source has no rows, without choosing again", () => {
    const detail = built(
      realtime({
        tick: {
          sourceId: "silent-rt",
          geometry: { available: true, reason: null },
          delaySeconds: null,
          cancelled: false,
          lastPassedIndex: 1,
          nextIndex: 2,
        },
      }),
    );
    expect(detail.provenance.kind).toBe("timetable");
  });

  it("falls back to progress by arrival when the tick's progress runs backwards", () => {
    const tick = {
      sourceId: "delfi-gtfs-rt",
      geometry: { available: true, reason: null },
      delaySeconds: 60,
      cancelled: false,
    } as const;
    const detail = built(realtime({ tick: { ...tick, lastPassedIndex: 4, nextIndex: 3 } }));
    expect(detail.progress).toEqual({ lastPassedIndex: 1, nextIndex: 2 });
  });
});

describe("buildTrainDetail, stops without passengers", () => {
  const passThrough: StaticStopRow = {
    index: 2,
    stopPlaceId: PLACE.solingen,
    scheduledArrival: T("20:00"),
    scheduledDeparture: T("20:00"),
    platform: null,
    passenger: false,
  };
  const operationalHalt: StaticStopRow = {
    ...passThrough,
    index: 3,
    scheduledArrival: T("21:00"),
    scheduledDeparture: T("21:02"),
  };
  const [altona, hbf, solingen, stuttgart, munich] = staticStops as [
    StaticStopRow,
    StaticStopRow,
    StaticStopRow,
    StaticStopRow,
    StaticStopRow,
  ];
  const withHalts: StaticStopRow[] = [
    altona,
    hbf,
    passThrough,
    operationalHalt,
    { ...solingen, index: 4 },
    { ...stuttgart, index: 5 },
    { ...munich, index: 6 },
  ];
  const tick = (lastPassedIndex: number | null, nextIndex: number | null) => ({
    sourceId: null,
    geometry: { available: true, reason: null },
    delaySeconds: null,
    cancelled: false,
    lastPassedIndex,
    nextIndex,
  });

  it("lists only stops where the train picks up or sets down passengers", () => {
    const detail = built(input({ staticStops: withHalts }));
    expect(detail.stops.map((stop) => stop.index)).toEqual([0, 1, 4, 5, 6]);
    expect(detail.progress).toEqual({ lastPassedIndex: 1, nextIndex: 4 });
  });

  it.each([
    ["an operational halt as last passed", tick(3, 4)],
    ["a pass-through as last passed", tick(2, 3)],
    ["an operational halt as next", tick(1, 3)],
    ["a pass-through as next", tick(1, 2)],
  ])("maps %s to the passenger stops around it", (_, decision) => {
    const detail = built(input({ staticStops: withHalts, tick: decision }));
    expect(detail.progress).toEqual({ lastPassedIndex: 1, nextIndex: 4 });
  });

  it("maps a halt after the last passenger stop to arrived", () => {
    const trailing = [...withHalts, { ...operationalHalt, index: 7 }];
    const detail = built(input({ staticStops: trailing, tick: tick(7, null) }));
    expect(detail.progress).toEqual({ lastPassedIndex: 6, nextIndex: null });
  });

  it("still falls back to progress by arrival for an index the timetable lacks", () => {
    const detail = built(input({ staticStops: withHalts, tick: tick(9, 10) }));
    expect(detail.progress).toEqual({ lastPassedIndex: 1, nextIndex: 4 });
  });
});

describe("buildTrainDetail, other trains", () => {
  it("builds an added trip from its source's stops alone", () => {
    const events = [delayed("delfi-gtfs-rt", 0, 0), delayed("delfi-gtfs-rt", 1, 120)];
    const detail = built(
      input({
        ref: {
          tripInstanceId: INSTANCE,
          serviceDate: "2026-10-26",
          feedVersionId: null,
          tripKey: null,
          frameKey: null,
        },
        trip: null,
        staticStops: [],
        instance: {
          tripInstanceId: INSTANCE,
          serviceDate: "2026-10-26",
          isAdded: true,
          trainNumber: null,
          categoryCode: null,
          operatorId: null,
        },
        events,
        activity: [{ sourceId: "delfi-gtfs-rt", firstSeen: T("19:00"), lastSeen: T("21:00") }],
      }),
    );
    expect(detail).toMatchObject({ added: true, category: "other", productName: null, line: null });
    expect(detail.geometry).toEqual({ available: false, reason: "no_shape" });
    expect(detail.stops).toHaveLength(2);
  });

  it("reads the product from the route name when no product row exists", () => {
    const trip = { ...baseTrip, line: "RE10", product: null, categoryCode: "rfast" };
    expect(built(input({ trip })).productName).toBe("RE");
  });

  it.each([
    ["low_quality", { available: false, reason: "low_quality" }],
    ["unmeasured", { available: false, reason: "unmeasured" }],
    [null, { available: false, reason: "no_shape" }],
  ] as const)("maps shape state %j to geometry", (shapeQaStatus, geometry) => {
    const trip = { ...baseTrip, shapeQaStatus };
    expect(built(input({ trip })).geometry).toEqual(geometry);
  });

  it("refuses to build a train with fewer than two stops", () => {
    expect(buildTrainDetail(input({ staticStops: staticStops.slice(0, 1) }))).toEqual({
      ok: false,
      reason: "too_few_stops",
    });
  });
});

describe("buildTrainDetail places rows as the live plan does", () => {
  const sourceId = "gtfsde-rt";
  const activity = [{ sourceId, firstSeen: T("19:00"), lastSeen: T("21:00") }];
  const extra = "57d45fba-4bcb-58e1-8162-11a19164dbac";
  const distant = "67d45fba-4bcb-58e1-8162-11a19164dbac";
  const places = new Map([
    ...input().places,
    [
      extra,
      { name: "Solingen Mitte", displayName: null, location: { lon: 7.0043, lat: 51.16224 } },
    ],
    [distant, { name: "Solingen Süd", displayName: null, location: { lon: 7.0043, lat: 51.1797 } }],
  ]);
  const sameStation = placesWithin(
    new Map(
      [...places].flatMap(([id, place]) => (place.location ? [[id, place.location] as const] : [])),
    ),
  );
  const placesOf = staticStops.map((stop) => stop.stopPlaceId);
  const scheduleOf = (place: string) =>
    staticStops.find((stop) => stop.stopPlaceId === place) ?? (staticStops[1] as StaticStopRow);

  function row(index: number, place: string, seconds: number): StopEventRow {
    const stop = scheduleOf(place);
    return event(sourceId, index, {
      stopPlaceId: place,
      predictedArrival: (stop.scheduledArrival as number) + seconds * 1000,
      predictedDeparture: (stop.scheduledDeparture as number) + seconds * 1000,
      arrivalDelaySeconds: seconds,
      departureDelaySeconds: seconds,
      predictionKind: "explicit",
    });
  }

  function renamed(index: number, place: string, seconds: number, as = extra): StopEventRow {
    return { ...row(index, place, seconds), stopPlaceId: as };
  }

  const run: StaticRun = {
    instanceId: INSTANCE,
    serviceDate: "2026-10-26",
    feedVersionId: 1,
    tripKey: "3448684827",
    category: "hsr",
    categoryCode: "hsr",
    foreign: false,
    line: "42",
    trainNumber: 619,
    shortName: "619",
    operatorId: null,
    patternId: "p",
    stopPlaces: placesOf,
    arrivals: Float64Array.from(staticStops, (s) => (s.scheduledArrival as number) / 1000),
    departures: Float64Array.from(staticStops, (s) => (s.scheduledDeparture as number) / 1000),
    passThrough: new Uint8Array(staticStops.length),
    shape: null,
    gap: null,
  };

  function planDelays(events: StopEventRow[], planned: StaticRun = run): number[] {
    const view: SourceView = {
      sourceId,
      firstSeen: T("19:00") / 1000,
      lastSeen: T("21:00") / 1000,
      stops: new Map(
        events.map((e) => [
          e.index,
          {
            observedAt: e.observedAt / 1000,
            predictedArrival: e.predictedArrival === null ? null : e.predictedArrival / 1000,
            predictedDeparture: e.predictedDeparture === null ? null : e.predictedDeparture / 1000,
            arrivalDelay: e.arrivalDelaySeconds,
            departureDelay: e.departureDelaySeconds,
            cancelled: e.cancelled,
            explicit: true,
            stopPlaceId: e.stopPlaceId,
          },
        ]),
      ),
    };
    const { stops } = expectedTimes(planned, view, T("22:00") / 1000, sameStation);
    return stops.map((stop, k) => stop.departure - (planned.departures[k] as number));
  }

  function expectSameDelays(detail: TrainDetail, plan: number[]) {
    let carried = 0;
    for (const stop of detail.stops) {
      const shown = stop.departureDelaySeconds ?? stop.arrivalDelaySeconds;
      if (shown !== null) carried = shown;
      expect([stop.index, plan[stop.index]]).toEqual([stop.index, carried]);
    }
  }

  it.each([
    [
      "a source folded on a version with one stop more",
      [row(1, PLACE.hbf, 60), row(2, extra, 120), row(3, PLACE.solingen, 300)],
      [row(4, PLACE.stuttgart, 420), row(5, PLACE.munich, 540)],
      1,
    ],
    [
      "a same-version source with one stray row",
      [row(1, PLACE.hbf, 60), row(2, PLACE.munich, 99), row(3, PLACE.stuttgart, 300)],
      [],
      1,
    ],
    ["a single row of another version", [row(5, PLACE.munich, 540)], [], 0],
    [
      "a renamed station 60 m from the stop at the same planned time",
      [row(1, PLACE.hbf, 60), renamed(2, PLACE.solingen, 180)],
      [row(3, PLACE.stuttgart, 300)],
      0,
    ],
    [
      "a renamed station 2 km from the stop at the same planned time",
      [row(1, PLACE.hbf, 60), renamed(2, PLACE.solingen, 180, distant)],
      [row(3, PLACE.stuttgart, 300)],
      1,
    ],
    [
      "a source folded on a version with two stops fewer",
      [row(0, PLACE.altona, 0), row(1, PLACE.solingen, 240)],
      [row(2, PLACE.munich, 480)],
      0,
    ],
  ])("%s", (_name, first, rest, dropped) => {
    const events = [...first, ...rest];
    const result = buildTrainDetail(realtime({ events, activity, places }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.placeMismatches).toBe(dropped);
    expectSameDelays(result.detail, planDelays(events));
    expect(result.detail.stops.some((stop) => stop.arrivalDelaySeconds !== null)).toBe(true);
  });

  it("takes the departure for a missing scheduled arrival as the plan does", () => {
    const stops = staticStops.map((stop) =>
      stop.index === 2 ? { ...stop, scheduledArrival: null } : stop,
    );
    const planned: StaticRun = {
      ...run,
      arrivals: Float64Array.from(
        stops,
        (s) => ((s.scheduledArrival ?? s.scheduledDeparture) as number) / 1000,
      ),
    };
    const events = [
      row(1, PLACE.hbf, 60),
      renamed(2, PLACE.solingen, 180),
      row(3, PLACE.stuttgart, 300),
    ];
    const result = buildTrainDetail(realtime({ events, activity, staticStops: stops, places }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.placeMismatches).toBe(1);
    expectSameDelays(result.detail, planDelays(events, planned));
  });
});
