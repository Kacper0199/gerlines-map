import { describe, expect, it } from "vitest";
import { minutesUntil } from "./minutes.ts";

describe("minutesUntil", () => {
  it("rounds up to whole minutes and never goes below zero", () => {
    expect(minutesUntil(90_000, 0)).toBe(2);
    expect(minutesUntil(60_000, 0)).toBe(1);
    expect(minutesUntil(0, 5000)).toBe(0);
  });
});
