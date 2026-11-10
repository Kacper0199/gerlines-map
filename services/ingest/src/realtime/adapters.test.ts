import type { TripObservation } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { bytesField, intField, textField, tripUpdateFeed } from "../gtfs-rt/encode.test-support.ts";
import { adaptGtfsRt, DELFI_FOLD_SOURCES, foldSourceOf, profileFor } from "./adapters.ts";

const OBSERVED = Date.parse("2026-10-27T10:00:00Z");
const NOW_S = OBSERVED / 1000;

function adapt(bytes: Uint8Array) {
  const profile = profileFor("delfi-gtfs-rt");
  if (!profile) throw new Error("no DELFI profile");
  const result = adaptGtfsRt(bytes, OBSERVED, profile);
  if (!result.ok) throw new Error(result.failure.error);
  return result;
}

const tripOf = (bytes: Uint8Array) => adapt(bytes).events[0] as TripObservation;

describe("source profiles", () => {
  it("folds the Mobilithek DELFI feed with the mirror as one DELFI source, Mobilithek first", () => {
    expect(foldSourceOf("delfi-mobilithek-rt")).toBe("delfi-gtfs-rt");
    expect(foldSourceOf("delfi-gtfs-rt")).toBe("delfi-gtfs-rt");
    expect(profileFor("delfi-mobilithek-rt")?.feed).toEqual({ primary: true });
    expect(profileFor("delfi-gtfs-rt")?.feed).toEqual({ primary: false });
    expect([...DELFI_FOLD_SOURCES].sort()).toEqual([
      "delfi-gtfs-rt",
      "delfi-gtfs-rt-deincr",
      "delfi-gtfs-sa",
    ]);
    expect(profileFor("gtfsde-rt")?.delfi).toBe(false);
  });

  it("names the feed header's timestamp and reads the largest uint32 stop sequence as unset", () => {
    const result = adapt(
      tripUpdateFeed("v1", [
        {
          entityId: "e1",
          tripId: "t1",
          startDate: "20261027",
          routeId: "r_106",
          stops: [
            { sequence: 4_294_967_295, stopId: "de:1", delay: 60 },
            { sequence: 3, stopId: "de:2", delay: 60 },
          ],
        },
      ]),
    );
    const trip = result.events[0] as TripObservation;
    expect(trip.stops.map((stop) => stop.stopSequence)).toEqual([null, 3]);
    expect(result.feedTimestamp).toBe(trip.feedTimestamp);
  });
});

describe("adapter boundary checks", () => {
  it("drops stop times further than two days from the observation and delays beyond a day", () => {
    const trip = tripOf(
      tripUpdateFeed("v1", [
        {
          entityId: "e1",
          tripId: "t1",
          startDate: "20261027",
          routeId: "r_106",
          delay: 90_000,
          stops: [
            { sequence: 1, stopId: "de:1", delay: 60, time: NOW_S + 60 },
            { sequence: 2, stopId: "de:2", delay: 60, time: 10_000_000_000_000n },
            { sequence: 3, stopId: "de:3", delay: 86_401, time: NOW_S + 3 * 86_400 },
            { sequence: 4, stopId: "de:4", delay: -86_401, time: -5 },
          ],
        },
      ]),
    );
    expect(trip.delaySeconds).toBeNull();
    expect(trip.stops.map((stop) => stop.arrival)).toEqual([
      { delaySeconds: 60, time: NOW_S + 60, uncertaintySeconds: null },
      { delaySeconds: 60, time: null, uncertaintySeconds: null },
      null,
      null,
    ]);
  });

  it("strips NUL from every string and caps ids at 1 KiB and texts at 64 KiB", () => {
    const longId = "x".repeat(5000);
    const trip = tripOf(
      tripUpdateFeed("v\u00001", [
        {
          entityId: `e\u00001`,
          tripId: longId,
          startDate: "20261027",
          routeId: "r\u0000_106",
          stops: [{ sequence: 1, stopId: "de:\u00001", delay: 0 }],
        },
      ]),
    );
    expect(trip.entityId).toBe("e1");
    expect(trip.routeId).toBe("r_106");
    expect(trip.sourceTripId).toHaveLength(1024);
    expect(trip.stops[0]?.stop).toEqual({ kind: "source", id: "de:1" });
    expect(adapt(tripUpdateFeed("v\u00001", [])).feedVersion).toBe("v1");

    const translation = (text: string) => bytesField(1, textField(1, text));
    const alert = [
      ...bytesField(5, textField(5, "de:\u00009")),
      ...bytesField(10, translation(`Bau\u0000arbeiten ${"y".repeat(70_000)}`)),
    ];
    const entity = [...textField(1, "a1"), ...bytesField(5, alert)];
    const header = [...textField(1, "2.0"), ...intField(3, 1_800_000_000)];
    const result = adapt(Uint8Array.from([...bytesField(1, header), ...bytesField(2, entity)]));
    const event = result.events[0];
    if (event?.kind !== "alert") throw new Error("expected an alert");
    expect(event.header[0]?.text.startsWith("Bauarbeiten ")).toBe(true);
    expect(event.header[0]?.text).toHaveLength(65_536);
    expect(event.selectors[0]?.stop).toEqual({ kind: "source", id: "de:9" });
  });
});
