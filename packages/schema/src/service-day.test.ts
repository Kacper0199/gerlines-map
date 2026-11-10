import { describe, expect, it } from "vitest";
import {
  addDays,
  gtfsDateToIso,
  gtfsTimeToSeconds,
  localDate,
  serviceDayReference,
  serviceInstant,
} from "./service-day.ts";

const iso = (ms: number) => new Date(ms).toISOString();

describe("serviceDayReference", () => {
  it("is local noon minus 12 h: midnight on an ordinary day", () => {
    expect(iso(serviceDayReference("2026-10-24"))).toBe("2026-10-23T22:00:00.000Z");
    expect(iso(serviceDayReference("2026-12-01"))).toBe("2026-11-30T23:00:00.000Z");
  });

  it("is 01:00 local summer time on the day clocks go back (2026-10-25)", () => {
    expect(iso(serviceDayReference("2026-10-25"))).toBe("2026-10-24T23:00:00.000Z");
  });

  it("is 23:00 local winter time the evening before clocks go forward (2026-03-29)", () => {
    expect(iso(serviceDayReference("2026-03-29"))).toBe("2026-03-28T22:00:00.000Z");
  });
});

describe("serviceInstant", () => {
  it("adds GTFS seconds, also past 24 h", () => {
    expect(iso(serviceInstant("2026-10-24", 25 * 3600))).toBe("2026-10-24T23:00:00.000Z");
    expect(iso(serviceInstant("2026-10-25", 12 * 3600))).toBe("2026-10-25T11:00:00.000Z");
  });

  it("gives the wall clock time an hour early before 02:00 on the DST day", () => {
    expect(iso(serviceInstant("2026-10-25", 3 * 3600))).toBe("2026-10-25T02:00:00.000Z");
  });
});

describe("localDate", () => {
  it("is the Europe/Berlin calendar date of an instant", () => {
    expect(localDate(Date.parse("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
    expect(localDate(Date.parse("2026-10-23T22:30:00Z"))).toBe("2026-10-24");
    expect(localDate(Date.parse("2026-10-23T21:59:59Z"))).toBe("2026-10-23");
    expect(localDate(Date.parse("2026-03-28T22:30:00Z"))).toBe("2026-03-28");
    expect(localDate(Date.parse("2026-03-28T23:00:00Z"))).toBe("2026-03-29");
  });
});

describe("helpers", () => {
  it("parses GTFS times and dates", () => {
    expect(gtfsTimeToSeconds("25:03:07")).toBe(90187);
    expect(gtfsTimeToSeconds("7:00:00")).toBe(25200);
    expect(gtfsTimeToSeconds("bad")).toBeNull();
    expect(gtfsDateToIso("20261025")).toBe("2026-10-25");
    expect(gtfsDateToIso("2026-10-25")).toBe("2026-10-25");
    expect(gtfsDateToIso("2026-13-01")).toBeNull();
    expect(addDays("2026-10-25", -1)).toBe("2026-10-24");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
