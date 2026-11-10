import { describe, expect, it } from "vitest";
import {
  categoryOf,
  type Delta,
  decodeDelta,
  decodeKeyframe,
  encodeDelta,
  encodeKeyframe,
  FrameDecodeError,
  frameToObject,
  type Keyframe,
  readTrip,
  type StopRecord,
  shapeIdOf,
  tripStopArcs,
  tripTimes,
} from "../src/index.ts";
import { DELTA, KEYFRAME, KEYFRAME_NUMBERED, stop, TIME_BASE, trip } from "./fixtures.ts";

function sortedKeyframe(frame: Keyframe): Keyframe {
  return { ...frame, trips: [...frame.trips].sort((a, b) => a.key - b.key) };
}

describe("keyframe", () => {
  it("round-trips every field, with trips in key order", () => {
    const view = decodeKeyframe(encodeKeyframe(KEYFRAME));
    expect(frameToObject(view)).toEqual(sortedKeyframe(KEYFRAME));
  });

  it("groups rows by line, then shape, in aligned columns viewing the input buffer", () => {
    const bytes = encodeKeyframe(KEYFRAME);
    const view = decodeKeyframe(bytes);
    expect(Array.from(view.trips.key)).toEqual([30, 10, 20, 40]);
    expect(view.trips.key.buffer).toBe(bytes.buffer);
    expect(view.stops.run.buffer).toBe(bytes.buffer);
    expect(view.trips.count).toBe(4);
    expect(view.stops.count).toBe(11);
    expect(view.shapes.count).toBe(2);
    expect(view.shapes.number).toBeUndefined();
    expect(Array.from(view.trips.shape)).toEqual([0, 1, 1, 1]);
    expect(view.strings).toEqual(["ICE", "RE 1", "Zürich HB – Łódź"]);
    expect(Array.from(view.trips.stopOffset)).toEqual([0, 3, 6, 8, 11]);
    expect(Array.from(view.trips.arcOffset)).toEqual([-1, -1, 0, -1]);
    expect(shapeIdOf(view, 0)).toBe("ffeeddccbbaa9988");
    expect(categoryOf(view, 0)).toBe("hsr");
  });

  it("copies columns when the input is not aligned and decodes the same values", () => {
    const bytes = encodeKeyframe(KEYFRAME);
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    const view = decodeKeyframe(shifted.subarray(1));
    expect(view.trips.key.buffer).not.toBe(shifted.buffer);
    expect(frameToObject(view)).toEqual(sortedKeyframe(KEYFRAME));
  });

  it("accepts an ArrayBuffer or any view", () => {
    const bytes = encodeKeyframe(KEYFRAME);
    expect(decodeKeyframe(bytes.buffer).trips.count).toBe(4);
    expect(decodeKeyframe(new DataView(bytes.buffer)).trips.count).toBe(4);
  });

  it("gives absolute times, filling an unknown time with the other one", () => {
    const view = decodeKeyframe(encodeKeyframe(KEYFRAME));
    const arrival = new Float64Array(4);
    const departure = new Float64Array(4);
    expect(tripTimes(view, 0, arrival, departure)).toBe(3);
    expect(Array.from(arrival.subarray(0, 3))).toEqual([
      TIME_BASE + 30,
      TIME_BASE + 1800,
      TIME_BASE + 4000,
    ]);
    expect(Array.from(departure.subarray(0, 3))).toEqual([
      TIME_BASE + 30,
      TIME_BASE + 1920,
      TIME_BASE + 4000,
    ]);
    expect(readTrip(view, 0).stops[0]?.arrival).toBeNull();
  });

  it("encodes an empty keyframe", () => {
    const frame: Keyframe = { ...KEYFRAME, trips: [] };
    expect(frameToObject(decodeKeyframe(encodeKeyframe(frame)))).toEqual(frame);
  });

  it("refuses a delta where a keyframe is expected", () => {
    expect(() => decodeKeyframe(encodeDelta(DELTA))).toThrow(
      expect.objectContaining({ code: "wrong_kind" }),
    );
  });
});

describe("tripStopArcs", () => {
  const view = decodeKeyframe(encodeKeyframe(KEYFRAME));
  const out = new Float64Array(8);

  it("takes the shape's stops from firstStop on", () => {
    expect(view.trips.key[1]).toBe(10);
    expect(tripStopArcs(view, 1, [0, 10, 20, 30, 40.5], out)).toBe(3);
    expect(Array.from(out.subarray(0, 3))).toEqual([20, 30, 40.5]);
  });

  it("uses the explicit positions of a trip with flag bit 3", () => {
    expect(view.trips.key[2]).toBe(20);
    expect(tripStopArcs(view, 2, [], out)).toBe(2);
    expect(Array.from(out.subarray(0, 2))).toEqual([1000.25, 5230.5]);
  });

  it("rejects a trip that names stops its shape does not have", () => {
    expect(() => tripStopArcs(view, 1, [0, 10, 20, 30], out)).toThrow(
      expect.objectContaining({ code: "corrupt" }),
    );
    expect(() => tripStopArcs(view, 1, [0, 10, 20, 30, 40], new Float64Array(2))).toThrow(
      RangeError,
    );
  });
});

describe("delta", () => {
  it("round-trips changed trips and sorted removals", () => {
    const decoded = frameToObject(decodeDelta(encodeDelta(DELTA))) as Delta;
    expect(decoded).toEqual({
      ...DELTA,
      trips: [...DELTA.trips].sort((a, b) => a.key - b.key),
      removed: [20, 40],
    });
  });

  it("rejects a base sequence other than sequence - 1", () => {
    expect(() => encodeDelta({ ...DELTA, baseSequence: DELTA.sequence })).toThrow(RangeError);
  });

  it("rejects a key that is both updated and removed, or removed twice", () => {
    expect(() => encodeDelta({ ...DELTA, removed: [10] })).toThrow(/both updated and removed/);
    expect(() => encodeDelta({ ...DELTA, removed: [7, 7] })).toThrow(/repeated/);
  });
});

const TWO_STOPS = [stop(TIME_BASE, null), stop(TIME_BASE + 60, null)];

function then(first: StopRecord): StopRecord[] {
  const time = (first.departure ?? first.arrival ?? TIME_BASE) + 60;
  return [first, stop(Math.ceil(time), null, first.s === null ? {} : { s: 99 })];
}

describe("encoder input checks", () => {
  const base = KEYFRAME;
  const withTrip = (t: ReturnType<typeof trip>): Keyframe => ({ ...base, trips: [t] });
  const cases: [string, Keyframe, RegExp][] = [
    ["repeated key", { ...base, trips: [trip(1), trip(1)] }, /repeated/],
    ["negative key", withTrip(trip(-1)), /trip key/],
    ["bad shape id", withTrip(trip(1, { shapeId: "XYZ" })), /shapeId/],
    ["unknown category", withTrip(trip(1, { category: "tram" as "hsr" })), /category/],
    ["delay out of range", withTrip(trip(1, { delay: 40_000 })), /delay/],
    ["delay sentinel", withTrip(trip(1, { delay: -32768 })), /delay/],
    ["train number 0", withTrip(trip(1, { trainNumber: 0 })), /trainNumber/],
    ["no stops", withTrip(trip(1, { stops: [] })), /stops/],
    ["one stop", withTrip(trip(1, { stops: [stop(TIME_BASE, null)] })), /stops/],
    ["first stop index", withTrip(trip(1, { firstStop: 70_000 })), /firstStop/],
    ["stop without times", withTrip(trip(1, { stops: then(stop(null, null)) })), /neither/],
    [
      "time going back",
      withTrip(trip(1, { stops: [stop(TIME_BASE, TIME_BASE + 60), stop(TIME_BASE + 30, null)] })),
      /run/,
    ],
    [
      "departure before arrival",
      withTrip(trip(1, { stops: then(stop(TIME_BASE, TIME_BASE - 1)) })),
      /dwell/,
    ],
    [
      "leg over 18 hours",
      withTrip(trip(1, { stops: [stop(TIME_BASE, TIME_BASE), stop(TIME_BASE + 70_000, null)] })),
      /run/,
    ],
    ["start beyond i32", withTrip(trip(1, { stops: then(stop(4_000_000_000, null)) })), /start/],
    ["fractional time", withTrip(trip(1, { stops: then(stop(TIME_BASE + 0.5, null)) })), /arrival/],
    [
      "s on some stops only",
      withTrip(trip(1, { stops: [stop(TIME_BASE, null, { s: 1 }), stop(TIME_BASE + 9, null)] })),
      /every stop or for none/,
    ],
    [
      "s decreasing",
      withTrip(
        trip(1, {
          stops: [stop(TIME_BASE, null, { s: 10 }), stop(TIME_BASE + 9, null, { s: 5 })],
        }),
      ),
      /decreases/,
    ],
    [
      "s negative",
      withTrip(trip(1, { stops: then(stop(TIME_BASE, null, { s: -1 })) })),
      /s in centimetres/,
    ],
    [
      "s not finite",
      withTrip(trip(1, { stops: then(stop(TIME_BASE, null, { s: Number.NaN })) })),
      /finite/,
    ],
    ["sequence not u32", { ...base, sequence: -1 }, /sequence/],
  ];

  it.each(cases)("rejects %s", (_, frame, message) => {
    expect(() => encodeKeyframe(frame)).toThrow(message);
  });

  it("rejects more line names than the string table can address", () => {
    const trips = Array.from({ length: 65_536 }, (_, i) =>
      trip(i, { line: `L${i}`, stops: TWO_STOPS }),
    );
    expect(() => encodeKeyframe({ ...base, trips })).toThrow(/more than 65535 line names/);
  });

  it("decodes unknown category codes as unknown", () => {
    const bytes = encodeKeyframe({ ...base, trips: [trip(1, { category: "bus" })] });
    const view = decodeKeyframe(bytes);
    view.trips.category[0] = 200;
    expect(categoryOf(view, 0)).toBe("unknown");
  });

  it("raises FrameDecodeError for every rejected input", () => {
    expect(() => decodeKeyframe(new Uint8Array(3))).toThrow(FrameDecodeError);
  });
});

describe("shape numbers", () => {
  it("round-trip in place of hash prefixes with the registry epoch", () => {
    const view = decodeKeyframe(encodeKeyframe(KEYFRAME_NUMBERED));
    expect(view.shapes.hashPrefix).toBeUndefined();
    expect(Array.from(view.shapes.number ?? [])).toEqual([4021, 17]);
    expect(view.header.shapeEpoch).toBe(KEYFRAME_NUMBERED.shapeEpoch);
    expect(frameToObject(view)).toEqual(sortedKeyframe(KEYFRAME_NUMBERED));
  });

  it("follow the frame's shape epoch: hash prefixes at 0, numbers from 1", () => {
    const numbers = [trip(1, { shapeId: 5 }), trip(2, { shapeId: 6 })];
    expect(() => encodeKeyframe({ ...KEYFRAME, trips: numbers })).toThrow(/shapeEpoch 0/);
    const mixed = [trip(1, { shapeId: 5 }), trip(2, { line: "ZZ" })];
    expect(() => encodeKeyframe({ ...KEYFRAME_NUMBERED, trips: mixed })).toThrow(/shapeEpoch 3/);
    expect(() => encodeKeyframe({ ...KEYFRAME, shapeEpoch: -1 })).toThrow(/shapeEpoch/);
  });

  it("are written for an empty frame of a numbered stream", () => {
    const empty = { ...DELTA, trips: [], shapeEpoch: 3 };
    const view = decodeDelta(encodeDelta(empty));
    expect(view.shapes.number?.length).toBe(0);
    expect(view.shapes.hashPrefix).toBeUndefined();
    expect(frameToObject(view)).toEqual({ ...empty, removed: [20, 40] });
  });

  it("must be u32 integers", () => {
    const trips = [trip(1, { shapeId: -3 })];
    expect(() => encodeKeyframe({ ...KEYFRAME_NUMBERED, trips })).toThrow(/shapeId/);
  });

  it("rejects more shapes than a u16 row can address", () => {
    const trips = Array.from({ length: 65_537 }, (_, i) =>
      trip(i, { shapeId: i, line: null, stops: TWO_STOPS }),
    );
    expect(() => encodeKeyframe({ ...KEYFRAME_NUMBERED, trips })).toThrow(/more than 65536 shapes/);
  });
});
