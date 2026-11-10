import { describe, expect, it } from "vitest";
import { DELAY_CLASSES, DELAY_DRAW_ORDER, delayClassOf } from "./delay.ts";

const domestic = (delay: number | null, realtime = true) =>
  delayClassOf({ delay, realtime, foreign: false });

describe("delayClassOf", () => {
  it("puts a train with realtime data and under three minutes on time", () => {
    expect(domestic(0)).toBe("ok");
    expect(domestic(179)).toBe("ok");
  });

  it("counts an early train as on time", () => {
    expect(domestic(-240)).toBe("ok");
  });

  it("splits minor, major and severe at 3, 6 and 15 minutes", () => {
    expect(domestic(180)).toBe("minor");
    expect(domestic(359)).toBe("minor");
    expect(domestic(360)).toBe("major");
    expect(domestic(899)).toBe("major");
    expect(domestic(900)).toBe("severe");
    expect(domestic(7200)).toBe("severe");
  });

  it("shows a train without realtime or without a delay value as missing, never as on time", () => {
    expect(domestic(0, false)).toBe("none");
    expect(domestic(null)).toBe("none");
    expect(domestic(null, false)).toBe("none");
  });

  it("keeps a foreign train in its own class whatever its delay", () => {
    expect(delayClassOf({ delay: 1200, realtime: true, foreign: true })).toBe("foreign");
    expect(delayClassOf({ delay: null, realtime: false, foreign: true })).toBe("foreign");
  });

  it("draws the worse delays on top", () => {
    const order = [...DELAY_CLASSES].sort((a, b) => DELAY_DRAW_ORDER[a] - DELAY_DRAW_ORDER[b]);
    expect(order).toEqual(["foreign", "none", "ok", "minor", "major", "severe"]);
  });
});
