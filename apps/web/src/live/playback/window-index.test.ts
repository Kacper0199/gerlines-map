import { describe, expect, it } from "vitest";
import {
  headAt,
  parseWindowIndex,
  parseWindowList,
  WINDOW_SECONDS,
  windowStartOf,
} from "./window-index.ts";

const START = 1_761_393_600;
const index = {
  format: 1,
  start: START,
  end: START + 3600,
  revision: "ff5f3b97dbd1",
  shapeEpoch: 4,
  heads: [
    [START + 3, 2, 1, 2, 7],
    [START + 13, 3, 1, 2, 7],
    [START + 23, 4, 1, 2, 7],
    [START + 303, 40, 39, 2, 7],
  ],
};

describe("parseWindowIndex", () => {
  it("reads an index and its heads", () => {
    const parsed = parseWindowIndex({ data: index });
    expect(parsed).toMatchObject({ start: START, end: START + 3600, revision: "ff5f3b97dbd1" });
    expect(parsed?.shapeEpoch).toBe(4);
    expect(parsed?.heads).toHaveLength(4);
  });

  it("refuses an index that is misaligned, has no heads or has heads out of order", () => {
    expect(parseWindowIndex({ data: { ...index, start: START + 1 } })).toBeNull();
    expect(parseWindowIndex({ data: { ...index, heads: [] } })).toBeNull();
    expect(
      parseWindowIndex({ data: { ...index, heads: [index.heads[1], index.heads[0]] } }),
    ).toBeNull();
    expect(parseWindowIndex({ data: { ...index, revision: "../x" } })).toBeNull();
    expect(parseWindowIndex({ data: { ...index, heads: [[START, 1, 2, 2, 7]] } })).toBeNull();
    expect(parseWindowIndex({})).toBeNull();
    expect(parseWindowIndex(null)).toBeNull();
  });
});

describe("headAt", () => {
  const parsed = parseWindowIndex({ data: index });
  if (!parsed) throw new Error("fixture");

  it("is the newest state published by the instant, at the instant", () => {
    const head = headAt(parsed, START + 20);
    expect(head).toMatchObject({
      kind: "head",
      sequence: 3,
      keyframeSequence: 1,
      oldestSequence: 2,
      timetableVersion: 7,
      timeBase: START + 20,
    });
    expect(headAt(parsed, START + 303)?.sequence).toBe(40);
    expect(headAt(parsed, START + 3599)?.keyframeSequence).toBe(39);
  });

  it("answers the first head before the engine published one", () => {
    expect(headAt(parsed, START)).toMatchObject({ sequence: 2, timeBase: START + 3 });
  });

  it("stops at the end of the window", () => {
    expect(headAt(parsed, START + 99_999)?.timeBase).toBe(START + 3600);
  });
});

describe("window arithmetic", () => {
  it("floors an instant to its hour", () => {
    expect(windowStartOf(START + 1234)).toBe(START);
    expect(windowStartOf(START)).toBe(START);
    expect(WINDOW_SECONDS).toBe(3600);
  });
});

describe("parseWindowList", () => {
  it("reads the windows and limits, oldest first", () => {
    const list = parseWindowList({
      data: {
        windows: [
          { start: START + 3600, end: START + 7200, revision: "aaaaaaaaaaaa", shapeEpoch: 4 },
          { start: START, end: START + 3600, revision: "bbbbbbbbbbbb", shapeEpoch: 4 },
        ],
        limits: { windowSeconds: 3600, maxAgeSeconds: 604_800, settleSeconds: 1800 },
      },
    });
    expect(list?.windows.map((window) => window.start)).toEqual([START, START + 3600]);
    expect(list?.limits.maxAgeSeconds).toBe(604_800);
  });

  it("drops windows that are not well formed and refuses a list without limits", () => {
    const list = parseWindowList({
      data: {
        windows: [{ start: START + 5, end: START + 3600, revision: "bbbbbbbbbbbb", shapeEpoch: 4 }],
        limits: { windowSeconds: 3600, maxAgeSeconds: 604_800, settleSeconds: 1800 },
      },
    });
    expect(list?.windows).toEqual([]);
    expect(parseWindowList({ data: { windows: [] } })).toBeNull();
  });
});
