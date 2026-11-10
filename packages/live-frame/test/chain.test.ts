import { describe, expect, it } from "vitest";
import { SECTION } from "../src/constants.ts";
import { writeContainer } from "../src/container.ts";
import {
  appliesTo,
  catchUp,
  decodeDelta,
  decodeHead,
  decodeKeyframe,
  encodeDelta,
  encodeHead,
  encodeKeyframe,
  type Head,
  peekHeader,
} from "../src/index.ts";
import { rebuilt } from "./craft.ts";
import { DELTA, HEAD, KEYFRAME } from "./fixtures.ts";

function headBytes(sequence: number, values: number[]): Uint8Array {
  const meta = { sequence, baseSequence: 0, timetableVersion: 7, timeBase: 1, shapeEpoch: 0 };
  return writeContainer("head", meta, [{ id: SECTION.head, data: Uint32Array.from(values) }]);
}

describe("sequence rules", () => {
  it("keyframes start at sequence 1", () => {
    expect(() => encodeKeyframe({ ...KEYFRAME, sequence: 0 })).toThrow(/sequence/);
    const zero = rebuilt(encodeKeyframe(KEYFRAME), {}, { sequence: 0 });
    expect(() => decodeKeyframe(zero)).toThrow(expect.objectContaining({ code: "corrupt" }));
  });

  it("a delta at s applies to s - 1 only", () => {
    expect(() => encodeDelta({ ...DELTA, baseSequence: DELTA.sequence - 2 })).toThrow(
      /baseSequence/,
    );
    expect(() => encodeDelta({ ...DELTA, sequence: 1, baseSequence: 0 })).toThrow(/sequence/);
    const skipping = rebuilt(encodeDelta(DELTA), {}, { baseSequence: DELTA.sequence - 2 });
    expect(() => decodeDelta(skipping)).toThrow(expect.objectContaining({ code: "corrupt" }));
    const first = rebuilt(encodeDelta(DELTA), {}, { sequence: 1, baseSequence: 0 });
    expect(() => decodeDelta(first)).toThrow(expect.objectContaining({ code: "corrupt" }));
  });

  it("a head keeps a path from its keyframe to the latest frame", () => {
    expect(decodeHead(headBytes(10, [10, 10, 11]))).toMatchObject({ oldestSequence: 11 });
    expect(decodeHead(headBytes(10, [4, 10, 2]))).toMatchObject({ keyframeSequence: 4 });
    for (const values of [
      [4, 10, 6],
      [0, 10, 1],
      [4, 10, 1],
      [10, 10, 12],
    ]) {
      expect(() => decodeHead(headBytes(10, values))).toThrow(
        expect.objectContaining({ code: "corrupt" }),
      );
      const [keyframeSequence = 0, , oldestSequence = 0] = values;
      expect(() => encodeHead({ ...HEAD, sequence: 10, keyframeSequence, oldestSequence })).toThrow(
        RangeError,
      );
    }
  });
});

describe("catchUp", () => {
  const head: Head = { ...HEAD, sequence: 120, keyframeSequence: 100, oldestSequence: 90 };

  it("fetches the deltas after the client's state while they are kept", () => {
    const state = { sequence: 95, timetableVersion: head.timetableVersion };
    expect(catchUp(head, state)).toEqual({ keyframe: null, firstDelta: 96, lastDelta: 120 });
    expect(catchUp(head, { ...state, sequence: 89 })).toEqual({
      keyframe: null,
      firstDelta: 90,
      lastDelta: 120,
    });
    expect(catchUp(head, { ...state, sequence: 120 })).toEqual({
      keyframe: null,
      firstDelta: 121,
      lastDelta: 120,
    });
  });

  it("loads the keyframe without a state, after a gap, a newer state or a new timetable", () => {
    const reload = { keyframe: 100, firstDelta: 101, lastDelta: 120 };
    const state = { sequence: 95, timetableVersion: head.timetableVersion };
    expect(catchUp(head, null)).toEqual(reload);
    expect(catchUp(head, { ...state, sequence: 88 })).toEqual(reload);
    expect(catchUp(head, { ...state, sequence: 121 })).toEqual(reload);
    expect(catchUp(head, { ...state, timetableVersion: 8 })).toEqual(reload);
  });
});

describe("keyframe without a delta (FORMAT.md section 3: switch and restart)", () => {
  const before: Head = { ...HEAD, sequence: 499, keyframeSequence: 480, oldestSequence: 460 };

  it("a timetable switch starts the new version at keyframe k with no delta k kept", () => {
    const after: Head = {
      ...before,
      sequence: 500,
      keyframeSequence: 500,
      oldestSequence: 501,
      timetableVersion: before.timetableVersion + 1,
    };
    expect(encodeHead(after)).toBeInstanceOf(Uint8Array);
    const client = { sequence: 499, timetableVersion: before.timetableVersion };
    expect(catchUp(after, client)).toEqual({ keyframe: 500, firstDelta: 501, lastDelta: 500 });
    const next: Head = { ...after, sequence: 501 };
    expect(catchUp(next, { sequence: 500, timetableVersion: after.timetableVersion })).toEqual({
      keyframe: null,
      firstDelta: 501,
      lastDelta: 501,
    });
  });

  it("a restart of the same version writes keyframe k without delta k, so older states reload", () => {
    const restarted: Head = {
      ...before,
      sequence: 500,
      keyframeSequence: 500,
      oldestSequence: 501,
    };
    for (const sequence of [480, 498, 499]) {
      expect(
        catchUp(restarted, { sequence, timetableVersion: before.timetableVersion }),
      ).toMatchObject({ keyframe: 500 });
    }
  });

  it("a keyframe of the new version may carry a trip key of the old version over", () => {
    const old = encodeKeyframe({ ...KEYFRAME, sequence: 499 });
    const carried = encodeKeyframe({
      ...KEYFRAME,
      sequence: 500,
      timetableVersion: KEYFRAME.timetableVersion + 1,
    });
    const keysBefore = new Set(decodeKeyframe(old).trips.key);
    const keysAfter = decodeKeyframe(carried).trips.key;
    expect([...keysAfter].every((key) => keysBefore.has(key))).toBe(true);
    expect(peekHeader(carried).timetableVersion).toBe(KEYFRAME.timetableVersion + 1);
  });
});

describe("appliesTo", () => {
  const header = peekHeader(encodeDelta(DELTA));
  const state = { sequence: DELTA.baseSequence, timetableVersion: DELTA.timetableVersion };

  it("takes a delta whose base and timetable are the client's state", () => {
    expect(appliesTo(header, state)).toBe(true);
  });

  it("drops a delta for another state or timetable, and a keyframe", () => {
    expect(appliesTo(header, { ...state, sequence: state.sequence - 1 })).toBe(false);
    expect(appliesTo(header, { ...state, timetableVersion: 8 })).toBe(false);
    expect(appliesTo(peekHeader(encodeKeyframe(KEYFRAME)), state)).toBe(false);
  });
});
