import { SearchStation } from "@gerlines/schema/search";
import { describe, expect, it } from "vitest";
import type { StationRecord } from "./records.ts";
import { SearchIndex } from "./search-index.ts";
import {
  BERLIN_HBF,
  GIESSEN,
  ICE_693,
  ICE_6930,
  KOELN_HBF,
  MUENCHEN_HBF,
  RE1_NOW,
  SEARCH_NOW_MS,
  STRALSUND_HBF,
  SZCZECIN_GLOWNY,
  testData,
} from "./test-data.ts";

const index = SearchIndex.of(testData());

function find(query: string, options: Partial<Parameters<SearchIndex["search"]>[1]> = {}) {
  return index.search(query, { limit: 10, locale: "en", nowMs: SEARCH_NOW_MS, ...options });
}

function ids(query: string, options?: Partial<Parameters<SearchIndex["search"]>[1]>) {
  return find(query, options).map((result) => result.id);
}

describe("SearchIndex stations", () => {
  it("finds a station by a name typed with umlaut spellings or the long form of Hbf", () => {
    expect(ids("Koeln Hbf")[0]).toBe(KOELN_HBF);
    expect(ids("köln hauptbahnhof")[0]).toBe(KOELN_HBF);
    expect(ids("Muenchen")).toContain(MUENCHEN_HBF);
    expect(ids("giessen")).toContain(GIESSEN);
    expect(ids("berlin hbf")[0]).toBe(BERLIN_HBF);
  });

  it("finds a name that spells out Hauptbahnhof when Hbf is typed, and the other way", () => {
    expect(ids("Stralsund Hbf")[0]).toBe(STRALSUND_HBF);
    expect(ids("stralsund, hbf")[0]).toBe(STRALSUND_HBF);
    expect(ids("Stralsund Hauptbahnhof")[0]).toBe(STRALSUND_HBF);
    expect(ids("Köln Hauptbahnhof")[0]).toBe(KOELN_HBF);
  });

  it("finds a station by its EVA number", () => {
    expect(ids("8000207")).toContain(KOELN_HBF);
  });

  it("matches words in any order and as prefixes", () => {
    expect(ids("hbf köl")[0]).toBe(KOELN_HBF);
  });

  it("finds a station by its other names too but answers with its display name", () => {
    const data = testData();
    const muenchenOst = "5b1c2f4e-8a3d-5e6f-9a0b-1c2d3e4f5a6b";
    const withOst = SearchIndex.of({
      ...data,
      stations: [
        ...data.stations,
        {
          id: muenchenOst,
          name: "München Ost",
          otherNames: ["Ostbahnhof", "München Ostbahnhof"],
          lon: 11.6049,
          lat: 48.1273,
          eva: 8000262,
          dhid: "de:09162:5",
          lines: ["S2"],
          trainsToday: 1233,
        },
      ],
    });
    const options = { limit: 10, locale: "en" as const, nowMs: SEARCH_NOW_MS };
    const [byTimetable] = withOst.search("Ostbahnhof", { ...options, kinds: ["station"] });
    expect(byTimetable).toEqual({
      kind: "station",
      id: muenchenOst,
      name: "München Ost",
      lon: 11.6049,
      lat: 48.1273,
      eva: 8000262,
      dhid: "de:09162:5",
      stopId: "de:09162:5",
      lines: ["S2"],
      trainsToday: 1233,
    });
    expect(withOst.search("münchen ost", options)[0]?.id).toBe(muenchenOst);
    expect(withOst.station(muenchenOst)).toEqual(byTimetable);
  });

  it("ranks a word of the shown name above a timetable name, Berlin Ostbahnhof before München Ost", () => {
    const data = testData();
    const berlinOst = "6c2d3e4f-9b0a-5c1d-8e2f-3a4b5c6d7e8f";
    const muenchenOst = "5b1c2f4e-8a3d-5e6f-9a0b-1c2d3e4f5a6b";
    const stuttgartHbf = "7d3e4f5a-0c1b-5d2e-9f3a-4b5c6d7e8f9a";
    const station = (id: string, name: string, otherNames: string[], trainsToday: number) => ({
      id,
      name,
      otherNames,
      lon: 10,
      lat: 50,
      eva: null,
      dhid: null,
      lines: [],
      trainsToday,
    });
    const real = SearchIndex.of({
      ...data,
      stations: [
        ...data.stations,
        station(berlinOst, "Berlin Ostbahnhof", ["S Ostbahnhof (Berlin)"], 1106),
        station(muenchenOst, "München Ost", ["Ostbahnhof"], 1233),
        station(stuttgartHbf, "Stuttgart Hbf", ["Hauptbahnhof"], 810),
      ],
    });
    const options = {
      limit: 10,
      locale: "en" as const,
      nowMs: SEARCH_NOW_MS,
      kinds: ["station" as const],
    };
    expect(real.search("Ostbahnhof", options).map((result) => result.id)).toEqual([
      berlinOst,
      muenchenOst,
    ]);
    const hauptbahnhof = real.search("Hauptbahnhof", options).map((result) => result.id);
    expect(hauptbahnhof.slice(0, 4)).toEqual([KOELN_HBF, stuttgartHbf, MUENCHEN_HBF, BERLIN_HBF]);
  });

  it("puts the busier station first when both match equally", () => {
    const stations = find("köln", { kinds: ["station"] });
    expect(stations.map((result) => result.id)).toEqual([KOELN_HBF, expect.any(String)]);
  });
});

function station(
  id: string,
  name: string,
  trainsToday: number,
  fields: Partial<StationRecord> = {},
): StationRecord {
  return { id, name, lon: 10, lat: 50, eva: null, dhid: null, lines: [], trainsToday, ...fields };
}

function stationIds(stations: readonly StationRecord[], query: string): string[] {
  const data = testData();
  return SearchIndex.of({ ...data, stations: [...data.stations, ...stations] })
    .search(query, { limit: 10, locale: "en", kinds: ["station"] })
    .map((result) => result.id);
}

describe("SearchIndex exact names and prefixes", () => {
  it("puts a one train station's exact name before the busiest main station holding the same words", () => {
    const furth = "8e4f5a6b-1d2c-5e3f-8a4b-5c6d7e8f9a0b";
    const fuerthHbf = "9f5a6b7c-2e3d-5f4a-9b5c-6d7e8f9a0b1c";
    const stations = [station(fuerthHbf, "Fürth Hbf", 2126), station(furth, "Furth", 1)];
    expect(stationIds(stations, "Furth")).toEqual([furth, fuerthHbf]);
  });

  it("answers a longer name by its prefix when the feed lacks the town, Metzingen for Metz", () => {
    const metz = "a06b7c8d-3f4e-5a5b-8c6d-7e8f9a0b1c2d";
    const metzingen = "b17c8d9e-4a5f-5b6c-9d7e-8f9a0b1c2d3e";
    const withoutMetz = [station(metzingen, "Metzingen Bahnhof", 163, { dhid: "de:08415:22008" })];
    expect(stationIds(withoutMetz, "Metz")).toEqual([metzingen]);
    const withMetz = [...withoutMetz, station(metz, "Metz", 6, { stopId: "000008719203" })];
    expect(stationIds(withMetz, "Metz")).toEqual([metz, metzingen]);
  });
});

describe("SearchIndex names of the journey pairs (display names, gerlines_wp27 on 2026-11-10)", () => {
  const ids = (n: number) => `10000000-0000-5000-8000-${String(n).padStart(12, "0")}`;
  const named = (
    n: number,
    name: string,
    otherNames: string[],
    dhid: string,
    trainsToday: number,
  ): StationRecord => station(ids(n), name, trainsToday, { otherNames, dhid });
  const stations = [
    named(1, "Stuttgart Hbf", [], "de:08111:6115", 816),
    named(2, "Stuttgart Hbf (tief)", [], "de:08111:6118", 904),
    named(3, "Stuttgart Schwabstraße", ["Stuttgart Schwabstr."], "de:08111:6052", 904),
    named(4, "Stuttgart Stadtmitte", [], "de:08111:6056", 904),
    named(5, "Freiburg (Breisgau) Hbf", ["Freiburg Hauptbahnhof"], "de:08311:6508", 436),
    named(6, "Freiburg Littenweiler Bahnhof", ["Freiburg-Littenweiler"], "de:08311:6540", 160),
    named(7, "Freiburg Wiehre", ["Freiburg Wiehre Bahnhof"], "de:08311:6541", 160),
    named(8, "Marburg Hbf", ["Marburg Hauptbahnhof", "Marburg (Lahn)"], "de:06534:10011", 182),
    named(9, "Marburg Südbahnhof", ["Marburg Süd"], "de:06534:11323", 70),
    named(
      10,
      "Singen (Htw)",
      ["Singen (Htw) Bahnhof", "Singen (Hohentwiel)"],
      "de:08335:6588",
      308,
    ),
    named(11, "Singen-Industriegebiet", ["Singen-Industriegebiet Bahnhof"], "de:08335:2409", 74),
    named(12, "Singen (Thür)", [], "de:16070:8012998", 35),
  ];

  it.each([
    ["Stuttgart Hbf", 1],
    ["Freiburg Hbf", 5],
    ["Freiburg (Breisgau) Hbf", 5],
    ["Marburg", 8],
    ["Marburg (Lahn)", 8],
    ["Singen", 10],
    ["Singen (Hohentwiel)", 10],
  ])("finds %s first", (query, n) => {
    expect(stationIds(stations, query)[0]).toBe(ids(n));
  });
});

describe("SearchIndex journey stop ids", () => {
  it("answers the stop id journeys take: the DHID, or the DELFI feed id of a station without one", () => {
    const [koeln] = find("Köln Hbf", { kinds: ["station"] });
    expect(koeln).toMatchObject({ dhid: "de:05315:11201", stopId: "de:05315:11201" });
    const [szczecin] = find("Szczecin Główny", { kinds: ["station"] });
    expect(szczecin).toMatchObject({
      id: SZCZECIN_GLOWNY,
      dhid: null,
      stopId: "pl:unknown:EVANR-5100057",
    });
    expect(SearchStation.parse(szczecin).stopId).toBe("pl:unknown:EVANR-5100057");
    expect(index.station(SZCZECIN_GLOWNY)?.stopId).toBe("pl:unknown:EVANR-5100057");
    expect(find("Gießen", { kinds: ["station"] })[0]).toMatchObject({ dhid: null, stopId: null });
  });
});

describe("SearchIndex stop ids", () => {
  it("names a DELFI stop id by its station's display name, through id_map or the station DHID", () => {
    const withIds = SearchIndex.of({
      ...testData(),
      stopIds: [
        { stopId: "de:11000:900003200:2:53", stationId: BERLIN_HBF },
        { stopId: "de:11000:900003201", stationId: BERLIN_HBF },
        { stopId: "ch:1:sloid:10", stationId: "00000000-0000-5000-8000-00000000ffff" },
      ],
    });
    expect(withIds.stationNameOfStop("de:11000:900003200:2:53")).toBe("Berlin Hbf");
    expect(withIds.stationNameOfStop("de:09162:100:22:22")).toBe("München Hbf");
    expect(withIds.stationNameOfStop("de:09162:100_G")).toBe("München Hbf");
    expect(withIds.stationNameOfStop("ch:1:sloid:10")).toBeNull();
    expect(withIds.stationNameOfStop("pl:unknown:EVANR-5100057")).toBeNull();
    expect(index.stationNameOfStop("de:11000:900003200:2:53")).toBeNull();
  });
});

describe("SearchIndex routable stop", () => {
  const OBERBETTINGEN = "00000000-0000-5000-8000-000000030669";
  const withPoints = SearchIndex.of({
    ...testData(),
    stopIds: [
      {
        stopId: "de:11000:900003201",
        stationId: BERLIN_HBF,
        stopPoint: false,
        seenMs: 2,
        patterns: 0,
      },
      {
        stopId: "de:11000:900003200:1:50",
        stationId: BERLIN_HBF,
        stopPoint: true,
        seenMs: 1,
        patterns: 90,
      },
      {
        stopId: "de:11000:900003200:2:53",
        stationId: BERLIN_HBF,
        stopPoint: true,
        seenMs: 2,
        patterns: 5,
      },
      {
        stopId: "de:11000:900003200:2:54",
        stationId: BERLIN_HBF,
        stopPoint: true,
        seenMs: 2,
        patterns: 40,
      },
      {
        stopId: "de:11000:900003200:2:55",
        stationId: BERLIN_HBF,
        stopPoint: true,
        seenMs: 2,
        patterns: 40,
      },
      {
        stopId: "de:07233:30669",
        stationId: OBERBETTINGEN,
        stopPoint: false,
        seenMs: 2,
        patterns: 0,
      },
      {
        stopId: "de:07233:30669:2:2_G",
        stationId: OBERBETTINGEN,
        stopPoint: true,
        seenMs: 2,
        patterns: 44,
      },
      {
        stopId: "de:07233:30669:1:DB",
        stationId: OBERBETTINGEN,
        stopPoint: true,
        seenMs: 2,
        patterns: 1,
      },
      { stopId: "ch:1:sloid:10", stationId: "00000000-0000-5000-8000-00000000ffff" },
    ],
  });

  it("gives the stops.txt row of the place a stop id belongs to: seen latest, then in the most trip patterns, then the smallest id", () => {
    expect(withPoints.routableStopOf("de:11000:900003201")).toBe("de:11000:900003200:2:54");
    expect(withPoints.routableStopOf("de:07233:30669")).toBe("de:07233:30669:2:2_G");
  });

  it("finds the place through a platform id or the DHID of a station", () => {
    expect(withPoints.routableStopOf("de:11000:900003200:2:53")).toBe("de:11000:900003200:2:54");
    expect(withPoints.routableStopOf("de:07233:30669:2:2")).toBe("de:07233:30669:2:2_G");
  });

  it("gives nothing for an unknown stop, a place without rows, or the row it was asked for", () => {
    expect(withPoints.routableStopOf("de:99999:1")).toBeNull();
    expect(withPoints.routableStopOf("ch:1:sloid:10")).toBeNull();
    expect(withPoints.routableStopOf("de:11000:900003200:2:54")).toBeNull();
    expect(SearchIndex.of(testData()).routableStopOf("de:11000:900003201")).toBeNull();
  });
});

describe("SearchIndex trip runs", () => {
  it("finds the run of a timetable trip by its service date and trip key", () => {
    const withTrips = SearchIndex.of({
      ...testData(),
      tripRuns: [
        { serviceDate: "2026-11-07", tripKey: "3448680724", trainId: ICE_693.id },
        { serviceDate: "2026-11-07", tripKey: "3448680725", trainId: ICE_693.id },
      ],
    });
    const run = {
      tripInstanceId: ICE_693.id,
      departure: ICE_693.departure,
      arrival: ICE_693.arrival,
      trainNumber: ICE_693.trainNumber,
    };
    expect(withTrips.runOfTrip("2026-11-07", "3448680724")).toEqual(run);
    expect(withTrips.runOfTrip("2026-11-07", "3448680725")).toEqual(run);
    expect(withTrips.runOfTrip("2026-11-06", "3448680724")).toBeNull();
    expect(withTrips.runOfTrip("2026-11-07", "1")).toBeNull();
    expect(index.runOfTrip("2026-11-07", "3448680724")).toBeNull();
  });
});

describe("SearchIndex trains and lines", () => {
  it("finds a train by product and number, with or without the space", () => {
    expect(ids("ICE 693")[0]).toBe(ICE_693.id);
    expect(ids("ice693")[0]).toBe(ICE_693.id);
  });

  it("finds a train by its bare number, the exact number before a longer one", () => {
    const trains = ids("693", { kinds: ["train"] });
    expect(trains[0]).toBe(ICE_693.id);
    expect(trains).toContain(ICE_6930.id);
  });

  it("finds a line and its trains, the running train before one that ran in the morning", () => {
    const results = find("RE 1");
    expect(results[0]?.kind).toBe("line");
    const trains = results.filter((result) => result.kind === "train").map((result) => result.id);
    expect(trains[0]).toBe(RE1_NOW.id);
    expect(ids("re1")[0]).toBe("national-express:RE1");
  });

  it("serves the train fields the card needs", () => {
    const train = find("ICE 693")[0];
    expect(train).toMatchObject({
      kind: "train",
      title: "ICE 693",
      origin: { name: "Berlin Hbf" },
      destination: { name: "München Hbf" },
    });
  });
});

describe("SearchIndex places", () => {
  it("names a Land in the asked language and finds it by any of its names", () => {
    expect(find("Bayern", { locale: "de" })[0]).toMatchObject({
      kind: "place",
      type: "land",
      name: "Bayern",
      landCode: "DE-BY",
    });
    expect(find("bavaria", { locale: "pl" })[0]).toMatchObject({ name: "Bawaria" });
  });

  it("puts the city before a village that starts the same way", () => {
    const places = find("kol", { kinds: ["place"] }).map((result) => result.id);
    expect(places).toEqual(["town:05315000", "town:01056031"]);
    expect(find("koln", { kinds: ["place"] }).map((result) => result.id)).toEqual([
      "town:05315000",
    ]);
    expect(find("koln", { kinds: ["place"], locale: "de" })[0]).toMatchObject({
      region: "Nordrhein-Westfalen",
    });
  });
});

describe("SearchIndex limits", () => {
  it("answers nothing for a query without a letter or digit", () => {
    expect(find("  ")).toEqual([]);
    expect(find("--")).toEqual([]);
  });

  it("keeps to the limit and the asked kinds", () => {
    expect(find("kö", { limit: 2 })).toHaveLength(2);
    expect(find("köln", { kinds: ["place"] }).every((result) => result.kind === "place")).toBe(
      true,
    );
  });

  it("finds nothing for a name that is not there", () => {
    expect(find("Atlantis")).toEqual([]);
  });

  it("answers within a few milliseconds over a national sized index", () => {
    const data = testData();
    const many = SearchIndex.of({
      ...data,
      trains: Array.from({ length: 40_000 }, (_, n) => ({
        ...ICE_693,
        id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
        title: `RB ${n}`,
        trainNumber: String(n),
        line: `RB${n % 400}`,
      })),
    });
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) many.search("Muenchen Hbf", { limit: 10, locale: "en" });
    expect((performance.now() - started) / 20).toBeLessThan(25);
  }, 60_000);
});

describe("SearchIndex cost", () => {
  it("answers nothing for one letter but a single digit still finds", () => {
    expect(find("k")).toEqual([]);
    expect(find("ö")).toEqual([]);
    expect(ids("1").length).toBeGreaterThan(0);
    expect(ids("kö").length).toBeGreaterThan(0);
  });

  it("serves a repeated query from a cache for 60 s", () => {
    let now = 0;
    const cached = SearchIndex.of(testData(), { cacheNow: () => now });
    const options = { limit: 5, locale: "en" as const };
    const first = cached.search("köln", options);
    expect(cached.search("köln", options)).toBe(first);
    expect(cached.search("köln", { ...options, locale: "pl" })).not.toBe(first);
    expect(cached.search("köln", { ...options, kinds: ["station"] })).not.toBe(first);
    now = 60_000;
    const later = cached.search("köln", options);
    expect(later).not.toBe(first);
    expect(later).toEqual(first);
  });

  it("returns result objects of its own, so a caller cannot change the index", () => {
    const station = find("köln hbf", { kinds: ["station"] })[0];
    if (station?.kind !== "station") throw new Error("no station");
    (station.lines as string[]).push("X");
    expect(index.station(KOELN_HBF)?.lines).not.toContain("X");
  });
});

describe("SearchIndex.build", () => {
  it("builds in slices with pauses between them and answers like an index built at once", async () => {
    let pauses = 0;
    const built = await SearchIndex.build(testData(), {
      sliceSize: 2,
      pause: async () => {
        pauses += 1;
      },
    });
    expect(pauses).toBeGreaterThan(3);
    expect(built.size).toBe(index.size);
    for (const query of ["köln", "ICE 693", "RE1", "Bayern", "8000207"]) {
      expect(built.search(query, { limit: 10, locale: "en", nowMs: SEARCH_NOW_MS })).toEqual(
        find(query),
      );
    }
  });
});

describe("SearchIndex factories", () => {
  it("are the only way to make an index, so its prepared names always come from its own records", () => {
    // @ts-expect-error the constructor is private
    const direct = () => new SearchIndex(testData());
    expect(typeof direct).toBe("function");
    expect(SearchIndex.of(testData()).size).toBe(index.size);
  });
});
