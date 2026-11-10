import { TrainDetail } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import ice from "../components/train/fixtures/ice-delay.json" with { type: "json" };
import { placeStops } from "./placement.ts";
import { selectionFrom } from "./selection-fixture.ts";
import { profileSubjectOf } from "./subject.ts";

const detail = TrainDetail.parse(ice.detail);
const refs = (stops: TrainDetail["stops"]) =>
  profileSubjectOf({ ...detail, stops: [...stops] }, true)?.stops ?? [];

describe("placeStops", () => {
  it("places the profile when the stops ahead have the times of the detail's tail", () => {
    const selection = selectionFrom(detail.stops, 7);
    expect(placeStops(refs(detail.stops), selection)).toBe(selection.vertices);
  });

  it("accepts the scheduled times of the detail as well as its predicted ones", () => {
    const selection = selectionFrom(
      detail.stops.map((stop) => ({ ...stop, predictedArrival: null, predictedDeparture: null })),
      7,
    );
    expect(placeStops(refs(detail.stops), selection)).toBe(selection.vertices);
  });

  it("allows a minute of drift between the worker's time and the detail's", () => {
    const selection = selectionFrom(detail.stops, 7);
    const drifted = { ...selection, arrivals: selection.arrivals.map((t) => t + 59) };
    expect(placeStops(refs(detail.stops), drifted)).toBe(drifted.vertices);
    const gone = { ...selection, arrivals: selection.arrivals.map((t) => t + 400) };
    expect(placeStops(refs(detail.stops), gone)).toBeUndefined();
  });

  it("does not place when a cancelled stop is dropped on one side and another stop added, count equal", () => {
    const base = detail.stops;
    const extra = {
      ...(base.at(-1) as (typeof base)[number]),
      scheduledArrival: "2026-10-26T23:50:00.000Z",
      scheduledDeparture: "2026-10-26T23:50:00.000Z",
      predictedArrival: null,
      predictedDeparture: null,
    };
    const added = [...base.slice(0, 10), ...base.slice(11), extra];
    const selection = selectionFrom(base, 7);
    expect(added).toHaveLength(base.length);
    expect(placeStops(refs(added), selection)).toBeUndefined();
  });

  it("does not place when the cancelled flag differs for a stop ahead", () => {
    const selection = selectionFrom(detail.stops, 7);
    const flagged = detail.stops.map((stop, i) => (i === 9 ? { ...stop, cancelled: true } : stop));
    expect(placeStops(refs(flagged), selection)).toBeUndefined();
  });

  it("does not place after a pattern change that moves the later stops to other times", () => {
    const shifted = detail.stops.map((stop, i) =>
      i >= 10
        ? {
            ...stop,
            scheduledArrival: stop.scheduledArrival && addMinutes(stop.scheduledArrival, 11),
            scheduledDeparture: stop.scheduledDeparture && addMinutes(stop.scheduledDeparture, 11),
            predictedArrival: stop.predictedArrival && addMinutes(stop.predictedArrival, 11),
            predictedDeparture: stop.predictedDeparture && addMinutes(stop.predictedDeparture, 11),
          }
        : stop,
    );
    expect(placeStops(refs(shifted), selectionFrom(detail.stops, 7))).toBeUndefined();
  });

  it("does not place when the shape's stop list and the detail differ in length, or the tail ends elsewhere", () => {
    const selection = selectionFrom(detail.stops, 7);
    expect(placeStops(refs(detail.stops).slice(1), selection)).toBeUndefined();
    expect(
      placeStops(refs(detail.stops), selectionFrom(detail.stops, 7, detail.stops.length + 1)),
    ).toBeUndefined();
    expect(placeStops(refs(detail.stops), { ...selection, firstStop: 8 })).toBeUndefined();
  });

  it("does not place without a selection or without stops ahead", () => {
    expect(placeStops(refs(detail.stops), undefined)).toBeUndefined();
    const none = selectionFrom(detail.stops, detail.stops.length);
    expect(placeStops(refs(detail.stops), none)).toBeUndefined();
  });
});

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
