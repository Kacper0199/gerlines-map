import { describe, expect, it } from "vitest";
import { nextWeekdayAt } from "./local-time.ts";

const TUESDAY = 2;

describe("nextWeekdayAt", () => {
  it.each([
    ["2026-10-26T10:00:00Z", "2026-10-27T07:00:00+01:00"],
    ["2026-10-27T05:00:00Z", "2026-11-03T07:00:00+01:00"],
    ["2026-10-24T22:30:00Z", "2026-10-27T07:00:00+01:00"],
    ["2026-03-25T12:00:00Z", "2026-03-31T07:00:00+02:00"],
    ["2026-12-29T23:30:00Z", "2027-01-05T07:00:00+01:00"],
  ])("from %s the next Tuesday 07:00 in Berlin is %s", (now, expected) => {
    expect(nextWeekdayAt(Date.parse(now), TUESDAY, 7, "Europe/Berlin")).toBe(expected);
  });

  it("names the same instant as its UTC form", () => {
    const text = nextWeekdayAt(Date.parse("2026-10-26T10:00:00Z"), TUESDAY, 7, "Europe/Berlin");
    expect(new Date(text).toISOString()).toBe("2026-10-27T06:00:00.000Z");
  });
});
