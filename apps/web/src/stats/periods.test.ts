import { describe, expect, it } from "vitest";
import {
  addDays,
  berlinDay,
  clampRange,
  coversWholeMonths,
  FIRST_DAY,
  type MonthRef,
  monthOf,
  periodRange,
  shiftMonth,
  validateRange,
} from "./periods.ts";

describe("berlinDay", () => {
  it("reads the Berlin calendar date, not the UTC one", () => {
    expect(berlinDay(Date.parse("2026-11-07T23:30:00Z"))).toBe("2026-11-08");
    expect(berlinDay(Date.parse("2026-07-07T22:30:00Z"))).toBe("2026-07-08");
    expect(berlinDay(Date.parse("2026-11-08T11:00:00Z"))).toBe("2026-11-08");
  });
});

describe("addDays", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
});

describe("periodRange", () => {
  const today = "2026-11-08";
  it("takes today as one day", () => {
    expect(periodRange({ kind: "today" }, today)).toEqual({ from: today, to: today });
  });
  it("counts the last 7 and 30 days including today", () => {
    expect(periodRange({ kind: "days", count: 7 }, today)).toEqual({
      from: "2026-11-02",
      to: today,
    });
    expect(periodRange({ kind: "days", count: 30 }, today)).toEqual({
      from: "2026-10-10",
      to: today,
    });
  });
  it("spans a whole past month and stops at today in the current month", () => {
    expect(periodRange({ kind: "month", year: 2025, month: 11 }, today)).toEqual({
      from: "2025-11-01",
      to: "2025-11-30",
    });
    expect(periodRange({ kind: "month", year: 2026, month: 2 }, today)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(periodRange({ kind: "month", year: 2026, month: 11 }, today)).toEqual({
      from: "2026-11-01",
      to: today,
    });
  });
  it("passes a custom range through", () => {
    expect(periodRange({ kind: "custom", from: "2025-11-03", to: "2025-11-09" }, today)).toEqual({
      from: "2025-11-03",
      to: "2025-11-09",
    });
  });
});

describe("shiftMonth", () => {
  it("steps across a year boundary", () => {
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2025, month: 12 }, 1)).toEqual({ year: 2026, month: 1 });
  });
  it("takes the month of a day", () => {
    const month: MonthRef = monthOf("2026-11-08");
    expect(month).toEqual({ year: 2026, month: 11 });
  });
});

describe("validateRange", () => {
  it("accepts a range of 1 to 366 days", () => {
    expect(validateRange("2025-11-01", "2025-11-01")).toEqual({ ok: true, days: 1 });
    expect(validateRange("2025-01-01", "2025-12-31")).toEqual({ ok: true, days: 365 });
    expect(validateRange("2024-01-01", "2024-12-31")).toEqual({ ok: true, days: 366 });
  });
  it("names what is wrong", () => {
    expect(validateRange("2025-11-05", "2025-11-01")).toEqual({ ok: false, problem: "order" });
    expect(validateRange("2024-01-01", "2025-01-01")).toEqual({ ok: false, problem: "too-long" });
    expect(validateRange("", "2025-01-01")).toEqual({ ok: false, problem: "incomplete" });
    expect(validateRange("2025-02-30", "2025-03-01")).toEqual({ ok: false, problem: "incomplete" });
  });
});

describe("clampRange", () => {
  const today = "2026-11-08";
  it("raises a day before the first data month to the first day", () => {
    expect(clampRange({ from: "0002-01-01", to: "2026-11-01" }, today)).toEqual({
      from: FIRST_DAY,
      to: "2026-11-01",
    });
    expect(clampRange({ from: "1999-12-31", to: "2025-01-01" }, today).from).toBe("2024-01-01");
  });
  it("lowers a day after today to today, since planned stops are not statistics", () => {
    expect(clampRange({ from: "2026-11-01", to: "2027-03-01" }, today).to).toBe(today);
    expect(clampRange({ from: "2026-12-01", to: "2026-12-05" }, today)).toEqual({
      from: today,
      to: today,
    });
  });
  it("leaves a range inside the bounds and an unfinished field alone", () => {
    expect(clampRange({ from: "2025-11-03", to: "2025-11-09" }, today)).toEqual({
      from: "2025-11-03",
      to: "2025-11-09",
    });
    expect(clampRange({ from: "", to: "2025-11-09" }, today)).toEqual({
      from: "",
      to: "2025-11-09",
    });
    expect(clampRange({ from: "2025-11-0", to: "2025-11-09" }, today).from).toBe("2025-11-0");
  });
  it("leaves an order problem for the message, it does not swap the days", () => {
    expect(clampRange({ from: "2025-11-20", to: "2025-11-03" }, today)).toEqual({
      from: "2025-11-20",
      to: "2025-11-03",
    });
  });
});

describe("coversWholeMonths", () => {
  it("is true for one month and for several, from the first to the last day", () => {
    expect(coversWholeMonths({ from: "2025-11-01", to: "2025-11-30" })).toBe(true);
    expect(coversWholeMonths({ from: "2025-10-01", to: "2025-11-30" })).toBe(true);
    expect(coversWholeMonths({ from: "2024-02-01", to: "2024-02-29" })).toBe(true);
  });
  it("is false for a month in progress, a partial month and a single day", () => {
    expect(coversWholeMonths({ from: "2026-11-01", to: "2026-11-08" })).toBe(false);
    expect(coversWholeMonths({ from: "2025-11-02", to: "2025-11-30" })).toBe(false);
    expect(coversWholeMonths({ from: "2025-11-08", to: "2025-11-08" })).toBe(false);
    expect(coversWholeMonths({ from: "2025-11-01", to: "2025-11-29" })).toBe(false);
  });
});
