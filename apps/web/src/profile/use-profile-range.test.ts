import { describe, expect, it } from "vitest";
import { profileRange } from "./use-profile-range.ts";

const TODAY = "2026-11-08";

describe("profileRange", () => {
  it("takes the last 30 days when the statistics period is Today", () => {
    expect(profileRange({ kind: "today" }, TODAY)).toEqual({
      from: "2026-10-10",
      to: "2026-11-08",
    });
  });

  it("follows the period chosen in the statistics panel", () => {
    expect(profileRange({ kind: "days", count: 7 }, TODAY)).toEqual({
      from: "2026-11-02",
      to: TODAY,
    });
    expect(profileRange({ kind: "month", year: 2026, month: 9 }, TODAY)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("falls back to 30 days for a custom period that is not valid", () => {
    expect(profileRange({ kind: "custom", from: "2026-11-05", to: "2026-11-01" }, TODAY)).toEqual({
      from: "2026-10-10",
      to: TODAY,
    });
  });
});
