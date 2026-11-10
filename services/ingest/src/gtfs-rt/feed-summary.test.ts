import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { summarizeFeed } from "./feed-summary.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

function field(number: number, payload: number[]): number[] {
  return [...varint((number << 3) | 2), ...varint(payload.length), ...payload];
}

describe("summarizeFeed", () => {
  it.each([
    ["delfi-gtfs-rt-first40.pb", 1792784184, { tripUpdates: 40, vehicles: 0, alerts: 0 }, "2.0"],
    ["delfi-gtfs-sa-first40.pb", 1792783730, { tripUpdates: 0, vehicles: 0, alerts: 40 }, "2.0"],
    ["gtfsde-rt-first40.pb", 1792784060, { tripUpdates: 40, vehicles: 0, alerts: 0 }, "2.0"],
    ["vbn-gtfs-rt-first40.pb", 1792785422, { tripUpdates: 40, vehicles: 0, alerts: 0 }, "2.0"],
    [
      "ovapi-vehicle-positions-first40.pb",
      1792785506,
      { tripUpdates: 0, vehicles: 40, alerts: 0 },
      "1.0",
    ],
  ])("reads the header and counts entities of %s", (name, timestamp, counts, version) => {
    const summary = summarizeFeed(fixture(name));
    expect(summary).toEqual({
      ok: true,
      gtfsRealtimeVersion: version,
      incrementality: "FULL_DATASET",
      headerTimestamp: timestamp,
      entities: 40,
      deleted: 0,
      ...counts,
    });
  });

  it("reports DIFFERENTIAL incrementality and deleted entities", () => {
    const header = field(1, [
      ...field(1, [0x32, 0x2e, 0x30]),
      0x10,
      0x01,
      0x18,
      ...varint(1700000000),
    ]);
    const entity = field(2, [...field(1, [0x61]), 0x10, 0x01]);
    const summary = summarizeFeed(Uint8Array.from([...header, ...entity]));
    expect(summary).toMatchObject({
      ok: true,
      incrementality: "DIFFERENTIAL",
      headerTimestamp: 1700000000,
      entities: 1,
      deleted: 1,
    });
  });

  it("fails cleanly on a truncated payload", () => {
    const bytes = fixture("vbn-gtfs-rt-first40.pb");
    const summary = summarizeFeed(bytes.subarray(0, bytes.length - 7));
    expect(summary.ok).toBe(false);
  });

  it("fails cleanly on bytes that are not protobuf", () => {
    expect(summarizeFeed(Buffer.from("<html>Service unavailable</html>")).ok).toBe(false);
  });

  it("fails cleanly on an empty payload without a header", () => {
    expect(summarizeFeed(new Uint8Array(0))).toEqual({ ok: false, error: "feed has no header" });
  });
});
