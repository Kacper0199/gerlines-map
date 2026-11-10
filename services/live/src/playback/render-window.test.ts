import { describe, expect, it } from "vitest";
import { versionAvailability } from "./render-window.ts";

describe("versionAvailability", () => {
  it("takes each version's load time, a named instant replacing it", () => {
    const loads = new Map([
      [1, 1_761_800_000],
      [2, 1_762_400_000],
    ]);
    expect(versionAvailability(loads, new Map())).toEqual(loads);
    expect(versionAvailability(loads, new Map([[1, 1_760_832_000]]))).toEqual(
      new Map([
        [1, 1_760_832_000],
        [2, 1_762_400_000],
      ]),
    );
    expect(versionAvailability(new Map(), new Map([[3, 5]]))).toEqual(new Map([[3, 5]]));
  });
});
