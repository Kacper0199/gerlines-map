import { describe, expect, it, vi } from "vitest";
import { createAnnouncer, SUMMARY_GAP_MS } from "./announcer.ts";

function setup() {
  let wall = 100_000;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const announce = vi.fn();
  const announcer = createAnnouncer({
    gapMs: SUMMARY_GAP_MS,
    now: () => wall,
    setTimer: (run, ms) => {
      timers.set(next, { at: wall + ms, run });
      return next++;
    },
    clearTimer: (id) => void timers.delete(id),
    announce,
  });
  const advance = (ms: number) => {
    wall += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= wall) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  return { announcer, announce, advance, timers };
}

describe("view summary announcer", () => {
  it("says nothing until the user moves the map", () => {
    const { announce, advance } = setup();
    advance(60_000);
    expect(announce).not.toHaveBeenCalled();
  });

  it("gap is ten seconds", () => {
    expect(SUMMARY_GAP_MS).toBe(10_000);
  });

  it("announces the first move at once", () => {
    const { announcer, announce, advance } = setup();
    announcer.moved();
    advance(0);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("holds a move that comes within ten seconds of the last announcement until the gap is over", () => {
    const { announcer, announce, advance } = setup();
    announcer.moved();
    advance(0);
    advance(3000);
    announcer.moved();
    advance(0);
    expect(announce).toHaveBeenCalledTimes(1);
    advance(6999);
    expect(announce).toHaveBeenCalledTimes(1);
    advance(1);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("folds many moves inside the gap into one announcement", () => {
    const { announcer, announce, advance } = setup();
    announcer.moved();
    advance(0);
    for (let i = 0; i < 20; i++) {
      advance(200);
      announcer.moved();
    }
    advance(10_000);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("announces a move after a quiet minute at once again", () => {
    const { announcer, announce, advance } = setup();
    announcer.moved();
    advance(0);
    advance(60_000);
    announcer.moved();
    advance(0);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("drops a waiting announcement when disposed", () => {
    const { announcer, announce, advance } = setup();
    announcer.moved();
    advance(0);
    announcer.moved();
    announcer.dispose();
    advance(20_000);
    expect(announce).toHaveBeenCalledTimes(1);
  });
});
