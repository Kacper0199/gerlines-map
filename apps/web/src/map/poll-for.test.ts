import { describe, expect, it, vi } from "vitest";
import { pollFor } from "./poll-for.ts";

function frames() {
  let next: (() => void) | null = null;
  let now = 0;
  return {
    clock: {
      frame: (callback: () => void) => {
        next = callback;
        return 1;
      },
      cancel: () => {
        next = null;
      },
      now: () => now,
    },
    tick(ms: number) {
      now += ms;
      const run = next;
      next = null;
      run?.();
    },
    pending: () => next !== null,
  };
}

describe("pollFor", () => {
  it("hands over the value once it appears", () => {
    const page = frames();
    let value: string | null = null;
    const found = vi.fn();
    pollFor(() => value, found, { timeoutMs: 1_000, ...page.clock });
    page.tick(16);
    value = "map";
    page.tick(16);
    expect(found).toHaveBeenCalledWith("map");
    expect(page.pending()).toBe(false);
  });

  it("stops looking after the timeout", () => {
    const page = frames();
    const found = vi.fn();
    pollFor(() => null, found, { timeoutMs: 100, ...page.clock });
    for (let i = 0; i < 10; i += 1) page.tick(16);
    expect(page.pending()).toBe(false);
    expect(found).not.toHaveBeenCalled();
  });

  it("stops when cancelled", () => {
    const page = frames();
    const stop = pollFor(() => null, vi.fn(), { timeoutMs: 1_000, ...page.clock });
    stop();
    expect(page.pending()).toBe(false);
  });
});
