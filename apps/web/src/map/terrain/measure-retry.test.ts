import { describe, expect, it } from "vitest";
import { MeasureRetry } from "./measure-retry.ts";

describe("MeasureRetry", () => {
  it("asks for nothing while nothing is unmeasured", () => {
    const retry = new MeasureRetry(1000);
    retry.changed();
    expect(retry.due(5000, 0)).toBe(false);
  });

  it("asks for nothing until the terrain or the view changed", () => {
    const retry = new MeasureRetry(1000);
    expect(retry.due(5000, 40)).toBe(false);
    retry.changed();
    expect(retry.due(5000, 40)).toBe(true);
    expect(retry.due(9000, 40)).toBe(false);
  });

  it("asks at most once per gap and keeps a change for the next gap", () => {
    const retry = new MeasureRetry(1000);
    retry.changed();
    expect(retry.due(5000, 40)).toBe(true);
    retry.changed();
    expect(retry.due(5400, 40)).toBe(false);
    expect(retry.due(6100, 40)).toBe(true);
  });

  it("forgets a pending change when a fresh measurement settled everything", () => {
    const retry = new MeasureRetry(1000);
    retry.changed();
    retry.settled();
    expect(retry.due(9000, 40)).toBe(false);
  });
});
