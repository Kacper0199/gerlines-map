import { describe, expect, it } from "vitest";
import { evaluateIris, readProbeAnswers } from "./iris-evaluate.ts";
import { Matcher } from "./matcher.ts";
import { type StaticTrip, Timetable } from "./timetable.ts";

const PROBE = new URL("../../test/fixtures/db-apis/probe-8000105-2026-11-08/", import.meta.url);
const FRANKFURT = "00000000-0000-5000-8000-000008000105";

function frankfurtOnly(trips: StaticTrip[]): Timetable {
  return new Timetable({
    feedVersionId: 2,
    feedVersion: "v2",
    publishedOn: "2026-11-02",
    trips,
    calendars: new Map([
      [
        "S",
        {
          weekdays: 127,
          startDate: "2026-11-01",
          endDate: "2026-11-30",
          added: new Set(),
          removed: new Set(),
        },
      ],
    ]),
    routes: new Map(),
    stopPoints: new Map([["p", { stopPlaceId: FRANKFURT, platform: null }]]),
    stopPlaces: new Map([
      [
        FRANKFURT,
        {
          name: "Frankfurt",
          eva: 8000105,
          uic: null,
          lon: null,
          lat: null,
          countryCode: "DE",
          dhid: null,
        },
      ],
    ]),
    delfiStopPoints: new Map(),
    delfiStopPlaces: new Map(),
  });
}

describe("IRIS match evaluation", () => {
  it("reads the probe folder: ten answers, both change answers and eight plans", async () => {
    const answers = await readProbeAnswers(PROBE.pathname);
    expect(answers).toHaveLength(10);
    expect(answers.filter((answer) => answer.endpoint === "plan")).toHaveLength(8);
    expect(new Set(answers.map((answer) => answer.eva))).toEqual(new Set([8000105]));
  });

  it("counts each IRIS trip with a change once, by category, against an empty timetable", async () => {
    const answers = await readProbeAnswers(PROBE.pathname);
    const report = evaluateIris(answers, new Matcher(frankfurtOnly([])));
    expect(report).toMatchObject({ answers: 10, failedAnswers: 0, trips: 283, matched: 0 });
    expect(report.byIrisFilter.F?.trips).toBe(62);
    expect(report.byIrisCategory.ICE?.unmatched).toEqual({
      "unmatched:train_number_not_in_timetable": 61,
    });
    expect(report.byTimetableCategory).toEqual({});
  });
});
