import { describe, expect, it } from "vitest";
import type { WindowList } from "../live/playback/window-index.ts";
import { dayGroups, dayOf, hourLabel, newestAvailable, newestSettledStart } from "./hours.ts";

const HOUR = 3600;
const LIMITS = { windowSeconds: HOUR, maxAgeSeconds: 7 * 24 * HOUR, settleSeconds: 1800 };
const NOW = Date.UTC(2025, 10, 8, 10, 40) / 1000;

function windows(...starts: number[]): WindowList {
  return {
    windows: starts.map((start) => ({
      start,
      end: start + HOUR,
      revision: "abcdef012345",
      shapeEpoch: 3,
    })),
    limits: LIMITS,
  };
}

describe("hour options", () => {
  const settled = newestSettledStart(windows(), NOW);

  it("lists the newest hour that is settled and no later one", () => {
    expect(settled).toBe(Date.UTC(2025, 10, 8, 9) / 1000);
  });

  it("groups hours by Berlin day, newest day first, gaps marked unavailable", () => {
    const groups = dayGroups(windows(settled, settled - 2 * HOUR), NOW);
    expect(groups).toHaveLength(1);
    const day = groups[0];
    expect(day?.key).toBe("2025-11-08");
    const hours = day?.hours.map((hour) => [hour.hour, hour.available]);
    expect(hours?.at(-1)).toEqual([10, true]);
    expect(hours?.at(-2)).toEqual([9, false]);
    expect(hours?.at(-3)).toEqual([8, true]);
  });

  it("starts a Berlin day at midnight Berlin time, not UTC", () => {
    const lateEvening = Date.UTC(2025, 10, 7, 23) / 1000;
    const groups = dayGroups(windows(lateEvening, settled), NOW);
    const first = groups[0]?.hours[0];
    expect(groups[0]?.key).toBe("2025-11-08");
    expect(first?.start).toBe(Date.UTC(2025, 10, 7, 23) / 1000);
    expect(first?.hour).toBe(0);
    expect(groups.map((group) => group.key)).not.toContain("2025-11-07");
  });

  it("leaves out days without a rendered hour and finds the newest one", () => {
    const groups = dayGroups(windows(settled - 30 * HOUR), NOW);
    expect(groups).toHaveLength(1);
    expect(newestAvailable(groups)).toBe(settled - 30 * HOUR);
    expect(dayOf(groups, settled - 30 * HOUR)?.key).toBe("2025-11-07");
    expect(dayGroups(windows(), NOW)).toEqual([]);
    expect(newestAvailable([])).toBeUndefined();
  });

  it("does not list hours older than the limit", () => {
    const old = NOW - 8 * 24 * HOUR;
    const groups = dayGroups(windows(Math.floor(old / HOUR) * HOUR), NOW);
    expect(groups).toEqual([]);
  });
});

describe("the October day with two 02:00", () => {
  const after = Date.UTC(2025, 9, 27, 10, 40) / 1000;
  const firstHour = Date.UTC(2025, 9, 25, 22) / 1000;
  const everyHour = Array.from({ length: 25 }, (_, index) => firstHour + index * HOUR);

  it("lists the repeated hour twice, each with its own offset", () => {
    const groups = dayGroups(windows(...everyHour), after);
    const day = groups.find((group) => group.key === "2025-10-26");
    const twos = day?.hours.filter((hour) => hour.hour === 2) ?? [];
    expect(day?.hours).toHaveLength(25);
    expect(twos.map((hour) => hour.start)).toEqual([firstHour + 2 * HOUR, firstHour + 3 * HOUR]);
    expect(twos.map((hour) => hour.offset)).toEqual([2, 1]);
    expect(twos.every((hour) => hour.repeated)).toBe(true);
    expect(day?.hours.filter((hour) => hour.repeated)).toHaveLength(2);
  });

  it("labels the repeated hours apart and every other hour by its time alone", () => {
    const groups = dayGroups(windows(...everyHour), after);
    const labels = groups.find((group) => group.key === "2025-10-26")?.hours.map(hourLabel) ?? [];
    expect(labels.filter((label) => label.startsWith("02:00"))).toEqual([
      "02:00 UTC+2",
      "02:00 UTC+1",
    ]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("03:00");
  });
});
