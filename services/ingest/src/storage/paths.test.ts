import { describe, expect, it } from "vitest";
import { objectKey, rawFilePath, SIDECAR_PATTERN, segmentLocation } from "./paths.ts";

describe("segmentLocation", () => {
  it("names hour segments by UTC date and hour, also across the DST switch", () => {
    const beforeSwitch = Date.parse("2026-10-25T00:59:59Z");
    const afterSwitch = Date.parse("2026-10-25T01:00:00Z");
    expect(segmentLocation("delfi-gtfs-rt", beforeSwitch, "hour", "live")).toEqual({
      periodKey: "2026-10-25/00",
      segment: "delfi-gtfs-rt/2026-10-25/00.seg.zst",
      sidecar: "delfi-gtfs-rt/2026-10-25/00.jsonl",
    });
    expect(segmentLocation("delfi-gtfs-rt", afterSwitch, "hour", "live").segment).toBe(
      "delfi-gtfs-rt/2026-10-25/01.seg.zst",
    );
  });

  it("uses the UTC date even when local German time is already the next day", () => {
    const localMidnight = Date.parse("2026-10-25T23:30:00Z");
    expect(segmentLocation("vbb-gtfs-rt", localMidnight, "hour", "live").segment).toBe(
      "vbb-gtfs-rt/2026-10-25/23.seg.zst",
    );
  });

  it("separates backfill writers and day segments", () => {
    const t = Date.parse("2026-10-25T09:13:00Z");
    expect(segmentLocation("delfi-gtfs-rt", t, "hour", "backfill").segment).toBe(
      "delfi-gtfs-rt/2026-10-25/09.backfill.seg.zst",
    );
    expect(segmentLocation("delfi-gtfs-rt-deincr", t, "day", "live").sidecar).toBe(
      "delfi-gtfs-rt-deincr/2026-10-25/day.jsonl",
    );
  });
});

describe("keys", () => {
  it("derives object keys that satisfy the raw_object key check", () => {
    const key = objectKey("delfi-gtfs-rt/2026-10-25/09.backfill.seg.zst", 7);
    expect(key).toBe("delfi-gtfs-rt/2026-10-25/09.backfill/00007");
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/=-]*$/);
  });

  it("names raw files by UTC time and a sanitised name", () => {
    expect(rawFilePath("delfi-gtfs", Date.parse("2026-10-25T08:15:03Z"), "20261019 gtfs.zip")).toBe(
      "delfi-gtfs/2026-10-25/081503Z-20261019_gtfs.zip",
    );
  });

  it("recognises sidecar names", () => {
    expect(SIDECAR_PATTERN.test("2026-10-25/09.jsonl")).toBe(true);
    expect(SIDECAR_PATTERN.test("2026-10-25/day.backfill.jsonl")).toBe(true);
    expect(SIDECAR_PATTERN.test("2026-10-25/09.seg.zst")).toBe(false);
  });
});
