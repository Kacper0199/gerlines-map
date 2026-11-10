import { describe, expect, it } from "vitest";
import { findGaps, missingSnapshots, openGap } from "./gaps.ts";

const at = (iso: string) => Date.parse(iso);
const minute = 60_000;

describe("findGaps", () => {
  it("finds intervals longer than twice the cadence between successes", () => {
    const times = [
      at("2026-10-25T09:00:20Z"),
      at("2026-10-25T09:01:20Z"),
      at("2026-10-25T09:03:21Z"),
      at("2026-10-25T09:13:20Z"),
      at("2026-10-25T09:14:20Z"),
    ];
    expect(findGaps(times, minute)).toEqual([
      { start: at("2026-10-25T09:01:20Z"), end: at("2026-10-25T09:03:21Z") },
      { start: at("2026-10-25T09:03:21Z"), end: at("2026-10-25T09:13:20Z") },
    ]);
  });

  it("tolerates one missed fetch, unsorted input and duplicates", () => {
    const times = [
      at("2026-10-25T09:02:20Z"),
      at("2026-10-25T09:00:20Z"),
      at("2026-10-25T09:00:20Z"),
    ];
    expect(findGaps(times, minute)).toEqual([]);
  });

  it("measures a gap over the DST switch in UTC, not in local wall time", () => {
    const times = [at("2026-10-25T00:58:20Z"), at("2026-10-25T01:03:20Z")];
    expect(findGaps(times, minute)).toEqual([
      { start: at("2026-10-25T00:58:20Z"), end: at("2026-10-25T01:03:20Z") },
    ]);
  });
});

describe("openGap", () => {
  it("reports a running gap only past twice the cadence", () => {
    const last = at("2026-10-25T09:00:20Z");
    expect(openGap(last, last + 2 * minute, minute)).toBeNull();
    expect(openGap(last, last + 2 * minute + 1, minute)).toEqual({
      start: last,
      end: last + 2 * minute + 1,
    });
    expect(openGap(null, last, minute)).toBeNull();
  });
});

describe("missingSnapshots", () => {
  it("lists the mirror minutes between the snapshots of the bounding successes", () => {
    const gap = { start: at("2026-10-25T09:05:21Z"), end: at("2026-10-25T09:09:20Z") };
    expect(missingSnapshots(gap).map((t) => new Date(t).toISOString())).toEqual([
      "2026-10-25T09:06:01.000Z",
      "2026-10-25T09:07:01.000Z",
      "2026-10-25T09:08:01.000Z",
    ]);
  });

  it("treats a backfilled snapshot time as its own snapshot", () => {
    const gap = { start: at("2026-10-25T09:06:01Z"), end: at("2026-10-25T09:08:20Z") };
    expect(missingSnapshots(gap).map((t) => new Date(t).toISOString())).toEqual([
      "2026-10-25T09:07:01.000Z",
    ]);
  });
});
