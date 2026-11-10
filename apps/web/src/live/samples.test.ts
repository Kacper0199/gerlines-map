import { describe, expect, it } from "vitest";
import { Samples } from "./samples.ts";

describe("Samples", () => {
  it("summarises nothing as zeros", () => {
    expect(new Samples().summary()).toEqual({ p50: 0, p95: 0, max: 0, count: 0 });
  });

  it("gives percentiles, the maximum and the total count", () => {
    const samples = new Samples();
    for (let value = 1; value <= 100; value++) samples.add(value);
    expect(samples.summary()).toEqual({ p50: 51, p95: 96, max: 100, count: 100 });
  });

  it("keeps only the newest window but counts every sample", () => {
    const samples = new Samples();
    for (let i = 0; i < 5_000; i++) samples.add(1000);
    for (let i = 0; i < 1_200; i++) samples.add(1);
    expect(samples.summary()).toEqual({ p50: 1, p95: 1, max: 1, count: 6_200 });
  });
});
