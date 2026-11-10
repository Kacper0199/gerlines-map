import { describe, expect, it } from "vitest";
import { berlinInstantOf, berlinLocalOf, isBerlinLocal } from "./berlin-time.ts";

describe("Berlin wall clock", () => {
  it("reads winter and summer times with their offsets", () => {
    expect(new Date(berlinInstantOf("2026-11-10T07:00") as number).toISOString()).toBe(
      "2026-11-10T06:00:00.000Z",
    );
    expect(new Date(berlinInstantOf("2026-07-01T07:00") as number).toISOString()).toBe(
      "2026-07-01T05:00:00.000Z",
    );
  });

  it("takes the earlier instant in the autumn overlap and skips nothing in spring", () => {
    expect(new Date(berlinInstantOf("2026-10-25T02:30") as number).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(berlinInstantOf("2026-03-29T03:30")).toBe(Date.parse("2026-03-29T01:30:00Z"));
  });

  it("writes an instant as the Berlin wall clock", () => {
    expect(berlinLocalOf(Date.parse("2026-11-10T06:00:00Z"))).toBe("2026-11-10T07:00");
    expect(berlinLocalOf(Date.parse("2026-11-09T23:30:00Z"))).toBe("2026-11-10T00:30");
  });

  it("round trips every quarter hour of a day", () => {
    for (let quarter = 0; quarter < 96; quarter += 1) {
      const ms = Date.parse("2026-11-10T00:00:00Z") + quarter * 900_000;
      expect(berlinInstantOf(berlinLocalOf(ms))).toBe(ms);
    }
  });

  it.each(["2026-11-10", "2026-02-30T07:00", "2026-11-10T24:00", "2026-11-10T07:60", "x"])(
    "refuses %s",
    (text) => {
      expect(isBerlinLocal(text)).toBe(false);
      expect(berlinInstantOf(text)).toBeNull();
    },
  );
});
