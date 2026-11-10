import { describe, expect, it } from "vitest";
import { checkWindow, DEFAULT_LIMITS, dueWindows, parseWindowStart } from "./window.ts";

const HOUR = 3600;
const NOW = Date.parse("2026-11-08T07:10:00Z") / 1000;
const START = Date.parse("2026-11-07T14:00:00Z") / 1000;

describe("playback windows", () => {
  it("accepts an aligned past hour that has settled and returns its bounds", () => {
    expect(checkWindow(START, NOW)).toEqual({ ok: true, start: START, end: START + HOUR });
  });

  it("refuses a start that is not on the hour", () => {
    expect(checkWindow(START + 60, NOW)).toMatchObject({ ok: false, code: "MISALIGNED" });
  });

  it("refuses a window older than seven days and one that has not settled", () => {
    const oldest = NOW - DEFAULT_LIMITS.maxAgeSeconds;
    const alignedOldest = Math.ceil(oldest / HOUR) * HOUR;
    expect(checkWindow(alignedOldest, NOW)).toMatchObject({ ok: true });
    expect(checkWindow(alignedOldest - HOUR, NOW)).toMatchObject({ ok: false, code: "TOO_OLD" });
    const lastSettled = Math.floor((NOW - DEFAULT_LIMITS.settleSeconds) / HOUR) * HOUR - HOUR;
    expect(checkWindow(lastSettled, NOW)).toMatchObject({ ok: true });
    expect(checkWindow(lastSettled + HOUR, NOW)).toMatchObject({ ok: false, code: "NOT_SETTLED" });
  });

  it("takes other window lengths from the limits", () => {
    const limits = { ...DEFAULT_LIMITS, windowSeconds: 600 };
    expect(checkWindow(START + 600, NOW, limits)).toEqual({
      ok: true,
      start: START + 600,
      end: START + 1200,
    });
    expect(checkWindow(START + 300, NOW, limits)).toMatchObject({ code: "MISALIGNED" });
  });

  it("parses only whole Unix seconds of ten digits", () => {
    expect(parseWindowStart(String(START))).toBe(START);
    for (const text of ["", "17624", "1762524000.0", "-1762524000", "01762524000", "abc", "1e9"]) {
      expect(parseWindowStart(text)).toBeNull();
    }
  });

  it("lists the settled windows of a range, oldest first, inside the age limit", () => {
    const due = dueWindows(START - 2 * HOUR + 1, START + HOUR, NOW);
    expect(due).toEqual([START - HOUR, START]);
    expect(dueWindows(NOW - 2 * HOUR, NOW, NOW)).toEqual([]);
    expect(dueWindows(NOW - 30 * 24 * HOUR, NOW - 29 * 24 * HOUR, NOW)).toEqual([]);
  });
});
