import type { StatsNetwork } from "@gerlines/schema/stats";
import { describe, expect, it } from "vitest";
import network from "./fixtures/network-2025-11.json" with { type: "json" };
import today from "./fixtures/today.json" with { type: "json" };
import {
  binClass,
  binLabelMinutes,
  categoryEntries,
  delayClasses,
  delayClassOf,
  durationParts,
  durationText,
  emptyReason,
  hourSeries,
  isTinyShare,
  percentNumber,
  percentOf,
  productOfLines,
} from "./model.ts";

const NET = network as unknown as StatsNetwork;

describe("delayClassOf", () => {
  it("follows the delay colour mode: early and under 3 minutes ok, 3 to 5 minor, 6 to 14 major, 15 and more severe", () => {
    expect(delayClassOf(-1800)).toBe("ok");
    expect(delayClassOf(-300)).toBe("ok");
    expect(delayClassOf(0)).toBe("ok");
    expect(delayClassOf(120)).toBe("ok");
    expect(delayClassOf(180)).toBe("minor");
    expect(delayClassOf(300)).toBe("minor");
    expect(delayClassOf(360)).toBe("major");
    expect(delayClassOf(840)).toBe("major");
    expect(delayClassOf(900)).toBe("severe");
    expect(delayClassOf(7200)).toBe("severe");
  });
});

describe("delayClasses", () => {
  it("sums the histogram bins per class and keeps the total equal to the observed stops", () => {
    const classes = delayClasses(NET.delayHistogram);
    expect(classes.total).toBe(NET.summary.observed);
    expect(classes.ok + classes.minor + classes.major + classes.severe).toBe(classes.total);
    expect(classes.ok).toBe(
      NET.delayHistogram.filter((bin) => (bin.fromS ?? 0) < 180).reduce((s, b) => s + b.count, 0),
    );
  });
  it("is empty for an empty histogram", () => {
    expect(delayClasses([])).toEqual({ ok: 0, minor: 0, major: 0, severe: 0, total: 0 });
  });
});

describe("binLabelMinutes", () => {
  it("names a bin by its lower edge in whole minutes and the open end with a plus", () => {
    expect(binLabelMinutes({ fromS: -1800, toS: -300, count: 1 })).toBe("\u221230");
    expect(binLabelMinutes({ fromS: 0, toS: 60, count: 1 })).toBe("0");
    expect(binLabelMinutes({ fromS: 960, toS: 1200, count: 1 })).toBe("16");
    expect(binLabelMinutes({ fromS: 7200, toS: null, count: 1 })).toBe("120+");
  });
});

describe("binClass", () => {
  it("colours a bin by its lower edge like the Delay mode of the map", () => {
    expect(binClass({ fromS: 0, toS: 60, count: 1 })).toBe("ok");
    expect(binClass({ fromS: 180, toS: 240, count: 1 })).toBe("minor");
    expect(binClass({ fromS: 600, toS: 660, count: 1 })).toBe("major");
    expect(binClass({ fromS: 960, toS: 1200, count: 1 })).toBe("severe");
    expect(binClass({ fromS: 7200, toS: null, count: 1 })).toBe("severe");
  });

  it("counts a bin without a lower edge as early, never as severe", () => {
    expect(binClass({ fromS: null, toS: -1800, count: 1 })).toBe("ok");
    const totals = delayClasses([{ fromS: null, toS: 0, count: 4 }]);
    expect(totals).toMatchObject({ ok: 4, severe: 0, total: 4 });
  });
});

describe("categoryEntries", () => {
  it("lists every map category in the legend order, with no row for those the answer lacks", () => {
    const entries = categoryEntries(NET.byCategory);
    expect(entries.map((entry) => entry.category)).toEqual([
      "hsr",
      "ld",
      "night",
      "rfast",
      "reg",
      "sbahn",
    ]);
    expect(entries.map((entry) => entry.row !== null)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(entries[2]?.row).toBe(NET.byCategory.find((row) => row.category === "night"));
  });

  it("appends the categories outside the map and the rows without a category after the map ones", () => {
    const row = (category: "urban" | "bus" | null) => ({ ...NET.byCategory[0], category }) as never;
    const entries = categoryEntries([row(null), row("bus"), ...NET.byCategory, row("urban")]);
    expect(entries.map((entry) => entry.category)).toEqual([
      "hsr",
      "ld",
      "night",
      "rfast",
      "reg",
      "sbahn",
      null,
      "bus",
      "urban",
    ]);
  });

  it("keeps an empty answer as six rows without data", () => {
    expect(categoryEntries([]).every((entry) => entry.row === null)).toBe(true);
  });
});

describe("productOfLines", () => {
  it("reads the product letters the lines carry, never the category", () => {
    expect(productOfLines(["IC35"])).toBe("IC");
    expect(productOfLines(["ICE"])).toBe("ICE");
    expect(productOfLines(["RE5", "RE5"])).toBe("RE");
    expect(productOfLines(["ICE", null])).toBe("ICE");
  });
  it("gives no product when the lines disagree, carry none or are not letters then digits", () => {
    expect(productOfLines(["IC35", "ICE"])).toBeNull();
    expect(productOfLines([null, null])).toBeNull();
    expect(productOfLines([])).toBeNull();
    expect(productOfLines(["S 1"])).toBeNull();
    expect(productOfLines(["12"])).toBeNull();
  });
});

describe("hourSeries", () => {
  it("lists all 24 hours, with a missing share where nothing was observed", () => {
    const series = hourSeries(NET.byHour);
    expect(series).toHaveLength(24);
    const first = NET.byHour[0];
    expect(series[first?.hour ?? 0]?.punctual6).toBe(first?.punctual6);
    const gap = hourSeries([
      { hour: 5, stops: 3, cancelled: 3, observedArrivals: 0, punctual6: null, meanDelayS: null },
    ]);
    expect(gap[5]?.punctual6).toBeNull();
    expect(gap[6]).toEqual({
      hour: 6,
      stops: 0,
      cancelled: 0,
      observedArrivals: 0,
      punctual6: null,
      meanDelayS: null,
    });
  });
});

describe("percentOf and durationParts", () => {
  it("formats a share with one decimal in the language's own style", () => {
    expect(percentOf(0.5278, "en")).toBe("52.8%");
    expect(percentOf(0.5278, "de")).toBe("52,8 %");
    expect(percentOf(0.5278, "pl")).toBe("52,8%");
    expect(percentOf(null, "en")).toBeNull();
  });
  it("says under 0.1 for a share above zero that would round to 0.0, and keeps a true zero", () => {
    const under = (value: string) => `under ${value}`;
    expect(percentOf(0.0003, "en", under)).toBe("under 0.1%");
    expect(percentOf(0.0003, "de", under)).toBe("under 0,1\u00a0%");
    expect(percentOf(0.0004, "pl", under)).toBe("under 0,1%");
    expect(percentOf(0, "en", under)).toBe("0.0%");
    expect(percentOf(0.0005, "en", under)).toBe("0.1%");
    expect(percentOf(0.0003, "en")).toBe("0.0%");
    expect(isTinyShare(0.0004)).toBe(true);
    expect(isTinyShare(0)).toBe(false);
    expect(isTinyShare(0.0005)).toBe(false);
  });
  it("splits a delay in seconds into the unit the reader needs", () => {
    expect(durationParts(42)).toEqual({ unit: "s", value: 42 });
    expect(durationParts(662.2)).toEqual({ unit: "min", value: 11 });
    expect(durationParts(17940)).toEqual({ unit: "h", value: 4, minutes: 59 });
    expect(durationParts(-90)).toEqual({ unit: "min", value: -1.5 });
    expect(durationText(662.2, "en", "min")).toBe("11.0 min");
    expect(durationText(276, "en", "min")).toBe("4.6 min");
    expect(durationText(42, "en", "min")).toBe("42 s");
    expect(durationParts(null)).toBeNull();
  });
});

describe("emptyReason", () => {
  it("separates a period without any stop from stops without a realtime arrival", () => {
    expect(emptyReason(NET.summary)).toBeNull();
    expect(emptyReason((today as unknown as StatsNetwork).summary)).toBe("no-stops");
    expect(
      emptyReason({ ...NET.summary, stops: 12, observed: 0, observedArrivals: 0, punctual6: null }),
    ).toBe("no-realtime");
    expect(emptyReason({ ...NET.summary, observedArrivals: 0, punctual6: null })).toBe(
      "no-arrivals",
    );
  });
});

describe("percentNumber", () => {
  it("rounds half up on the decimal digits of the share, never on its binary error", () => {
    expect(percentNumber(0.4305)).toBe(43.1);
    expect(percentNumber(0.5278)).toBe(52.8);
    expect(percentNumber(0.41049)).toBe(41);
    expect(percentNumber(0.4105)).toBe(41.1);
    expect(percentNumber(0)).toBe(0);
    expect(percentNumber(1)).toBe(100);
    expect(percentNumber(0.0005)).toBe(0.1);
  });
});
