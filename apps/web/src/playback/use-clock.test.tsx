// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useClockWithSeconds } from "./use-clock.ts";

afterEach(async () => {
  await changeLocale("en");
});

describe("useClockWithSeconds", () => {
  it("formats Berlin time and stays the same function across renders", async () => {
    await changeLocale("en");
    const { result, rerender } = renderHook(() => useClockWithSeconds());
    const first = result.current;
    expect(first(Date.UTC(2025, 10, 8, 9, 5, 7) / 1000)).toBe("10:05:07");
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  it("changes only with the language", async () => {
    await changeLocale("en");
    const { result } = renderHook(() => useClockWithSeconds());
    const first = result.current;
    await act(async () => {
      await changeLocale("de", { persist: false });
    });
    expect(result.current).not.toBe(first);
    expect(result.current(Date.UTC(2025, 10, 8, 9, 5, 7) / 1000)).toBe("10:05:07");
  });
});
