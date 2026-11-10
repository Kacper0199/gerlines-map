import { describe, expect, it } from "vitest";
import { categoryKeyOf } from "./categories.ts";

describe("categoryKeyOf", () => {
  it("maps rail categories to their legend category and urban rail to S-Bahn", () => {
    expect(categoryKeyOf({ category: "hsr", foreign: false })).toBe("hsr");
    expect(categoryKeyOf({ category: "urban", foreign: false })).toBe("sbahn");
    expect(categoryKeyOf({ category: "reg", foreign: false })).toBe("reg");
  });

  it("gives foreign trains their own category", () => {
    expect(categoryKeyOf({ category: "ld", foreign: true })).toBe("foreign");
  });

  it("names no category for a bus or a trip without one", () => {
    expect(categoryKeyOf({ category: "bus", foreign: false })).toBeNull();
    expect(categoryKeyOf({ category: "unknown", foreign: false })).toBeNull();
  });
});
