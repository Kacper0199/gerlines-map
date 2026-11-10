import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECTION } from "../src/constants.ts";
import {
  decodeDelta,
  decodeKeyframe,
  encodeDelta,
  encodeKeyframe,
  FrameDecodeError,
  frameToObject,
  type Keyframe,
  peekHeader,
  type TripRecord,
} from "../src/index.ts";
import { rebuilt, sectionsOf } from "./craft.ts";
import {
  decodeKeyframe as decode12,
  decodeDelta as decodeDelta12,
  frameToObject as object12,
} from "./decoder-1.2/frame.ts";
import { DELTA_VEHICLE, KEYFRAME, KEYFRAME_NUMBERED, KEYFRAME_VEHICLE, trip } from "./fixtures.ts";

function byKey(frame: Keyframe): Keyframe {
  return { ...frame, trips: [...frame.trips].sort((a, b) => a.key - b.key) };
}

function decodeError(run: () => unknown): FrameDecodeError {
  try {
    run();
  } catch (error) {
    if (error instanceof FrameDecodeError) return error;
    throw error;
  }
  throw new Error("expected a FrameDecodeError");
}

const vector = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../test-vectors/${name}.bin`, import.meta.url)));

describe("vehicle columns (FORMAT 1.3)", () => {
  it("round-trips series, operator and units per trip in a 1.3 keyframe", () => {
    const bytes = encodeKeyframe(KEYFRAME_VEHICLE);
    expect(peekHeader(bytes).versionMinor).toBe(3);
    expect(frameToObject(decodeKeyframe(bytes))).toEqual(byKey(KEYFRAME_VEHICLE));
  });

  it("round-trips a 1.3 delta", () => {
    const bytes = encodeDelta(DELTA_VEHICLE);
    expect(peekHeader(bytes).versionMinor).toBe(3);
    const delta = frameToObject(decodeDelta(bytes));
    expect(delta.trips.map((t) => [t.key, t.series, t.operator, t.units])).toEqual([
      [10, "db-1440", "db-regio-ag-nrw", 3],
      [50, null, null, null],
    ]);
  });

  it("keeps a frame without vehicle fields at 1.0, byte for byte, and decodes it without them", () => {
    const bytes = encodeKeyframe(KEYFRAME);
    expect(peekHeader(bytes).versionMinor).toBe(0);
    const ids = [...sectionsOf(bytes).keys()];
    for (const id of [SECTION.tripSeries, SECTION.tripOperator, SECTION.tripUnits]) {
      expect(ids).not.toContain(id);
    }
    const decoded = frameToObject(decodeKeyframe(bytes)).trips[0] as TripRecord;
    expect("series" in decoded).toBe(false);
  });

  it("writes the columns when a trip names its vehicle as unknown, and fills the others with null", () => {
    const frame: Keyframe = {
      ...KEYFRAME_NUMBERED,
      trips: [trip(1, { shapeId: 17, series: null }), trip(2, { shapeId: 17 })],
    };
    const bytes = encodeKeyframe(frame);
    expect(peekHeader(bytes).versionMinor).toBe(3);
    const trips = frameToObject(decodeKeyframe(bytes)).trips;
    expect(trips.map((t) => [t.series, t.operator, t.units])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("stores a series that equals a line name in one string row", () => {
    const view = decodeKeyframe(encodeKeyframe(KEYFRAME_VEHICLE));
    expect(view.strings.filter((text) => text === "db-423")).toHaveLength(1);
    expect(view.vehicle).not.toBeNull();
    expect(view.vehicle?.series.length).toBe(view.trips.count);
  });

  it("refuses units outside 1 to 255 and a string table beyond its rows", () => {
    expect(() =>
      encodeKeyframe({ ...KEYFRAME_NUMBERED, trips: [trip(1, { shapeId: 17, units: 0 })] }),
    ).toThrow(RangeError);
    expect(() =>
      encodeKeyframe({ ...KEYFRAME_NUMBERED, trips: [trip(1, { shapeId: 17, units: 256 })] }),
    ).toThrow(RangeError);
  });

  it("rejects a frame with only some vehicle columns, a column of another length or a row out of range", () => {
    const bytes = encodeKeyframe(KEYFRAME_VEHICLE);
    const sections = sectionsOf(bytes);
    const series = sections.get(SECTION.tripSeries) as Uint8Array;
    expect(
      decodeError(() => decodeKeyframe(rebuilt(bytes, { [SECTION.tripUnits]: null }))).code,
    ).toBe("corrupt");
    expect(
      decodeError(() => decodeKeyframe(rebuilt(bytes, { [SECTION.tripUnits]: new Uint8Array(1) })))
        .code,
    ).toBe("corrupt");
    const outOfRange = new Uint16Array(series.slice().buffer);
    outOfRange[0] = 4000;
    expect(
      decodeError(() =>
        decodeKeyframe(rebuilt(bytes, { [SECTION.tripSeries]: new Uint8Array(outOfRange.buffer) })),
      ).code,
    ).toBe("corrupt");
  });

  it("reads the committed 1.3 vector with a deployed 1.2 decoder as the same trips without vehicles", () => {
    const bytes = vector("keyframe-vehicle");
    expect(bytes).toEqual(encodeKeyframe(KEYFRAME_VEHICLE));
    const view = decode12(bytes);
    expect(view.header.versionMinor).toBe(3);
    const stripped = KEYFRAME_VEHICLE.trips.map(({ series, operator, units, ...rest }) => rest);
    expect(object12(view)).toEqual(byKey({ ...KEYFRAME_VEHICLE, trips: stripped }));
  });

  it("reads the committed 1.3 delta vector with a deployed 1.2 decoder as the same trips and removals", () => {
    const bytes = vector("delta-vehicle");
    expect(bytes).toEqual(encodeDelta(DELTA_VEHICLE));
    const view = decodeDelta12(bytes);
    expect(view.header.versionMinor).toBe(3);
    const stripped = DELTA_VEHICLE.trips.map(({ series, operator, units, ...rest }) => rest);
    const read = object12(view);
    expect(read).toEqual(
      frameToObject(decodeDelta(encodeDelta({ ...DELTA_VEHICLE, trips: stripped }))),
    );
    expect("removed" in read && read.removed).toEqual(
      [...DELTA_VEHICLE.removed].sort((a, b) => a - b),
    );
  });
});
