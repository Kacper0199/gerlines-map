// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCooldown } from "./use-cooldown.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCooldown", () => {
  it("counts the asked seconds down to zero and stays there", () => {
    const { result } = renderHook(() => useCooldown(3, "first"));
    expect(result.current).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(2);
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(0);
  });

  it("is zero when the server asked for no wait", () => {
    const { result } = renderHook(() => useCooldown(undefined, "first"));
    expect(result.current).toBe(0);
  });

  it("starts over for a new refusal even when it asks for the same seconds", () => {
    const { result, rerender } = renderHook(({ token }) => useCooldown(5, token), {
      initialProps: { token: "a" },
    });
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current).toBe(1);
    rerender({ token: "b" });
    expect(result.current).toBe(5);
  });
});
