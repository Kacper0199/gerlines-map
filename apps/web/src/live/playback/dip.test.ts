import { describe, expect, it } from "vitest";
import { SeekDip } from "./dip.ts";

describe("SeekDip", () => {
  it("is fully visible until a seek begins", () => {
    const dip = new SeekDip(200, 300);
    expect(dip.opacity(0)).toBe(1);
    expect(dip.active).toBe(false);
    expect(dip.swapDue(0)).toBe(false);
  });

  it("fades the old trains out, then asks for the swap", () => {
    const dip = new SeekDip(200, 300);
    dip.begin(1_000);
    expect(dip.active).toBe(true);
    expect(dip.opacity(1_000)).toBe(1);
    expect(dip.opacity(1_100)).toBeCloseTo(0.5, 5);
    expect(dip.swapDue(1_100)).toBe(false);
    expect(dip.swapDue(1_200)).toBe(true);
    expect(dip.opacity(1_200)).toBe(0);
  });

  it("holds at zero while the new state loads, then fades in", () => {
    const dip = new SeekDip(200, 300);
    dip.begin(0);
    dip.swapped();
    expect(dip.opacity(5_000)).toBe(0);
    expect(dip.swapDue(5_000)).toBe(false);
    dip.release(5_000);
    expect(dip.opacity(5_150)).toBeCloseTo(0.5, 5);
    expect(dip.opacity(5_300)).toBe(1);
    expect(dip.active).toBe(false);
  });

  it("restarts from the opacity it has when a seek comes during a fade", () => {
    const dip = new SeekDip(200, 300);
    dip.begin(0);
    dip.swapped();
    dip.release(1_000);
    dip.begin(1_150);
    expect(dip.opacity(1_150)).toBeCloseTo(0.5, 5);
    expect(dip.opacity(1_200)).toBeCloseTo(0.25, 5);
    expect(dip.swapDue(1_250)).toBe(true);
  });

  it("does nothing at all when the durations are zero", () => {
    const dip = new SeekDip(0, 0);
    dip.begin(0);
    expect(dip.opacity(0)).toBe(1);
    expect(dip.swapDue(0)).toBe(true);
    dip.swapped();
    expect(dip.opacity(0)).toBe(1);
    dip.release(0);
    expect(dip.active).toBe(false);
  });
});
