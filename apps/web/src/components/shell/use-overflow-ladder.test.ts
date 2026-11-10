import { describe, expect, it } from "vitest";
import { nextStep } from "./use-overflow-ladder.ts";

describe("nextStep", () => {
  it("stays where it is while the content fits", () => {
    expect(nextStep({ index: 1, last: 3, overflowing: false, pinAt: 2, pinned: false })).toBe(1);
  });

  it("walks one step further while the content overflows", () => {
    expect(nextStep({ index: 1, last: 3, overflowing: true, pinAt: 2, pinned: false })).toBe(2);
  });

  it("never walks past the last step", () => {
    expect(nextStep({ index: 3, last: 3, overflowing: true, pinAt: 2, pinned: false })).toBe(3);
  });

  it("walks up to the pin step and no further while a disclosure is open", () => {
    expect(nextStep({ index: 1, last: 3, overflowing: true, pinAt: 2, pinned: true })).toBe(2);
    expect(nextStep({ index: 2, last: 3, overflowing: true, pinAt: 2, pinned: true })).toBe(2);
  });

  it("does not move back from a step beyond the pin", () => {
    expect(nextStep({ index: 3, last: 3, overflowing: true, pinAt: 2, pinned: true })).toBe(3);
  });
});
