import { describe, expect, it } from "vitest";
import {
  DECK_MIN_ZOOM,
  DeckSchedule,
  emptyDeck,
  MAX_DECK_VERTICES,
  mergeWindows,
} from "./deck-windows.ts";

describe("emptyDeck", () => {
  it("is a new value with its own buffers each time, so it can be transferred more than once", () => {
    const a = emptyDeck();
    const b = emptyDeck();
    expect(a.paths.buffer).not.toBe(b.paths.buffer);
    expect(a.first.buffer).not.toBe(b.first.buffer);
    expect(a.counts.buffer).not.toBe(b.counts.buffer);
  });
});

describe("mergeWindows", () => {
  it("joins windows that overlap or touch and keeps the others apart", () => {
    expect(
      mergeWindows([
        { from: 40, to: 60 },
        { from: 0, to: 10 },
        { from: 8, to: 20 },
        { from: 21, to: 25 },
        { from: 50, to: 70 },
      ]),
    ).toEqual([
      { from: 0, to: 25 },
      { from: 40, to: 70 },
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(mergeWindows([])).toEqual([]);
    expect(emptyDeck().paths).toHaveLength(0);
    expect(DECK_MIN_ZOOM).toBe(12);
    expect(MAX_DECK_VERTICES).toBeGreaterThan(50_000);
  });
});

describe("DeckSchedule", () => {
  const view = (x: number, size = 10_000) => ({
    minX: x,
    minY: 0,
    maxX: x + size,
    maxY: size,
  });

  it("asks for the first deck at once and scans half a screen beyond the view", () => {
    const schedule = new DeckSchedule();
    expect(schedule.due(view(0), 1, 0)).toEqual({
      minX: -5000,
      minY: -5000,
      maxX: 15_000,
      maxY: 15_000,
    });
  });

  it("sends nothing again while the view stays within the scanned box and nothing changed", () => {
    const schedule = new DeckSchedule();
    schedule.due(view(0), 1, 0);
    expect(schedule.due(view(0), 1, 1000)).toBeNull();
    expect(schedule.due(view(2000), 1, 2000)).toBeNull();
    expect(schedule.due(view(-3000), 1, 3000)).toBeNull();
  });

  it("asks again when the view nears the edge of what was scanned", () => {
    const schedule = new DeckSchedule();
    schedule.due(view(0), 1, 0);
    expect(schedule.due(view(4500), 1, 1000)).not.toBeNull();
  });

  it("asks again when the view grows out of the box, at most every 600 ms", () => {
    const schedule = new DeckSchedule();
    schedule.due(view(0), 1, 0);
    expect(schedule.due(view(0, 30_000), 1, 300)).toBeNull();
    expect(schedule.due(view(0, 30_000), 1, 700)).not.toBeNull();
  });

  it("asks again when the categories changed, and now and then anyway", () => {
    const schedule = new DeckSchedule();
    schedule.due(view(0), 1, 0);
    expect(schedule.due(view(0), 2, 1000)).not.toBeNull();
    expect(schedule.due(view(0), 2, 2000)).toBeNull();
    expect(schedule.due(view(0), 2, 6000)).not.toBeNull();
  });

  it("starts over after a reset", () => {
    const schedule = new DeckSchedule();
    schedule.due(view(0), 1, 0);
    schedule.reset();
    expect(schedule.due(view(0), 1, 10)).not.toBeNull();
  });
});
