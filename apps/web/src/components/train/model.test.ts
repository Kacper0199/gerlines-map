import { TrainDetail } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { buildCardModel, STALE_AFTER_MS } from "./model.ts";
import { FIVE_STOPS, MINUTE, type StopSpec, T0, testDetail, testStops } from "./test-detail.ts";

const NOW = T0 + 30 * MINUTE;

describe("test detail builder", () => {
  it("builds details that pass the contract", () => {
    expect(TrainDetail.safeParse(testDetail()).success).toBe(true);
    expect(TrainDetail.safeParse(testDetail({ stops: testStops(FIVE_STOPS, false) })).success).toBe(
      true,
    );
  });
});

describe("buildCardModel identity", () => {
  it("titles a long distance train by product and number and keeps the line apart", () => {
    const model = buildCardModel(testDetail(), NOW);
    expect(model.title).toBe("ICE 541");
    expect(model.subtitle).toEqual({ kind: "line", value: "10" });
    expect(model.category).toBe("hsr");
  });

  it("titles a regional train by its line and shows the train number apart", () => {
    const model = buildCardModel(
      testDetail({ category: "rfast", productName: null, line: "RE4", trainNumber: "93052" }),
      NOW,
    );
    expect(model.title).toBe("RE4");
    expect(model.subtitle).toEqual({ kind: "number", value: "93052" });
  });

  it("reads an alphabetic line of a long distance train as its product", () => {
    const model = buildCardModel(
      testDetail({ category: "ld", productName: null, line: "EC", trainNumber: "378" }),
      NOW,
    );
    expect(model.title).toBe("EC 378");
    expect(model.subtitle).toBeNull();
  });

  it("marks a number as the title when no product is known, so the card words it as Train 541", () => {
    const model = buildCardModel(testDetail({ productName: null, line: "10" }), NOW);
    expect(model.title).toBe("541");
    expect(model.titleKind).toBe("number");
    expect(model.subtitle).toEqual({ kind: "line", value: "10" });
  });

  it("marks a digits only regional line as a line, so the card words it as Line 527", () => {
    const model = buildCardModel(
      testDetail({ category: "reg", productName: null, line: "527", trainNumber: "4711" }),
      NOW,
    );
    expect(model.title).toBe("527");
    expect(model.titleKind).toBe("line");
    expect(model.subtitle).toEqual({ kind: "number", value: "4711" });
  });

  it("takes the product from productName for any category, ICE 597 and TGV 9553", () => {
    expect(
      buildCardModel(testDetail({ productName: "ICE", line: "12", trainNumber: "597" }), NOW),
    ).toMatchObject({ title: "ICE 597", titleKind: "plain" });
    expect(
      buildCardModel(testDetail({ productName: "TGV", line: "82", trainNumber: "9553" }), NOW),
    ).toMatchObject({ title: "TGV 9553", titleKind: "plain" });
  });

  it("never leaves a digits only title plain, for any category and field combination", () => {
    const categories = [
      "hsr",
      "ld",
      "night",
      "rfast",
      "reg",
      "sbahn",
      "urban",
      "bus",
      "other",
    ] as const;
    const products = [null, "ICE"];
    const lines = [null, "12", "S1"];
    const numbers = [null, "597"];
    const models = categories.flatMap((category) =>
      products.flatMap((productName) =>
        lines.flatMap((line) =>
          numbers.map((trainNumber) =>
            buildCardModel(testDetail({ category, productName, line, trainNumber }), NOW),
          ),
        ),
      ),
    );
    const bare = models.filter(
      (model) => model.title !== null && /^\d+$/.test(model.title) && model.titleKind === "plain",
    );
    expect(models).toHaveLength(108);
    expect(bare).toEqual([]);
  });

  it("has no title when the data names nothing", () => {
    const model = buildCardModel(
      testDetail({ productName: null, line: null, trainNumber: null }),
      NOW,
    );
    expect(model.title).toBeNull();
  });

  it("marks foreign trains with the foreign category and maps non rail codes to regional", () => {
    expect(buildCardModel(testDetail({ foreign: true }), NOW).category).toBe("foreign");
    const other = buildCardModel(testDetail({ category: "other" }), NOW);
    expect(other.category).toBe("reg");
    expect(other.badge).toBe("train");
  });

  it("names the last stop as the destination, never a local headsign like Hauptbahnhof", () => {
    const model = buildCardModel(testDetail({ headsign: "Hauptbahnhof" }), NOW);
    expect(model.destination).toBe("Hannover Hbf");
    expect(model.destinationNote).toBeNull();
    expect(model.origin).toBe("Berlin Hbf");
    expect(buildCardModel(testDetail(), NOW).destination).toBe("Hannover Hbf");
  });

  it("adds a headsign only through the note it carries, such as a diversion", () => {
    expect(
      buildCardModel(testDetail({ headsign: "Hannover Hbf (Umleitung)" }), NOW).destinationNote,
    ).toBe("Umleitung");
    expect(buildCardModel(testDetail({ headsign: "Altona" }), NOW).destinationNote).toBeNull();
    expect(buildCardModel(testDetail({ headsign: null }), NOW).destinationNote).toBeNull();
  });

  it("drops a headsign note that names the operator, keeps place and diversion notes", () => {
    const sweg = testDetail({
      headsign: "Riegel-Malterdingen (SWEG)",
      operator: { id: "sweg", name: "SWEG Südwestdeutsche Landesverkehrs-GmbH", wikidataQid: null },
    });
    expect(buildCardModel(sweg, NOW).destinationNote).toBeNull();
    const place = { ...sweg, headsign: "Hornberg Bahnhof (Schwarzw)" };
    expect(buildCardModel(place, NOW).destinationNote).toBe("Schwarzw");
    const diverted = { ...sweg, headsign: "Hannover Hbf (Umleitung)" };
    expect(buildCardModel(diverted, NOW).destinationNote).toBe("Umleitung");
    expect(
      buildCardModel(
        {
          ...sweg,
          headsign: "Ort (DB Regio AG)",
          operator: { id: "x", name: "DB Regio AG", wikidataQid: null },
        },
        NOW,
      ).destinationNote,
    ).toBeNull();
  });

  it("drops a note that only the operator id matches", () => {
    const detail = testDetail({
      headsign: "Ort (NX)",
      operator: { id: "nx", name: "National Express Rail GmbH", wikidataQid: null },
    });
    expect(buildCardModel(detail, NOW).destinationNote).toBeNull();
  });

  it("matches a note against whole words of the last stop's name", () => {
    const detail = testDetail({ headsign: "Emsdetten (Ems)" });
    const emsdetten = { ...detail, destination: { ...detail.destination, name: "Emsdetten" } };
    expect(buildCardModel(emsdetten, NOW).destinationNote).toBe("Ems");
    const spaced = { ...detail, destination: { ...detail.destination, name: "Bad Ems Bahnhof" } };
    expect(buildCardModel(spaced, NOW).destinationNote).toBeNull();
  });

  it("drops a headsign note the last stop's name already carries", () => {
    const detail = testDetail({ headsign: "Berlin-Lichtenberg (Berlin)" });
    const bracketed = {
      ...detail,
      destination: { ...detail.destination, name: "S+U Lichtenberg Bhf (Berlin)" },
    };
    expect(buildCardModel(bracketed, NOW).destinationNote).toBeNull();
    expect(buildCardModel(detail, NOW).destinationNote).toBe("Berlin");
  });

  it("titles a long distance train without a number by its line as written", () => {
    const model = buildCardModel(
      testDetail({ category: "ld", productName: "FLX", line: "FLX10", trainNumber: null }),
      NOW,
    );
    expect(model.title).toBe("FLX10");
    expect(model.titleKind).toBe("plain");
    expect(model.subtitle).toBeNull();
  });

  it("falls back to the product only when a train has neither number nor line", () => {
    const model = buildCardModel(
      testDetail({ productName: "ICE", line: null, trainNumber: null }),
      NOW,
    );
    expect(model.title).toBe("ICE");
  });

  it("is not on the map when the worker does not draw the train, whatever the detail says", () => {
    const drawn = buildCardModel(testDetail(), NOW);
    const notDrawn = buildCardModel(testDetail(), NOW, {
      fetchAgeMs: 0,
      refreshError: null,
      notDrawn: true,
    });
    expect(drawn.onMap).toBe(true);
    expect(notDrawn.onMap).toBe(false);
    expect(notDrawn.notDrawn).toBe(true);
    expect(drawn.notDrawn).toBe(false);
  });
});

describe("buildCardModel delay and realtime", () => {
  it("rounds the delay to minutes and keeps null as no data", () => {
    expect(buildCardModel(testDetail({ delaySeconds: 330 }), NOW).delayMinutes).toBe(6);
    expect(buildCardModel(testDetail({ delaySeconds: 0 }), NOW).delayMinutes).toBe(0);
    expect(buildCardModel(testDetail({ delaySeconds: -90 }), NOW).delayMinutes).toBe(-2);
    expect(buildCardModel(testDetail({ delaySeconds: null }), NOW).delayMinutes).toBeNull();
  });

  it("marks a delay read from the live tick, not from a stop, as the delay now", () => {
    expect(buildCardModel(testDetail({ delayBasis: "current" }), NOW).delayNow).toBe(true);
    expect(buildCardModel(testDetail({ delayBasis: "stop" }), NOW).delayNow).toBe(false);
    expect(buildCardModel(testDetail(), NOW).delayNow).toBe(false);
    expect(
      buildCardModel(testDetail({ delayBasis: "current", delaySeconds: null }), NOW).delayNow,
    ).toBe(false);
    expect(
      buildCardModel(testDetail({ delayBasis: "current", delaySeconds: 20 }), NOW).delayNow,
    ).toBe(false);
  });

  it("shows no delay at all for a timetable only train", () => {
    const detail = testDetail({
      stops: testStops(FIVE_STOPS, false),
      delaySeconds: null,
      provenance: { ...testDetail().provenance, kind: "timetable", feedObservedAt: null },
    });
    const model = buildCardModel(detail, NOW);
    expect(model.realtime).toBe(false);
    expect(model.delayMinutes).toBeNull();
    expect(model.stops.every((stop) => stop.delayMinutes === null)).toBe(true);
    expect(model.stops[2]?.main.predictedMs).toBeNull();
  });

  it("calls the data stale from the feed age the server reports, not from the device clock", () => {
    const observed = T0 + 29.5 * MINUTE;
    expect(buildCardModel(testDetail(), NOW).stale).toBe(false);
    expect(buildCardModel(testDetail(), NOW + 24 * 60 * MINUTE).stale).toBe(false);
    const late = testDetail({ asOf: new Date(observed + STALE_AFTER_MS + 1000).toISOString() });
    expect(buildCardModel(late, NOW).stale).toBe(true);
    expect(buildCardModel(late, NOW).dataTimeMs).toBe(observed);
  });

  it("calls the data stale when the last successful fetch is older than three minutes", () => {
    const fresh = buildCardModel(testDetail(), NOW, {
      fetchAgeMs: STALE_AFTER_MS,
      refreshError: null,
    });
    expect(fresh.stale).toBe(false);
    const old = buildCardModel(testDetail(), NOW, {
      fetchAgeMs: STALE_AFTER_MS + 1,
      refreshError: "unreachable",
    });
    expect(old.stale).toBe(true);
    expect(old.refreshFailed).toBe(true);
  });

  it("can call a timetable only train stale only by the fetch age", () => {
    const detail = testDetail({
      stops: testStops(FIVE_STOPS, false),
      provenance: { ...testDetail().provenance, kind: "timetable", feedObservedAt: null },
    });
    expect(buildCardModel(detail, NOW + 60 * MINUTE).stale).toBe(false);
    expect(
      buildCardModel(detail, NOW, { fetchAgeMs: STALE_AFTER_MS + 1, refreshError: null }).stale,
    ).toBe(true);
  });
});

describe("buildCardModel stops", () => {
  it("gives every stop its role, its time and its delay in minutes", () => {
    const { stops } = buildCardModel(testDetail(), NOW);
    expect(stops.map((stop) => stop.role)).toEqual(["passed", "passed", "next", "ahead", "ahead"]);
    expect(stops[0]?.main.kind).toBe("departure");
    expect(stops[1]?.main).toMatchObject({ kind: "departure", scheduledMs: T0 + 12 * MINUTE });
    expect(stops[4]?.main.kind).toBe("arrival");
    expect(stops[2]?.main).toMatchObject({
      predictedMs: T0 + 46 * MINUTE,
      scheduledMs: T0 + 40 * MINUTE,
    });
    expect(stops.map((stop) => stop.delayMinutes)).toEqual([2, 4, 6, 6, 5]);
  });

  it("reads a changed platform as the new track with the old one", () => {
    const { stops } = buildCardModel(testDetail(), NOW);
    expect(stops[2]?.platform).toEqual({ track: "8", was: "7" });
    expect(stops[3]?.platform).toEqual({ track: "2", was: null });
  });

  it("has no platform when the data has none", () => {
    const detail = testDetail({
      stops: testStops([
        { name: "A", departure: 0 },
        { name: "B", arrival: 5 },
      ]),
    });
    expect(
      buildCardModel({ ...detail, progress: { lastPassedIndex: 0, nextIndex: 1 } }, NOW).stops[1]
        ?.platform,
    ).toBeNull();
  });
});

describe("buildCardModel position", () => {
  it("places the train between the last passed and the next stop by time", () => {
    const { position } = buildCardModel(testDetail(), NOW);
    expect(position.kind).toBe("between");
    if (position.kind !== "between") return;
    expect(position.from.name).toBe("Berlin-Spandau");
    expect(position.to.name).toBe("Stendal Hbf");
    expect(position.progress).toBeCloseTo((30 - 16) / (46 - 16), 5);
    expect(position.arrivalMs).toBe(T0 + 46 * MINUTE);
  });

  it("clamps the progress to the leg", () => {
    const late = buildCardModel(testDetail(), T0 + 90 * MINUTE).position;
    expect(late.kind === "between" && late.progress).toBe(1);
  });

  it("keeps the train before the next stop until the server reports it reached, whatever the clock says", () => {
    const { position } = buildCardModel(testDetail(), T0 + 47 * MINUTE);
    expect(position.kind).toBe("between");
    if (position.kind === "between") expect(position.progress).toBe(1);
  });

  it("stands at the stop the server reports reached until its departure", () => {
    const detail = testDetail({ progress: { lastPassedIndex: 2, nextIndex: 3 } });
    const at = buildCardModel(detail, T0 + 47 * MINUTE).position;
    expect(at.kind).toBe("at");
    if (at.kind === "at") {
      expect(at.stop.name).toBe("Stendal Hbf");
      expect(at.next?.name).toBe("Wolfsburg Hbf");
    }
    const left = buildCardModel(detail, T0 + 49 * MINUTE).position;
    expect(left.kind).toBe("between");
  });

  it("knows a train that has not left its first stop", () => {
    const detail = testDetail({ progress: { lastPassedIndex: null, nextIndex: 0 } });
    const { position } = buildCardModel(detail, T0 - 5 * MINUTE);
    expect(position.kind).toBe("before");
    if (position.kind === "before") expect(position.stop.name).toBe("Berlin Hbf");
  });

  it("knows a train that has arrived", () => {
    const detail = testDetail({ progress: { lastPassedIndex: 4, nextIndex: null } });
    const model = buildCardModel(detail, T0 + 110 * MINUTE);
    expect(model.position.kind).toBe("arrived");
    expect(model.stops.every((stop) => stop.role === "passed")).toBe(true);
  });

  it("skips a cancelled next stop and keeps it in the list", () => {
    const specs = FIVE_STOPS.map((spec, index) =>
      index === 2 ? { ...spec, cancelled: true } : spec,
    );
    const model = buildCardModel(testDetail({ stops: testStops(specs) }), NOW);
    expect(model.position.kind === "between" && model.position.to.name).toBe("Wolfsburg Hbf");
    expect(model.stops[2]).toMatchObject({ cancelled: true, role: "ahead" });
  });

  it("has no position for a cancelled train and keeps it off the map", () => {
    const model = buildCardModel(testDetail({ cancelled: true }), NOW);
    expect(model.position.kind).toBe("cancelled");
    expect(model.onMap).toBe(false);
  });

  it("keeps a train without track geometry off the map", () => {
    const detail = testDetail({ geometry: { available: false, reason: "low_quality" } });
    expect(buildCardModel(detail, NOW).onMap).toBe(false);
    expect(buildCardModel(testDetail(), NOW).onMap).toBe(true);
  });
});

describe("buildCardModel delays per side", () => {
  it("takes the delay from the side of the time shown and never borrows the other side", () => {
    const stops = testStops(FIVE_STOPS).map((stop) =>
      stop.index === 1 ? { ...stop, departureDelaySeconds: null, predictedDeparture: null } : stop,
    );
    const model = buildCardModel(testDetail({ stops }), NOW);
    expect(model.stops[1]?.main.kind).toBe("departure");
    expect(model.stops[1]?.delayMinutes).toBeNull();
    expect(model.stops[1]?.arrivalDelayMinutes).toBe(4);
    expect(model.stops[1]?.departureDelayMinutes).toBeNull();
  });
});

describe("buildCardModel short runs", () => {
  const RE9: readonly StopSpec[] = [
    { name: "München Hbf", departure: 0, delay: 0 },
    { name: "Augsburg Hbf", arrival: 30, departure: 32, delay: 0 },
    { name: "Günzburg", arrival: 60, departure: 61, delay: 0 },
    { name: "Leipheim", arrival: 65, departure: 66, cancelled: true },
    { name: "Nersingen", arrival: 70, departure: 71, cancelled: true },
    { name: "Neu-Ulm", arrival: 75, departure: 76, cancelled: true },
    { name: "Ulm Hbf", arrival: 80, cancelled: true },
  ];

  it("says where a train ends early and how many stops it drops", () => {
    const model = buildCardModel(testDetail({ stops: testStops(RE9) }), NOW);
    expect(model.shortRun).toMatchObject({ kind: "ends-early", cancelled: 4 });
    expect(model.shortRun?.kind === "ends-early" && model.shortRun.stop.name).toBe("Günzburg");
    expect(model.lastServedIndex).toBe(2);
  });

  it("counts cancelled stops ahead when the train still reaches its destination", () => {
    const specs = FIVE_STOPS.map((spec, index) =>
      index === 3 ? { ...spec, cancelled: true } : spec,
    );
    const model = buildCardModel(testDetail({ stops: testStops(specs) }), NOW);
    expect(model.shortRun).toEqual({ kind: "skips", cancelled: 1 });
  });

  it("says nothing for a train that serves every stop or is cancelled as a whole", () => {
    expect(buildCardModel(testDetail(), NOW).shortRun).toBeNull();
    expect(buildCardModel(testDetail({ cancelled: true }), NOW).shortRun).toBeNull();
  });

  it("ignores cancelled stops the train has already passed", () => {
    const specs = FIVE_STOPS.map((spec, index) =>
      index === 1 ? { ...spec, cancelled: true } : spec,
    );
    const detail = testDetail({
      stops: testStops(specs),
      progress: { lastPassedIndex: 2, nextIndex: 3 },
    });
    expect(buildCardModel(detail, NOW).shortRun).toBeNull();
  });
});

describe("buildCardModel days", () => {
  it("marks times on a later day than the first departure, in Berlin time", () => {
    const night = testDetail({
      asOf: "2026-10-26T22:00:00Z",
      progress: { lastPassedIndex: 0, nextIndex: 1 },
      stops: testStops([
        { name: "Hamburg", departure: 13 * 60, delay: 0 },
        { name: "Hannover", arrival: 14 * 60 + 30, departure: 14 * 60 + 35, delay: 0 },
        { name: "Basel SBB", arrival: 22 * 60, delay: 0 },
      ]),
    });
    expect(
      buildCardModel(night, Date.parse("2026-10-26T22:00:00Z")).stops.map((stop) => stop.dayOffset),
    ).toEqual([0, 0, 1]);
  });

  it("counts days across the switch from summer to winter time", () => {
    const base = Date.parse("2026-10-24T21:30:00Z");
    const minutesFromT0 = (ms: number) => (ms - T0) / MINUTE;
    const detail = testDetail({
      asOf: "2026-10-24T21:40:00Z",
      progress: { lastPassedIndex: 0, nextIndex: 1 },
      stops: testStops([
        { name: "Berlin", departure: minutesFromT0(base), delay: 0 },
        { name: "Halle", arrival: minutesFromT0(base + 150 * MINUTE), delay: 0 },
        { name: "Erfurt", arrival: minutesFromT0(base + 3 * 60 * MINUTE + 30 * MINUTE), delay: 0 },
      ]),
    });
    expect(buildCardModel(detail, base).stops.map((stop) => stop.dayOffset)).toEqual([0, 1, 1]);
  });
});

describe("buildCardModel badge", () => {
  it("names buses and urban rail instead of calling them trains", () => {
    expect(buildCardModel(testDetail({ category: "bus" }), NOW).badge).toBe("bus");
    expect(buildCardModel(testDetail({ category: "urban" }), NOW).badge).toBe("urban");
    expect(buildCardModel(testDetail({ category: "other" }), NOW).badge).toBe("train");
    expect(buildCardModel(testDetail(), NOW).badge).toBe("named");
    expect(buildCardModel(testDetail({ foreign: true, category: "bus" }), NOW).badge).toBe("named");
  });
});
