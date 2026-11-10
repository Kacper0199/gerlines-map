import { describe, expect, it } from "vitest";
import {
  beyondUntil,
  checkableByIris,
  directTrains,
  foldStation,
  irisInstant,
  matchEvent,
  parseIrisPlan,
  parseOptions,
  sliceOf,
  stationOf,
  trainKey,
} from "../scripts/journey-plausibility.ts";

const PLAN = `<?xml version='1.0' encoding='UTF-8'?><timetable station='Testheim Hbf'>
<s id="a-1"><tl t="p" o="80" c="ICE" n="1028"/><ar pt="2611080758" pp="3" ppth="Nordstadt Hbf|Mitte"/><dp pt="2611080801" pp="3" ppth="Frankfurt(Main)Hbf|München Hbf"/></s>
<s id="b-1"><tl t="p" o="NXRE" c="NX" n="26812"/><dp pt="2611080815" pp="2" l="RE1" ppth="Mülheim(Ruhr)Hbf|Köln Hbf"/></s>
<s id="c-1"><tl t="p" o="800" c="RB" n="4711"/><ar pt="2611080840" pp="5" l="33" ppth="Westdorf"/></s>
</timetable>`;

const at = (local: string) => Date.parse(`2026-11-08T${local}:00+01:00`);

describe("parseIrisPlan", () => {
  it("reads train, planned times in German local time, line and paths", () => {
    const stops = parseIrisPlan(PLAN);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toMatchObject({ category: "ICE", number: "1028" });
    expect(stops[0]?.arrival?.at).toBe(at("07:58"));
    expect(stops[0]?.departure?.path).toEqual(["Frankfurt(Main)Hbf", "München Hbf"]);
    expect(stops[1]?.departure?.line).toBe("RE1");
    expect(stops[2]?.departure).toBeNull();
  });

  it("reads summer time too", () => {
    expect(irisInstant("2607011230")).toBe(Date.parse("2026-07-01T12:30:00+02:00"));
    expect(sliceOf(Date.parse("2026-11-08T23:30:00Z"))).toEqual({ date: "261109", hour: "00" });
  });
});

describe("matchEvent", () => {
  const stops = parseIrisPlan(PLAN);

  it("finds the train by its number with DELFI's zero padding, within two minutes", () => {
    expect(
      matchEvent({ tripNumber: "001028", line: null }, "departure", at("08:03"), stops),
    ).toEqual({ status: "within", deltaMin: -2, train: "ICE 1028" });
  });

  it("is outside when the same train runs three minutes off", () => {
    expect(matchEvent({ tripNumber: "1028", line: null }, "departure", at("08:04"), stops)).toEqual(
      { status: "outside", deltaMin: -3, train: "ICE 1028" },
    );
  });

  it("falls back to the line, written with or without the category, only within the tolerance", () => {
    expect(matchEvent({ tripNumber: null, line: "RE1" }, "departure", at("08:16"), stops)).toEqual({
      status: "within",
      deltaMin: -1,
      train: "NX 26812",
    });
    expect(matchEvent({ tripNumber: "999", line: "RB33" }, "arrival", at("08:40"), stops)).toEqual({
      status: "within",
      deltaMin: 0,
      train: "RB 4711",
    });
    expect(matchEvent({ tripNumber: null, line: "RE1" }, "departure", at("08:30"), stops)).toEqual({
      status: "outside",
      deltaMin: null,
      train: null,
    });
  });

  it("does not take an arrival for a departure", () => {
    expect(matchEvent({ tripNumber: "4711", line: null }, "departure", at("08:40"), stops)).toEqual(
      { status: "outside", deltaMin: null, train: null },
    );
  });
});

describe("directTrains", () => {
  it("lists the trains whose onward path names the destination inside the window", () => {
    const stops = parseIrisPlan(PLAN);
    const found = directTrains(stops, ["München Hbf"], at("08:00"), at("09:00"));
    expect(found.map((stop) => stop.number)).toEqual(["1028"]);
    expect(directTrains(stops, ["Mülheim (Ruhr) Hbf"], at("08:00"), at("09:00"))).toHaveLength(1);
    expect(directTrains(stops, ["München Hbf"], at("08:05"), at("09:00"))).toHaveLength(0);
  });
});

describe("names, numbers and stations", () => {
  it("folds station names as IRIS writes them", () => {
    expect(foldStation("Frankfurt (Main) Hauptbahnhof")).toBe(foldStation("Frankfurt(Main)Hbf"));
    expect(foldStation("Kobenhavn H")).toBe(foldStation("København H"));
    expect(foldStation("Wrocław Główny")).toBe(foldStation("Wroclaw Glowny"));
    expect(foldStation("Metz")).not.toBe(foldStation("Metzingen"));
  });

  it("drops DELFI's leading zeros", () => {
    expect(trainKey("001028")).toBe("1028");
    expect(trainKey("0")).toBe("0");
    expect(trainKey(" ")).toBeNull();
  });

  const stations = [
    {
      name: "Testheim Hbf",
      ifopt: "de:01001:100",
      evas: [
        { eva: 8000001, lon: 10, lat: 50 },
        { eva: 8098001, lon: 10.003, lat: 50 },
      ],
    },
  ];

  it("takes the station by DHID with its EVAs nearest the stop first", () => {
    const stop = {
      stopId: "de:01001:100:2:5",
      name: "x",
      lat: 50,
      lon: 10.0029,
      scheduledTime: null,
    };
    expect(stationOf(stop, stations)).toEqual({ name: "Testheim Hbf", evas: [8098001, 8000001] });
  });

  it("takes the nearest station within 400 m when the id is not a DHID, and none abroad", () => {
    const near = { stopId: "at:45:1", name: "x", lat: 50.002, lon: 10, scheduledTime: null };
    const far = { stopId: "at:45:1", name: "x", lat: 50.01, lon: 10, scheduledTime: null };
    expect(stationOf(near, stations)?.evas).toEqual([8000001, 8098001]);
    expect(stationOf(far, stations)).toBeNull();
  });

  it("leaves city buses and city rail to the router, since DB Timetables lists only trains and its own buses", () => {
    expect(checkableByIris("bus")).toBe(false);
    expect(checkableByIris("urban")).toBe(false);
    expect(["hsr", "ld", "night", "rfast", "reg", "sbahn"].every(checkableByIris)).toBe(true);
  });
});

describe("parseOptions", () => {
  it("keeps the first run's pacing and fetches nothing without --fetch", () => {
    expect(parseOptions(["a", "b", "c", "d"])).toEqual({
      fetch: false,
      max: 0,
      gapMs: 2_100,
      until: null,
    });
  });

  it("reads --max, a slower --gap-ms and an --until slice hour", () => {
    expect(
      parseOptions(["a", "--fetch", "--max", "300", "--gap-ms", "5000", "--until", "26110923"]),
    ).toEqual({ fetch: true, max: 300, gapMs: 5_000, until: "26110923" });
  });

  it("refuses a gap under the first run's 2.1 s and an --until that is not YYMMDDHH", () => {
    expect(() => parseOptions(["--fetch", "--gap-ms", "500"])).toThrow(/gap-ms/);
    expect(() => parseOptions(["--fetch", "--until", "2026-11-09"])).toThrow(/until/);
  });
});

describe("beyondUntil", () => {
  it("holds back slices after the --until hour so they are asked in a later run, not refused now", () => {
    expect(beyondUntil("8000001/261109/23", "26110922")).toBe(true);
    expect(beyondUntil("8000001/261109/22", "26110922")).toBe(false);
    expect(beyondUntil("8000001/261110/00", null)).toBe(false);
  });
});
