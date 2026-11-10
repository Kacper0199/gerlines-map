import { describe, expect, it, vi } from "vitest";
import { fadeIn } from "./fade.ts";

describe("fadeIn", () => {
  it("animates opacity from a lower value to 1 in 180 ms", () => {
    const animate = vi.fn();
    fadeIn({ animate } as never);
    expect(animate).toHaveBeenCalledWith(
      [{ opacity: 0.4 }, { opacity: 1 }],
      expect.objectContaining({ duration: 180 }),
    );
  });

  it("does nothing without an element or without the Web Animations API", () => {
    expect(() => fadeIn(undefined)).not.toThrow();
    expect(() => fadeIn({} as never)).not.toThrow();
  });
});
