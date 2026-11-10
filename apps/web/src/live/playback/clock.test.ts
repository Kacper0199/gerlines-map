import { describe, expect, it } from "vitest";
import { MAX_SPEED, MIN_SPEED, PlaybackClock } from "./clock.ts";

const T0 = 1_762_000_000;

describe("PlaybackClock", () => {
  it("stands still until played", () => {
    const clock = new PlaybackClock(T0, 1, false, 0);
    expect(clock.now(5_000)).toBe(T0);
    expect(clock.playing).toBe(false);
  });

  it("runs at the speed in plan seconds per wall second", () => {
    const clock = new PlaybackClock(T0, 10, true, 1_000);
    expect(clock.now(3_000)).toBe(T0 + 20);
  });

  it("pauses at the position it had and resumes from it", () => {
    const clock = new PlaybackClock(T0, 1, true, 0);
    clock.pause(4_000);
    expect(clock.now(9_000)).toBe(T0 + 4);
    clock.play(10_000);
    expect(clock.now(12_000)).toBe(T0 + 6);
  });

  it("changes speed without a jump in position", () => {
    const clock = new PlaybackClock(T0, 1, true, 0);
    clock.setSpeed(2_000, 60);
    expect(clock.now(2_000)).toBe(T0 + 2);
    expect(clock.now(3_000)).toBe(T0 + 62);
  });

  it("seeks to a position and keeps playing or pausing", () => {
    const clock = new PlaybackClock(T0, 5, true, 0);
    clock.seek(1_000, T0 + 600);
    expect(clock.now(1_000)).toBe(T0 + 600);
    expect(clock.now(2_000)).toBe(T0 + 605);
    clock.pause(2_000);
    clock.seek(3_000, T0 + 10);
    expect(clock.now(9_000)).toBe(T0 + 10);
  });

  it("never runs past its limit and reports that it got there", () => {
    const clock = new PlaybackClock(T0, 60, true, 0);
    clock.setLimit(T0 + 90);
    expect(clock.now(1_000)).toBe(T0 + 60);
    expect(clock.atLimit(1_000)).toBe(false);
    expect(clock.now(5_000)).toBe(T0 + 90);
    expect(clock.atLimit(5_000)).toBe(true);
  });

  it("refuses a speed outside 1x to 60x", () => {
    const clock = new PlaybackClock(T0, 1, false, 0);
    expect(() => clock.setSpeed(0, 0.5)).toThrow(RangeError);
    expect(() => clock.setSpeed(0, 61)).toThrow(RangeError);
    expect(() => clock.setSpeed(0, Number.NaN)).toThrow(RangeError);
    expect(MIN_SPEED).toBe(1);
    expect(MAX_SPEED).toBe(60);
  });

  it("is not moved by a wall clock that steps back", () => {
    const clock = new PlaybackClock(T0, 1, true, 10_000);
    expect(clock.now(9_000)).toBe(T0);
  });
});
