import { describe, expect, it } from "vitest";
import {
  type TrainDetail as Detail,
  LiveKeyLookup,
  liveKeyPath,
  TrainDetail,
  trainDetailPath,
} from "./train-detail.ts";

const PLACE_A = "6f1c2a1e-1a52-4c8e-9a3b-0d6a2f4c1b01";
const PLACE_B = "6f1c2a1e-1a52-4c8e-9a3b-0d6a2f4c1b02";
const PLACE_C = "6f1c2a1e-1a52-4c8e-9a3b-0d6a2f4c1b03";

function stop(index: number, stopPlaceId: string, name: string) {
  return {
    index,
    stopPlaceId,
    name,
    scheduledArrival: index === 0 ? null : "2026-10-29T14:10:00Z",
    scheduledDeparture: "2026-10-29T14:12:00Z",
    predictedArrival: null,
    predictedDeparture: null,
    arrivalDelaySeconds: null,
    departureDelaySeconds: null,
    platformScheduled: "3",
    platformActual: null,
    cancelled: false,
    prediction: null,
  };
}

function detail(overrides: Partial<Detail> = {}): unknown {
  return {
    tripInstanceId: "0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c6d",
    frameKey: 4711,
    serviceDate: "2026-10-29",
    timetableVersion: "2026-10-24T14:58:08",
    version: 12,
    asOf: "2026-10-29T14:05:31.250Z",
    category: "rfast",
    productName: "RE",
    line: "RE 1",
    trainNumber: "4321",
    foreign: false,
    added: false,
    cancelled: false,
    operator: { id: "example-operator", name: "Example Rail", wikidataQid: "Q42" },
    destination: { stopPlaceId: PLACE_C, name: "Stop C" },
    headsign: "Stop C",
    delaySeconds: null,
    provenance: {
      kind: "timetable",
      sourceId: "delfi-gtfs",
      sourceName: "DELFI timetable",
      attribution: "DELFI e.V.",
      predictionChangedAt: null,
      feedObservedAt: null,
    },
    geometry: { available: true, reason: null },
    progress: { lastPassedIndex: 0, nextIndex: 2 },
    stops: [stop(0, PLACE_A, "Stop A"), stop(2, PLACE_B, "Stop B"), stop(5, PLACE_C, "Stop C")],
    vehicle: null,
    photo: null,
    ...overrides,
  };
}

describe("TrainDetail", () => {
  it("accepts a timetable-only train with nothing invented", () => {
    const parsed = TrainDetail.parse(detail());
    expect(parsed.delaySeconds).toBeNull();
    expect(parsed.vehicle).toBeNull();
  });

  it("keeps a zero delay distinct from no data", () => {
    expect(TrainDetail.parse(detail({ delaySeconds: 0 })).delaySeconds).toBe(0);
  });

  it("drops fields a newer server adds", () => {
    const parsed = TrainDetail.parse({ ...(detail() as object), addedByNewerServer: 120 });
    expect(parsed).not.toHaveProperty("addedByNewerServer");
  });

  it("refuses stop indexes that do not increase", () => {
    const stops = [stop(2, PLACE_A, "Stop A"), stop(2, PLACE_B, "Stop B")];
    const result = TrainDetail.safeParse(
      detail({ stops, progress: { lastPassedIndex: null, nextIndex: null } }),
    );
    expect(result.success).toBe(false);
  });

  it("refuses progress that points outside the stop list", () => {
    const result = TrainDetail.safeParse(
      detail({ progress: { lastPassedIndex: 0, nextIndex: 3 } }),
    );
    expect(result.success).toBe(false);
  });

  it("refuses a next stop before the last passed stop", () => {
    const result = TrainDetail.safeParse(
      detail({ progress: { lastPassedIndex: 2, nextIndex: 0 } }),
    );
    expect(result.success).toBe(false);
  });

  it("requires a reason exactly when geometry is missing", () => {
    expect(
      TrainDetail.safeParse(detail({ geometry: { available: false, reason: null } })).success,
    ).toBe(false);
    expect(
      TrainDetail.safeParse(detail({ geometry: { available: false, reason: "low_quality" } }))
        .success,
    ).toBe(true);
    expect(
      TrainDetail.safeParse(detail({ geometry: { available: true, reason: "no_shape" } })).success,
    ).toBe(false);
  });

  it("carries the catalogue display name of the vehicle source, null when the catalogue has none", () => {
    const vehicle = {
      seriesId: "db-412",
      seriesName: "ICE 4",
      variant: null,
      units: null,
      cars: null,
      lengthMetres: null,
      layer: "L2" as const,
      confidence: 0.8,
      source: "wikipedia-de-ice-linien",
    };
    const named = { ...vehicle, sourceName: "Wikipedia (de), Liste der Intercity-Express-Linien" };
    expect(TrainDetail.parse(detail({ vehicle: named })).vehicle?.sourceName).toBe(
      "Wikipedia (de), Liste der Intercity-Express-Linien",
    );
    expect(
      TrainDetail.parse(detail({ vehicle: { ...vehicle, sourceName: null } })).vehicle?.sourceName,
    ).toBeNull();
    expect(TrainDetail.parse(detail({ vehicle })).vehicle).not.toHaveProperty("sourceName");
    expect(
      TrainDetail.safeParse(detail({ vehicle: { ...vehicle, sourceName: " " } })).success,
    ).toBe(false);
  });

  it("refuses empty labels and local times", () => {
    expect(TrainDetail.safeParse(detail({ line: " " })).success).toBe(false);
    expect(TrainDetail.safeParse(detail({ asOf: "2026-10-29T14:05:31" })).success).toBe(false);
  });

  it("accepts a stored photo with https credit links only", () => {
    const photo = {
      photoId: "db-403-p1",
      seriesId: "db-403",
      small: { url: "/api/v1/photos/db-403-p1-330-0123456789ab.jpg", width: 330, height: 220 },
      large: { url: "/api/v1/photos/db-403-p1-960-0123456789ab.jpg", width: 960, height: 640 },
      focus: { x: 0.5, y: 0.6 },
      title: "ICE 3 in Köln.jpg",
      author: "Author",
      authorUrl: null,
      licence: "CC BY-SA 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg",
    };
    expect(TrainDetail.safeParse(detail({ photo })).success).toBe(true);
    expect(TrainDetail.safeParse(detail({ photo: { ...photo, licenceUrl: null } })).success).toBe(
      true,
    );
    for (const url of [
      "javascript:alert(1)",
      "data:image/png;base64,AA",
      "https://upload.wikimedia.org/a.jpg",
      "/api/v1/photos/../../etc/passwd",
      "/api/v1/photos/db-403-p1-500-0123456789ab.jpg",
    ]) {
      const small = { ...photo.small, url };
      expect(TrainDetail.safeParse(detail({ photo: { ...photo, small } })).success).toBe(false);
    }
    for (const link of ["javascript:alert(1)", "http://example.org/a"]) {
      expect(TrainDetail.safeParse(detail({ photo: { ...photo, sourceUrl: link } })).success).toBe(
        false,
      );
      expect(TrainDetail.safeParse(detail({ photo: { ...photo, authorUrl: link } })).success).toBe(
        false,
      );
    }
    expect(
      TrainDetail.safeParse(detail({ photo: { ...photo, focus: { x: 1.2, y: 0 } } })).success,
    ).toBe(false);
  });

  it("refuses a frame key outside u32", () => {
    expect(TrainDetail.safeParse(detail({ frameKey: 2 ** 32 })).success).toBe(false);
  });
});

describe("TrainDetail forecast", () => {
  const forecast = {
    method: "b1-change",
    fromIndex: 0,
    fromDelayMinutes: 4,
    upperQuantile: 0.8,
    trainedFrom: "2026-08",
    trainedTo: "2026-10",
    sourceName: "piebro/deutsche-bahn-data",
    attribution:
      "Deutsche Bahn train data, collected and processed by piebro, data from Deutsche Bahn",
    licence: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    stops: [
      {
        index: 2,
        stopsAhead: 1,
        expectedDelayMinutes: 3,
        upperDelayMinutes: 6,
        level: "train",
        runs: 61,
      },
    ],
  };

  it("is optional and nullable, so details stored before it still parse", () => {
    expect(TrainDetail.safeParse(detail()).success).toBe(true);
    expect(TrainDetail.safeParse(detail({ forecast: null })).success).toBe(true);
    expect(TrainDetail.parse(detail({ forecast } as Partial<Detail>)).forecast?.stops).toHaveLength(
      1,
    );
  });

  it("refuses forecast stops that are not after the start stop", () => {
    const back = { ...forecast, fromIndex: 2, stops: [{ ...forecast.stops[0], index: 2 }] };
    expect(TrainDetail.safeParse(detail({ forecast: back } as Partial<Detail>)).success).toBe(
      false,
    );
    const unknown = { ...forecast, stops: [{ ...forecast.stops[0], index: 3 }] };
    expect(TrainDetail.safeParse(detail({ forecast: unknown } as Partial<Detail>)).success).toBe(
      false,
    );
  });

  it("refuses an upper quantile below the median and an empty list", () => {
    const inverted = { ...forecast, stops: [{ ...forecast.stops[0], upperDelayMinutes: 1 }] };
    expect(TrainDetail.safeParse(detail({ forecast: inverted } as Partial<Detail>)).success).toBe(
      false,
    );
    expect(
      TrainDetail.safeParse(detail({ forecast: { ...forecast, stops: [] } } as Partial<Detail>))
        .success,
    ).toBe(false);
  });
  it("takes a basis per stop, feed plus spread or B1, and refuses any other", () => {
    const anchored = {
      ...forecast,
      stops: [{ ...forecast.stops[0], basis: "feed_plus_spread" }],
    };
    expect(
      TrainDetail.parse(detail({ forecast: anchored } as Partial<Detail>)).forecast?.stops[0]
        ?.basis,
    ).toBe("feed_plus_spread");
    const b1 = { ...forecast, stops: [{ ...forecast.stops[0], basis: "b1" }] };
    expect(TrainDetail.safeParse(detail({ forecast: b1 } as Partial<Detail>)).success).toBe(true);
    const other = { ...forecast, stops: [{ ...forecast.stops[0], basis: "feed" }] };
    expect(TrainDetail.safeParse(detail({ forecast: other } as Partial<Detail>)).success).toBe(
      false,
    );
  });
});

describe("TrainDetail provenance holders", () => {
  const realtime = {
    kind: "realtime" as const,
    sourceId: "delfi-gtfs-rt",
    sourceName: "DELFI GTFS-RT",
    attribution: "DELFI e.V., mirrored by traines.eu",
    predictionChangedAt: "2026-10-29T14:04:00Z",
    feedObservedAt: "2026-10-29T14:05:00Z",
  };
  const holders = [
    { name: "DELFI e.V.", role: "publisher" as const, url: "https://www.delfi.de/" },
    { name: "traines.eu", role: "mirror" as const, url: null },
  ];
  const licence = { id: "CC-BY-SA-4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" };

  it("carries holders and the licence so clients join them per locale", () => {
    const parsed = TrainDetail.parse(detail({ provenance: { ...realtime, holders, licence } }));
    expect(parsed.provenance.holders?.map((holder) => holder.role)).toEqual([
      "publisher",
      "mirror",
    ]);
    expect(parsed.provenance.licence?.id).toBe("CC-BY-SA-4.0");
  });

  it("still accepts a provenance without holders, as servers before the field sent it", () => {
    const parsed = TrainDetail.parse(detail({ provenance: realtime }));
    expect(parsed.provenance.holders).toBeUndefined();
    expect(parsed.provenance.licence).toBeUndefined();
  });

  it("refuses an empty holder list, an unknown role and links that are not https", () => {
    const refused = [
      { ...realtime, holders: [] },
      { ...realtime, holders: [{ name: "X", role: "owner", url: null }] },
      { ...realtime, holders: [{ name: "X", role: "publisher", url: "http://example.org/" }] },
      { ...realtime, holders, licence: { id: "CC-BY-4.0", url: "javascript:alert(1)" } },
    ];
    for (const provenance of refused) {
      expect(TrainDetail.safeParse(detail({ provenance } as Partial<Detail>)).success).toBe(false);
    }
  });
});

describe("live key lookup", () => {
  it("builds the key path and reads the answer", () => {
    expect(liveKeyPath(4711)).toBe("/api/v1/live/keys/4711");
    expect(LiveKeyLookup.parse({ tripInstanceId: "0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c6d" })).toEqual(
      { tripInstanceId: "0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c6d" },
    );
    expect(LiveKeyLookup.safeParse({ tripInstanceId: "4711" }).success).toBe(false);
  });
});

describe("trainDetailPath", () => {
  it("builds the versioned API path", () => {
    expect(trainDetailPath("0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c6d")).toBe(
      "/api/v1/trains/0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c6d",
    );
  });
});
