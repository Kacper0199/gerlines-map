import { describe, expect, it } from "vitest";
import type { StationRecord } from "./records.ts";
import { SearchIndex } from "./search-index.ts";
import { familyStopIds, type StopIdCandidate } from "./stop-ids.ts";
import { testData } from "./test-data.ts";

const GOETTINGEN_03159 = "795a14a8-63bf-5379-b5b8-6d76edaad93f";
const GOETTINGEN_03152 = "b2e2b3aa-156f-5812-9e17-c1f756fbb20e";
const SEEN = Date.parse("2026-10-29T14:13:19.501Z");

function candidate(
  fields: Partial<StopIdCandidate> & Pick<StopIdCandidate, "id">,
): StopIdCandidate {
  return {
    name: "Göttingen",
    eva: 8000128,
    dhid: null,
    lon: 9.926,
    lat: 51.5368,
    stopId: null,
    inNewestFeed: true,
    stopIdSeenMs: SEEN,
    stopIdIsRow: false,
    stopIdSynthesised: false,
    trainsToday: 0,
    ...fields,
  };
}

/** gerlines_wp32 (feed 2026-10-19 only), service day 2026-11-09, as measured. */
const GOETTINGEN_WP32 = [
  candidate({
    id: GOETTINGEN_03159,
    dhid: "de:03159:33817",
    stopId: "de:03159:33817",
    lon: 9.9256,
    trainsToday: 304,
  }),
  candidate({
    id: GOETTINGEN_03152,
    dhid: "de:03152:33817",
    stopId: "de:03152:33817",
    lon: 9.926072,
    stopIdIsRow: true,
    trainsToday: 38,
  }),
];

const stopIds = (stations: readonly StopIdCandidate[]) =>
  Object.fromEntries(familyStopIds(stations).map((station) => [station.id, station.stopId]));

describe("familyStopIds", () => {
  it("gives both Göttingen places the stop id that is a stops.txt row, de:03152:33817", () => {
    expect(stopIds(GOETTINGEN_WP32)).toEqual({
      [GOETTINGEN_03159]: "de:03152:33817",
      [GOETTINGEN_03152]: "de:03152:33817",
    });
  });

  it("prefers the place the newest loaded feed still serves over a busier one only the older serves", () => {
    const [older, newer] = GOETTINGEN_WP32 as [StopIdCandidate, StopIdCandidate];
    const t084 = [
      { ...older, inNewestFeed: false, stopIdIsRow: true },
      { ...newer, stopIdIsRow: false },
    ];
    expect(stopIds(t084)[GOETTINGEN_03159]).toBe("de:03152:33817");
  });

  it("prefers the id a later load saw, before a stops.txt row and before trains", () => {
    const [older, newer] = GOETTINGEN_WP32 as [StopIdCandidate, StopIdCandidate];
    const stations = [
      { ...older, stopIdIsRow: true, stopIdSeenMs: Date.parse("2026-11-06T15:19:03.786Z") },
      { ...newer, stopIdIsRow: false, stopIdSeenMs: Date.parse("2026-11-06T15:21:53.301Z") },
    ];
    expect(stopIds(stations)[GOETTINGEN_03159]).toBe("de:03152:33817");
  });

  it("keeps each place's own id when the evidence ties, as for Hamburg-Altona", () => {
    const stations = [
      candidate({
        id: "a",
        name: "Hamburg-Altona",
        eva: 8002553,
        stopId: "de:02000:8002553",
        stopIdIsRow: true,
        trainsToday: 240,
      }),
      candidate({
        id: "b",
        name: "Hamburg-Altona",
        eva: 8002553,
        stopId: "de:02000:80953",
        stopIdIsRow: true,
        trainsToday: 982,
      }),
    ];
    expect(stopIds(stations)).toEqual({ a: "de:02000:8002553", b: "de:02000:80953" });
  });

  it("finds district twins without an EVA number", () => {
    const stations = GOETTINGEN_WP32.map((station) => ({ ...station, eva: null }));
    expect(stopIds(stations)[GOETTINGEN_03159]).toBe("de:03152:33817");
  });

  it("leaves places apart that differ in name, lie over a kilometre apart or share only the station number", () => {
    const [older, newer] = GOETTINGEN_WP32 as [StopIdCandidate, StopIdCandidate];
    const busStation = [older, { ...newer, name: "Göttingen ZOB" }];
    expect(stopIds(busStation)[GOETTINGEN_03159]).toBe("de:03159:33817");
    const far = [older, { ...newer, lat: newer.lat + 0.02 }];
    expect(stopIds(far)[GOETTINGEN_03159]).toBe("de:03159:33817");
    const otherTown = [
      { ...older, eva: null },
      { ...newer, eva: null, dhid: "de:03159:338170", stopId: "de:03159:338170" },
    ];
    expect(stopIds(otherTown)[GOETTINGEN_03159]).toBe("de:03159:33817");
  });

  it("keeps one name within 1 km apart when the EVA numbers differ", () => {
    const [older, newer] = GOETTINGEN_WP32 as [StopIdCandidate, StopIdCandidate];
    const stations = [
      { ...older, dhid: null, stopId: "de:03159:1" },
      { ...newer, dhid: null, eva: 8000129, stopId: "de:03152:2" },
    ];
    expect(stopIds(stations)[GOETTINGEN_03159]).toBe("de:03159:1");
  });

  it("keeps one station number and one name in another district over 1 km away apart without an EVA number", () => {
    const [older, newer] = GOETTINGEN_WP32 as [StopIdCandidate, StopIdCandidate];
    const stations = [
      { ...older, eva: null },
      { ...newer, eva: null, lat: newer.lat + 0.5 },
    ];
    expect(stopIds(stations)[GOETTINGEN_03159]).toBe("de:03159:33817");
  });

  it("answers the same whatever the order of the stations", () => {
    const [older, newer] = GOETTINGEN_WP32 as [StopIdCandidate, StopIdCandidate];
    const stations = [
      older,
      newer,
      { ...newer, id: "c", stopId: "de:03152:33817:9", stopIdIsRow: true, trainsToday: 38 },
      candidate({
        id: "d",
        name: "Hamburg-Altona",
        eva: 8002553,
        stopId: "de:02000:80953",
        stopIdIsRow: true,
      }),
      candidate({ id: "e", name: "Hamburg-Altona", eva: 8002553, stopId: "de:02000:8002553" }),
    ];
    const expected = stopIds(stations);
    const orders = [
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
      [1, 4, 0, 3, 2],
    ];
    for (const order of orders) {
      expect(stopIds(order.map((at) => stations[at] as StopIdCandidate))).toEqual(expected);
    }
    expect(expected).toMatchObject({ [GOETTINGEN_03159]: "de:03152:33817", e: "de:02000:80953" });
  });

  it("never hands out a missing stop id and leaves a station without one as it is", () => {
    const [older, newer] = GOETTINGEN_WP32 as [StopIdCandidate, StopIdCandidate];
    const stations = [
      { ...older, stopIdIsRow: false },
      { ...newer, stopId: null, stopIdSeenMs: null, stopIdIsRow: false },
    ];
    expect(stopIds(stations)).toEqual({
      [GOETTINGEN_03159]: "de:03159:33817",
      [GOETTINGEN_03152]: null,
    });
  });

  it("changes only the stop id, so the search still ranks the busier Göttingen first", () => {
    const stations: StationRecord[] = familyStopIds(GOETTINGEN_WP32).map((station) => ({
      id: station.id,
      name: station.name,
      lon: station.lon,
      lat: station.lat,
      eva: station.eva,
      dhid: station.dhid,
      stopId: station.stopId,
      lines: [],
      trainsToday: station.trainsToday,
    }));
    const data = testData();
    const results = SearchIndex.of({ ...data, stations: [...data.stations, ...stations] }).search(
      "Göttingen",
      { limit: 5, locale: "en", kinds: ["station"] },
    );
    expect(
      results.map((result) => result.kind === "station" && [result.id, result.dhid, result.stopId]),
    ).toEqual([
      [GOETTINGEN_03159, "de:03159:33817", "de:03152:33817"],
      [GOETTINGEN_03152, "de:03152:33817", "de:03152:33817"],
    ]);
  });
});

describe("familyStopIds with a place built from platform ids", () => {
  /** gerlines_wp32, feed 2026-10-19: 16032 is a parent row (location_type 1), 16078 has no stops.txt row. */
  const DUISBURG_WP32 = [
    candidate({
      id: "2c655c84-84e4-5088-b0f2-a0c4e391ae0e",
      name: "Duisburg Hbf",
      eva: 8000086,
      dhid: "de:05112:16032",
      stopId: "de:05112:16032",
      lon: 6.774528,
      lat: 51.430453,
    }),
    candidate({
      id: "a878f8be-d28e-5569-9188-adeb735afdd3",
      name: "Duisburg Hbf",
      eva: 8000086,
      dhid: "de:05112:16078",
      stopId: "de:05112:16078",
      lon: 6.777266,
      lat: 51.429918,
      stopIdSynthesised: true,
    }),
  ];

  it("gives the place built from platform ids its twin's parent row", () => {
    expect(stopIds(DUISBURG_WP32)).toEqual({
      "2c655c84-84e4-5088-b0f2-a0c4e391ae0e": "de:05112:16032",
      "a878f8be-d28e-5569-9188-adeb735afdd3": "de:05112:16032",
    });
  });

  it("ranks a parent row with a stop point row: both are rows the router holds", () => {
    const [parent, built] = DUISBURG_WP32 as [StopIdCandidate, StopIdCandidate];
    expect(stopIds([parent, { ...built, stopIdSynthesised: false }])).toEqual({
      [parent.id]: "de:05112:16032",
      [built.id]: "de:05112:16078",
    });
  });

  it("puts the feed version and when the id was seen before it", () => {
    const [parent, built] = DUISBURG_WP32 as [StopIdCandidate, StopIdCandidate];
    expect(stopIds([{ ...parent, inNewestFeed: false }, built])[built.id]).toBe("de:05112:16078");
  });
});
