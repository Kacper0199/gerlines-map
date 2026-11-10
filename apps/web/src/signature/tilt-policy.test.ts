import { describe, expect, it } from "vitest";
import {
  initialSelectionTilt,
  SELECTION_TILT_STORAGE_KEY,
  storeSelectionTilt,
} from "./tilt-policy.ts";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("selection tilt preference", () => {
  it("is on until the user switches it off", () => {
    expect(initialSelectionTilt(storage())).toBe(true);
  });

  it("keeps the stored choice", () => {
    const store = storage();
    storeSelectionTilt(store, false);
    expect(store.getItem(SELECTION_TILT_STORAGE_KEY)).toBe("off");
    expect(initialSelectionTilt(store)).toBe(false);
    storeSelectionTilt(store, true);
    expect(initialSelectionTilt(store)).toBe(true);
  });
});
