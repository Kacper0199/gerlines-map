import { describe, expect, it } from "vitest";
import { REALTIME_SOURCES } from "./adapters.ts";
import { instantArg, irisMatchArgs, numberArg, sourcesArg } from "./args.ts";

describe("realtime command arguments", () => {
  it("reads an instant and refuses a typo", () => {
    expect(instantArg("since", "2026-10-25T00:00:00Z")).toBe(Date.UTC(2026, 9, 25));
    expect(() => instantArg("since", "2026-13-45")).toThrow(/--since is not a date/);
  });

  it("refuses numbers that would disable pruning or busy-loop the poll", () => {
    const hours = { min: 1 };
    expect(numberArg("horizon-hours", undefined, 48, hours)).toBe(48);
    expect(numberArg("horizon-hours", "12", 48, hours)).toBe(12);
    expect(() => numberArg("horizon-hours", "x", 48, hours)).toThrow(/at least 1/);
    expect(() => numberArg("horizon-hours", "", 48, hours)).toThrow();
    expect(() => numberArg("poll-seconds", "0", 5, { min: 0, exclusiveMin: true })).toThrow(
      /above 0/,
    );
    expect(() => numberArg("duplicates", "2", 0.1, { min: 0, max: 1 })).toThrow();
  });

  it("takes only known sources", () => {
    expect(sourcesArg(undefined)).toEqual([...REALTIME_SOURCES]);
    expect(sourcesArg("delfi-gtfs-rt, gtfsde-rt")).toEqual(["delfi-gtfs-rt", "gtfsde-rt"]);
    expect(() => sourcesArg("../etc")).toThrow(/unknown sources: \.\.\/etc/);
    expect(() => sourcesArg("delfi-gtfs-rt,")).toThrow(/unknown sources/);
  });

  it("reads iris-match options and needs --allow-shared for a shared database", () => {
    const values = { dir: "/tmp/probe", "feed-version-ids": "1,2" };
    expect(irisMatchArgs(values)).toEqual({
      dir: "/tmp/probe",
      feedVersionIds: [1, 2],
      allowShared: false,
    });
    expect(irisMatchArgs({ ...values, "allow-shared": true }).allowShared).toBe(true);
    expect(() => irisMatchArgs({ ...values, dir: "probe" })).toThrow(/absolute/);
    expect(() => irisMatchArgs({ ...values, "feed-version-ids": "1,x" })).toThrow(/versions/);
    expect(() => irisMatchArgs({ dir: "/tmp/probe" })).toThrow(/versions/);
  });
});
