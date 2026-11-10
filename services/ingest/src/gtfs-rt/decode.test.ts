import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DECODE_LIMITS, decodeFeed } from "./decode.ts";
import { summarizeFeed } from "./feed-summary.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  let rest = BigInt.asUintN(64, value);
  while (rest >= 0x80n) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return bytes;
}

const key = (field: number, wire: number) => varint(BigInt((field << 3) | wire));
const bytesField = (field: number, payload: number[]) => [
  ...key(field, 2),
  ...varint(BigInt(payload.length)),
  ...payload,
];
const textField = (field: number, value: string) => bytesField(field, [...Buffer.from(value)]);
const intField = (field: number, value: number) => [...key(field, 0), ...varint(BigInt(value))];

describe("decodeFeed", () => {
  it("reads a hand-built trip update with negative delays and a skipped stop", () => {
    const stop1 = [
      ...intField(1, 3),
      ...bytesField(2, intField(1, -48)),
      ...bytesField(3, [...intField(1, -48), ...intField(2, 1792940259)]),
      ...textField(4, "de:06435:4513:2:7"),
    ];
    const stop2 = [...intField(1, 4), ...intField(5, 1)];
    const trip = [
      ...textField(1, "3031840095"),
      ...textField(3, "20261025"),
      ...intField(4, 0),
      ...textField(5, "de:rmv:00000120:_3"),
    ];
    const update = [...bytesField(1, trip), ...bytesField(2, stop1), ...bytesField(2, stop2)];
    const entity = [...textField(1, "e1"), ...bytesField(3, update)];
    const header = [...textField(1, "2.0"), ...intField(3, 1792940259), ...textField(4, "v1")];
    const result = decodeFeed(
      Uint8Array.from([...bytesField(1, header), ...bytesField(2, entity)]),
    );
    expect(result).toEqual({
      ok: true,
      feed: {
        header: {
          gtfsRealtimeVersion: "2.0",
          incrementality: "FULL_DATASET",
          timestamp: 1792940259,
          feedVersion: "v1",
        },
        entities: [
          {
            id: "e1",
            isDeleted: false,
            tripUpdate: {
              trip: {
                tripId: "3031840095",
                startDate: "20261025",
                scheduleRelationship: 0,
                routeId: "de:rmv:00000120:_3",
              },
              stopTimeUpdates: [
                {
                  stopSequence: 3,
                  arrival: { delay: -48 },
                  departure: { delay: -48, time: 1792940259 },
                  stopId: "de:06435:4513:2:7",
                },
                { stopSequence: 4, scheduleRelationship: 1 },
              ],
            },
          },
        ],
      },
    });
  });

  it.each([
    "delfi-gtfs-rt-first40.pb",
    "delfi-gtfs-sa-first40.pb",
    "gtfsde-rt-first40.pb",
    "vbn-gtfs-rt-first40.pb",
    "ovapi-vehicle-positions-first40.pb",
  ])("agrees with the recorder's feed summary on %s", (name) => {
    const bytes = fixture(name);
    const summary = summarizeFeed(bytes);
    const result = decodeFeed(bytes);
    if (!result.ok || !summary.ok) throw new Error("fixture did not decode");
    const entities = result.feed.entities;
    expect(entities.length).toBe(summary.entities);
    expect(entities.filter((entity) => entity.tripUpdate).length).toBe(summary.tripUpdates);
    expect(entities.filter((entity) => entity.vehicle).length).toBe(summary.vehicles);
    expect(entities.filter((entity) => entity.alert).length).toBe(summary.alerts);
    expect(result.feed.header.timestamp).toBe(summary.headerTimestamp);
  });

  describe("limits against amplification", () => {
    const header = bytesField(1, [...textField(1, "2.0"), ...intField(3, 1792940259)]);
    const repeat = (unit: number[], count: number): Uint8Array => {
      const out = new Uint8Array(unit.length * count);
      for (let index = 0; index < count; index += 1) out.set(unit, index * unit.length);
      return out;
    };
    const feed = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
      const length = parts.reduce((sum, part) => sum + part.length, 0);
      const out = new Uint8Array(length);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    };
    const lengthPrefixed = (field: number, body: Uint8Array): Uint8Array =>
      feed([...varint(BigInt((field << 3) | 2)), ...varint(BigInt(body.length))], body);

    it("refuses 16 MiB of empty entities at the entity limit", () => {
      const result = decodeFeed(feed(header, repeat([0x12, 0x00], 8 * 1024 * 1024)));
      expect(result).toEqual({
        ok: false,
        error: `feed has more than ${DECODE_LIMITS.entities} entities`,
      });
    }, 30_000);

    it("refuses 16 MiB of empty stop time updates in one trip at the per-trip limit", () => {
      const update = lengthPrefixed(3, repeat([0x12, 0x00], 8 * 1024 * 1024));
      const result = decodeFeed(feed(header, lengthPrefixed(2, update)));
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(/stop time updates/),
      });
    });

    it("refuses an alert with 16 MiB of empty translations at the translation limit", () => {
      const translated = lengthPrefixed(10, repeat([0x0a, 0x00], 8 * 1024 * 1024));
      const result = decodeFeed(feed(header, lengthPrefixed(2, lengthPrefixed(5, translated))));
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/translations/) });
    });

    it("refuses strings over 1 MiB and feeds over the message budget", () => {
      const long = textField(1, "x".repeat(DECODE_LIMITS.stringBytes + 1));
      expect(decodeFeed(feed(header, bytesField(2, long)))).toMatchObject({
        ok: false,
        error: expect.stringMatching(/string longer than/),
      });
      const trip = lengthPrefixed(3, repeat([0x12, 0x00], 200));
      const many = repeat([...lengthPrefixed(2, trip)], 20);
      expect(decodeFeed(feed(header, many), { ...DECODE_LIMITS, messages: 1000 })).toMatchObject({
        ok: false,
        error: "feed has more than 1000 messages",
      });
      expect(decodeFeed(feed(header, many), { ...DECODE_LIMITS, messages: 5000 }).ok).toBe(true);
    });

    it("keeps an alert naming more trips than any real one (93k seen in gtfs.de) readable", () => {
      const selectors = repeat([0x2a, 0x00], 100_000);
      const result = decodeFeed(feed(header, lengthPrefixed(2, lengthPrefixed(5, selectors))));
      expect(result.ok).toBe(true);
    });
  });

  it("reports truncated and foreign bytes instead of throwing", () => {
    const bytes = fixture("delfi-gtfs-rt-first40.pb");
    expect(decodeFeed(bytes.subarray(0, bytes.length - 7)).ok).toBe(false);
    expect(decodeFeed(Buffer.from("<html>not a feed</html>"))).toMatchObject({ ok: false });
    expect(decodeFeed(new Uint8Array())).toEqual({ ok: false, error: "feed has no header" });
  });
});
