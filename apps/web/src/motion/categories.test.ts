import { describe, expect, it } from "vitest";
import { DRAW_ORDER } from "./categories.ts";

describe("DRAW_ORDER", () => {
  it("draws foreign trains first and high speed trains last", () => {
    expect(DRAW_ORDER.foreign).toBeLessThan(DRAW_ORDER.reg);
    expect(DRAW_ORDER.reg).toBeLessThan(DRAW_ORDER.rfast);
    expect(DRAW_ORDER.rfast).toBeLessThan(DRAW_ORDER.sbahn);
    expect(DRAW_ORDER.sbahn).toBeLessThan(DRAW_ORDER.ld);
    expect(DRAW_ORDER.ld).toBeLessThan(DRAW_ORDER.hsr);
  });
});
