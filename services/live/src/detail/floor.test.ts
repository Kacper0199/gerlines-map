import type { TrainDetail, TrainStop } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { floorAt, traceOf, withFloor } from "./floor.ts";

const T = (time: string) => `2026-10-25T${time}:00.000Z`;

function stop(index: number, arrival: string | null, cancelled = false): TrainStop {
  return {
    index,
    stopPlaceId: "6f1c2a1e-1a52-4c8e-9a3b-0d6a2f4c1b01",
    name: `Stop ${index}`,
    scheduledArrival: arrival,
    scheduledDeparture: arrival,
    predictedArrival: null,
    predictedDeparture: null,
    arrivalDelaySeconds: null,
    departureDelaySeconds: null,
    platformScheduled: null,
    platformActual: null,
    cancelled,
    prediction: null,
  };
}

function detail(stops: TrainStop[], lastPassedIndex: number | null, nextIndex: number | null) {
  return { stops, progress: { lastPassedIndex, nextIndex } } as unknown as TrainDetail;
}

describe("the served progress floor", () => {
  const first = detail([stop(0, T("14:50")), stop(1, T("14:56")), stop(2, T("15:00"))], 1, 2);

  it("is the furthest stop the API could have served from the last write by an instant", () => {
    const trace = traceOf(first);
    expect(floorAt(trace, Date.parse(T("14:59")))).toBe(1);
    expect(floorAt(trace, Date.parse(T("15:01")))).toBe(2);
  });

  it("keeps a stop reached under an older forecast as passed after a later one moves it", () => {
    const later = detail([stop(0, T("14:50")), stop(1, T("14:56")), stop(2, T("15:10"))], 1, 2);
    const floored = withFloor(later, floorAt(traceOf(first), Date.parse(T("15:01"))));
    expect(floored.progress).toEqual({ lastPassedIndex: 2, nextIndex: null });
  });

  it("names the next served stop after the floor and leaves a detail already ahead alone", () => {
    const four = [
      stop(0, T("14:50")),
      stop(1, T("14:56")),
      stop(2, T("15:10"), true),
      stop(3, T("15:20")),
    ];
    expect(withFloor(detail(four, 0, 1), 1).progress).toEqual({ lastPassedIndex: 1, nextIndex: 3 });
    const ahead = detail(four, 3, null);
    expect(withFloor(ahead, 1)).toBe(ahead);
  });

  it("lets a cancelled train go back: a progress by timetable before the cancellation was a guess", () => {
    const cancelled = {
      ...detail([stop(0, T("14:50"), true), stop(1, T("14:56"), true)], null, null),
      cancelled: true,
    } as TrainDetail;
    expect(withFloor(cancelled, 1)).toBe(cancelled);
  });

  it("holds at the last served stop at or before the floor, never at a cancelled one", () => {
    const skipped = [
      stop(0, T("14:50")),
      stop(1, T("14:56")),
      stop(2, T("15:00"), true),
      stop(3, T("15:20")),
    ];
    expect(withFloor(detail(skipped, 0, 1), 2).progress).toEqual({
      lastPassedIndex: 1,
      nextIndex: 3,
    });
  });

  it("ignores a floor that names no stop of the new detail", () => {
    const shorter = detail([stop(0, T("14:50")), stop(1, T("14:56"))], 0, 1);
    expect(withFloor(shorter, 2)).toBe(shorter);
  });
});
